import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFactoryPatentTemplates,
  createLegacyFactoryPatentTemplatesV1,
  instantiateBookTemplate,
  PATENT_TEMPLATE_TOKENS,
} from "../../shared/patent/templates.js";
import { DEFAULT_APP_SETTINGS } from "../../shared/settings/model.js";
import type { LibraryDatabase } from "./library-database.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { PatentTemplateService } from "./patent-template-service.js";

const roots: string[] = [];
const databases: LibraryDatabase[] = [];

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

async function fixture(options: { beforeCommit?: () => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), "patent-template-service-"));
  roots.push(root);
  const prepared = await new LibraryMigrationService(root).prepare();
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("fixture");
  databases.push(prepared.database);
  let nextUuid = 10_000;
  const service = new PatentTemplateService({
    database: prepared.database,
    now: () => new Date("2026-08-28T12:00:00.000Z"),
    randomUUID: () => testUuid(nextUuid++),
    ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}),
  });
  return { database: prepared.database, service };
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("shares templates by default, persists the mode and restores separate selections without losing slots", async () => {
  const { service, database } = await fixture();
  const opened = service.openEditor({ patentType: "invention" });
  expect(opened.catalog.separatePatentTypes).toBe(false);
  const factory = createFactoryPatentTemplates(() => crypto.randomUUID());
  const first = opened.catalog.invention.slots[0];
  const utility = opened.catalog["utility-model"].slots[0];
  if (!first || !utility) throw new Error("missing slots");
  for (const [slot, group] of [
    [first, factory.invention],
    [utility, factory["utility-model"]],
  ] as const) {
    slot.claims = group.claims;
    slot.description = group.description;
    slot.abstract = group.abstract;
  }
  first.name = "共用内容";
  utility.name = "实用新型专用内容";
  opened.catalog.invention.selection = { kind: "custom", templateId: first.templateId };
  opened.catalog["utility-model"].selection = { kind: "custom", templateId: utility.templateId };
  const saved = await service.saveEditor({ ...opened, expectedRevision: opened.catalog.revision });
  expect(saved.catalog.separatePatentTypes).toBe(false);
  const reloaded = new PatentTemplateService({ database });
  expect(reloaded.readLauncherSummary()["utility-model"].selectedTemplateName).toBe("共用内容");
  const source = reloaded.resolveCreationSource("utility-model");
  expect(source.templateId).toBe(first.templateId);
  const document = instantiateBookTemplate({
    template: source.templates.abstract,
    kind: "abstract",
    patentType: "utility-model",
    patentName: "装置",
    timestamp: "2026-09-09T00:00:00.000Z",
    createId: () => crypto.randomUUID(),
  });
  const text = JSON.stringify(document.content);
  expect(text).toContain("本实用新型");
  expect(text).not.toContain("本发明");
  const separated = reloaded.openEditor({ patentType: "invention" });
  separated.catalog.separatePatentTypes = true;
  await reloaded.saveEditor({ ...separated, expectedRevision: separated.catalog.revision });
  expect(reloaded.resolveCreationSource("utility-model").templateId).toBe(utility.templateId);
  expect(reloaded.readSummary().invention.slots[0]?.name).toBe("共用内容");
  expect(reloaded.readSummary()["utility-model"].slots[0]?.name).toBe("实用新型专用内容");
});

test("preserves older custom catalogs in separate mode when no sharing preference exists", async () => {
  const { database, service } = await fixture();
  database.transaction((raw) =>
    raw
      .prepare(
        "UPDATE patent_template_preferences SET selection_kind = 'blank' WHERE patent_type = 'utility-model'",
      )
      .run(),
  );
  expect(service.readSummary().separatePatentTypes).toBe(true);
  expect(service.resolveCreationSource("utility-model").kind).toBe("blank");
  expect(service.resolveCreationSource("invention").kind).toBe("system");
});

