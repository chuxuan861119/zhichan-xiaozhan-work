import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParagraphNode, PatentBookDocument } from "../../shared/document/model.js";
import type { PatentBookKind } from "../../shared/patent/model.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import type { LibraryDatabase } from "./library-database.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { type OpenedPatent, PatentService } from "./patent-service.js";

const roots: string[] = [];
const databases: LibraryDatabase[] = [];

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patent-edit-journal-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openService() {
  const root = await createRoot();
  const prepared = await new LibraryMigrationService(root).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("fixture");
  databases.push(prepared.database);
  let uuid = 1;
  const service = new PatentService({
    database: prepared.database,
    now: () => new Date("2026-08-01T09:00:00.000Z"),
    randomUUID: () => testUuid(uuid++),
  });
  return { database: prepared.database, service };
}

function bookDocument(opened: OpenedPatent, kind: PatentBookKind): PatentBookDocument {
  const book = opened.patent.books.find((candidate) => candidate.kind === kind);
  if (!book) throw new Error("fixture");
  return book.document;
}

function withParagraphText(document: PatentBookDocument, text: string): PatentBookDocument {
  const next = structuredClone(document);
  const paragraph = next.content.find(
    (block): block is ParagraphNode => block.type === "paragraph",
  );
  if (paragraph === undefined) {
    next.content.push({
      id: testUuid(900),
      type: "paragraph",
      attrs: {
        alignment: "left",
        paragraphIndentMm: 0,
        lineSpacing: 1.5,
        defaultFontFamily: "SimSun",
        defaultFontSizePt: 12,
      },
      content: [],
    });
  }
  const target = next.content.find((block): block is ParagraphNode => block.type === "paragraph");
  if (target === undefined) throw new Error("fixture");
  target.content = [{ type: "text", text, marks: [] }];
  return next;
}

async function applyBookEdit(
  service: PatentService,
  opened: OpenedPatent,
  kind: PatentBookKind,
  text: string,
): Promise<OpenedPatent> {
  const current = await service.open(opened.patentId);
  await service.applyBookEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    bookKind: kind,
    expectedRevision: current.revision,
    document: withParagraphText(bookDocument(current, kind), text),
    editorState: { selection: { anchor: 1 } },
  });
  return service.open(opened.patentId);
}

test("persists one patent book edit log only after the aggregate revision advances", async () => {
  const { database, service } = await openService();
  const created = await service.create({
    patentType: "invention",
    name: "编辑日志专利",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  const opened = await applyBookEdit(service, created, "claims", "1. 一种夹具。");

  expect(opened.revision).toBe(1);
  expect(bookDocument(opened, "claims").content).toEqual(
    bookDocument(await service.open(created.patentId), "claims").content,
  );
  expect(
    database.read((raw) =>
      raw
        .prepare(
          "SELECT patent_id, base_revision, target_revision, model_version FROM edit_log ORDER BY target_revision",
        )
        .all(),
    ),
  ).toEqual([
    {
      patent_id: created.patentId,
      base_revision: 0,
      target_revision: 1,
      model_version: 2,
    },
  ]);
});

test("records settings and book edits as one aggregate revision chain", async () => {
  const { database, service } = await openService();
  const created = await service.create({
    patentType: "invention",
    name: null,
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  await service.updateSettings({
    patentId: created.patentId,
    expectedRevision: 0,
    name: "链式专利",
    patentType: "utility-model",
  });
  await applyBookEdit(service, created, "description", "本实用新型涉及夹具。");

  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT base_revision, target_revision FROM edit_log ORDER BY target_revision")
        .all(),
    ),
  ).toEqual([
    { base_revision: 0, target_revision: 1 },
    { base_revision: 1, target_revision: 2 },
  ]);
});

test("rejects a revision conflict without adding an edit log row", async () => {
  const { database, service } = await openService();
  const created = await service.create({
    patentType: "utility-model",
    name: "修订冲突",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });

  await expect(
    service.applyBookEdit({
      patentId: created.patentId,
      sessionId: created.sessionId,
      bookKind: "claims",
      expectedRevision: 4,
      document: withParagraphText(bookDocument(created, "claims"), "1. 一种夹具。"),
      editorState: {},
    }),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

  expect((await service.open(created.patentId)).revision).toBe(0);
  expect(
    database.read((raw) => raw.prepare("SELECT count(*) AS count FROM edit_log").get()),
  ).toEqual({ count: 0 });
});
