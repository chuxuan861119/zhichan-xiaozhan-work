import { lstat, mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  AiCorrectionSettingsRequestSchema,
  AiCorrectionSettingsSchema,
} from "../../shared/ai-correction/model.js";
import { AI_POLICY_VERSION } from "../../shared/ai-correction/policy.js";
import { PatentTemplateSettingsSchema } from "../../shared/patent/templates.js";
import { CustomDualViewPresetsSchema } from "../../shared/settings/custom-dual-view.js";
import {
  type AppSettings,
  type AppSettingsPatch,
  AppSettingsPatchSchema,
  AppSettingsSchema,
  AppSettingsV1Schema,
  DEFAULT_APP_SETTINGS,
  type SettingsHealth,
} from "../../shared/settings/model.js";
import { PartialShortcutSettingsSchema } from "../../shared/settings/shortcuts.js";
import { SnapshotSettingsSchema } from "../../shared/snapshot/model.js";

const LegacyAutosaveMinutesSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(3),
  z.literal(5),
  z.literal(10),
  z.literal(30),
]);

const LegacyPatentTemplateSettingsSchema = PatentTemplateSettingsSchema.omit({ enabled: true });

const LegacySnapshotSettingsSchema = z
  .object({
    enabled: z.boolean(),
    intervalMinutes: z.union([
      z.literal(1),
      z.literal(3),
      z.literal(5),
      z.literal(10),
      z.literal(15),
      z.literal(30),
      z.literal(60),
    ]),
    maxCount: z.number().int().min(5).max(500),
  })
  .strict();

const MigratableAppSettingsSchema = AppSettingsSchema.omit({
  patentTemplates: true,
  shortcuts: true,
  customDualViewPresets: true,
  aiCorrection: true,
})
  .partial({
    printPreferences: true,
    backup: true,
    snapshot: true,
    referenceMarkSyncIntroDismissed: true,
    referenceMarkLocatorEnabled: true,
    pageMargins: true,
    patentLibraryViewMode: true,
  })
  .extend({
    autosaveMinutes: LegacyAutosaveMinutesSchema.optional(),
    patentTemplates: z
      .union([PatentTemplateSettingsSchema, LegacyPatentTemplateSettingsSchema])
      .optional(),
    shortcuts: PartialShortcutSettingsSchema.optional(),
    customDualViewPresets: CustomDualViewPresetsSchema.optional(),
    aiCorrection: AiCorrectionSettingsSchema.optional(),
    snapshot: z.union([SnapshotSettingsSchema, LegacySnapshotSettingsSchema]).optional(),
  })
  .strict();

const LegacyAppSettingsSchema = AppSettingsV1Schema.extend({
  autosaveMinutes: LegacyAutosaveMinutesSchema,
});

const LegacyAppSettingsWithPrintPreferencesSchema = AppSettingsSchema.omit({
  patentTemplates: true,
  backup: true,
  snapshot: true,
  referenceMarkSyncIntroDismissed: true,
  referenceMarkLocatorEnabled: true,
  shortcuts: true,
  customDualViewPresets: true,
  aiCorrection: true,
  patentLibraryViewMode: true,
}).extend({
  autosaveMinutes: z
    .union([z.literal(0), z.literal(1), z.literal(3), z.literal(5), z.literal(10), z.literal(30)])
    .optional(),
  shortcuts: PartialShortcutSettingsSchema.optional(),
  customDualViewPresets: CustomDualViewPresetsSchema.optional(),
  aiCorrection: AiCorrectionSettingsSchema.optional(),
});

type AtomicWriter = (
  filename: string,
  data: string | Buffer,
  options?: { encoding?: BufferEncoding },
) => Promise<void>;

