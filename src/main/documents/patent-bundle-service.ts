import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainCurrentPatentAssets } from "../../shared/patent/asset-references.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import type { PersistentAssetStore } from "../assets/asset-store.js";
import type { PatentService } from "../library/patent-service.js";
import type { PatentPatdocPayload } from "./patdoc-format.js";
import { patdocRestoreBytes } from "./patdoc-history.js";
import { readPatdoc } from "./patdoc-reader.js";
import { readPatentBundle } from "./patent-bundle.js";

export function fiveBookPatent(source: CanonicalPatent): CanonicalPatent {
  const patent = structuredClone(source);
  patent.auxiliaryDocuments = [];
  patent.docxImportReport = null;
  return retainCurrentPatentAssets(patent);
}

function remapAssets(patent: CanonicalPatent, ids: Map<string, string>): CanonicalPatent {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        (key === "assetId" ||
          key === "previewAssetId" ||
          key === "sourceAssetId" ||
          key === "bodyAssetId" ||
          key === "baseAssetId") &&
        typeof nested === "string"
          ? (ids.get(nested) ?? nested)
          : visit(nested),
      ]),
    );
  };
  return visit(patent) as CanonicalPatent;
}

export async function importPatentBundle(
  path: string,
  patents: Pick<PatentService, "hasImportedBundle" | "importBundle">,
  assets: PersistentAssetStore,
  confirmDuplicate: () => Promise<boolean>,
) {
  const bundle = await readPatentBundle(path);
  const duplicate = patents.hasImportedBundle(bundle.bundleId);
  if (duplicate && !(await confirmDuplicate())) return null;
  if (!assets.stageMany || !assets.discardStaged)
    throw new Error("资源暂存服务不可用，未导入任何专利。");
  const root = await mkdtemp(join(tmpdir(), "patent-bundle-import-"));
  const stageId = randomUUID();
  const stagedIds: string[] = [];
  const payloads: PatentPatdocPayload[] = [];
  try {
    let size = 0;
    // Validate every native file before installing any resource or patent.
    for (const [index, item] of bundle.items.entries()) {
      const file = join(root, `${index}.patdoc`);
      await writeFile(file, item.native, { flag: "wx" });
      const payload = await readPatdoc<PatentPatdocPayload>(file);
      if (
        !("patent" in payload) ||
        payload.patent.auxiliaryDocuments.length ||
        payload.patent.docxImportReport
      )
        throw new Error("压缩包不是五书专利包。");
      size += patdocRestoreBytes(payload);
      if (size > 256 * 1024 * 1024) throw new Error("还原数据超过 256 MiB，请分批导入。");
      payloads.push(payload);
    }
    for (const payload of payloads) {
      const ids = new Map<string, string>();
      const allAssets = [
        ...payload.assets,
        ...(payload.snapshots ?? []).flatMap((item) => item.assets),
      ];
      const descriptors = new Map<string, (typeof payload.assets)[number]["descriptor"]>();
      for (const asset of allAssets) {
        const originalId = asset.descriptor.assetId;
        if (ids.has(originalId)) continue;
        const [saved] = await assets.stageMany(
          stageId,
          [{ ...asset, descriptor: { ...asset.descriptor, assetId: randomUUID() } }],
          stageId,
        );
        if (!saved) throw new Error("资源暂存失败。");
        stagedIds.push(saved.descriptor.assetId);
        ids.set(originalId, saved.descriptor.assetId);
        descriptors.set(originalId, saved.descriptor);
      }
      for (const snapshot of payload.snapshots ?? []) {
        snapshot.patent = remapAssets(snapshot.patent, ids);
        snapshot.assets = snapshot.assets.map((asset) => ({
          ...asset,
          descriptor: descriptors.get(asset.descriptor.assetId)!,
        }));
        snapshot.patent.assets = [
          ...new Map(
            snapshot.assets.map((asset) => [asset.descriptor.assetId, asset.descriptor]),
          ).values(),
        ];
      }
      payload.assets = payload.assets.map((asset) => ({
        ...asset,
        descriptor: descriptors.get(asset.descriptor.assetId)!,
      }));
      payload.patent = remapAssets(payload.patent, ids);
      payload.patent.assets = [
        ...new Map(
          payload.assets.map((asset) => [asset.descriptor.assetId, asset.descriptor]),
        ).values(),
      ];
      const patent = payload.patent;
      patent.patentId = randomUUID();
      patent.revision = 0;
      patent.books.forEach((book) => {
        book.bookId = randomUUID();
        book.localRevision = 0;
        book.persistedRevision = 0;
      });
    }
    return await patents.importBundle({
      bundleId: bundle.bundleId,
      patents: payloads,
      allowDuplicate: duplicate,
    });
  } finally {
    // Referenced resources survive discard; only uncommitted staged resources are collected.
    await assets.discardStaged(stageId, stagedIds, stageId).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}
