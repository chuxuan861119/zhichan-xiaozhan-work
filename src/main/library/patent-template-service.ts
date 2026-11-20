import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { remapAssetIds } from "../../shared/document/asset-references.js";
import { DEFAULT_PAGE_SETTINGS } from "../../shared/document/defaults.js";
import { type ParagraphNode, ParagraphNodeSchema } from "../../shared/document/model.js";
import type {
  CanonicalPatent,
  PatentType as LibraryPatentType,
} from "../../shared/patent/model.js";
import {
  captureThreeBookTemplate,
  makeTemplateTypeDynamic,
} from "../../shared/patent/template-capture.js";
import {
  isFilledPatentTemplateSlot,
  type PatentTemplateAuxiliaryCatalog,
  PatentTemplateAuxiliaryCatalogSchema,
  type PatentTemplateCaptureCurrentRequest,
  type PatentTemplateCatalog,
  PatentTemplateCatalogSchema,
  type PatentTemplateEditorCloseRequest,
  type PatentTemplateEditorOpenRequest,
  type PatentTemplateEditorSaveRequest,
  PatentTemplateEditorSaveRequestSchema,
  type PatentTemplateEditorSnapshot,
  type PatentTemplateLauncherSummary,
  PatentTemplateLauncherSummarySchema,
  type PatentTemplateSlot,
} from "../../shared/patent/template-catalog.js";
import {
  blockingTemplateIssues,
  createFactoryPatentTemplates,
  createLegacyFactoryPatentTemplatesV1,
  type PatentBookTemplate,
  PatentBookTemplateSchema,
  type PatentTemplateSettings,
} from "../../shared/patent/templates.js";
import type { AppSettings } from "../../shared/settings/model.js";
import type { AssetStore } from "./asset-store.js";
import { LibraryServiceError } from "./edit-journal.js";
import type { LibraryDatabase } from "./library-database.js";
import { decodeJson, encodeJson } from "./plaintext-codec.js";

const CATALOG_REVISION_KEY = "patent-template-catalog-revision";
const SEPARATE_TYPES_KEY = "patent-template-separate-types";
export const LEGACY_MIGRATION_KEY = "patent-template-catalog-migrated-v1";
export const UNDERLINED_SPACE_MIGRATION_KEY = "patent-template-auxiliary-underlined-spaces-v2";
const TEMPLATE_VALIDATION_ID = "00000000-0000-4000-8000-000000000000";
const PATENT_TYPES = ["invention", "utility-model"] as const;
type PatentType = Exclude<LibraryPatentType, "design">;

type TemplateSlotRow = {
  template_id: string;
  patent_type: PatentType;
  slot_index: 1 | 2 | 3 | 4 | 5;
  name: string;
  claims_json: Uint8Array | null;
  description_json: Uint8Array | null;
  abstract_json: Uint8Array | null;
  template_revision: number;
  created_at: string;
  updated_at: string;
};

type PreferenceRow = {
  patent_type: PatentType;
  selection_kind: "blank" | "system" | "custom";
  selected_template_id: string | null;
};

type AuxiliaryRow = {
  patent_type: PatentType;
  figure_explanation_json: Uint8Array;
  drawing_legend_json: Uint8Array;
  updated_at: string;
};

export type ResolvedPatentTemplateSource = {
  kind: "blank" | "system" | "custom";
  templateId: string | null;
  templates: PatentTemplateSettings["invention"];
  assetIds: string[];
};

export type PatentTemplateServiceOptions = {
  database: LibraryDatabase;
  assetStore?: AssetStore;
  loadPatent?: (patentId: string) => CanonicalPatent;
  now?: () => Date;
  randomUUID?: () => string;
  beforeCommit?: () => void;
};

export class PatentTemplateService {
  readonly #database: LibraryDatabase;
  readonly #assetStore: AssetStore | undefined;
  readonly #loadPatent: PatentTemplateServiceOptions["loadPatent"];
  readonly #now: () => Date;
  readonly #randomUUID: () => string;
  readonly #beforeCommit: (() => void) | undefined;
  readonly #sessions = new Map<string, PatentType>();

  constructor(options: PatentTemplateServiceOptions) {
    this.#database = options.database;
    this.#assetStore = options.assetStore;
    this.#loadPatent = options.loadPatent;
    this.#now = options.now ?? (() => new Date());
    this.#randomUUID = options.randomUUID ?? (() => randomUUID());
    this.#beforeCommit = options.beforeCommit;
  }