type ReadableSettingsForMigration = {
  [Key in Exclude<keyof AppSettings, "patentTemplates" | "shortcuts" | "snapshot">]?:
    | AppSettings[Key]
    | undefined;
} & {
  autosaveMinutes?: z.infer<typeof LegacyAutosaveMinutesSchema> | undefined;
  snapshot?: AppSettings["snapshot"] | z.infer<typeof LegacySnapshotSettingsSchema> | undefined;
  patentTemplates?:
    | AppSettings["patentTemplates"]
    | z.infer<typeof LegacyPatentTemplateSettingsSchema>
    | undefined;
  shortcuts?:
    | { [Key in keyof AppSettings["shortcuts"]]?: AppSettings["shortcuts"][Key] | undefined }
    | undefined;
};

type ParsedSettings = {
  settings: AppSettings;
  migrated: boolean;
};

function nativeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export class SettingsService {
  private updateTail: Promise<unknown> = Promise.resolve();
  private health: SettingsHealth = { state: "healthy", message: null };
  private lastGoodSeeded = false;

  constructor(
    private readonly path: string,
    private readonly writeAtomic: AtomicWriter = writeFileAtomic,
  ) {}

  status(): SettingsHealth {
    return structuredClone(this.health);
  }

  /** Read only genuinely persisted template settings, before read() fills defaults. */
  async readForTemplateMigration(): Promise<AppSettings | null> {
    let hasUnreadableSettings = false;
    for (const path of [this.path, `${this.path}.last-good`]) {
      let input: unknown;
      try {
        input = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (nativeErrorCode(error) !== "ENOENT") hasUnreadableSettings = true;
        continue;
      }
      const parsed = this.#parseSettings(input);
      if (parsed === null) {
        hasUnreadableSettings = true;
        continue;
      }
      return typeof input === "object" && input !== null && "patentTemplates" in input
        ? parsed.settings
        : null;
    }
    if (hasUnreadableSettings) {
      throw new Error("无法读取原有默认模板设置，请先恢复设置文件后重试。");
    }
    return null;
  }

  async read(): Promise<AppSettings> {
    let input: unknown;
    try {
      input = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (nativeErrorCode(error) === "ENOENT") return structuredClone(DEFAULT_APP_SETTINGS);
      return await this.#recoverFromLastGood();
    }

    const parsed = this.#parseSettings(input);
    if (parsed === null) return await this.#recoverFromLastGood();
    if (!parsed.migrated) {
      await this.#seedLastGood(parsed.settings);
      return parsed.settings;
    }
    try {
      await this.#write(parsed.settings);
    } catch {
      this.health = {
        state: "degraded",
        message: "设置已读取，但无法写入设置文件或保护副本，请检查数据目录权限。",
      };
      // Strict historical parsers keep the preferences readable on the next launch.
    }
    return parsed.settings;
  }

  /**
   * Read settings only when they predate the editable template catalog on disk.
   * A fresh profile has no settings file; the in-memory factory defaults must not
   * be mistaken for user-authored legacy templates.
   */
  async readForLegacyTemplateMigration(): Promise<AppSettings | null> {
    try {
      await lstat(this.path);
    } catch (error) {
      if (nativeErrorCode(error) === "ENOENT") return null;
      throw error;
    }
    return await this.read();
  }

  /**
   * Ensure the mutable settings file exists before an operation that must be
   * able to journal and roll back the current settings state.
   */
  async ensurePersisted(): Promise<void> {
    const operation = this.updateTail.then(
      () => this.#ensurePersisted(),
      () => this.#ensurePersisted(),
    );
    this.updateTail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  /**
   * Read settings while the application is in manual-safe startup mode.
   *
   * Unlike read(), this method never migrates, seeds a last-good copy,
   * quarantines a corrupt file, or writes a repaired current file. The
   * read-only startup path must not mutate user data merely because the
   * settings IPC endpoint was queried.
   */
  async readReadOnly(): Promise<AppSettings> {
    const readAndParse = async (path: string): Promise<AppSettings | undefined> => {
      try {
        const parsed = this.#parseSettings(JSON.parse(await readFile(path, "utf8")));
        return parsed?.settings;
      } catch {
        return undefined;
      }
    };

    return (
      (await readAndParse(this.path)) ??
      (await readAndParse(`${this.path}.last-good`)) ??
      structuredClone(DEFAULT_APP_SETTINGS)
    );
  }

  async update(
    input: AppSettingsPatch,
    beforeWrite?: (current: AppSettings) => void,
  ): Promise<AppSettings> {
    const patch = AppSettingsPatchSchema.parse({
      ...input,
      ...(typeof input.zoomPercent === "number"
        ? { zoomPercent: Math.min(200, Math.max(50, Math.round(input.zoomPercent))) }
        : {}),
    });
    const operation = this.updateTail.then(
      () => this.#applyUpdate(patch, beforeWrite),
      () => this.#applyUpdate(patch, beforeWrite),
    );
    this.updateTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  async #applyUpdate(
    patch: AppSettingsPatch,
    beforeWrite?: (current: AppSettings) => void,
  ): Promise<AppSettings> {
    const current = await this.read();
    if (
      patch.aiConnectionsEnabled === true &&
      patch.aiPolicyAcceptedVersion !== AI_POLICY_VERSION
    ) {
      throw new Error("请先阅读并同意 AI 使用协议与隐私说明，再开启 AI 连接。");
    }
    const retired = [
      ...new Set([
        ...(current.aiCorrection.retiredProfileIds ?? []),
        ...(patch.aiCorrection?.retiredProfileIds ?? []),
      ]),
    ];
    const aiCorrection = patch.aiCorrection
      ? AiCorrectionSettingsRequestSchema.parse({
          ...patch.aiCorrection,
          ...(retired.length ? { retiredProfileIds: retired } : {}),
        })
      : current.aiCorrection;
    const settings = AppSettingsSchema.parse({ ...current, ...patch, aiCorrection });
    beforeWrite?.(current);
    await this.#write(settings);
    this.health = { state: "healthy", message: null };
    return settings;
  }

  async #ensurePersisted(): Promise<void> {
    try {
      await lstat(this.path);
      return;
    } catch (error) {
      if (nativeErrorCode(error) !== "ENOENT") throw error;
    }

    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    await this.#write(settings);
    this.health = { state: "healthy", message: null };
  }

  #parseSettings(input: unknown): ParsedSettings | null {
    const parsed = AppSettingsSchema.safeParse(input);
    if (parsed.success) {
      const needsConsent =
        parsed.data.aiConnectionsEnabled &&
        parsed.data.aiPolicyAcceptedVersion !== AI_POLICY_VERSION;
      return {
        settings: needsConsent ? { ...parsed.data, aiConnectionsEnabled: false } : parsed.data,
        migrated: needsConsent,
      };
    }
    const migratable = MigratableAppSettingsSchema.safeParse(input);
    const v1 = AppSettingsV1Schema.safeParse(input);
    const legacy = LegacyAppSettingsSchema.safeParse(input);
    const legacyWithPrintPreferences = LegacyAppSettingsWithPrintPreferencesSchema.safeParse(input);
    if (
      !migratable.success &&
      !v1.success &&
      !legacy.success &&
      !legacyWithPrintPreferences.success
    ) {
      return null;
    }
    let source: ReadableSettingsForMigration;
    if (migratable.success) source = migratable.data;
    else if (legacyWithPrintPreferences.success) source = legacyWithPrintPreferences.data;
    else if (legacy.success) source = legacy.data;
    else if (v1.success) source = v1.data;
    else return null;
    const { autosaveMinutes: _obsoleteAutosaveMinutes, ...legacySettings } = source;
    const patentTemplates = legacySettings.patentTemplates
      ? "enabled" in legacySettings.patentTemplates
        ? legacySettings.patentTemplates
        : { enabled: true, ...legacySettings.patentTemplates }
      : structuredClone(DEFAULT_APP_SETTINGS.patentTemplates);
    const snapshot = legacySettings.snapshot
      ? "maxCount" in legacySettings.snapshot
        ? {
            enabled: legacySettings.snapshot.enabled,
            intervalMinutes:
              legacySettings.snapshot.intervalMinutes === 1
                ? DEFAULT_APP_SETTINGS.snapshot.intervalMinutes
                : legacySettings.snapshot.intervalMinutes,
          }
        : legacySettings.snapshot
      : structuredClone(DEFAULT_APP_SETTINGS.snapshot);
    const migrated = AppSettingsSchema.parse({
      ...legacySettings,
      printPreferences:
        legacySettings.printPreferences ?? structuredClone(DEFAULT_APP_SETTINGS.printPreferences),
      patentTemplates,
      backup: legacySettings.backup ?? structuredClone(DEFAULT_APP_SETTINGS.backup),
      snapshot,
      editorIntroductionSeen: legacySettings.editorIntroductionSeen ?? false,
      referenceMarkSyncIntroDismissed: legacySettings.referenceMarkSyncIntroDismissed ?? false,
      referenceMarkLocatorEnabled:
        legacySettings.referenceMarkLocatorEnabled ??
        DEFAULT_APP_SETTINGS.referenceMarkLocatorEnabled,
      pageMargins: legacySettings.pageMargins ?? structuredClone(DEFAULT_APP_SETTINGS.pageMargins),
      shortcuts: {
        ...structuredClone(DEFAULT_APP_SETTINGS.shortcuts),
        ...(legacySettings.shortcuts ?? {}),
      },
      customDualViewPresets:
        legacySettings.customDualViewPresets ??
        structuredClone(DEFAULT_APP_SETTINGS.customDualViewPresets),
      aiCorrection:
        legacySettings.aiCorrection ?? structuredClone(DEFAULT_APP_SETTINGS.aiCorrection),
      patentLibraryViewMode:
        legacySettings.patentLibraryViewMode ?? DEFAULT_APP_SETTINGS.patentLibraryViewMode,
    });
    if (migrated.aiPolicyAcceptedVersion !== AI_POLICY_VERSION)
      migrated.aiConnectionsEnabled = false;
    return { settings: migrated, migrated: true };
  }

  async #recoverFromLastGood(): Promise<AppSettings> {
    let recovered: AppSettings;
    try {
      const input = JSON.parse(await readFile(`${this.path}.last-good`, "utf8"));
      const parsed = this.#parseSettings(input);
      if (parsed === null) throw new Error("Last-good settings are invalid.");
      recovered = parsed.settings;
      this.lastGoodSeeded = true;
    } catch {
      this.health = {
        state: "degraded",
        message: "设置文件损坏且没有有效备份，数据安全设置已回退为默认值，请立即重新确认。",
      };
      return structuredClone(DEFAULT_APP_SETTINGS);
    }

    await this.#quarantineCorruptSettings();
    try {
      await this.#writeCurrent(recovered);
      this.health = {
        state: "recovered",
        message: "设置文件损坏，已从最后一次有效设置恢复。",
      };
    } catch {
      this.health = {
        state: "degraded",
        message: "已读取最后一次有效设置，但无法修复设置文件，请检查数据目录权限。",
      };
    }
    return recovered;
  }

  async #quarantineCorruptSettings(): Promise<void> {
    try {
      await rename(this.path, `${this.path}.corrupt-${Date.now()}`);
    } catch (error) {
      if (nativeErrorCode(error) !== "ENOENT") {
        // A locked file may still be safely replaced by the atomic writer.
      }
    }
  }

  async #write(settings: AppSettings): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const serialized = `${JSON.stringify(settings, null, 2)}\n`;
    await this.writeAtomic(`${this.path}.last-good`, serialized, {
      encoding: "utf8",
    });
    this.lastGoodSeeded = true;
    await this.writeAtomic(this.path, serialized, {
      encoding: "utf8",
    });
  }

  async #seedLastGood(settings: AppSettings): Promise<void> {
    if (this.lastGoodSeeded) return;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await this.writeAtomic(`${this.path}.last-good`, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: "utf8",
      });
      this.lastGoodSeeded = true;
    } catch {
      this.health = {
        state: "degraded",
        message: "设置可读取，但无法创建保护副本，请检查数据目录权限。",
      };
    }
  }

  async #writeCurrent(settings: AppSettings): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await this.writeAtomic(this.path, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
    });
  }
}
