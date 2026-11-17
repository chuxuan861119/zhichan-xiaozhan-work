import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { FlowchartSourceStore } from "../flowcharts/flowchart-source-store.js";
import { AssetStore } from "../library/asset-store.js";
import type { LibraryDatabase } from "../library/library-database.js";
import { LibraryMigrationService } from "../library/library-migration-service.js";
import { PatentService } from "../library/patent-service.js";
import { SnapshotService } from "../library/snapshot-service.js";
import { writePatdoc } from "./patdoc-writer.js";
import { writePatentBundle } from "./patent-bundle.js";
import { importPatentBundle } from "./patent-bundle-service.js";

let root: string;
let database: LibraryDatabase;
afterEach(async () => {
  database?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
test.each(["patdoc", "docx"] as const)(
  "restores five books, figures and editable flowchart from %s bundle without replacing originals",
  async (format) => {
    root = await mkdtemp(join(tmpdir(), "bundle-restore-"));
    const prepared = await new LibraryMigrationService(join(root, "library")).prepare();
    if (prepared.status !== "ready") throw new Error("fixture");
    database = prepared.database;
    const assets = new AssetStore({ root: join(root, "library"), database });
    const service = new PatentService({ database, assetStore: assets });
    const patent = createBlankPatent({
      patentType: "utility-model",
      name: "测试夹具",
      customer: "客户甲",
    });
    const bytes = Buffer.from("test-image");
    const sha = createHash("sha256").update(bytes).digest("hex").toUpperCase();
    const asset = {
      descriptor: {
        assetId: randomUUID(),
        kind: "image" as const,
        originalName: "图.png",
        mediaType: "image/png" as const,
        extension: "png" as const,
        byteLength: bytes.length,
        sha256: sha,
        widthPx: 12,
        heightPx: 8,
        previewByteLength: bytes.length,
        previewSha256: sha,
      },
      original: bytes,
      preview: bytes,
    };
    const source = Buffer.from('<mxfile><diagram id="p1"><mxGraphModel/></diagram></mxfile>');
    const projectId = randomUUID();
    const sourceSha = createHash("sha256").update(source).digest("hex").toUpperCase();
    patent.assets = [asset.descriptor];
    patent.figures = [
      {
        figureId: randomUUID(),
        assetId: asset.descriptor.assetId,
        widthMm: 100,
        rotationDeg: 90,
        flowchartLink: {
          projectId,
          exportedProjectRevision: 3,
          exportedSourceSha256: sourceSha,
          pageId: "p1",
          exportScope: "page",
          selectedCellIds: [],
          borderMm: 0,
          renderProfileVersion: 1,
        },
      },
    ];
    patent.abstractDrawingFigureId = patent.figures[0]!.figureId;
    patent.flowchartProjects = [
      {
        projectId,
        name: "流程",
        revision: 3,
        sourceSha256: sourceSha,
        pageCount: 1,
        lastPageId: "p1",
        createdAt: patent.createdAt,
        modifiedAt: patent.modifiedAt,
      },
    ];
    patent.drawingProjects = [drawingProjectFixture(asset.descriptor.assetId)];
    const native = join(root, "native.patdoc");
    await writePatdoc(native, {
      patent,
      assets: [asset],
      flowcharts: [{ projectId, source }],
      snapshots: [
        {
          patent,
          assets: [asset],
          flowcharts: [{ projectId, source }],
          createdAt: patent.createdAt,
          source: "manual-create",
        },
      ],
    });
    const archive = join(root, "patents.zip");
    await writePatentBundle(archive, format, [
      { name: "测试夹具", file: native, native },
      { name: "测试夹具", file: native, native },
    ]);
    expect(await importPatentBundle(archive, service, assets, async () => false)).toBe(2);
    const listed = await service.list("active");
    expect(listed).toHaveLength(2);
    const opened = await service.open(listed[0]!.patentId);
    const snapshots = new SnapshotService({
      database,
      readAssetPreview: async (id) => (await assets.readAsset(id)).preview,
    });
    expect(
      (await snapshots.list(opened.patentId)).some((item) => item.source === "manual-create"),
    ).toBe(false);
    expect(opened.patent.docxImportReport).toBeNull();
    expect(opened.patent.patentId).not.toBe(patent.patentId);
    expect(opened.patent.customer).toBe("客户甲");
    expect(opened.patent.drawingProjects).toEqual([
      {
        ...patent.drawingProjects[0],
        sourceAssetId: opened.patent.figures[0]?.assetId,
        baseAssetId: opened.patent.figures[0]?.assetId,
      },
    ]);
    expect(opened.patent.books.map((book) => book.document)).toEqual(
      patent.books.map((book) => book.document),
    );
    expect(opened.patent.abstractDrawingFigureId).toBe(patent.abstractDrawingFigureId);
    expect((await assets.readAsset(opened.patent.figures[0]!.assetId)).original).toEqual(
      Uint8Array.from(bytes),
    );
    expect(
      new FlowchartSourceStore({ database }).loadCurrent(opened.patent.patentId, projectId).source,
    ).toEqual(Uint8Array.from(source));
    expect(await importPatentBundle(archive, service, assets, async () => false)).toBeNull();
    expect(await service.list("active")).toHaveLength(2);
    expect(await importPatentBundle(archive, service, assets, async () => true)).toBe(2);
    expect(await service.list("active")).toHaveLength(4);
    const commit = vi
      .spyOn(service, "importBundle")
      .mockRejectedValueOnce(new Error("模拟提交失败"));
    await expect(importPatentBundle(archive, service, assets, async () => true)).rejects.toThrow(
      "模拟提交失败",
    );
    commit.mockRestore();
    expect(await service.list("active")).toHaveLength(4);
    expect((await assets.readAsset(opened.patent.figures[0]!.assetId)).original).toEqual(
      Uint8Array.from(bytes),
    );
    const invalid = join(root, "invalid.patdoc");
    await writeFile(invalid, "invalid native data");
    await writePatentBundle(archive, format, [
      { name: "有效", file: native, native },
      { name: "无效", file: invalid, native: invalid },
    ]);
    const stage = vi.spyOn(assets, "stageMany");
    await expect(importPatentBundle(archive, service, assets, async () => false)).rejects.toThrow();
    expect(stage).not.toHaveBeenCalled();
    stage.mockRestore();
    expect(await service.list("active")).toHaveLength(4);
  },
);
