import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import { FileService } from "../documents/file-service.js";
import { encodePatentRecoverySnapshot, hashJson } from "./edit-journal.js";
import { createLibraryRuntime } from "./library-runtime.js";
import { installPatdocHistory } from "./patdoc-history-install.js";
import { LibraryRecoveryService } from "./recovery-service.js";
import { importPatentPatdocPayload } from "./register-library-ipc.js";

const xml = (value: string) => Buffer.from(`<mxfile><diagram id="p1">${value}</diagram></mxfile>`);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pwb-flowchart-snapshot-"));
  const runtime = await createLibraryRuntime({
    libraryRoot: root,
    readOnly: false,
    runRecovery: true,
    startBackgroundSchedulers: false,
  });
  const opened = await runtime.patents.create({
    name: "流程图与文档快照分离",
    patentType: "invention",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const created = await runtime.flowcharts.create({
    patentId: opened.patentId,
    expectedPatentRevision: opened.revision,
    name: "流程图",
    source: xml("first"),
    pageCount: 1,
    lastPageId: "p1",
  });
  const publish = async () => {
    const current = runtime.flowcharts.load(opened.patentId, created.project.projectId);
    const preview = await runtime.flowcharts.renderPreview({
      patentId: opened.patentId,
      projectId: current.project.projectId,
      expectedProjectRevision: current.project.revision,
      expectedSourceSha256: current.project.sourceSha256,
      pageId: "p1",
      exportScope: "page",
      selectedCellIds: [],
      borderMm: 2,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect x="5" y="5" width="90" height="40" fill="white" stroke="black"/></svg>',
      target: { kind: "new", insertIndex: 0 },
    });
    return runtime.flowcharts.commitPreview({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      expectedPatentRevision: current.patentRevision,
      projectId: current.project.projectId,
      previewToken: preview.previewToken,
    });
  };
  return {
    root,
    runtime,
    opened,
    created,
    publish,
    async close() {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("flowchart-only creation, edit, rename and deletion do not create document snapshots", async () => {
  const f = await fixture();
  try {
    const { runtime: r, opened: p, created: c } = f;
    expect((await r.snapshots.create(p.patentId, "automatic")).outcome).toBe("already-exists");
    const changed = await r.flowcharts.save({
      patentId: p.patentId,
      projectId: c.project.projectId,
      expectedPatentRevision: c.patentRevision,
      expectedProjectRevision: c.project.revision,
      source: xml("second"),
      pageCount: 1,
      lastPageId: "p1",
    });
    const renamed = await r.flowcharts.rename({
      patentId: p.patentId,
      projectId: c.project.projectId,
      expectedPatentRevision: changed.patentRevision,
      expectedProjectRevision: changed.project.revision,
      name: "改名的流程图",
    });
    expect((await r.snapshots.create(p.patentId, "manual-create")).outcome).toBe("already-exists");
    await r.patents.release(p.sessionId);
    const reopened = await r.patents.open(p.patentId);
    expect(reopened.patent.flowchartProjects[0]?.name).toBe("改名的流程图");
    expect(r.flowcharts.load(p.patentId, c.project.projectId).source).toEqual(
      new Uint8Array(xml("second")),
    );
    await r.flowcharts.delete({
      patentId: p.patentId,
      projectId: c.project.projectId,
      expectedPatentRevision: renamed.patentRevision,
    });
    expect((await r.snapshots.create(p.patentId, "patent-close")).outcome).toBe("already-exists");
    expect(await r.snapshots.list(p.patentId)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("published images remain in snapshots without editable flowcharts, while complete PATDOC keeps current sources", async () => {
  const f = await fixture();
  try {
    const { runtime: r, opened: p, created: c } = f;
    const published = await f.publish();
    const version = await r.snapshots.create(p.patentId, "manual-create");
    const snapshot = await r.snapshots.open(p.patentId, version.revision);
    expect(snapshot.patent.flowchartProjects).toHaveLength(0);
    expect(snapshot.patent.figures).toHaveLength(1);
    expect(snapshot.patent.figures[0]?.flowchartLink).toBeUndefined();
    expect(snapshot.patent.assets.map((a) => a.assetId)).toEqual([
      published.patent.figures[0]?.assetId,
    ]);
    expect(await r.snapshots.readFlowchartArchive(p.patentId, version.revision)).toEqual([]);
    expect(
      r.database.read((db) =>
        db
          .prepare("SELECT count(*) AS n FROM snapshot_flowchart_revisions WHERE patent_id = ?")
          .get(p.patentId),
      ),
    ).toEqual({ n: 0 });
    const saved = await r.flowcharts.save({
      patentId: p.patentId,
      projectId: c.project.projectId,
      expectedPatentRevision: published.patent.revision,
      expectedProjectRevision: c.project.revision,
      source: xml("latest"),
      pageCount: 1,
      lastPageId: "p1",
    });
    expect((await r.snapshots.create(p.patentId, "automatic")).outcome).toBe("already-exists");
    const live = r.patents.loadSavedPatent(p.patentId);
    const payload = {
      patent: live,
      assets: await Promise.all(live.assets.map((a) => r.assetStore.readAsset(a.assetId))),
      flowcharts: [{ projectId: c.project.projectId, source: saved.source }],
    };
    const files = new FileService(),
      path = join(f.root, "complete.patdoc");
    expect((await files.savePatent(path, payload)).ok).toBe(true);
    const read = await files.openPatent(path);
    if (!read.ok) throw Error(read.error.message);
    expect(read.value.flowcharts?.[0]?.source).toEqual(new Uint8Array(xml("latest")));
    const imported = await importPatentPatdocPayload(
      r.patents,
      r.assetStore,
      async () => DEFAULT_PATENT_TEMPLATE_SETTINGS,
      read.value,
      r.flowcharts,
    );
    expect(imported.patent.flowchartProjects).toHaveLength(1);
    expect((await r.snapshots.open(imported.patentId, 0)).patent.flowchartProjects).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("document restore and startup recovery preserve current independently saved flowchart sources and matching links", async () => {
  const f = await fixture();
  try {
    const { runtime: r, opened: p, created: c } = f;
    await f.publish();
    const version = await r.snapshots.create(p.patentId, "manual-create");
    const snapshot = await r.snapshots.open(p.patentId, version.revision);
    const current = r.flowcharts.load(p.patentId, c.project.projectId);
    const changed = await r.flowcharts.save({
      patentId: p.patentId,
      projectId: c.project.projectId,
      expectedPatentRevision: current.patentRevision,
      expectedProjectRevision: current.project.revision,
      source: xml("latest"),
      pageCount: 1,
      lastPageId: "p1",
    });
    const restored = await r.patents.applyAutomationChange({
      patentId: p.patentId,
      expectedRevision: changed.patentRevision,
      patent: snapshot.patent,
      restoreSnapshot: true,
    });
    expect(restored.flowchartProjects[0]?.revision).toBe(changed.project.revision);
    expect(restored.figures[0]?.flowchartLink).toBeDefined();
    expect(r.flowcharts.load(p.patentId, c.project.projectId).source).toEqual(
      new Uint8Array(xml("latest")),
    );
    const latest = r.flowchartSourceStore.appendRevision({
      patentId: p.patentId,
      projectId: c.project.projectId,
      expectedProjectRevision: changed.project.revision,
      source: xml("durable"),
      metadata: { name: "当前持久化工程", pageCount: 1, lastPageId: "p1" },
    });
    const recovered = await new LibraryRecoveryService({ database: r.database }).recoverPatent(
      p.patentId,
    );
    expect(recovered.patent.flowchartProjects[0]?.sourceSha256).toBe(latest.sourceSha256);
    expect(r.flowcharts.load(p.patentId, c.project.projectId).source).toEqual(
      new Uint8Array(xml("durable")),
    );
  } finally {
    await f.close();
  }
});

test("a document-only anchor replays a linked image resize without losing its live flowchart", async () => {
  const f = await fixture();
  try {
    const { runtime: r, opened: p } = f;
    const published = await f.publish();
    const snapshot = await r.snapshots.create(p.patentId, "manual-create");
    const resized = await r.patents.applyFigureEdit({
      patentId: p.patentId,
      sessionId: p.sessionId,
      expectedRevision: published.patent.revision,
      figures: published.patent.figures.map((figure) => ({
        ...figure,
        widthMm: 75,
        rotationDeg: 90 as const,
      })),
      abstractDrawingFigureId: null,
      assets: published.patent.assets,
    });
    // Keep only the actual new document anchor, so fallback cannot hide an invalid replay.
    r.database.transaction((db) =>
      db
        .prepare("DELETE FROM snapshots WHERE patent_id = ? AND revision < ?")
        .run(p.patentId, snapshot.revision),
    );
    const recovered = await new LibraryRecoveryService({ database: r.database }).recoverPatent(
      p.patentId,
    );
    expect(recovered.patent.revision).toBe(resized.revision);
    expect(recovered.patent.figures[0]).toMatchObject({
      widthMm: 75,
      rotationDeg: 90,
      flowchartLink: published.patent.figures[0]?.flowchartLink,
    });
    expect(recovered.patent.flowchartProjects).toEqual(published.patent.flowchartProjects);
  } finally {
    await f.close();
  }
});

test("restoring an old published image never borrows the link from its newer replacement", async () => {
  const f = await fixture();
  try {
    const { runtime: r, opened: p, created: c } = f;
    const published = await f.publish();
    const original = published.patent.figures[0];
    if (!original) throw Error("Missing published fixture");
    const version = await r.snapshots.create(p.patentId, "manual-create");
    const snapshot = await r.snapshots.open(p.patentId, version.revision);
    const preview = await r.flowcharts.renderPreview({
      patentId: p.patentId,
      projectId: c.project.projectId,
      expectedProjectRevision: c.project.revision,
      expectedSourceSha256: c.project.sourceSha256,
      pageId: "p1",
      exportScope: "page",
      selectedCellIds: [],
      borderMm: 2,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><circle cx="50" cy="25" r="20" fill="white" stroke="black"/></svg>',
      target: { kind: "replace", figureId: original.figureId, assetId: original.assetId },
    });
    const replaced = await r.flowcharts.commitPreview({
      patentId: p.patentId,
      sessionId: p.sessionId,
      expectedPatentRevision: published.patent.revision,
      projectId: c.project.projectId,
      previewToken: preview.previewToken,
    });
    expect(replaced.patent.figures[0]?.assetId).not.toBe(original.assetId);
    const restored = await r.patents.applyAutomationChange({
      patentId: p.patentId,
      expectedRevision: replaced.patent.revision,
      patent: snapshot.patent,
      restoreSnapshot: true,
    });
    expect(restored.figures[0]?.assetId).toBe(original.assetId);
    expect(restored.figures[0]?.flowchartLink).toBeUndefined();
    expect(restored.flowchartProjects).toHaveLength(1);
    expect(r.flowcharts.load(p.patentId, c.project.projectId).source).toEqual(c.source);
  } finally {
    await f.close();
  }
});

test.each([1, 2])(
  "legacy scope %s retains raw source indexes, but importing history never rolls back live flowcharts",
  async (scopeVersion) => {
    const f = await fixture();
    try {
      const { runtime: r, opened: p, created: c } = f;
      await f.publish();
      const live = r.patents.loadSavedPatent(p.patentId);
      const version = await r.snapshots.create(p.patentId, "manual-create");
      const value = JSON.parse(encodePatentRecoverySnapshot(live).payload.toString());
      value.formatVersion = scopeVersion;
      const legacy = { payload: Buffer.from(JSON.stringify(value)), contentHash: hashJson(value) };
      r.database.transaction((db) =>
        db
          .prepare(
            "UPDATE snapshots SET payload = ?, content_hash = ? WHERE patent_id = ? AND revision = ?",
          )
          .run(legacy.payload, legacy.contentHash, p.patentId, version.revision),
      );
      await r.snapshots.reconcileAssetReferences();
      expect(
        (await r.snapshots.open(p.patentId, version.revision)).patent.flowchartProjects,
      ).toHaveLength(0);
      expect(
        r.database.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM snapshot_flowchart_revisions WHERE patent_id = ? AND snapshot_revision = ?",
            )
            .get(p.patentId, version.revision),
        ),
      ).toEqual({ n: 1 });
      const row = r.database.read((db) =>
        db
          .prepare("SELECT payload FROM snapshots WHERE patent_id = ? AND revision = ?")
          .get(p.patentId, version.revision),
      ) as { payload: Uint8Array };
      expect(Buffer.from(row.payload)).toEqual(legacy.payload);
      const changed = await r.flowcharts.save({
        patentId: p.patentId,
        projectId: c.project.projectId,
        expectedPatentRevision: live.revision,
        expectedProjectRevision: c.project.revision,
        source: xml("current"),
        pageCount: 1,
        lastPageId: "p1",
      });
      const current = r.patents.loadSavedPatent(p.patentId);
      r.database.transaction((db) =>
        installPatdocHistory(r.database, db, current, [
          {
            patent: live,
            source: "historical",
            createdAt: live.modifiedAt,
            assets: [],
            flowcharts: [{ projectId: c.project.projectId, source: c.source }],
          },
        ]),
      );
      expect(r.flowcharts.load(p.patentId, c.project.projectId).project.revision).toBe(
        changed.project.revision,
      );
      expect(r.flowcharts.load(p.patentId, c.project.projectId).source).toEqual(
        new Uint8Array(xml("current")),
      );
      expect(
        r.database.read((db) =>
          db
            .prepare("SELECT count(*) AS n FROM snapshot_flowchart_revisions WHERE patent_id = ?")
            .get(p.patentId),
        ),
      ).toEqual({ n: 0 });
    } finally {
      await f.close();
    }
  },
);