  async initialize(readLegacySettings: () => Promise<AppSettings | null>): Promise<void> {
    const settings =
      this.#stateValue(LEGACY_MIGRATION_KEY) === null ? await readLegacySettings() : null;
    this.initializeFromLegacySettings(settings);
  }

  initializeFromLegacySettings(settings: AppSettings | null): void {
    if (this.#stateValue(LEGACY_MIGRATION_KEY) === null) {
      const legacyFactory = createLegacyFactoryPatentTemplatesV1(this.#randomUUID);
      const now = this.#now().toISOString();

      this.#database.transaction((database) => {
        if (this.#stateValueFrom(database, LEGACY_MIGRATION_KEY) !== null) return;
        for (const patentType of PATENT_TYPES) {
          // A fresh profile has no legacy settings. Keep schema-seeded system templates.
          if (settings === null) continue;
          const legacyGroup = settings.patentTemplates[patentType];
          database
            .prepare(
              `UPDATE patent_template_auxiliary
               SET figure_explanation_json = ?, drawing_legend_json = ?, updated_at = ?
               WHERE patent_type = ?`,
            )
            .run(
              Buffer.from(encodeJson(legacyGroup.figureExplanation)),
              Buffer.from(encodeJson(legacyGroup.drawingLegend)),
              now,
              patentType,
            );

          if (!settings.patentTemplates.enabled) {
            this.#writePreference(database, patentType, "blank", null, now);
            continue;
          }
          if (sameThreeBooks(legacyGroup, legacyFactory[patentType])) {
            this.#writePreference(database, patentType, "system", null, now);
            continue;
          }

          const slot = database
            .prepare(
              "SELECT template_id FROM patent_template_slots WHERE patent_type = ? AND slot_index = 1",
            )
            .get(patentType) as { template_id: string } | undefined;
          if (!slot) throw new LibraryServiceError("CORRUPT_FILE", "默认模板槽位缺失。");
          this.#assertAssetsExist(database, previewAssetIds(legacyGroup));
          database
            .prepare(
              `UPDATE patent_template_slots
               SET name = '原默认模板', claims_json = ?, description_json = ?, abstract_json = ?,
                   template_revision = template_revision + 1, updated_at = ?
               WHERE template_id = ?`,
            )
            .run(
              encodeTemplate(legacyGroup.claims),
              encodeTemplate(legacyGroup.description),
              encodeTemplate(legacyGroup.abstract),
              now,
              slot.template_id,
            );
          this.#replaceTemplateAssets(database, slot.template_id, previewAssetIds(legacyGroup));
          this.#writePreference(database, patentType, "custom", slot.template_id, now);
        }
        this.#beforeCommit?.();
        this.#writeState(database, LEGACY_MIGRATION_KEY, "1", now);
      });
    }

    this.#upgradeUntouchedAuxiliaryDefaults();
  }

