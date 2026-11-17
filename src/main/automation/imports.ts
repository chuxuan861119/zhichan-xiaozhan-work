import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import type { AutomationPatentImportSchema } from "../../shared/automation/imports.js";
import { AutomationError, type ResolvedAutomationScope } from "../../shared/automation/protocol.js";
import type { StoredAsset } from "../assets/asset-store.js";
import type { PatentPatdocPayload } from "../documents/patdoc-format.js";
import { patdocRestoreBytes } from "../documents/patdoc-history.js";
import { readPatdoc } from "../documents/patdoc-reader.js";
import { readPatentBundle } from "../documents/patent-bundle.js";
import type { LibraryRuntime } from "../library/library-runtime.js";
import type { AutomationLedger, OperationRecord } from "./ledger.js";
import { readAllowedFile } from "./paths.js";

const LIMIT = 256 * 1024 * 1024;
const RESOURCE_KEYS = new Set([
  "assetId",
  "previewAssetId",
  "sourceAssetId",
  "baseAssetId",
  "bodyAssetId",
]);
export function remapAssets<T>(patent: T, ids: ReadonlyMap<string, string>): T {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        RESOURCE_KEYS.has(key) && typeof child === "string"
          ? (ids.get(child) ?? child)
          : visit(child),
      ]),
    );
  };
  return visit(patent) as T;
}

export async function importAutomationPatents(
  runtime: LibraryRuntime,
  home: string,
  input: z.infer<typeof AutomationPatentImportSchema>,
  context: {
    grant: ResolvedAutomationScope;
    taskId: string;
    record: OperationRecord;
    ledger: AutomationLedger;
    assertAuthorized(): void;
    restoreBytes?: Uint8Array;
  },
) {
  context.assertAuthorized();
  const bytes =
    context.restoreBytes ??
    (await readAllowedFile(input.path, [context.grant.workspace.importDirectory], LIMIT));
  const directory = await mkdtemp(join(home, "import-"));
  const stageId = context.record.operationId;
  const stagedIds = new Set<string>();
  try {
    const file = join(directory, input.format === "patdoc" ? "input.patdoc" : "input.zip");
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    context.assertAuthorized();
    let bundleId = stageId;
    const payloads: PatentPatdocPayload[] = [];
    if (input.format === "bundle") {
      const bundle = await readPatentBundle(file);
      bundleId = bundle.bundleId;
      if (runtime.patents.hasImportedBundle(bundleId) && !input.allowDuplicate)
        throw new AutomationError(
          "DUPLICATE_IMPORT",
          "专利包已导入；确需创建另一份时设置 allowDuplicate。",
        );
      for (const [index, item] of bundle.items.entries()) {
        context.assertAuthorized();
        const path = join(directory, `${index}.patdoc`);
        await writeFile(path, item.native, { flag: "wx", mode: 0o600 });
        const payload = await readPatdoc<PatentPatdocPayload>(path);
        if (
          !("patent" in payload) ||
          payload.patent.auxiliaryDocuments.length ||
          payload.patent.docxImportReport
        )
          throw new AutomationError("INVALID_INPUT", "文件不是五书专利包。");
        payloads.push(payload);
      }
    } else {
      const payload = await readPatdoc<PatentPatdocPayload>(file);
      if (!("patent" in payload))
        throw new AutomationError("INVALID_INPUT", "文件不是原生专利，请使用独立文档导入入口。");
      payloads.push(payload);
    }
    if (payloads.reduce((sum, payload) => sum + patdocRestoreBytes(payload), 0) > LIMIT)
      throw new AutomationError("TOO_LARGE", "还原数据超过 256 MiB，请分批导入。");
    if (
      !context.restoreBytes &&
      context.ledger.createdForTask(context.taskId, context.record.clientId).length +
        payloads.length >
        context.grant.createLimit
    )
      throw new AutomationError(
        "SCOPE_DENIED",
        "本次新建额度不足，请执行 pair renew-create 请求用户再次授权；每次最多 5 件，专利包请按剩余额度分批。",
      );
    for (const payload of payloads) {
      if (context.restoreBytes)
        payload.patent.name = `${(payload.patent.name ?? "未命名专利").slice(0, 295)} (恢复)`;
      const replacements = new Map<string, string>();
      const descriptors = new Map<string, StoredAsset["descriptor"]>();
      for (const asset of [
        ...payload.assets,
        ...(payload.snapshots ?? []).flatMap((snapshot) => snapshot.assets),
      ]) {
        context.assertAuthorized();
        if (replacements.has(asset.descriptor.assetId)) continue;
        const [stored] = await runtime.assetStore.stageMany(
          stageId,
          [{ ...asset, descriptor: { ...asset.descriptor, assetId: randomUUID() } }],
          stageId,
        );
        if (!stored) throw new AutomationError("INTERNAL", "资源暂存失败。");
        stagedIds.add(stored.descriptor.assetId);
        replacements.set(asset.descriptor.assetId, stored.descriptor.assetId);
        descriptors.set(asset.descriptor.assetId, stored.descriptor);
      }
      for (const item of [payload, ...(payload.snapshots ?? [])]) {
        item.patent = remapAssets(item.patent, replacements);
        item.assets = item.assets.map((asset) => ({
          ...asset,
          descriptor: descriptors.get(asset.descriptor.assetId)!,
        }));
        item.patent.assets = [
          ...new Map(
            item.assets.map((asset) => [asset.descriptor.assetId, asset.descriptor]),
          ).values(),
        ];
      }
      payload.patent.patentId = randomUUID();
      payload.patent.revision = 0;
      for (const book of payload.patent.books) {
        book.bookId = randomUUID();
        book.localRevision = book.persistedRevision = 0;
      }
      for (const document of payload.patent.auxiliaryDocuments)
        document.localRevision = document.persistedRevision = 0;
    }
    let result: { patents: Array<{ patentId: string; revision: number }> } | undefined;
    await runtime.patents.importBundle({
      bundleId,
      patents: payloads,
      allowDuplicate: input.allowDuplicate,
      allowAttachments: input.format === "patdoc",
      beforeCommit: context.assertAuthorized,
      inTransaction: (database, patents) => {
        context.assertAuthorized();
        for (const patent of patents) {
          if (context.restoreBytes)
            context.ledger.recordRestored(
              database,
              context.taskId,
              context.record.clientId,
              patent.patentId,
            );
          else
            context.ledger.recordCreated(
              database,
              context.taskId,
              context.record.clientId,
              patent.patentId,
              context.grant.createLimit,
            );
        }
        result = {
          patents: patents.map((patent) => ({
            patentId: patent.patentId,
            revision: patent.revision,
          })),
        };
        context.ledger.inTransaction(
          database,
          { ...context.record, target: { patentIds: patents.map((patent) => patent.patentId) } },
          "committed",
          result,
        );
      },
    });
    return result;
  } finally {
    await runtime.assetStore.discardStaged(stageId, [...stagedIds], stageId);
    await rm(directory, { recursive: true, force: true });
  }
}