test("persists and selects fourth and fifth templates for both patent types", async () => {
  const { service, database } = await fixture();
  const opened = service.openEditor({ patentType: "invention" });
  opened.catalog.separatePatentTypes = true;
  const factory = createFactoryPatentTemplates(() => crypto.randomUUID());
  for (const type of ["invention", "utility-model"] as const) {
    for (const slot of opened.catalog[type].slots.slice(3)) {
      slot.claims = factory[type].claims;
      slot.description = factory[type].description;
      slot.abstract = factory[type].abstract;
    }
    const fifth = opened.catalog[type].slots[4];
    if (!fifth) throw new Error("missing fifth slot");
    opened.catalog[type].selection = { kind: "custom", templateId: fifth.templateId };
  }
  await service.saveEditor({ ...opened, expectedRevision: opened.catalog.revision });
  const reopened = new PatentTemplateService({ database });
  for (const type of ["invention", "utility-model"] as const) {
    expect(
      reopened
        .readSummary()
        [type].slots.slice(3)
        .every((slot) => slot.claims !== null),
    ).toBe(true);
    expect(reopened.resolveCreationSource(type).templateId).toBe(
      opened.catalog[type].slots[4]?.templateId,
    );
  }
});

test("reads ten stable slots and saves duplicate custom names atomically", async () => {
  const { service } = await fixture();
  const opened = service.openEditor({ patentType: "invention" });
  expect(opened.catalog.invention.slots.map((slot) => slot.slotIndex)).toEqual([1, 2, 3, 4, 5]);
  expect(opened.catalog["utility-model"].slots.map((slot) => slot.slotIndex)).toEqual([
    1, 2, 3, 4, 5,
  ]);

  const system = createLegacyFactoryPatentTemplatesV1(() => testUuid(20));
  const first = opened.catalog.invention.slots[0];
  const second = opened.catalog.invention.slots[1];
  if (!first || !second) throw new Error("missing seeded slots");
  for (const slot of [first, second]) {
    slot.name = "可重复名称";
    slot.claims = structuredClone(system.invention.claims);
    slot.description = structuredClone(system.invention.description);
    slot.abstract = structuredClone(system.invention.abstract);
  }
  opened.catalog.invention.selection = { kind: "custom", templateId: first.templateId };

  const saved = await service.saveEditor({
    sessionId: opened.sessionId,
    expectedRevision: opened.catalog.revision,
    catalog: opened.catalog,
    auxiliary: opened.auxiliary,
  });

  expect(saved.catalog.revision).toBe(1);
  expect(saved.catalog.invention.slots.slice(0, 2).map((slot) => slot.name)).toEqual([
    "可重复名称",
    "可重复名称",
  ]);
  expect(service.resolveCreationSource("invention")).toMatchObject({
    kind: "custom",
    templateId: first.templateId,
  });
});

test("rolls back books, selection, auxiliary text, and asset relationships on save failure", async () => {
  const { database, service } = await fixture({
    beforeCommit: () => {
      throw new Error("injected save failure");
    },
  });
  const opened = service.openEditor({ patentType: "invention" });
  opened.catalog.separatePatentTypes = true;
  const first = opened.catalog.invention.slots[0];
  if (!first) throw new Error("missing seeded slot");
  const system = createLegacyFactoryPatentTemplatesV1(() => testUuid(30));
  first.name = "事务内修改";
  first.claims = system.invention.claims;
  first.description = system.invention.description;
  first.abstract = system.invention.abstract;
  opened.catalog.invention.selection = { kind: "custom", templateId: first.templateId };
  opened.auxiliary.invention.figureExplanation.content = [
    {
      type: "text",
      text: `图${PATENT_TEMPLATE_TOKENS.figureNumber}事务内辅助模板`,
      marks: [],
    },
  ];

  await expect(
    service.saveEditor({
      sessionId: opened.sessionId,
      expectedRevision: opened.catalog.revision,
      catalog: opened.catalog,
      auxiliary: opened.auxiliary,
    }),
  ).rejects.toThrow("injected save failure");
  expect(service.readSummary().separatePatentTypes).toBe(false);

  expect(service.openEditor({ patentType: "invention" }).catalog.invention.slots[0]).toMatchObject({
    name: "自定义模板 1",
    claims: null,
  });
  expect(
    database.read((raw) => raw.prepare("SELECT count(*) AS count FROM template_assets").get()),
  ).toEqual({ count: 0 });
});

test("rejects a missing chemical preview without changing the catalog", async () => {
  const { service } = await fixture();
  const opened = service.openEditor({ patentType: "invention" });
  const first = opened.catalog.invention.slots[0];
  if (!first) throw new Error("missing seeded slot");
  const system = createLegacyFactoryPatentTemplatesV1(() => crypto.randomUUID());
  first.claims = structuredClone(system.invention.claims);
  first.claims.content.push({
    id: testUuid(999),
    type: "chemical-structure",
    ketSource: "(ket) (atom O)",
    previewAssetId: testUuid(998),
    widthMm: 80,
    alignment: "center",
  });
  first.description = structuredClone(system.invention.description);
  first.abstract = structuredClone(system.invention.abstract);
  opened.catalog.invention.selection = { kind: "custom", templateId: first.templateId };

  await expect(
    service.saveEditor({
      sessionId: opened.sessionId,
      expectedRevision: opened.catalog.revision,
      catalog: opened.catalog,
      auxiliary: opened.auxiliary,
    }),
  ).rejects.toThrow("默认模板引用的资源不存在");
  expect(service.readSummary().invention.slots[0]?.claims).toBeNull();
});

