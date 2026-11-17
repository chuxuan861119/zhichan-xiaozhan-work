import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { PatentPatdocPayload } from "../../src/main/documents/patdoc-format.js";
import { readPatdoc } from "../../src/main/documents/patdoc-reader.js";
import { createPatdocFidelityPayload } from "../fixtures/patdoc-fidelity.js";
import { writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

test("imports independent patent resources and preserves each original preview on reexport", async ({
  workbench,
}) => {
  const incoming = await createPatdocFidelityPayload();
  incoming.patent.name = "清晰预览";
  const older = structuredClone(incoming);
  older.patent.name = "原有预览";
  const preview = await sharp(Buffer.from(older.assets[0]!.original)).resize(6, 4).png().toBuffer();
  older.assets[0]!.preview = Uint8Array.from(preview);
  Object.assign(older.assets[0]!.descriptor, {
    previewByteLength: preview.length,
    previewSha256: createHash("sha256").update(preview).digest("hex").toUpperCase(),
  });
  const oldPath = join(workbench.root, "old.patdoc");
  const newPath = join(workbench.root, "new.patdoc");
  const exportPath = join(workbench.root, "reexport.patdoc");
  await writePatdoc(oldPath, older);
  await writePatdoc(newPath, incoming);
  const originalArchive = await readFile(newPath);
  const profile = await workbench.launchProfile("independent-resources");
  try {
    const page = await profile.application.firstWindow();
    const imported = [];
    for (const path of [oldPath, newPath, newPath]) {
      await profile.application.evaluate(({ dialog }, filePath) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [filePath] }),
        });
      }, path);
      const result = await page.evaluate(async () => window.patentApi.patents.importPatdoc());
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok || !result.value) throw new Error("导入失败");
      imported.push(result.value);
    }
    expect(new Set(imported.map((item) => item.patentId)).size).toBe(3);
    const ids = imported.flatMap((item) => item.patent.assets.map((asset) => asset.assetId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      (await readdir(join(profile.libraryRoot, "assets"))).filter((name) =>
        name.endsWith(".asset"),
      ),
    ).toHaveLength(ids.length);
    for (const [index, item] of imported.entries()) {
      const descriptor = item.patent.assets[0]!;
      const result = await page.evaluate(
        async ({ sessionId, assetId }) => window.patentApi.assets.getPreview(sessionId, assetId),
        { sessionId: item.sessionId, assetId: descriptor.assetId },
      );
      if (!result.ok) throw new Error("预览失败");
      expect(await sharp(Buffer.from(result.value)).metadata()).toMatchObject(
        index === 0 ? { width: 6, height: 4 } : { width: 12, height: 8 },
      );
      expect(descriptor.previewSha256).toBe(
        (index === 0 ? older : incoming).assets[0]!.descriptor.previewSha256,
      );
    }
    await profile.application.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePath }),
      });
    }, exportPath);
    const current = imported[1]!;
    const exported = await page.evaluate(
      async (request) => window.patentApi.patents.exportPatdoc(request),
      { patentId: current.patentId, expectedRevision: current.revision },
    );
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    const archived = await readPatdoc<PatentPatdocPayload>(exportPath);
    for (const [index, asset] of incoming.assets.entries()) {
      expect(archived.assets[index]!.original).toEqual(asset.original);
      expect(archived.assets[index]!.preview).toEqual(asset.preview);
    }
    expect(await readFile(newPath)).toEqual(originalArchive);
    for (const item of imported)
      await page.evaluate(
        async (sessionId) => window.patentApi.patents.release(sessionId),
        item.sessionId,
      );
    const reopened = await page.evaluate(
      async (id) => window.patentApi.patents.open(id),
      imported[0]!.patentId,
    );
    if (!reopened.ok) throw new Error("旧专利重新打开失败");
    expect(reopened.value.patent.assets[0]!.previewSha256).toBe(
      older.assets[0]!.descriptor.previewSha256,
    );
  } finally {
    await profile.application.close();
  }
});
