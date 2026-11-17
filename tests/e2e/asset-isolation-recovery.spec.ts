import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PatentPatdocPayload } from "../../src/main/documents/patdoc-format.js";
import { readPatdoc } from "../../src/main/documents/patdoc-reader.js";
import { hashJson } from "../../src/main/library/edit-journal.js";
import { createLibraryRuntime } from "../../src/main/library/library-runtime.js";
import { encodeJson } from "../../src/main/library/plaintext-codec.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../src/shared/settings/model.js";
import { createPatdocFidelityPayload } from "../fixtures/patdoc-fidelity.js";
import { expect, test } from "./helpers/workbench.js";

test("unfinished asset isolation opens read-only, exports healthy patents, and retries after repair", async ({
  workbench,
}) => {
  const first = await workbench.launchProfile("asset-isolation-recovery");
  await first.application.firstWindow();
  await first.application.close();
  const runtime = await createLibraryRuntime({
    libraryRoot: first.libraryRoot,
    readOnly: false,
    runRecovery: false,
    startBackgroundSchedulers: false,
  });
  const source = (await createPatdocFidelityPayload()).assets[0];
  if (!source) throw new Error("缺少测试图片");
  let sharedPath = "";
  let healthyId = "";
  const legacyIds: string[] = [];
  try {
    for (const name of ["旧专利一", "旧专利二", "健康专利"]) {
      const opened = await runtime.patents.create({
        name,
        patentType: "invention",
        templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
      });
      if (name === "健康专利") healthyId = opened.patentId;
      else legacyIds.push(opened.patentId);
    }
    const firstOwner = legacyIds[0];
    if (!firstOwner) throw new Error("缺少测试专利");
    const shared = await runtime.assetStore.install(
      { kind: "patent", patentId: firstOwner },
      { ...source, descriptor: { ...source.descriptor, assetId: randomUUID() } },
    );
    // Recreate the pre-isolation format in this test-only library, including history.
    for (const patentId of legacyIds) {
      const patent = runtime.patents.loadSavedPatent(patentId);
      patent.assets = [shared.descriptor];
      runtime.database.transaction((db) => {
        db.prepare("INSERT OR IGNORE INTO patent_assets VALUES (?, ?)").run(
          patentId,
          shared.descriptor.assetId,
        );
        db.prepare("INSERT INTO snapshot_assets VALUES (?, 0, ?)").run(
          patentId,
          shared.descriptor.assetId,
        );
        db.prepare("UPDATE snapshots SET payload = ?, content_hash = ? WHERE patent_id = ?").run(
          Buffer.from(encodeJson(patent)),
          hashJson(patent),
          patentId,
        );
        db.prepare("UPDATE library_state SET value = ? WHERE key = ?").run(
          Buffer.from(
            encodeJson({ assets: patent.assets, abstractDrawingFigureId: null, rotations: {} }),
          ),
          `patent:${patentId}:figure-state`,
        );
      });
    }
    const row = runtime.database.read((db) =>
      db
        .prepare("SELECT relative_path FROM assets WHERE asset_id = ?")
        .get(shared.descriptor.assetId),
    ) as { relative_path: string };
    sharedPath = join(first.libraryRoot, "assets", row.relative_path);
  } finally {
    await runtime.close();
  }
  const original = await readFile(sharedPath);
  await writeFile(sharedPath, Buffer.from([0]));
  const protectedProfile = await workbench.relaunchProfile(first);
  try {
    const page = await protectedProfile.application.firstWindow();
    const report = await page.evaluate(() =>
      window.patentApi.application.getStartupRecoveryReport?.(),
    );
    expect(report).toMatchObject({
      ok: true,
      value: { mode: "read-only", assetIsolationPending: true },
    });
    await expect(page.getByRole("alert", { name: "启动恢复状态" })).toContainText("原数据已保留");
    const opened = await page.evaluate((id) => window.patentApi.patents.open(id), healthyId);
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) throw new Error("健康专利打开失败");
    const revisionRequest = {
      patentId: opened.value.patentId,
      expectedRevision: opened.value.revision,
    };
    expect(
      await page.evaluate((request) => window.patentApi.patents.flush(request), revisionRequest),
    ).toMatchObject({ ok: true });
    expect(
      await page.evaluate((request) => window.patentApi.patents.flush(request), {
        ...revisionRequest,
        expectedRevision: opened.value.revision + 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    const rejected = await page.evaluate(() =>
      window.patentApi.patents.create({
        name: "保护模式不应创建",
        patentType: "invention",
      }),
    );
    expect(rejected).toMatchObject({ ok: false, error: { code: "READ_ONLY_RECOVERY" } });
    const rejectedImport = await page.evaluate(() => window.patentApi.patents.importPatdoc());
    expect(rejectedImport).toMatchObject({ ok: false, error: { code: "READ_ONLY_RECOVERY" } });
    const exportPath = join(workbench.root, "healthy.patdoc");
    await protectedProfile.application.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePath }),
      });
    }, exportPath);
    const exported = await page.evaluate(
      (request) => window.patentApi.patents.exportPatdoc(request),
      {
        patentId: opened.value.patentId,
        expectedRevision: opened.value.revision,
      },
    );
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    expect((await readPatdoc<PatentPatdocPayload>(exportPath)).patent.name).toBe("健康专利");
    const bundled = await page.evaluate(
      (request) => window.patentApi.patents.exportBundle?.(request),
      {
        format: "patdoc" as const,
        patents: [revisionRequest],
      },
    );
    expect(bundled?.ok, JSON.stringify(bundled)).toBe(true);
    await page.evaluate(
      (sessionId) => window.patentApi.patents.release(sessionId),
      opened.value.sessionId,
    );
    expect(await readFile(sharedPath)).toEqual(Buffer.from([0]));
  } finally {
    await protectedProfile.application.close();
  }
  await writeFile(sharedPath, original);
  const retried = await workbench.relaunchProfile(first);
  try {
    const page = await retried.application.firstWindow();
    const report = await page.evaluate(() =>
      window.patentApi.application.getStartupRecoveryReport?.(),
    );
    expect(report).toMatchObject({ ok: true, value: { mode: "read-write" } });
    if (!report?.ok) throw new Error("恢复状态不可用");
    expect(report.value.assetIsolationPending).toBeUndefined();
    const assets: string[] = [];
    for (const id of legacyIds) {
      const opened = await page.evaluate((patentId) => window.patentApi.patents.open(patentId), id);
      if (!opened.ok) throw new Error("修复后专利不可用");
      const asset = opened.value.patent.assets[0];
      if (!asset) throw new Error("修复后缺少图片");
      assets.push(asset.assetId);
      const preview = await page.evaluate(
        ({ sessionId, assetId }) => window.patentApi.assets.getPreview(sessionId, assetId),
        {
          sessionId: opened.value.sessionId,
          assetId: asset.assetId,
        },
      );
      if (!preview.ok) throw new Error("修复后图片不可用");
      expect(preview.value).toEqual(source.preview);
      await page.evaluate(
        (sessionId) => window.patentApi.patents.release(sessionId),
        opened.value.sessionId,
      );
    }
    expect(new Set(assets).size).toBe(2);
  } finally {
    await retried.application.close();
  }
});