test("rejects an auxiliary figure explanation without the figure-number token", async () => {
  const { service } = await fixture();
  const opened = service.openEditor({ patentType: "invention" });
  opened.auxiliary.invention.figureExplanation.content = [
    { type: "text", text: "图示说明", marks: [] },
  ];

  await expect(
    service.saveEditor({
      sessionId: opened.sessionId,
      expectedRevision: opened.catalog.revision,
      catalog: opened.catalog,
      auxiliary: opened.auxiliary,
    }),
  ).rejects.toThrow("附图说明模板缺少动态图号字段");
  expect(service.readSummary().revision).toBe(0);
});

test("rejects a filled custom slot containing a broken dynamic token", async () => {
  const { service } = await fixture();
  const opened = service.openEditor({ patentType: "invention" });
  const first = opened.catalog.invention.slots[0];
  if (!first) throw new Error("missing seeded slot");
  const system = createLegacyFactoryPatentTemplatesV1(() => crypto.randomUUID());
  first.claims = structuredClone(system.invention.claims);
  const claim = first.claims.content[0];
  if (claim?.type !== "paragraph") throw new Error("claim fixture");
  claim.content = [{ type: "text", text: "{{unknownToken}}", marks: [] }];
  first.description = structuredClone(system.invention.description);
  first.abstract = structuredClone(system.invention.abstract);

  await expect(
    service.saveEditor({
      sessionId: opened.sessionId,
      expectedRevision: opened.catalog.revision,
      catalog: opened.catalog,
      auxiliary: opened.auxiliary,
    }),
  ).rejects.toThrow("模板中存在无法识别的动态字段");
  expect(service.readSummary().revision).toBe(0);
});

test("migrates disabled legacy settings to blank while retaining auxiliary templates", async () => {
  const { database, service } = await fixture();
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.patentTemplates.enabled = false;
  settings.patentTemplates.invention.figureExplanation.content = [
    { type: "text", text: `附图${PATENT_TEMPLATE_TOKENS.figureNumber}`, marks: [] },
  ];

  service.initializeFromLegacySettings(settings);

  const opened = service.openEditor({ patentType: "invention" });
  expect(opened.catalog.invention.selection).toEqual({ kind: "blank" });
  expect(opened.auxiliary.invention.figureExplanation.content).toEqual([
    { type: "text", text: `附图${PATENT_TEMPLATE_TOKENS.figureNumber}`, marks: [] },
  ]);
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT value FROM library_state WHERE key = ?")
        .get("patent-template-catalog-migrated-v1"),
    ),
  ).toBeDefined();
});

test("recognizes the frozen historical factory without importing it as a custom template", async () => {
  const { service } = await fixture();
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.patentTemplates = createLegacyFactoryPatentTemplatesV1(() => crypto.randomUUID());

  service.initializeFromLegacySettings(settings);

  const catalog = service.readSummary();
  expect(catalog.invention.selection).toEqual({ kind: "system" });
  expect(catalog.invention.slots[0]?.claims).toBeNull();
  expect(catalog["utility-model"].selection).toEqual({ kind: "system" });
});

test("initializes a first-run catalog without creating custom slots and remains idempotent", async () => {
  const { service } = await fixture();
  service.initializeFromLegacySettings(null);
  service.initializeFromLegacySettings(structuredClone(DEFAULT_APP_SETTINGS));
  for (const patentType of ["invention", "utility-model"] as const) {
    expect(service.readSummary()[patentType].selection).toEqual({ kind: "system" });
    expect(service.readSummary()[patentType].slots.every((slot) => slot.claims === null)).toBe(
      true,
    );
  }
});

test("does not reread legacy settings after catalog migration, and retries failed first reads", async () => {
  const { service } = await fixture();
  const unreadable = vi.fn(async () => {
    throw new Error("unreadable settings");
  });
  await expect(service.initialize(unreadable)).rejects.toThrow("unreadable settings");
  await service.initialize(async () => null);
  await service.initialize(unreadable);
  expect(unreadable).toHaveBeenCalledOnce();
  expect(service.readSummary().invention.selection).toEqual({ kind: "system" });
});

