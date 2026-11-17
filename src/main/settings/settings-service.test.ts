import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_POLICY_VERSION } from "../../shared/ai-correction/policy.js";
import { DEFAULT_BACKUP_SETTINGS } from "../../shared/backup/model.js";
import { DEFAULT_PRINT_PREFERENCES } from "../../shared/printing/model.js";
import {
  AppSettingsPatchSchema,
  DEFAULT_APP_SETTINGS,
  DEFAULT_PATENT_TEMPLATE_SETTINGS,
} from "../../shared/settings/model.js";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../shared/settings/shortcuts.js";
import { DEFAULT_SNAPSHOT_SETTINGS } from "../../shared/snapshot/model.js";
import { SettingsService } from "./settings-service.js";

describe("local settings", () => {
  test("persists custom book and tool presets across a new settings service", async () => {
    const path = join(directory, "custom-tool-presets.json");
    const presets = [
      { leftBookKind: "description" as const, rightBookKind: "claims" as const },
      { leftBookKind: "drawing-markup" as const, rightBookKind: "description" as const },
      { leftBookKind: "flowchart" as const, rightBookKind: "drawing-markup" as const },
    ];
    const service = new SettingsService(path);
    await service.update({ customDualViewPresets: presets });
    expect((await new SettingsService(path).read()).customDualViewPresets).toEqual(presets);
    expect(JSON.parse(await readFile(path, "utf8")).customDualViewPresets).toEqual(presets);
  });
  test("AI is off by default and cannot be enabled without current policy acceptance", async () => {
    const service = new SettingsService(join(directory, "consent-settings.json"));
    expect((await service.read()).aiConnectionsEnabled).toBe(false);
    await expect(service.update({ aiConnectionsEnabled: true })).rejects.toThrow(/协议/);
  });
  test("legacy enabled settings require consent, and acceptance persists across restarts", async () => {
    const path = join(directory, "legacy-consent.json");
    const legacy = { ...DEFAULT_APP_SETTINGS, aiConnectionsEnabled: true } as Record<
      string,
      unknown
    >;
    delete legacy.aiPolicyAcceptedVersion;
    await writeFile(path, JSON.stringify(legacy));
    const service = new SettingsService(path);
    expect((await service.readReadOnly()).aiConnectionsEnabled).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(legacy);
    expect((await service.read()).aiConnectionsEnabled).toBe(false);
    await expect(
      service.update({ aiConnectionsEnabled: true, aiPolicyAcceptedVersion: "outdated" }),
    ).rejects.toThrow(/协议/);
    await service.update({
      aiConnectionsEnabled: true,
      aiPolicyAcceptedVersion: AI_POLICY_VERSION,
    });
    expect((await new SettingsService(path).read()).aiConnectionsEnabled).toBe(true);
    await service.update({ aiConnectionsEnabled: false });
    await expect(service.update({ aiConnectionsEnabled: true })).rejects.toThrow(/协议/);
    expect((await service.read()).aiConnectionsEnabled).toBe(false);
  });
  test("preserves retired credential identities across writes and rejects profile reuse", async () => {
    const path = join(directory, "settings.json");
    const retired = "00000000-0000-4000-8000-000000000102";
    await writeFile(
      path,
      JSON.stringify({
        ...DEFAULT_APP_SETTINGS,
        aiCorrection: {
          ...DEFAULT_APP_SETTINGS.aiCorrection,
          profiles: [
            {
              profileId: retired,
              providerId: "openai",
              displayName: "Old",
              baseUrl: "https://api.openai.com/v1",
              model: "old-model",
            },
          ],
          activeProfileId: retired,
        },
      }),
    );
    const service = new SettingsService(path);
    expect((await service.read()).aiCorrection.retiredProfileIds).toEqual([retired]);
    await service.update({ aiCorrection: structuredClone(DEFAULT_APP_SETTINGS.aiCorrection) });
    expect((await new SettingsService(path).read()).aiCorrection.retiredProfileIds).toEqual([
      retired,
    ]);
    await expect(
      service.update({
        aiCorrection: {
          ...DEFAULT_APP_SETTINGS.aiCorrection,
          profiles: [
            {
              profileId: retired,
              providerId: "deepseek",
              displayName: "New",
              baseUrl: "https://api.deepseek.com",
              model: "deepseek-flash",
            },
          ],
        },
      }),
    ).rejects.toThrow("标识不能复用");
    expect((await service.read()).aiCorrection.profiles).toEqual([]);
  });

  test("enables export auto sizing by default and preserves an explicit opt-out", async () => {
    const path = join(directory, "settings.json");
    const service = new SettingsService(path);
    expect((await service.read()).drawingAutoAdjustLabelSize).toBe(true);
    await service.update({ contentSearchEnabled: false });
    await service.update({ drawingAutoAdjustLabelSize: true });
    expect((await service.read()).contentSearchEnabled).toBe(false);
    await service.update({ zoomPercent: 110 });
    expect((await new SettingsService(path).read()).drawingAutoAdjustLabelSize).toBe(true);
    await service.update({ drawingAutoLabelScale: 1.5 });
    expect((await new SettingsService(path).read()).drawingAutoLabelScale).toBe(1.5);
    await service.update({ drawingAutoAdjustLabelSize: false });
    expect((await new SettingsService(path).read()).drawingAutoAdjustLabelSize).toBe(false);
  });
  test("enables background content indexing by default and preserves an explicit opt-out", async () => {
    const path = join(directory, "settings.json");
    const service = new SettingsService(path);
    expect((await service.read()).contentSearchEnabled).toBe(true);
    await service.update({ contentSearchEnabled: false });
    expect((await new SettingsService(path).read()).contentSearchEnabled).toBe(false);
  });

  test("persists dual-column style and mode across unrelated updates and restart", async () => {
    const path = join(directory, "settings.json");
    const service = new SettingsService(path);
    expect((await service.read()).dualColumnFlow).toEqual({
      style: "graphite",
      mode: "boxes",
      margin: "dust",
    });
    for (const mode of ["cable", "boxes", "off"] as const) {
      await service.update({ dualColumnFlow: { style: "graphite", mode, margin: "threads" } });
      await service.update({ zoomPercent: 110 });
      expect((await new SettingsService(path).read()).dualColumnFlow).toEqual({
        style: "graphite",
        mode,
        margin: "threads",
      });
    }
  });
  test("persists the default detail ratio across unrelated updates and restart", async () => {
    const path = join(directory, "settings.json");
    const service = new SettingsService(path);
    expect((await service.read()).drawingDetailDefaultRatio).toBe(2);
    await service.update({ drawingDetailDefaultRatio: 2.34567 });
    await service.update({ zoomPercent: 125 });
    expect((await new SettingsService(path).read()).drawingDetailDefaultRatio).toBe(2.34567);
    expect(AppSettingsPatchSchema.safeParse({ drawingDetailDefaultRatio: 0 }).success).toBe(false);
  });
  test("persists the invention prefix across unrelated updates and restart", async () => {
    const path = join(directory, "settings.json");
    const service = new SettingsService(path);
    await service.update({ inventionContentPrefix: "可选地，" });
    await service.update({ zoomPercent: 125 });
    expect((await new SettingsService(path).read()).inventionContentPrefix).toBe("可选地，");
  });
  test("persists display and AI preferences across unrelated updates and restart", async () => {
    const path = join(directory, "settings.json");
    const service = new SettingsService(path);
    await service.update({ aiConnectionsEnabled: false, uiScalePercent: 110, reducedMotion: true });
    await service.update({ zoomPercent: 125 });
    expect(await new SettingsService(path).read()).toMatchObject({
      aiConnectionsEnabled: false,
      uiScalePercent: 110,
      reducedMotion: true,
      zoomPercent: 125,
    });
  });
  test("persists drawing style defaults across service restart without unrelated patches resetting them", async () => {
    const path = join(directory, "settings.json");
    const service = new SettingsService(path);
    expect((await service.read()).drawingAnnotationDefaults).toEqual({
      fontSize: 12,
      lineWidth: 0.3,
    });
    await service.update({ drawingAnnotationDefaults: { fontSize: 18, lineWidth: 0.5 } });
    await service.update({ zoomPercent: 125 });
    expect((await new SettingsService(path).read()).drawingAnnotationDefaults).toEqual({
      fontSize: 18,
      lineWidth: 0.5,
    });
    await expect(
      service.update({ drawingAnnotationDefaults: { fontSize: 0, lineWidth: -1 } }),
    ).rejects.toThrow();
  });
  let directory = "";
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "patent-settings-"));
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  test("does not expose first-run defaults as stored templates for catalog migration", async () => {
    const service = new SettingsService(join(directory, "settings.json"));
    expect(await service.read()).toEqual(DEFAULT_APP_SETTINGS);
    expect(await service.readForTemplateMigration()).toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });

  test("preserves stored templates even when they equal the current factory", async () => {
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify(DEFAULT_APP_SETTINGS));
    expect(await new SettingsService(path).readForTemplateMigration()).toEqual(
      DEFAULT_APP_SETTINGS,
    );
  });

  test("does not manufacture legacy templates for settings predating template support", async () => {
    const path = join(directory, "settings.json");
    const { patentTemplates: _templates, ...legacy } = DEFAULT_APP_SETTINGS;
    await writeFile(path, JSON.stringify(legacy));
    expect(await new SettingsService(path).readForTemplateMigration()).toBeNull();
  });

  test.each(["missing", "corrupt"])(
    "uses last-good templates when settings are %s",
    async (kind) => {
      const path = join(directory, "settings.json");
      if (kind === "corrupt") await writeFile(path, "broken-json");
      const settings = structuredClone(DEFAULT_APP_SETTINGS);
      settings.patentTemplates.enabled = false;
      await writeFile(`${path}.last-good`, JSON.stringify(settings));
      expect(await new SettingsService(path).readForTemplateMigration()).toEqual(settings);
    },
  );

  test("does not silently mark unreadable legacy templates as migrated", async () => {
    const path = join(directory, "settings.json");
    await writeFile(path, "broken-json");
    await expect(new SettingsService(path).readForTemplateMigration()).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("broken-json");
  });

  test("stores the global reference sync introduction preference", async () => {
    const service = new SettingsService(join(directory, "settings.json"));
    expect((await service.read()).referenceMarkSyncIntroDismissed).toBe(false);
    expect(
      (await service.update({ referenceMarkSyncIntroDismissed: true }))
        .referenceMarkSyncIntroDismissed,
    ).toBe(true);
  });

  test("migrates settings that predate the patent library view preference", async () => {
    const path = join(directory, "settings.json");
    const legacy = structuredClone(DEFAULT_APP_SETTINGS) as Record<string, unknown>;
    delete legacy.patentLibraryViewMode;
    legacy.zoomPercent = 125;
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`);

    const settings = await new SettingsService(path).read();

    expect(settings).toEqual({ ...DEFAULT_APP_SETTINGS, zoomPercent: 125 });
    expect(settings.patentLibraryViewMode).toBe("single");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(settings);
  });

  test("enables reference-mark keyword locating when migrating older settings", async () => {
    const path = join(directory, "settings.json");
    const legacy = structuredClone(DEFAULT_APP_SETTINGS) as Record<string, unknown>;
    delete legacy.referenceMarkLocatorEnabled;
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`);

    const settings = await new SettingsService(path).read();

    expect(settings.referenceMarkLocatorEnabled).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).referenceMarkLocatorEnabled).toBe(true);
  });

  test("persists a double-column patent library preference", async () => {
    const service = new SettingsService(join(directory, "settings.json"));

    await expect(service.update({ patentLibraryViewMode: "double" })).resolves.toMatchObject({
      patentLibraryViewMode: "double",
    });
  });

  test("materializes default settings for a fresh profile before a destructive data import", async () => {
    const path = join(directory, "settings.json");
    const service = new SettingsService(path);

    await expect(service.ensurePersisted()).resolves.toBeUndefined();
    await expect(readFile(path, "utf8")).resolves.toBe(
      `${JSON.stringify(DEFAULT_APP_SETTINGS, null, 2)}\n`,
    );
    await expect(readFile(`${path}.last-good`, "utf8")).resolves.toBe(
      `${JSON.stringify(DEFAULT_APP_SETTINGS, null, 2)}\n`,
    );
  });

  test("does not present generated defaults as persisted legacy template settings", async () => {
    const path = join(directory, "settings.json");
    const service = new SettingsService(path);

    await expect(service.readForLegacyTemplateMigration()).resolves.toBeNull();
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const persisted = { ...DEFAULT_APP_SETTINGS, zoomPercent: 125 };
    await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`);
    await expect(service.readForLegacyTemplateMigration()).resolves.toEqual(persisted);
  });

  test("does not rewrite settings that are already persisted", async () => {
    const path = join(directory, "settings.json");
    const original = `${JSON.stringify({ ...DEFAULT_APP_SETTINGS, zoomPercent: 125 }, null, 2)}\n`;
    await writeFile(path, original);
    const writeAtomic = vi.fn(async () => undefined);
    const service = new SettingsService(path, writeAtomic);

    await expect(service.ensurePersisted()).resolves.toBeUndefined();
    expect(writeAtomic).not.toHaveBeenCalled();
    await expect(readFile(path, "utf8")).resolves.toBe(original);
  });

  test("readReadOnly reads settings without repairing, migrating, or quarantining files", async () => {
    const path = join(directory, "settings.json");
    const original = "not-json";
    await writeFile(path, original);
    const lastGood = `${JSON.stringify(DEFAULT_APP_SETTINGS, null, 2)}\n`;
    await writeFile(`${path}.last-good`, lastGood);

    const service = new SettingsService(path);
    await expect(service.readReadOnly()).resolves.toEqual(DEFAULT_APP_SETTINGS);
    await expect(readFile(path, "utf8")).resolves.toBe(original);
    await expect(readFile(`${path}.last-good`, "utf8")).resolves.toBe(lastGood);
    await expect(readdir(directory)).resolves.toEqual(
      expect.arrayContaining(["settings.json", "settings.json.last-good"]),
    );
  });

  test("app settings no longer expose a disableable autosave interval", async () => {
    const service = new SettingsService(join(directory, "settings.json"));
    expect(await service.read()).toEqual(DEFAULT_APP_SETTINGS);
    expect(DEFAULT_APP_SETTINGS.printPreferences).toEqual(DEFAULT_PRINT_PREFERENCES);
    expect("autosaveMinutes" in DEFAULT_APP_SETTINGS).toBe(false);
    expect(AppSettingsPatchSchema.safeParse({ autosaveMinutes: 30 }).success).toBe(false);
    await expect(service.update({ autosaveMinutes: 30 } as never)).rejects.toThrow();
  });

  test("migrates a settings file that predates print preferences", async () => {
    const path = join(directory, "settings.json");
    await writeFile(
      path,
      `${JSON.stringify(
        {
          zoomPercent: 110,
          recentDirectory: "C:\\专利资料",
          windowBounds: null,
          welcomeCompleted: true,
          patentTemplates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
          backup: DEFAULT_BACKUP_SETTINGS,
          snapshot: DEFAULT_SNAPSHOT_SETTINGS,
        },
        null,
        2,
      )}\n`,
    );
    const service = new SettingsService(path);
    const expected = {
      zoomPercent: 110,
      recentDirectory: "C:\\专利资料",
      windowBounds: null,
      welcomeCompleted: true,
      editorIntroductionSeen: false,
      referenceMarkSyncIntroDismissed: false,
      referenceMarkLocatorEnabled: true,
      inventionContentPrefix: DEFAULT_APP_SETTINGS.inventionContentPrefix,
      closeToTray: true,
      trayIntroDismissed: false,
      autoCheckUpdates: true,
      contentSearchEnabled: true,
      printPreferences: DEFAULT_PRINT_PREFERENCES,
      patentTemplates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
      backup: DEFAULT_BACKUP_SETTINGS,
      snapshot: DEFAULT_SNAPSHOT_SETTINGS,
      pageMargins: DEFAULT_APP_SETTINGS.pageMargins,
      shortcuts: DEFAULT_SHORTCUT_SETTINGS,
      customDualViewPresets: [],
      aiCorrection: DEFAULT_APP_SETTINGS.aiCorrection,
      patentLibraryViewMode: "single",
      drawingDetailDefaultRatio: 2,
      drawingAutoAdjustLabelSize: true,
      drawingAutoLabelScale: 1,
      drawingAnnotationDefaults: { fontSize: 12, lineWidth: 0.3 },
      aiConnectionsEnabled: false,
      aiPolicyAcceptedVersion: null,
      uiScalePercent: 100,
      reducedMotion: false,
      editorColors: DEFAULT_APP_SETTINGS.editorColors,
      dualColumnFlow: { style: "graphite", mode: "boxes", margin: "dust" },
    };

    expect(await service.read()).toEqual(expected);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(expected);
    expect(await service.read()).toEqual(expected);
  });

  test("migrates settings without custom shortcuts to empty shortcut assignments", async () => {
    const path = join(directory, "settings.json");
    const legacy = { ...structuredClone(DEFAULT_APP_SETTINGS) } as Record<string, unknown>;
    delete legacy.shortcuts;
    await writeFile(path, JSON.stringify(legacy));

    const settings = await new SettingsService(path).read();

    expect(settings.shortcuts).toEqual(DEFAULT_SHORTCUT_SETTINGS);
    expect(JSON.parse(await readFile(path, "utf8")).shortcuts).toEqual(DEFAULT_SHORTCUT_SETTINGS);
  });

  test("migrates old shortcut assignments and adds empty custom dual-view slots", async () => {
    const path = join(directory, "settings.json");
    const legacyShortcuts = {
      "clear-extra-formatting": "Ctrl+Alt+K",
      "check-problems": null,
      "assign-reference-number": null,
      "assign-custom-reference-number": null,
      "insert-dependent-claim": null,
      "toggle-drawing-sort": null,
      "import-drawing-images": null,
    };
    const legacy = { ...structuredClone(DEFAULT_APP_SETTINGS) } as Record<string, unknown>;
    legacy.shortcuts = legacyShortcuts;
    delete legacy.customDualViewPresets;
    await writeFile(path, JSON.stringify(legacy));

    const settings = await new SettingsService(path).read();

    expect(settings.customDualViewPresets).toEqual([]);
    expect(settings.shortcuts).toMatchObject({
      ...legacyShortcuts,
      "open-custom-dual-view-1": null,
      "open-custom-dual-view-2": null,
      "open-custom-dual-view-3": null,
    });
  });

  test("enables templates when migrating settings saved before the template switch existed", async () => {
    const path = join(directory, "settings.json");
    const legacyTemplates = structuredClone(DEFAULT_PATENT_TEMPLATE_SETTINGS) as Record<
      string,
      unknown
    >;
    delete legacyTemplates.enabled;
    await writeFile(
      path,
      `${JSON.stringify({ ...DEFAULT_APP_SETTINGS, patentTemplates: legacyTemplates }, null, 2)}\n`,
    );

    const settings = await new SettingsService(path).read();

    expect(settings.patentTemplates.enabled).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).patentTemplates.enabled).toBe(true);
  });

  test("persists only durable print preferences", async () => {
    const path = join(directory, "settings.json");
    const service = new SettingsService(path);
    const printPreferences = {
      printerDeviceName: "printer-1",
      duplexMode: "longEdge" as const,
      color: false,
      orientation: "landscape" as const,
      paperSize: "Letter" as const,
    };

    await expect(service.update({ printPreferences })).resolves.toMatchObject({
      printPreferences,
    });
    expect((await service.read()).printPreferences).toEqual(printPreferences);
    expect(JSON.parse(await readFile(path, "utf8")).printPreferences).toEqual(printPreferences);

    await expect(
      service.update({
        printPreferences: {
          ...printPreferences,
          copies: 2,
          pageRanges: [{ from: 0, to: 0 }],
          scalePercent: 90,
          pagesPerSheet: 2,
          collate: false,
          margins: { mode: "none" },
        },
      } as never),
    ).rejects.toThrow();

    expect(JSON.parse(await readFile(path, "utf8")).printPreferences).toEqual(printPreferences);
  });

  test("falls back without persisting invalid print preferences", async () => {
    const path = join(directory, "settings.json");
    const original = `${JSON.stringify(
      {
        zoomPercent: 100,
        recentDirectory: null,
        windowBounds: null,
        welcomeCompleted: true,
        printPreferences: {
          printerDeviceName: "printer-1",
          duplexMode: "unsupported-mode",
          color: true,
          orientation: "portrait",
          paperSize: "A4",
        },
        patentTemplates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
        backup: DEFAULT_BACKUP_SETTINGS,
        snapshot: DEFAULT_SNAPSHOT_SETTINGS,
      },
      null,
      2,
    )}\n`;
    await writeFile(path, original);
    const service = new SettingsService(path);

    expect(await service.read()).toEqual(DEFAULT_APP_SETTINGS);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("falls back without deleting a corrupt settings file", async () => {
    const path = join(directory, "settings.json");
    await writeFile(path, "not-json");
    const service = new SettingsService(path);

    expect(await service.read()).toEqual(DEFAULT_APP_SETTINGS);
    expect(await readFile(path, "utf8")).toBe("not-json");
  });

  test("migrates a known legacy settings file without losing user preferences", async () => {
    const path = join(directory, "settings.json");
    await writeFile(
      path,
      `${JSON.stringify(
        {
          autosaveMinutes: 30,
          zoomPercent: 135,
          recentDirectory: "C:\\专利资料",
          windowBounds: { x: 12, y: 24, width: 1280, height: 800 },
          welcomeCompleted: true,
        },
        null,
        2,
      )}\n`,
    );
    const service = new SettingsService(path);
    const expected = {
      zoomPercent: 135,
      recentDirectory: "C:\\专利资料",
      windowBounds: { x: 12, y: 24, width: 1280, height: 800 },
      welcomeCompleted: true,
      editorIntroductionSeen: false,
      referenceMarkSyncIntroDismissed: false,
      referenceMarkLocatorEnabled: true,
      inventionContentPrefix: DEFAULT_APP_SETTINGS.inventionContentPrefix,
      closeToTray: true,
      trayIntroDismissed: false,
      autoCheckUpdates: true,
      contentSearchEnabled: true,
      printPreferences: DEFAULT_PRINT_PREFERENCES,
      patentTemplates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
      backup: DEFAULT_BACKUP_SETTINGS,
      snapshot: DEFAULT_SNAPSHOT_SETTINGS,
      pageMargins: DEFAULT_APP_SETTINGS.pageMargins,
      shortcuts: DEFAULT_SHORTCUT_SETTINGS,
      customDualViewPresets: [],
      aiCorrection: DEFAULT_APP_SETTINGS.aiCorrection,
      patentLibraryViewMode: "single",
      drawingDetailDefaultRatio: 2,
      drawingAutoAdjustLabelSize: true,
      drawingAutoLabelScale: 1,
      drawingAnnotationDefaults: { fontSize: 12, lineWidth: 0.3 },
      aiConnectionsEnabled: false,
      aiPolicyAcceptedVersion: null,
      uiScalePercent: 100,
      reducedMotion: false,
      editorColors: DEFAULT_APP_SETTINGS.editorColors,
      dualColumnFlow: { style: "graphite", mode: "boxes", margin: "dust" },
    };

    expect(await service.read()).toEqual(expected);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(expected);
    expect(await service.read()).toEqual(expected);
  });

  test("does not rewrite a legacy-looking settings file with an unknown field", async () => {
    const path = join(directory, "settings.json");
    const original = `${JSON.stringify(
      {
        autosaveMinutes: 5,
        zoomPercent: 135,
        recentDirectory: "C:\\专利资料",
        windowBounds: null,
        welcomeCompleted: true,
        unknownFutureField: "keep-the-original-file",
      },
      null,
      2,
    )}\n`;
    await writeFile(path, original);

    expect(await new SettingsService(path).read()).toEqual(DEFAULT_APP_SETTINGS);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("keeps the legacy file intact when atomic migration cannot be written", async () => {
    const path = join(directory, "settings.json");
    const original = `${JSON.stringify(
      {
        autosaveMinutes: 10,
        zoomPercent: 125,
        recentDirectory: "C:\\案件",
        windowBounds: null,
        welcomeCompleted: true,
      },
      null,
      2,
    )}\n`;
    await writeFile(path, original);
    const writeAtomic = vi.fn(async () => {
      throw new Error("injected atomic write failure");
    });
    const service = new SettingsService(path, writeAtomic);

    expect(await service.read()).toEqual({
      zoomPercent: 125,
      recentDirectory: "C:\\案件",
      windowBounds: null,
      welcomeCompleted: true,
      editorIntroductionSeen: false,
      referenceMarkSyncIntroDismissed: false,
      referenceMarkLocatorEnabled: true,
      inventionContentPrefix: DEFAULT_APP_SETTINGS.inventionContentPrefix,
      closeToTray: true,
      trayIntroDismissed: false,
      autoCheckUpdates: true,
      contentSearchEnabled: true,
      printPreferences: DEFAULT_PRINT_PREFERENCES,
      patentTemplates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
      backup: DEFAULT_BACKUP_SETTINGS,
      snapshot: DEFAULT_SNAPSHOT_SETTINGS,
      pageMargins: DEFAULT_APP_SETTINGS.pageMargins,
      shortcuts: DEFAULT_SHORTCUT_SETTINGS,
      customDualViewPresets: [],
      aiCorrection: DEFAULT_APP_SETTINGS.aiCorrection,
      patentLibraryViewMode: "single",
      drawingDetailDefaultRatio: 2,
      drawingAutoAdjustLabelSize: true,
      drawingAutoLabelScale: 1,
      drawingAnnotationDefaults: { fontSize: 12, lineWidth: 0.3 },
      aiConnectionsEnabled: false,
      aiPolicyAcceptedVersion: null,
      uiScalePercent: 100,
      reducedMotion: false,
      editorColors: DEFAULT_APP_SETTINGS.editorColors,
      dualColumnFlow: { style: "graphite", mode: "boxes", margin: "dust" },
    });
    expect(writeAtomic).toHaveBeenCalledOnce();
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("adds factory patent templates without losing v1 preferences", async () => {
    const path = join(directory, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        zoomPercent: 125,
        recentDirectory: "D:\\exports",
        windowBounds: { x: 10, y: 20, width: 1200, height: 800 },
        welcomeCompleted: true,
      }),
    );
    const service = new SettingsService(path);

    const settings = await service.read();
    expect(settings.zoomPercent).toBe(125);
    expect(settings.welcomeCompleted).toBe(true);
    expect(settings.patentTemplates).toEqual(DEFAULT_PATENT_TEMPLATE_SETTINGS);
  });

  test("updates the complete template set atomically", async () => {
    const service = new SettingsService(join(directory, "settings.json"));
    const next = structuredClone(DEFAULT_PATENT_TEMPLATE_SETTINGS);
    const first = next.invention.claims.content[0];
    if (first?.type !== "paragraph") throw new Error("claims template paragraph missing");
    first.content = [
      { type: "text", text: "1. 一种{{patentName}}，包括：", marks: [{ type: "bold" }] },
    ];

    const saved = await service.update({ patentTemplates: next });

    expect(saved.patentTemplates.invention.claims).toEqual(next.invention.claims);
  });

  test("rejects partial template sets", async () => {
    const service = new SettingsService(join(directory, "settings.json"));

    await expect(
      service.update({
        patentTemplates: { invention: DEFAULT_PATENT_TEMPLATE_SETTINGS.invention },
      } as never),
    ).rejects.toThrow();
  });

  test("keeps existing settings readable when an atomic template update fails", async () => {
    const path = join(directory, "settings.json");
    const persisted = { ...DEFAULT_APP_SETTINGS, zoomPercent: 125 };
    await writeFile(path, JSON.stringify(persisted));
    const writeAtomic = vi.fn(async () => {
      throw new Error("injected atomic write failure");
    });
    const service = new SettingsService(path, writeAtomic);
    const next = structuredClone(DEFAULT_PATENT_TEMPLATE_SETTINGS);
    next.invention.claims.content = [];

    await expect(service.update({ patentTemplates: next })).rejects.toThrow();
    expect(await new SettingsService(path).read()).toEqual(persisted);
  });

  test("adds Word default page margins when a settings file predates the setting", async () => {
    const path = join(directory, "settings.json");
    await writeFile(
      path,
      `${JSON.stringify(
        {
          zoomPercent: 118,
          recentDirectory: "C:\\专利资料",
          windowBounds: null,
          welcomeCompleted: true,
          printPreferences: DEFAULT_PRINT_PREFERENCES,
          patentTemplates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
          backup: DEFAULT_BACKUP_SETTINGS,
          snapshot: DEFAULT_SNAPSHOT_SETTINGS,
        },
        null,
        2,
      )}\n`,
    );
    const service = new SettingsService(path);

    const settings = await service.read();
    expect(settings.zoomPercent).toBe(118);
    expect(settings.welcomeCompleted).toBe(true);
    expect(settings.pageMargins).toEqual(DEFAULT_APP_SETTINGS.pageMargins);
    expect(JSON.parse(await readFile(path, "utf8")).pageMargins).toEqual(
      DEFAULT_APP_SETTINGS.pageMargins,
    );
    expect(await service.read()).toEqual(settings);
  });

  test("preserves stored page margins while filling other missing settings", async () => {
    const path = join(directory, "settings.json");
    const customMargins = {
      marginTopMm: 30,
      marginRightMm: 20,
      marginBottomMm: 30,
      marginLeftMm: 20,
    };
    await writeFile(
      path,
      `${JSON.stringify(
        {
          zoomPercent: 100,
          recentDirectory: null,
          windowBounds: null,
          welcomeCompleted: true,
          pageMargins: customMargins,
        },
        null,
        2,
      )}\n`,
    );
    const service = new SettingsService(path);

    const settings = await service.read();
    expect(settings.pageMargins).toEqual(customMargins);
    expect(settings.printPreferences).toEqual(DEFAULT_PRINT_PREFERENCES);
    expect(settings.patentTemplates).toEqual(DEFAULT_PATENT_TEMPLATE_SETTINGS);
    expect(settings.backup).toEqual(DEFAULT_BACKUP_SETTINGS);
    expect(settings.snapshot).toEqual(DEFAULT_SNAPSHOT_SETTINGS);
  });

  test("still rejects unknown keys even when pageMargins is present", async () => {
    const path = join(directory, "settings.json");
    const original = `${JSON.stringify(
      {
        zoomPercent: 100,
        recentDirectory: null,
        windowBounds: null,
        welcomeCompleted: true,
        pageMargins: DEFAULT_APP_SETTINGS.pageMargins,
        unknownFutureField: "keep-the-original-file",
      },
      null,
      2,
    )}\n`;
    await writeFile(path, original);

    expect(await new SettingsService(path).read()).toEqual(DEFAULT_APP_SETTINGS);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("falls back to defaults when stored pageMargins are out of range", async () => {
    const path = join(directory, "settings.json");
    const original = `${JSON.stringify(
      {
        zoomPercent: 100,
        recentDirectory: null,
        windowBounds: null,
        welcomeCompleted: true,
        printPreferences: DEFAULT_PRINT_PREFERENCES,
        patentTemplates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
        backup: DEFAULT_BACKUP_SETTINGS,
        snapshot: DEFAULT_SNAPSHOT_SETTINGS,
        pageMargins: {
          marginTopMm: 60.1,
          marginRightMm: 31.7,
          marginBottomMm: 25.4,
          marginLeftMm: 31.7,
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(path, original);

    // 单边超过 60mm 属于非法值：严格 schema 校验失败，与其它非法字段行为一致回退默认，
    // 不重写原文件（避免把非法值传播出去）。
    expect(await new SettingsService(path).read()).toEqual(DEFAULT_APP_SETTINGS);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("serializes independent backup and snapshot updates without losing either change", async () => {
    const path = join(directory, "settings.json");
    await writeFile(path, `${JSON.stringify(DEFAULT_APP_SETTINGS, null, 2)}\n`, "utf8");
    const delayedWriter = async (filename: string, data: string | Buffer) => {
      const settings = JSON.parse(data.toString()) as typeof DEFAULT_APP_SETTINGS;
      if (settings.backup.enabled) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      await writeFile(filename, data);
    };
    const service = new SettingsService(path, delayedWriter);

    await Promise.all([
      service.update({
        backup: { enabled: true, folder: directory, intervalMinutes: 1 },
      }),
      service.update({
        snapshot: { enabled: false, intervalMinutes: 10 },
      }),
    ]);

    const persisted = JSON.parse(await readFile(path, "utf8")) as typeof DEFAULT_APP_SETTINGS;
    expect(persisted.backup.enabled).toBe(true);
    expect(persisted.snapshot.enabled).toBe(false);
  });

  test("migrates development-era snapshot settings without maxCount", async () => {
    const path = join(directory, "settings.json");
    const legacy = {
      ...structuredClone(DEFAULT_APP_SETTINGS),
      snapshot: { enabled: false, intervalMinutes: 1, maxCount: 50 },
    };
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const service = new SettingsService(path);

    await expect(service.read()).resolves.toMatchObject({
      snapshot: { enabled: false, intervalMinutes: 5 },
    });
    expect((await service.read()).snapshot).toEqual({ enabled: false, intervalMinutes: 5 });
    expect(JSON.parse(await readFile(path, "utf8")).snapshot).toEqual({
      enabled: false,
      intervalMinutes: 5,
    });
  });

  test("restores corrupt settings from the last-good copy and reports the recovery", async () => {
    const path = join(directory, "settings.json");
    const recovered = {
      ...structuredClone(DEFAULT_APP_SETTINGS),
      welcomeCompleted: true,
      backup: { enabled: true, folder: directory, intervalMinutes: 3 },
    };
    await writeFile(path, "corrupt-settings", "utf8");
    await writeFile(`${path}.last-good`, `${JSON.stringify(recovered, null, 2)}\n`, "utf8");
    const service = new SettingsService(path);

    await expect(service.read()).resolves.toEqual(recovered);
    expect(service.status()).toEqual({
      state: "recovered",
      message: "设置文件损坏，已从最后一次有效设置恢复。",
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(recovered);
    expect(
      (await readdir(directory)).some((name) => name.startsWith("settings.json.corrupt-")),
    ).toBe(true);
  });

  test("seeds a last-good copy when an existing valid settings file is first read", async () => {
    const path = join(directory, "settings.json");
    const existing = {
      ...structuredClone(DEFAULT_APP_SETTINGS),
      backup: { enabled: true, folder: directory, intervalMinutes: 3 },
    };
    await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
    const service = new SettingsService(path);

    await expect(service.read()).resolves.toEqual(existing);
    expect(JSON.parse(await readFile(`${path}.last-good`, "utf8"))).toEqual(existing);
  });

  test("returns to healthy status after the user successfully saves settings", async () => {
    const path = join(directory, "settings.json");
    await writeFile(path, "corrupt-settings", "utf8");
    const service = new SettingsService(path);
    await service.read();
    expect(service.status().state).toBe("degraded");

    await service.update({ welcomeCompleted: true });

    expect(service.status()).toEqual({ state: "healthy", message: null });
  });

  test("reports degraded protection when corrupt settings have no recoverable copy", async () => {
    const path = join(directory, "settings.json");
    await writeFile(path, "corrupt-settings", "utf8");
    const service = new SettingsService(path);

    await expect(service.read()).resolves.toEqual(DEFAULT_APP_SETTINGS);
    expect(service.status()).toEqual({
      state: "degraded",
      message: "设置文件损坏且没有有效备份，数据安全设置已回退为默认值，请立即重新确认。",
    });
    expect(await readFile(path, "utf8")).toBe("corrupt-settings");
  });
  test("persists editor introduction once across restart and unrelated settings changes", async () => {
    const path = join(directory, "settings.json");
    const service = new SettingsService(path);
    await service.update({ editorIntroductionSeen: true });
    await service.update({ zoomPercent: 120 });
    expect((await new SettingsService(path).read()).editorIntroductionSeen).toBe(true);
  });
});

test("migrates default update detection and persists opt-out across restart and unrelated changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "settings-updates-"));
  const path = join(root, "settings.json");
  const old = { ...DEFAULT_APP_SETTINGS } as Record<string, unknown>;
  delete old.autoCheckUpdates;
  await writeFile(path, JSON.stringify(old));
  const settings = new SettingsService(path);
  expect((await settings.read()).autoCheckUpdates).toBe(true);
  await settings.update({ autoCheckUpdates: false });
  await settings.update({ zoomPercent: 100 });
  expect((await new SettingsService(path).read()).autoCheckUpdates).toBe(false);
});
