import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import { AssetStore } from "../library/asset-store.js";
import { encodeEnvelope } from "../library/edit-journal.js";
import { LibraryMigrationService } from "../library/library-migration-service.js";
import { PatentService } from "../library/patent-service.js";
import { encodeJson } from "../library/plaintext-codec.js";
import { FlowchartService } from "./flowchart-service.js";
import { FlowchartSourceStore } from "./flowchart-source-store.js";

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "flowchart-service-"));
  roots.push(root);
  const prepared = await new LibraryMigrationService(root).prepare();
  if (prepared.status !== "ready") throw new Error("setup failed");
  const assetStore = new AssetStore({ root, database: prepared.database });
  const patentService = new PatentService({ database: prepared.database, assetStore });
  const opened = await patentService.create({
    patentType: "invention",
    name: null,
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const patentId = opened.patentId;
  const store = new FlowchartSourceStore({ database: prepared.database });
  return {
    database: prepared.database,
    patentId,
    sessionId: opened.sessionId,
    service: new FlowchartService({
      database: prepared.database,
      sourceStore: store,
      patentService,
      assetStore,
    }),
  };
}

test("atomically commits a revision-bound preview as a linked description figure", async () => {
  const { database, patentId, sessionId, service } = await setup();
  using _owned = database;
  const created = await service.create({
    patentId,
    expectedPatentRevision: 0,
    name: "控制流程",
    source: Buffer.from('<mxfile><diagram id="p1"/></mxfile>'),
    pageCount: 1,
    lastPageId: "p1",
  });
  const preview = await service.renderPreview({
    patentId,
    projectId: created.project.projectId,
    expectedProjectRevision: 0,
    expectedSourceSha256: created.project.sourceSha256,
    pageId: "p1",
    exportScope: "page",
    selectedCellIds: [],
    borderMm: 2,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="red" stroke="blue"/></svg>',
    target: { kind: "new", insertIndex: 0 },
  });
  const committed = await service.commitPreview({
    patentId,
    sessionId,
    expectedPatentRevision: 1,
    projectId: created.project.projectId,
    previewToken: preview.previewToken,
  });
  expect(committed.patent).toMatchObject({
    revision: 2,
    figures: [
      {
        assetId: committed.patent.assets.at(-1)?.assetId,
        widthMm: preview.outputWidthMm,
        flowchartLink: {
          projectId: created.project.projectId,
          pageId: "p1",
          borderMm: 2,
          exportedProjectRevision: 0,
        },
      },
    ],
  });
  expect(committed.patent.assets.at(-1)?.kind).toBe("flowchart-preview");

  const originalAssetId = committed.patent.figures[0]?.assetId;
  const replacement = await service.renderPreview({
    patentId,
    projectId: created.project.projectId,
    expectedProjectRevision: 0,
    expectedSourceSha256: created.project.sourceSha256,
    pageId: "p1",
    exportScope: "page",
    selectedCellIds: [],
    borderMm: 0,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 400"><rect width="100" height="400"/></svg>',
    target: {
      kind: "replace",
      figureId: committed.patent.figures[0]?.figureId ?? "",
      assetId: originalAssetId ?? "",
    },
  });
  const replaced = await service.commitPreview({
    patentId,
    sessionId,
    expectedPatentRevision: 2,
    projectId: created.project.projectId,
    previewToken: replacement.previewToken,
  });
  expect(replaced.patent.assets).toHaveLength(1);
  expect(replaced.patent.assets.some((asset) => asset.assetId === originalAssetId)).toBe(false);
  const tallImage = replaced.patent.assets[0];
  const tallFigure = replaced.patent.figures[0];
  if (!tallImage || !tallFigure) throw new Error("Missing replacement image");
  expect(tallFigure.widthMm).toBe(replacement.outputWidthMm);
  expect(tallFigure.widthMm).toBeCloseTo(26.46, 2);
  expect((tallFigure.widthMm * tallImage.heightPx) / tallImage.widthPx).toBeCloseTo(105.84, 0);

  const oversized = await service.renderPreview({
    patentId,
    projectId: created.project.projectId,
    expectedProjectRevision: 0,
    expectedSourceSha256: created.project.sourceSha256,
    pageId: "p1",
    exportScope: "page",
    selectedCellIds: [],
    borderMm: 2,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500"><rect width="1000" height="500"/></svg>',
    target: { kind: "new", insertIndex: 0 },
  });
  expect(oversized.outputWidthMm).toBe(146.6);
  const fitted = await service.commitPreview({
    patentId,
    sessionId,
    expectedPatentRevision: 3,
    projectId: created.project.projectId,
    previewToken: oversized.previewToken,
  });
  expect(fitted.patent.figures.map((figure) => figure.widthMm)).toEqual([
    oversized.outputWidthMm,
    tallFigure.widthMm,
  ]);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("creates, lists, loads, saves, renames and duplicates projects with aggregate revisions", async () => {
  const { database, patentId, service } = await setup();
  using _owned = database;
  const source = Buffer.from('<mxfile><diagram id="p1"/></mxfile>');
  const created = await service.create({
    patentId,
    expectedPatentRevision: 0,
    name: "原工程",
    source,
    pageCount: 1,
    lastPageId: "p1",
  });
  expect(created.patentRevision).toBe(1);
  expect(service.list(patentId)).toEqual([created.project]);
  expect(service.load(patentId, created.project.projectId).source).toEqual(Uint8Array.from(source));

  const unchanged = await service.save({
    patentId,
    projectId: created.project.projectId,
    expectedPatentRevision: 1,
    expectedProjectRevision: 0,
    source,
    pageCount: 1,
    lastPageId: "p1",
  });
  expect(unchanged.patentRevision).toBe(1);
  const changed = await service.save({
    patentId,
    projectId: created.project.projectId,
    expectedPatentRevision: 1,
    expectedProjectRevision: 0,
    source: Buffer.from('<mxfile><diagram id="p1">changed</diagram></mxfile>'),
    pageCount: 1,
    lastPageId: "p1",
  });
  expect(changed).toMatchObject({ patentRevision: 2, project: { revision: 1 } });
  const renamed = await service.rename({
    patentId,
    projectId: created.project.projectId,
    expectedPatentRevision: 2,
    expectedProjectRevision: 1,
    name: "新工程",
  });
  expect(renamed).toMatchObject({ patentRevision: 3, project: { name: "新工程", revision: 1 } });
  const duplicate = await service.duplicate({
    patentId,
    projectId: created.project.projectId,
    expectedPatentRevision: 3,
    name: "副本",
  });
  expect(duplicate).toMatchObject({ patentRevision: 4, project: { name: "副本", revision: 0 } });
  expect(
    database.read(
      (raw) =>
        (raw.prepare("SELECT count(*) AS count FROM edit_log").get() as { count: number }).count,
    ),
  ).toBe(4);
});

test("imports a validated external drawio file as one aggregate revision", async () => {
  const { database, patentId, service } = await setup();
  using _owned = database;

  const imported = await service.importExternal({
    patentId,
    expectedPatentRevision: 0,
    fileName: "external.drawio",
    bytes: Buffer.from(
      '<mxfile><diagram id="p1"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>',
    ),
  });

  expect(imported).toMatchObject({
    patentRevision: 1,
    project: { name: "external", pageCount: 1, lastPageId: "p1" },
  });
});

test("deleting a linked project preserves the static figure and asset while clearing its link", async () => {
  const { database, patentId, service } = await setup();
  using _owned = database;
  const created = await service.create({
    patentId,
    expectedPatentRevision: 0,
    name: "工程",
    source: Buffer.from('<mxfile><diagram id="p1"/></mxfile>'),
    pageCount: 1,
    lastPageId: "p1",
  });
  const assetId = randomUUID();
  const figureId = randomUUID();
  const assetDescriptor = {
    assetId,
    kind: "image" as const,
    originalName: "flowchart.svg",
    mediaType: "image/png",
    extension: "png",
    byteLength: 1,
    sha256: "A".repeat(64),
    widthPx: 1,
    heightPx: 1,
    previewByteLength: 1,
    previewSha256: "B".repeat(64),
  };
  database.transaction((raw) => {
    raw
      .prepare("INSERT INTO assets VALUES (?, ?, ?, 'image/svg+xml', 1, 1, 1, 'now')")
      .run(assetId, "HASH", `asset-${assetId}`);
    raw.prepare("INSERT INTO patent_assets VALUES (?, ?)").run(patentId, assetId);
    raw.prepare("INSERT OR REPLACE INTO library_state VALUES (?, ?, 'now')").run(
      `patent:${patentId}:figure-state`,
      encodeEnvelope(
        encodeJson({
          assets: [assetDescriptor],
          abstractDrawingFigureId: null,
        }),
      ),
    );
    raw.prepare("INSERT INTO patent_figures VALUES (?, ?, ?, 0, 100, '', ?)").run(
      patentId,
      figureId,
      assetId,
      encodeEnvelope(
        encodeJson({
          projectId: created.project.projectId,
          pageId: "p1",
          exportScope: "page",
          selectedCellIds: [],
          borderMm: 0,
          exportedProjectRevision: 0,
          exportedSourceSha256: created.project.sourceSha256,
          renderProfileVersion: 1,
        }),
      ),
    );
  });

  const deleted = await service.delete({
    patentId,
    projectId: created.project.projectId,
    expectedPatentRevision: 1,
  });
  expect(deleted).toMatchObject({ patentRevision: 2, detachedFigureCount: 1 });
  expect(
    database.read((raw) =>
      raw.prepare("SELECT flowchart_link FROM patent_figures WHERE figure_id = ?").get(figureId),
    ),
  ).toEqual({ flowchart_link: null });
  expect(
    database.read((raw) =>
      raw.prepare("SELECT asset_id FROM assets WHERE asset_id = ?").get(assetId),
    ),
  ).toEqual({ asset_id: assetId });
});

test("rejects patent revision conflicts without switching current source", async () => {
  const { database, patentId, service } = await setup();
  using _owned = database;
  const created = await service.create({
    patentId,
    expectedPatentRevision: 0,
    name: "工程",
    source: Buffer.from('<mxfile><diagram id="p1"/></mxfile>'),
    pageCount: 1,
    lastPageId: "p1",
  });
  await expect(
    service.save({
      patentId,
      projectId: created.project.projectId,
      expectedPatentRevision: 0,
      expectedProjectRevision: 0,
      source: Buffer.from('<mxfile><diagram id="p1">lost</diagram></mxfile>'),
      pageCount: 1,
      lastPageId: "p1",
    }),
  ).rejects.toThrow(/revision|版本/iu);
  expect(service.load(patentId, created.project.projectId).project.revision).toBe(0);
});

test("disposes idempotently and rejects use after disposal", async () => {
  const { database, patentId, service } = await setup();
  using _owned = database;
  service.dispose();
  service.dispose();
  expect(() => service.list(patentId)).toThrow(/disposed|closed/iu);
});