test("upgrades untouched legacy auxiliary defaults to underlined spaces", async () => {
  const { service } = await fixture();
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.patentTemplates = createLegacyFactoryPatentTemplatesV1(() => crypto.randomUUID());

  service.initializeFromLegacySettings(settings);

  const auxiliary = service.readAuxiliary();
  for (const patentType of ["invention", "utility-model"] as const) {
    for (const paragraph of [
      auxiliary[patentType].figureExplanation,
      auxiliary[patentType].drawingLegend,
    ]) {
      expect(paragraph.content).toContainEqual({
        type: "text",
        text: " ".repeat(6),
        marks: [{ type: "underline" }],
      });
      expect(JSON.stringify(paragraph)).not.toContain("_");
    }
  }
});

test("imports legacy user content that happens to equal the current factory", async () => {
  const { service } = await fixture();
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.patentTemplates = createFactoryPatentTemplates(() => crypto.randomUUID());

  service.initializeFromLegacySettings(settings);

  const catalog = service.readSummary();
  expect(catalog.invention.selection.kind).toBe("custom");
  expect(catalog.invention.slots[0]).toMatchObject({
    name: "原默认模板",
    unavailableReason: null,
  });
  expect(catalog.invention.slots[0]?.claims).not.toBeNull();
});

test("isolates one corrupted slot without blocking healthy templates", async () => {
  const { database, service } = await fixture();
  const opened = service.openEditor({ patentType: "invention" });
  const first = opened.catalog.invention.slots[0];
  if (!first) throw new Error("missing seeded slot");
  const system = createLegacyFactoryPatentTemplatesV1(() => crypto.randomUUID());
  first.claims = structuredClone(system.invention.claims);
  first.description = structuredClone(system.invention.description);
  first.abstract = structuredClone(system.invention.abstract);
  opened.catalog.invention.selection = { kind: "custom", templateId: first.templateId };
  await service.saveEditor({
    sessionId: opened.sessionId,
    expectedRevision: opened.catalog.revision,
    catalog: opened.catalog,
    auxiliary: opened.auxiliary,
  });

  database.transaction((raw) =>
    raw
      .prepare(
        `UPDATE patent_template_slots
         SET claims_json = ?, description_json = ?, abstract_json = ?
         WHERE patent_type = 'utility-model' AND slot_index = 3`,
      )
      .run(Buffer.from("not-json"), Buffer.from("not-json"), Buffer.from("not-json")),
  );

  const catalog = service.readSummary();
  expect(catalog["utility-model"].slots[2]).toMatchObject({
    claims: null,
    description: null,
    abstract: null,
    unavailableReason: "模板内容损坏，请清空后重新填入。",
  });
  expect(service.resolveCreationSource("invention")).toMatchObject({
    kind: "custom",
    templateId: first.templateId,
  });
});

test("falls back to the system source when the selected custom slot is corrupted", async () => {
  const { database, service } = await fixture();
  const opened = service.openEditor({ patentType: "invention" });
  const first = opened.catalog.invention.slots[0];
  if (!first) throw new Error("missing seeded slot");
  const system = createLegacyFactoryPatentTemplatesV1(() => crypto.randomUUID());
  first.claims = structuredClone(system.invention.claims);
  first.description = structuredClone(system.invention.description);
  first.abstract = structuredClone(system.invention.abstract);
  opened.catalog.invention.selection = { kind: "custom", templateId: first.templateId };
  await service.saveEditor({
    sessionId: opened.sessionId,
    expectedRevision: opened.catalog.revision,
    catalog: opened.catalog,
    auxiliary: opened.auxiliary,
  });
  database.transaction((raw) =>
    raw
      .prepare("UPDATE patent_template_slots SET description_json = ? WHERE template_id = ?")
      .run(Buffer.from("not-json"), first.templateId),
  );

  expect(service.readSummary().invention.selection).toEqual({ kind: "system" });
  expect(service.resolveCreationSource("invention")).toMatchObject({
    kind: "system",
    templateId: null,
  });
});