  #upgradeUntouchedAuxiliaryDefaults(): void {
    if (this.#stateValue(UNDERLINED_SPACE_MIGRATION_KEY) !== null) return;
    const legacyFactory = createLegacyFactoryPatentTemplatesV1(this.#randomUUID);
    const currentFactory = createFactoryPatentTemplates(this.#randomUUID);
    const now = this.#now().toISOString();

    this.#database.transaction((database) => {
      if (this.#stateValueFrom(database, UNDERLINED_SPACE_MIGRATION_KEY) !== null) return;
      const select = database.prepare(
        `SELECT figure_explanation_json, drawing_legend_json
         FROM patent_template_auxiliary WHERE patent_type = ?`,
      );
      const update = database.prepare(
        `UPDATE patent_template_auxiliary
         SET figure_explanation_json = ?, drawing_legend_json = ?, updated_at = ?
         WHERE patent_type = ?`,
      );
      for (const patentType of PATENT_TYPES) {
        const row = select.get(patentType) as
          | Pick<AuxiliaryRow, "figure_explanation_json" | "drawing_legend_json">
          | undefined;
        if (!row) throw new LibraryServiceError("CORRUPT_FILE", "附图辅助模板缺失。");
        const figureExplanation = ParagraphNodeSchema.parse(
          decodeJson(row.figure_explanation_json),
        );
        const drawingLegend = ParagraphNodeSchema.parse(decodeJson(row.drawing_legend_json));
        const nextFigureExplanation = upgradeLegacyAuxiliaryContent(
          figureExplanation,
          legacyFactory[patentType].figureExplanation,
          currentFactory[patentType].figureExplanation,
        );
        const nextDrawingLegend = upgradeLegacyAuxiliaryContent(
          drawingLegend,
          legacyFactory[patentType].drawingLegend,
          currentFactory[patentType].drawingLegend,
        );
        update.run(
          Buffer.from(encodeJson(nextFigureExplanation)),
          Buffer.from(encodeJson(nextDrawingLegend)),
          now,
          patentType,
        );
      }
      this.#beforeCommit?.();
      this.#writeState(database, UNDERLINED_SPACE_MIGRATION_KEY, "1", now);
    });
  }

  readSummary(): PatentTemplateCatalog {
    return this.#readCatalog();
  }

  readLauncherSummary(): PatentTemplateLauncherSummary {
    const { preferences, selectedRows } = this.#database.read((database) => {
      const preferences = database
        .prepare(
          "SELECT patent_type, selection_kind, selected_template_id FROM patent_template_preferences",
        )
        .all() as PreferenceRow[];
      const selectedStatement = database.prepare(
        `SELECT template_id, patent_type, slot_index, name, claims_json, description_json,
                abstract_json, template_revision, created_at, updated_at
         FROM patent_template_slots WHERE template_id = ? AND patent_type = ?`,
      );
      const selectedRows = preferences.flatMap((preference) => {
        if (preference.selection_kind !== "custom" || !preference.selected_template_id) return [];
        const row = selectedStatement.get(
          preference.selected_template_id,
          preference.patent_type,
        ) as TemplateSlotRow | undefined;
        return row ? [row] : [];
      });
      return { preferences, selectedRows };
    });
    const summary = Object.fromEntries(
      PATENT_TYPES.map((patentType) => {
        const preference = preferences.find((candidate) => candidate.patent_type === patentType);
        if (!preference) throw new LibraryServiceError("CORRUPT_FILE", "默认模板偏好缺失。");
        if (preference.selection_kind !== "custom") {
          return [
            patentType,
            { selection: { kind: preference.selection_kind }, selectedTemplateName: null },
          ];
        }
        const selectedRow = selectedRows.find(
          (row) =>
            row.patent_type === patentType && row.template_id === preference.selected_template_id,
        );
        const selected = selectedRow ? decodeTemplateSlot(selectedRow) : null;
        if (!selected || !isFilledPatentTemplateSlot(selected)) {
          return [patentType, { selection: { kind: "system" }, selectedTemplateName: null }];
        }
        return [
          patentType,
          {
            selection: { kind: "custom", templateId: selected.templateId },
            selectedTemplateName: selected.name,
          },
        ];
      }),
    );
    const separatePatentTypes = this.#separateTypes();
    return PatentTemplateLauncherSummarySchema.parse({
      ...summary,
      separatePatentTypes,
      ...(!separatePatentTypes ? { "utility-model": summary.invention } : {}),
    });
  }

  openEditor(input: PatentTemplateEditorOpenRequest): PatentTemplateEditorSnapshot {
    const sessionId = this.#randomUUID();
    this.#sessions.set(sessionId, input.patentType);
    return {
      sessionId,
      catalog: this.#readCatalog(),
      auxiliary: this.#readAuxiliary(),
    };
  }

  capturePatent(input: PatentTemplateCaptureCurrentRequest) {
    this.#requireSession(input.sessionId);
    const slot = this.#readCatalog()[input.targetPatentType].slots.find(
      (candidate) => candidate.templateId === input.targetTemplateId,
    );
    if (!slot) throw new LibraryServiceError("NOT_FOUND", "默认模板槽位不存在。");
    if (!this.#loadPatent) throw new LibraryServiceError("INVALID_INPUT", "当前无法读取专利内容。");
    const patent = this.#loadPatent(input.patentId);
    if (patent.revision !== input.expectedPatentRevision) {
      throw new LibraryServiceError("REVISION_CONFLICT", "专利内容已更新，请保存后重试。");
    }
    const captured = captureThreeBookTemplate({ patent, targetPatentType: input.targetPatentType });
    return {
      templateId: input.targetTemplateId,
      patentType: input.targetPatentType,
      claims: captured.books.claims,
      description: captured.books.description,
      abstract: captured.books.abstract,
      omittedOrdinaryImageCount: captured.omittedOrdinaryImageCount,
      referencedChemicalPreviewAssetIds: captured.referencedChemicalPreviewAssetIds,
    };
  }

  async saveEditor(
    input: PatentTemplateEditorSaveRequest,
    inTransaction?: (database: DatabaseSync, revision: number) => void,
  ): Promise<PatentTemplateEditorSnapshot> {
    this.#requireSession(input.sessionId);
    const parsed = PatentTemplateEditorSaveRequestSchema.parse(input);
    this.#assertSemanticallyUsable(parsed);
    const now = this.#now().toISOString();
    const stagedIds: string[] = [];
    try {
      if (this.#assetStore) {
        for (const patentType of PATENT_TYPES) {
          for (const slot of parsed.catalog[patentType].slots) {
            if (!isFilledPatentTemplateSlot(slot)) continue;
            const replacements = new Map<string, string>();
            for (const assetId of new Set(previewAssetIds(slot))) {
              const owners = this.#assetStore.references({ kind: "patent-template" }, [assetId]);
              if (
                owners.length === 1 &&
                owners[0] === slot.templateId &&
                this.#assetStore.references({ kind: "patent" }, [assetId]).length === 0 &&
                this.#assetStore.references({ kind: "library-document" }, [assetId]).length === 0
              )
                continue;
              const original = await this.#assetStore.readAsset(assetId);
              const [copy] = await this.#assetStore.stageMany(parsed.sessionId, [
                {
                  ...original,
                  descriptor: { ...original.descriptor, assetId: this.#randomUUID() },
                },
              ]);
              if (!copy) throw new Error("模板资源副本不存在。");
              stagedIds.push(copy.descriptor.assetId);
              replacements.set(assetId, copy.descriptor.assetId);
            }
            Object.assign(slot, remapAssetIds(slot, replacements));
          }
        }
      }

      this.#database.transaction((database) => {
        const revision = this.#catalogRevisionFrom(database);
        if (revision !== parsed.expectedRevision) {
          throw new LibraryServiceError("REVISION_CONFLICT", "默认模板已在其他窗口中更新。");
        }
        this.#assertStableSlotIdentities(database, parsed.catalog);
        const allAssetIds = PATENT_TYPES.flatMap((patentType) =>
          parsed.catalog[patentType].slots.flatMap((slot) => {
            if (!isFilledPatentTemplateSlot(slot)) return [];
            return previewAssetIds(slot);
          }),
        );
        this.#assertAssetsExist(database, allAssetIds);

        for (const patentType of PATENT_TYPES) {
          for (const slot of parsed.catalog[patentType].slots) {
            if (slot.unavailableReason !== null) continue;
            database
              .prepare(
                `UPDATE patent_template_slots
               SET name = ?, claims_json = ?, description_json = ?, abstract_json = ?,
                   template_revision = template_revision + 1, updated_at = ?
               WHERE template_id = ? AND patent_type = ? AND slot_index = ?`,
              )
              .run(
                slot.name,
                slot.claims ? encodeTemplate(slot.claims) : null,
                slot.description ? encodeTemplate(slot.description) : null,
                slot.abstract ? encodeTemplate(slot.abstract) : null,
                now,
                slot.templateId,
                patentType,
                slot.slotIndex,
              );
            this.#replaceTemplateAssets(
              database,
              slot.templateId,
              isFilledPatentTemplateSlot(slot) ? previewAssetIds(slot) : [],
            );
          }
          const selection = parsed.catalog[patentType].selection;
          this.#writePreference(
            database,
            patentType,
            selection.kind,
            selection.kind === "custom" ? selection.templateId : null,
            now,
          );
          const auxiliary = parsed.auxiliary[patentType];
          database
            .prepare(
              `UPDATE patent_template_auxiliary
             SET figure_explanation_json = ?, drawing_legend_json = ?, updated_at = ?
             WHERE patent_type = ?`,
            )
            .run(
              Buffer.from(encodeJson(auxiliary.figureExplanation)),
              Buffer.from(encodeJson(auxiliary.drawingLegend)),
              now,
              patentType,
            );
        }
        this.#beforeCommit?.();
        this.#writeState(database, CATALOG_REVISION_KEY, String(revision + 1), now);
        this.#writeState(
          database,
          SEPARATE_TYPES_KEY,
          (parsed.catalog.separatePatentTypes ?? this.#separateTypes()) ? "1" : "0",
          now,
        );
        inTransaction?.(database, revision + 1);
      });
      await this.#assetStore?.commitStaged(parsed.sessionId, stagedIds);

      return {
        sessionId: parsed.sessionId,
        catalog: this.#readCatalog(),
        auxiliary: this.#readAuxiliary(),
      };
    } catch (error) {
      await this.#assetStore?.discardStaged(parsed.sessionId, stagedIds);
      throw error;
    }
  }

  closeEditor(input: PatentTemplateEditorCloseRequest): void {
    this.#requireSession(input.sessionId);
    this.#sessions.delete(input.sessionId);
  }

  resolveCreationSource(patentType: Exclude<PatentType, "design">): ResolvedPatentTemplateSource {
    const catalog = this.#readCatalog();
    const sourceType = catalog.separatePatentTypes === false ? "invention" : patentType;
    const auxiliary = this.#readAuxiliary()[patentType];
    const selection = catalog[sourceType].selection;
    const factory = createFactoryPatentTemplates(this.#randomUUID)[patentType];
    const withAuxiliary = (
      books: Pick<PatentTemplateSettings["invention"], "claims" | "description" | "abstract">,
    ): PatentTemplateSettings["invention"] => ({
      ...structuredClone(books),
      figureExplanation: structuredClone(auxiliary.figureExplanation),
      drawingLegend: structuredClone(auxiliary.drawingLegend),
    });
    if (selection.kind === "blank") {
      const blank: PatentBookTemplate = { page: { ...DEFAULT_PAGE_SETTINGS }, content: [] };
      return {
        kind: "blank",
        templateId: null,
        templates: withAuxiliary({ claims: blank, description: blank, abstract: blank }),
        assetIds: [],
      };
    }
    if (selection.kind === "system") {
      return { kind: "system", templateId: null, templates: withAuxiliary(factory), assetIds: [] };
    }
    const slot = catalog[sourceType].slots.find(
      (candidate) => candidate.templateId === selection.templateId,
    );
    const claims = slot?.claims;
    const description = slot?.description;
    const abstract = slot?.abstract;
    if (!claims || !description || !abstract) {
      throw new LibraryServiceError("CORRUPT_FILE", "当前默认模板不完整。");
    }
    return {
      kind: "custom",
      templateId: slot.templateId,
      templates: withAuxiliary({
        claims: catalog.separatePatentTypes === false ? makeTemplateTypeDynamic(claims) : claims,
        description:
          catalog.separatePatentTypes === false
            ? makeTemplateTypeDynamic(description)
            : description,
        abstract:
          catalog.separatePatentTypes === false ? makeTemplateTypeDynamic(abstract) : abstract,
      }),
      assetIds: previewAssetIds({ claims, description, abstract }),
    };
  }

  readAuxiliary(): PatentTemplateAuxiliaryCatalog {
    return this.#readAuxiliary();
  }

  #assertSemanticallyUsable(input: PatentTemplateEditorSaveRequest): void {
    const factory = createFactoryPatentTemplates(() => TEMPLATE_VALIDATION_ID);
    for (const patentType of PATENT_TYPES) {
      const auxiliary = input.auxiliary[patentType];
      const filledSlots = input.catalog[patentType].slots.filter(isFilledPatentTemplateSlot);
      const candidates =
        filledSlots.length > 0
          ? filledSlots.map((slot) => ({
              claims: slot.claims,
              description: slot.description,
              abstract: slot.abstract,
            }))
          : [factory[patentType]];
      for (const books of candidates) {
        const settings = structuredClone(factory);
        settings[patentType] = {
          claims: structuredClone(books.claims),
          description: structuredClone(books.description),
          abstract: structuredClone(books.abstract),
          figureExplanation: structuredClone(auxiliary.figureExplanation),
          drawingLegend: structuredClone(auxiliary.drawingLegend),
        };
        const issue = blockingTemplateIssues(settings).find(
          (candidate) => candidate.patentType === patentType,
        );
        if (!issue) continue;
        const message =
          issue.code === "missing-token" && issue.slot === "figure-explanation"
            ? "附图说明模板缺少动态图号字段。"
            : issue.code === "broken-token"
              ? "模板中存在无法识别的动态字段。"
              : issue.message;
        throw new LibraryServiceError("INVALID_INPUT", message);
      }
    }
  }

  #readCatalog(): PatentTemplateCatalog {
    const rows = this.#database.read((database) =>
      database
        .prepare(
          `SELECT template_id, patent_type, slot_index, name, claims_json, description_json,
                  abstract_json, template_revision, created_at, updated_at
           FROM patent_template_slots ORDER BY patent_type, slot_index`,
        )
        .all(),
    ) as TemplateSlotRow[];
    const preferences = this.#database.read((database) =>
      database
        .prepare(
          "SELECT patent_type, selection_kind, selected_template_id FROM patent_template_preferences",
        )
        .all(),
    ) as PreferenceRow[];
    const result = {
      separatePatentTypes: this.#separateTypes(),
      revision: this.#catalogRevision(),
      invention: { selection: { kind: "system" as const }, slots: [] },
      "utility-model": { selection: { kind: "system" as const }, slots: [] },
    };
    for (const patentType of PATENT_TYPES) {
      const preference = preferences.find((candidate) => candidate.patent_type === patentType);
      if (!preference) throw new LibraryServiceError("CORRUPT_FILE", "默认模板偏好缺失。");
      const slots = rows.filter((row) => row.patent_type === patentType).map(decodeTemplateSlot);
      const selected =
        preference.selection_kind === "custom"
          ? slots.find((slot) => slot.templateId === preference.selected_template_id)
          : null;
      result[patentType].selection =
        preference.selection_kind === "custom" && selected && isFilledPatentTemplateSlot(selected)
          ? ({ kind: "custom", templateId: preference.selected_template_id } as never)
          : ({
              kind: preference.selection_kind === "custom" ? "system" : preference.selection_kind,
            } as never);
      result[patentType].slots = slots as never;
    }
    return PatentTemplateCatalogSchema.parse(result);
  }

  #readAuxiliary(): PatentTemplateAuxiliaryCatalog {
    const rows = this.#database.read((database) =>
      database
        .prepare(
          `SELECT patent_type, figure_explanation_json, drawing_legend_json, updated_at
           FROM patent_template_auxiliary`,
        )
        .all(),
    ) as AuxiliaryRow[];
    const byType = Object.fromEntries(
      rows.map((row) => [
        row.patent_type,
        {
          patentType: row.patent_type,
          figureExplanation: ParagraphNodeSchema.parse(decodeJson(row.figure_explanation_json)),
          drawingLegend: ParagraphNodeSchema.parse(decodeJson(row.drawing_legend_json)),
          updatedAt: row.updated_at,
        },
      ]),
    );
    return PatentTemplateAuxiliaryCatalogSchema.parse(byType);
  }

  #catalogRevision(): number {
    return this.#database.read((database) => this.#catalogRevisionFrom(database));
  }

  #separateTypes(): boolean {
    const stored = this.#stateValue(SEPARATE_TYPES_KEY);
    if (stored !== null) {
      if (stored !== "0" && stored !== "1")
        throw new LibraryServiceError("CORRUPT_FILE", "模板共用设置无效。");
      return stored === "1";
    }
    // Preserve existing customized catalogs; fresh libraries share the system template.
    return this.#database.read(
      (database) =>
        database
          .prepare(
            "SELECT 1 FROM patent_template_slots WHERE claims_json IS NOT NULL OR description_json IS NOT NULL OR abstract_json IS NOT NULL LIMIT 1",
          )
          .get() !== undefined ||
        database
          .prepare(
            "SELECT 1 FROM patent_template_preferences WHERE selection_kind != 'system' LIMIT 1",
          )
          .get() !== undefined,
    );
  }

  #catalogRevisionFrom(database: DatabaseSync): number {
    const value = this.#stateValueFrom(database, CATALOG_REVISION_KEY);
    if (value === null) return 0;
    const revision = Number(value);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new LibraryServiceError("CORRUPT_FILE", "默认模板版本无效。");
    }
    return revision;
  }

  #stateValue(key: string): string | null {
    return this.#database.read((database) => this.#stateValueFrom(database, key));
  }

  #stateValueFrom(database: DatabaseSync, key: string): string | null {
    const row = database.prepare("SELECT value FROM library_state WHERE key = ?").get(key) as
      | { value: Uint8Array }
      | undefined;
    return row ? decodeJson<string>(row.value) : null;
  }

  #writeState(database: DatabaseSync, key: string, value: string, now: string): void {
    database
      .prepare(
        `INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, Buffer.from(encodeJson(value)), now);
  }

  #writePreference(
    database: DatabaseSync,
    patentType: PatentType,
    kind: "blank" | "system" | "custom",
    templateId: string | null,
    now: string,
  ): void {
    database
      .prepare(
        `UPDATE patent_template_preferences
         SET selection_kind = ?, selected_template_id = ?, updated_at = ? WHERE patent_type = ?`,
      )
      .run(kind, templateId, now, patentType);
  }

  #assertStableSlotIdentities(database: DatabaseSync, catalog: PatentTemplateCatalog): void {
    const rows = database
      .prepare("SELECT template_id, patent_type, slot_index FROM patent_template_slots")
      .all() as Array<{ template_id: string; patent_type: PatentType; slot_index: number }>;
    for (const patentType of PATENT_TYPES) {
      for (const slot of catalog[patentType].slots) {
        if (
          !rows.some(
            (row) =>
              row.template_id === slot.templateId &&
              row.patent_type === patentType &&
              row.slot_index === slot.slotIndex,
          )
        ) {
          throw new LibraryServiceError("INVALID_INPUT", "默认模板槽位身份无效。");
        }
      }
    }
  }

  #assertAssetsExist(database: DatabaseSync, assetIds: readonly string[]): void {
    const statement = database.prepare("SELECT 1 FROM assets WHERE asset_id = ?");
    for (const assetId of new Set(assetIds)) {
      if (statement.get(assetId) === undefined) {
        throw new LibraryServiceError("NOT_FOUND", "默认模板引用的资源不存在。");
      }
    }
  }

  #replaceTemplateAssets(
    database: DatabaseSync,
    templateId: string,
    assetIds: readonly string[],
  ): void {
    database.prepare("DELETE FROM template_assets WHERE template_id = ?").run(templateId);
    const insert = database.prepare(
      "INSERT INTO template_assets(template_id, asset_id, purpose) VALUES (?, ?, 'chemical-preview')",
    );
    for (const assetId of new Set(assetIds)) insert.run(templateId, assetId);
  }

  #requireSession(sessionId: string): PatentType {
    const patentType = this.#sessions.get(sessionId);
    if (!patentType) throw new LibraryServiceError("INVALID_INPUT", "默认模板会话不存在。");
    return patentType;
  }
}

function encodeTemplate(template: PatentBookTemplate): Buffer {
  return Buffer.from(encodeJson(PatentBookTemplateSchema.parse(template)));
}

function decodeTemplate(value: Uint8Array | null): PatentBookTemplate | null {
  return value === null ? null : PatentBookTemplateSchema.parse(decodeJson(value));
}

function decodeTemplateSlot(row: TemplateSlotRow): PatentTemplateSlot {
  const base = {
    templateId: row.template_id,
    patentType: row.patent_type,
    slotIndex: row.slot_index,
    name: row.name,
    revision: row.template_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  try {
    return {
      ...base,
      claims: decodeTemplate(row.claims_json),
      description: decodeTemplate(row.description_json),
      abstract: decodeTemplate(row.abstract_json),
      unavailableReason: null,
    };
  } catch {
    return {
      ...base,
      claims: null,
      description: null,
      abstract: null,
      unavailableReason: "模板内容损坏，请清空后重新填入。",
    };
  }
}

function previewAssetIds(
  books: Pick<PatentTemplateSettings["invention"], "claims" | "description" | "abstract">,
): string[] {
  return [books.claims, books.description, books.abstract].flatMap((book) =>
    book.content.flatMap((block) =>
      block.type === "chemical-structure" ? [block.previewAssetId] : [],
    ),
  );
}

function sameThreeBooks(
  left: PatentTemplateSettings["invention"],
  right: PatentTemplateSettings["invention"],
): boolean {
  return (
    JSON.stringify(withoutGeneratedIds([left.claims, left.description, left.abstract])) ===
    JSON.stringify(withoutGeneratedIds([right.claims, right.description, right.abstract]))
  );
}

function upgradeLegacyAuxiliaryContent(
  value: ParagraphNode,
  legacy: ParagraphNode,
  current: ParagraphNode,
): ParagraphNode {
  if (JSON.stringify(value.content) !== JSON.stringify(legacy.content)) return value;
  return { ...structuredClone(value), content: structuredClone(current.content) };
}

function withoutGeneratedIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutGeneratedIds);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "id")
      .map(([key, child]) => [key, withoutGeneratedIds(child)]),
  );
}