test("reads a lightweight launcher summary and isolates an invalid selected template", async () => {
  const { database, service } = await fixture();
  const opened = service.openEditor({ patentType: "invention" });
  opened.catalog.separatePatentTypes = true;
  const first = opened.catalog.invention.slots[0];
  if (!first) throw new Error("missing seeded slot");
  const system = createLegacyFactoryPatentTemplatesV1(() => crypto.randomUUID());
  first.name = "我的常用模板";
  first.claims = structuredClone(system.invention.claims);
  first.description = structuredClone(system.invention.description);
  first.abstract = structuredClone(system.invention.abstract);
  opened.catalog.invention.selection = { kind: "custom", templateId: first.templateId };
  await service.saveEditor({
    sessionId: opened.sessionId,
    expectedRevision: opened.catalog.revision,
    catalog: opened.catalog,
    auxiliary: opened.auxiliary,
  });

  expect(service.readLauncherSummary()).toEqual({
    separatePatentTypes: true,
    invention: {
      selection: { kind: "custom", templateId: first.templateId },
      selectedTemplateName: "我的常用模板",
    },
    "utility-model": {
      selection: { kind: "system" },
      selectedTemplateName: null,
    },
  });

  database.transaction((raw) =>
    raw
      .prepare("UPDATE patent_template_slots SET abstract_json = ? WHERE template_id = ?")
      .run(Buffer.from("not-json"), first.templateId),
  );
  expect(service.readLauncherSummary().invention).toEqual({
    selection: { kind: "system" },
    selectedTemplateName: null,
  });
});

test("leaves no migration marker or partial slot when migration fails and can retry", async () => {
  const { database } = await fixture();
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.patentTemplates = createLegacyFactoryPatentTemplatesV1(() => crypto.randomUUID());
  const claim = settings.patentTemplates.invention.claims.content[0];
  if (claim?.type !== "paragraph") throw new Error("legacy claim fixture");
  claim.content = [{ type: "text", text: "需要迁移", marks: [] }];
  const failing = new PatentTemplateService({
    database,
    beforeCommit: () => {
      throw new Error("migration failure");
    },
  });

  expect(() => failing.initializeFromLegacySettings(settings)).toThrow("migration failure");
  expect(failing.readSummary().invention.slots[0]?.claims).toBeNull();
  expect(
    database.read((raw) =>
      raw
        .prepare("SELECT value FROM library_state WHERE key = ?")
        .get("patent-template-catalog-migrated-v1"),
    ),
  ).toBeUndefined();

  const retry = new PatentTemplateService({ database });
  expect(() => retry.initializeFromLegacySettings(settings)).not.toThrow();
  expect(retry.readSummary().invention.slots[0]?.claims).not.toBeNull();
});

test("imports a modified legacy group once and never overwrites it after the marker exists", async () => {
  const { service } = await fixture();
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.patentTemplates = createLegacyFactoryPatentTemplatesV1(() => crypto.randomUUID());
  const firstClaim = settings.patentTemplates.invention.claims.content[0];
  if (firstClaim?.type !== "paragraph") throw new Error("legacy claim fixture");
  firstClaim.content = [
    { type: "text", text: "用户旧模板", marks: [{ type: "color", value: "#D93025" }] },
  ];

  service.initializeFromLegacySettings(settings);
  const first = service.readSummary().invention;
  expect(first.selection.kind).toBe("custom");
  expect(first.slots[0]).toMatchObject({ name: "原默认模板" });

  const secondSettings = structuredClone(settings);
  const secondClaim = secondSettings.patentTemplates.invention.claims.content[0];
  if (secondClaim?.type !== "paragraph") throw new Error("legacy claim fixture");
  secondClaim.content = [{ type: "text", text: "不应重复导入", marks: [] }];
  service.initializeFromLegacySettings(secondSettings);

  const second = service.readSummary().invention.slots[0];
  expect(second?.claims?.content[0]).toEqual(first.slots[0]?.claims?.content[0]);
});

test("keeps the editor session available for retry after an optimistic revision conflict", async () => {
  const { service } = await fixture();
  const first = service.openEditor({ patentType: "invention" });
  const second = service.openEditor({ patentType: "utility-model" });
  await service.saveEditor({
    sessionId: first.sessionId,
    expectedRevision: first.catalog.revision,
    catalog: first.catalog,
    auxiliary: first.auxiliary,
  });

  await expect(
    service.saveEditor({
      sessionId: second.sessionId,
      expectedRevision: second.catalog.revision,
      catalog: second.catalog,
      auxiliary: second.auxiliary,
    }),
  ).rejects.toThrow();
  expect(() => service.closeEditor({ sessionId: second.sessionId })).not.toThrow();
});
