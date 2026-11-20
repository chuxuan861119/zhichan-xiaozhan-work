import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { AI_PROVIDER_PRESETS, type AiModelProfile } from "../ai-correction/model.js";
import { type AppSettings, AppSettingsSchema, DEFAULT_APP_SETTINGS } from "../settings/model.js";
import {
  mergePortableSettings,
  type PortableSettings,
  PortableSettingsSchema,
  projectPortableSettings,
  SETTING_TRANSFER_POLICY,
} from "./portable-settings.js";

const CUSTOM_ID = "00000000-0000-4000-8000-000000000101";
const PRESET_ID = "00000000-0000-4000-8000-000000000102";
const LOCAL_PRESET_ID = "00000000-0000-4000-8000-000000000103";
const REMAPPED_ID = "00000000-0000-4000-8000-000000000104";
const MISSING_ID = "00000000-0000-4000-8000-000000000105";

test("all settings are classified and all portable fields are projected", () => {
  const portable = projectPortableSettings(DEFAULT_APP_SETTINGS);
  expect(Object.keys(SETTING_TRANSFER_POLICY).sort()).toEqual(
    [...AppSettingsSchema.keyof().options].sort(),
  );
  for (const [key, policy] of Object.entries(SETTING_TRANSFER_POLICY)) {
    if (policy === "portable" || policy === "mixed") expect(portable).toHaveProperty(key);
    else expect(portable).not.toHaveProperty(key);
  }
});
test("old version-one settings without newly portable fields preserve target values", () => {
  const {
    editorColors: _colors,
    drawingDetailDefaultRatio: _ratio,
    inventionContentPrefix: _prefix,
    ...old
  } = projectPortableSettings(DEFAULT_APP_SETTINGS);
  const target = {
    ...DEFAULT_APP_SETTINGS,
    drawingDetailDefaultRatio: 4,
    inventionContentPrefix: "优选地，",
  };
  const merged = mergePortableSettings(
    target,
    PortableSettingsSchema.parse(old),
    () => REMAPPED_ID,
  );
  expect(merged.editorColors).toEqual(target.editorColors);
  expect(merged.drawingDetailDefaultRatio).toBe(4);
  expect(merged.inventionContentPrefix).toBe(target.inventionContentPrefix);
});

test("roundtrips editing colors, CAD detail ratio and invention prefix without resetting local fields", () => {
  const source = {
    ...DEFAULT_APP_SETTINGS,
    editorColors: { page: "#e7f1e5", canvas: "#354b43", panel: "#e7f1e5", panelFollowsPage: true },
    drawingDetailDefaultRatio: 3,
    inventionContentPrefix: "优选地，",
  };
  const target = { ...DEFAULT_APP_SETTINGS, closeToTray: false, trayIntroDismissed: true };
  const merged = mergePortableSettings(target, projectPortableSettings(source), () => REMAPPED_ID);
  expect(merged.editorColors).toEqual(source.editorColors);
  expect(merged.drawingDetailDefaultRatio).toBe(3);
  expect(merged.inventionContentPrefix).toBe("优选地，");
  expect(merged.closeToTray).toBe(false);
  expect(merged.trayIntroDismissed).toBe(true);
});

test("keeps the local CAD export preference when importing portable settings", () => {
  const current = { ...DEFAULT_APP_SETTINGS, drawingAutoAdjustLabelSize: true };
  expect(
    mergePortableSettings(current, projectPortableSettings(DEFAULT_APP_SETTINGS), () => REMAPPED_ID)
      .drawingAutoAdjustLabelSize,
  ).toBe(true);
});

test("migrates the content indexing preference independently of the local cache", () => {
  const portable = projectPortableSettings({ ...DEFAULT_APP_SETTINGS, contentSearchEnabled: true });
  expect(portable.contentSearchEnabled).toBe(true);
  const merged = mergePortableSettings(DEFAULT_APP_SETTINGS, portable, () => REMAPPED_ID);
  expect(merged.contentSearchEnabled).toBe(true);
  expect(
    PortableSettingsSchema.safeParse({ ...portable, contentSearchCache: "local-cache" }).success,
  ).toBe(false);
});

function presetProfile(profileId = PRESET_ID): AiModelProfile {
  const preset = AI_PROVIDER_PRESETS.find(({ providerId }) => providerId === "deepseek");
  if (!preset) throw new Error("DeepSeek preset is required by the test fixture.");
  return {
    profileId,
    providerId: preset.providerId,
    displayName: preset.label,
    baseUrl: preset.baseUrl,
    model: preset.models[0].id,
  };
}

function customProfile(profileId = CUSTOM_ID): AiModelProfile {
  return {
    profileId,
    providerId: "custom",
    displayName: "本机私有服务",
    baseUrl: "https://private.example.com/v1",
    model: "private-model",
  };
}

function currentSettings(): AppSettings {
  const current = structuredClone(DEFAULT_APP_SETTINGS);
  current.zoomPercent = 135;
  current.dualColumnFlow = { style: "ceramic", mode: "boxes", margin: "threads" };
  current.recentDirectory = "D:\\客户专利";
  current.windowBounds = { x: 10, y: 20, width: 1200, height: 800 };
  current.welcomeCompleted = true;
  current.editorIntroductionSeen = true;
  current.referenceMarkSyncIntroDismissed = true;
  current.printPreferences = {
    printerDeviceName: "Office Printer",
    duplexMode: "longEdge",
    color: false,
    orientation: "landscape",
    paperSize: "A3",
  };
  current.backup = { enabled: true, folder: "E:\\实时备份", intervalMinutes: 15 };
  current.snapshot = { enabled: false, intervalMinutes: 10 };
  current.pageMargins = {
    marginTopMm: 20,
    marginRightMm: 21,
    marginBottomMm: 22,
    marginLeftMm: 23,
  };
  current.shortcuts["check-problems"] = "Ctrl+Alt+P";
  current.customDualViewPresets = [{ leftBookKind: "claims", rightBookKind: "description" }];
  current.aiCorrection = {
    enabled: true,
    activeProfileId: CUSTOM_ID,
    profiles: [presetProfile(), customProfile()],
    deepseekThinkingEnabled: false,
    timeoutMs: 90_000,
    maxUploadCharacters: 75_000,
  };
  return current;
}

function portableWithPreset(profileId = PRESET_ID): PortableSettings {
  const portable = projectPortableSettings(currentSettings());
  return PortableSettingsSchema.parse({
    ...portable,
    referenceMarkSyncIntroDismissed: false,
    printPreferences: {
      duplexMode: "shortEdge",
      color: true,
      orientation: "portrait",
      paperSize: "A5",
    },
    patentTemplates: { ...portable.patentTemplates, enabled: false },
    backup: { intervalMinutes: 30 },
    snapshot: { enabled: true, intervalMinutes: 30 },
    pageMargins: {
      marginTopMm: 12,
      marginRightMm: 13,
      marginBottomMm: 14,
      marginLeftMm: 15,
    },
    shortcuts: { ...portable.shortcuts, "check-problems": "Ctrl+Alt+C" },
    customDualViewPresets: [{ leftBookKind: "abstract", rightBookKind: "description-drawings" }],
    aiCorrection: {
      activeProfileId: profileId,
      profiles: [presetProfile(profileId)],
      deepseekThinkingEnabled: true,
      timeoutMs: 45_000,
      maxUploadCharacters: 40_000,
    },
  });
}

function assertReadonlyContracts(portable: PortableSettings) {
  // @ts-expect-error Portable settings are immutable transfer snapshots.
  portable.version = 2;
  // @ts-expect-error Nested settings records are immutable snapshots.
  portable.backup.intervalMinutes = 60;
  // @ts-expect-error Profile collections cannot be changed after validation.
  portable.aiCorrection.profiles.push(presetProfile());
  const profile = portable.aiCorrection.profiles[0];
  if (profile) {
    // @ts-expect-error Imported profile records are immutable snapshots.
    profile.baseUrl = "https://attacker.example.com";
  }
  const claims = portable.patentTemplates.invention.claims;
  // @ts-expect-error Nested template collections are recursively readonly.
  claims.content = [];
  // @ts-expect-error Nested template arrays cannot be appended to.
  claims.content.push();
  const block = claims.content[0];
  if (block?.type === "paragraph") {
    // @ts-expect-error Nested template blocks are recursively readonly.
    block.id = "changed";
    // @ts-expect-error Inline content collections are recursively readonly.
    block.content = [];
    const inlineNode = block.content[0];
    if (inlineNode?.type === "text") {
      // @ts-expect-error Deep text nodes are recursively readonly.
      inlineNode.text = "changed";
    }
  }
  const preset = portable.customDualViewPresets[0];
  if (preset) {
    // @ts-expect-error Preset elements are recursively readonly.
    preset.leftBookKind = "abstract";
  }
}

void assertReadonlyContracts;

test("importing portable settings preserves this computer's AI privacy and display preferences", () => {
  const current = {
    ...currentSettings(),
    aiConnectionsEnabled: false,
    aiPolicyAcceptedVersion: "2026-10-05",
    uiScalePercent: 125,
    reducedMotion: true,
  };
  const merged = mergePortableSettings(current, portableWithPreset(), () => REMAPPED_ID);
  expect(merged).toMatchObject({
    aiConnectionsEnabled: false,
    aiPolicyAcceptedVersion: "2026-10-05",
    uiScalePercent: 125,
    reducedMotion: true,
  });
});

describe("portable settings projection", () => {
  test("projects only the explicit portable whitelist and filters custom AI state", () => {
    const current = currentSettings() as AppSettings & {
      credentialProfileIds?: string[];
      apiKey?: string;
    };
    current.credentialProfileIds = [CUSTOM_ID];
    current.apiKey = "secret";

    const projected = projectPortableSettings(current);

    expect(projected).toMatchObject({
      version: 1,
      referenceMarkSyncIntroDismissed: true,
      printPreferences: {
        duplexMode: "longEdge",
        color: false,
        orientation: "landscape",
        paperSize: "A3",
      },
      backup: { intervalMinutes: 15 },
      patentTemplates: current.patentTemplates,
      snapshot: current.snapshot,
      pageMargins: current.pageMargins,
      shortcuts: current.shortcuts,
      customDualViewPresets: current.customDualViewPresets,
      aiCorrection: {
        activeProfileId: null,
        profiles: [presetProfile()],
        deepseekThinkingEnabled: false,
        timeoutMs: 90_000,
        maxUploadCharacters: 75_000,
      },
    });
    for (const excluded of [
      "zoomPercent",
      "recentDirectory",
      "windowBounds",
      "welcomeCompleted",
      "editorIntroductionSeen",
      "credentialProfileIds",
      "apiKey",
    ]) {
      expect(projected).not.toHaveProperty(excluded);
    }
    expect(projected.printPreferences).not.toHaveProperty("printerDeviceName");
    expect(projected.backup).not.toHaveProperty("enabled");
    expect(projected.backup).not.toHaveProperty("folder");
    expect(JSON.stringify(projected)).not.toContain("private.example.com");
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.backup)).toBe(true);
    expect(Object.isFrozen(projected.aiCorrection)).toBe(true);
    expect(Object.isFrozen(projected.aiCorrection.profiles)).toBe(true);
    expect(Object.isFrozen(projected.aiCorrection.profiles[0])).toBe(true);
  });

  test("keeps an active preset profile selected", () => {
    const current = currentSettings();
    current.aiCorrection.activeProfileId = PRESET_ID;

    expect(projectPortableSettings(current).aiCorrection.activeProfileId).toBe(PRESET_ID);
  });

  test("rejects malformed preset URLs instead of silently omitting the preset", () => {
    const current = currentSettings();
    current.aiCorrection.profiles = [
      { ...presetProfile(), baseUrl: "https://private.example.com/v1" },
    ];
    current.aiCorrection.activeProfileId = PRESET_ID;

    expect(() => projectPortableSettings(current)).toThrow("预置提供商地址不可修改。");
  });

  test("deep-freezes cloned template and dual-view trees without freezing current settings", () => {
    const current = currentSettings();
    const currentClaims = current.patentTemplates.invention.claims;
    const currentBlock = currentClaims.content[0];
    if (currentBlock?.type !== "paragraph") throw new Error("claims paragraph fixture missing");
    const currentText = currentBlock.content[0];
    if (currentText?.type !== "text") throw new Error("claims text fixture missing");
    const currentPreset = current.customDualViewPresets[0];
    if (!currentPreset) throw new Error("dual-view preset fixture missing");

    const portable = projectPortableSettings(current);
    const claims = portable.patentTemplates.invention.claims;
    const block = claims.content[0];
    if (block?.type !== "paragraph") throw new Error("portable claims paragraph missing");
    const text = block.content[0];
    if (text?.type !== "text") throw new Error("portable claims text missing");

    expect(portable.patentTemplates).not.toBe(current.patentTemplates);
    expect(portable.patentTemplates.invention).not.toBe(current.patentTemplates.invention);
    expect(claims).not.toBe(currentClaims);
    expect(claims.content).not.toBe(currentClaims.content);
    expect(block).not.toBe(currentBlock);
    expect(block.content).not.toBe(currentBlock.content);
    expect(text).not.toBe(currentText);
    expect(portable.customDualViewPresets).not.toBe(current.customDualViewPresets);
    expect(portable.customDualViewPresets[0]).not.toBe(current.customDualViewPresets[0]);

    for (const value of [
      portable.patentTemplates,
      portable.patentTemplates.invention,
      claims,
      claims.content,
      block,
      block.content,
      text,
      portable.customDualViewPresets,
      portable.customDualViewPresets[0],
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    for (const value of [
      current.patentTemplates,
      current.patentTemplates.invention,
      currentClaims,
      currentClaims.content,
      currentBlock,
      currentBlock.content,
      currentText,
      current.customDualViewPresets,
      current.customDualViewPresets[0],
    ]) {
      expect(Object.isFrozen(value)).toBe(false);
    }

    const portableTextBefore = text.text;
    currentText.text = "本机继续编辑";
    currentPreset.leftBookKind = "abstract";
    expect(currentText.text).toBe("本机继续编辑");
    expect(text.text).toBe(portableTextBefore);
    expect(portable.customDualViewPresets[0]?.leftBookKind).toBe("claims");
    expect(() => {
      (claims.content as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      (text as { text: string }).text = "篡改迁移快照";
    }).toThrow(TypeError);
    expect(() => {
      (portable.customDualViewPresets[0] as { leftBookKind: string }).leftBookKind = "abstract";
    }).toThrow(TypeError);
  });
});

describe("portable settings schema", () => {
  test("is strict at the top level and nested boundaries", () => {
    const portable = projectPortableSettings(currentSettings());
    expect(PortableSettingsSchema.safeParse({ ...portable, zoomPercent: 100 }).success).toBe(false);
    expect(
      PortableSettingsSchema.safeParse({
        ...portable,
        backup: { ...portable.backup, folder: "D:\\leak" },
      }).success,
    ).toBe(false);
    expect(
      PortableSettingsSchema.safeParse({
        ...portable,
        aiCorrection: { ...portable.aiCorrection, enabled: true },
      }).success,
    ).toBe(false);
  });

  test("rejects custom profiles and preset providers with forged private URLs", () => {
    const portable = projectPortableSettings(currentSettings());
    expect(
      PortableSettingsSchema.safeParse({
        ...portable,
        aiCorrection: { ...portable.aiCorrection, profiles: [customProfile()] },
      }).success,
    ).toBe(false);
    expect(
      PortableSettingsSchema.safeParse({
        ...portable,
        aiCorrection: {
          ...portable.aiCorrection,
          profiles: [{ ...presetProfile(), baseUrl: "https://private.example.com/v1" }],
        },
      }).success,
    ).toBe(false);
  });

  test("rejects duplicate imported profile IDs", () => {
    const portable = projectPortableSettings(currentSettings());
    expect(
      PortableSettingsSchema.safeParse({
        ...portable,
        aiCorrection: {
          ...portable.aiCorrection,
          profiles: [presetProfile(), presetProfile()],
        },
      }).success,
    ).toBe(false);
  });

  test("infers readonly profile collections", () => {
    expectTypeOf<PortableSettings["aiCorrection"]["profiles"]>().toEqualTypeOf<
      readonly Readonly<AiModelProfile>[]
    >();
  });
});

describe("portable settings merge", () => {
  test("overwrites portable fields while preserving machine state and excluding unsupported AI", () => {
    const current = currentSettings();
    current.patentLibraryViewMode = "double";
    current.aiCorrection.activeProfileId = CUSTOM_ID;
    const localPreset = presetProfile(LOCAL_PRESET_ID);
    current.aiCorrection.profiles = [customProfile(), localPreset];
    const portable = portableWithPreset();

    const merged = mergePortableSettings(current, portable, () => REMAPPED_ID);

    expect(merged).toMatchObject({
      zoomPercent: 135,
      dualColumnFlow: { style: "ceramic", mode: "boxes", margin: "threads" },
      patentLibraryViewMode: "double",
      recentDirectory: "D:\\客户专利",
      windowBounds: { x: 10, y: 20, width: 1200, height: 800 },
      welcomeCompleted: true,
      editorIntroductionSeen: true,
      referenceMarkSyncIntroDismissed: false,
      printPreferences: {
        printerDeviceName: "Office Printer",
        duplexMode: "shortEdge",
        color: true,
        orientation: "portrait",
        paperSize: "A5",
      },
      backup: { enabled: false, folder: null, intervalMinutes: 30 },
      patentTemplates: portable.patentTemplates,
      snapshot: portable.snapshot,
      pageMargins: portable.pageMargins,
      shortcuts: portable.shortcuts,
      customDualViewPresets: portable.customDualViewPresets,
      aiCorrection: {
        enabled: false,
        activeProfileId: PRESET_ID,
        profiles: [presetProfile()],
        deepseekThinkingEnabled: true,
        timeoutMs: 45_000,
        maxUploadCharacters: 40_000,
      },
    });
    expect(merged.aiCorrection.profiles).not.toContainEqual(localPreset);
  });

  test("remaps imported preset IDs that conflict with local custom credential associations", () => {
    const current = currentSettings();
    current.aiCorrection.profiles = [customProfile(PRESET_ID)];
    current.aiCorrection.activeProfileId = PRESET_ID;
    const portable = portableWithPreset(PRESET_ID);
    const createId = vi.fn().mockReturnValueOnce(PRESET_ID).mockReturnValueOnce(REMAPPED_ID);

    const merged = mergePortableSettings(current, portable, createId);

    expect(createId).toHaveBeenCalledTimes(2);
    expect(merged.aiCorrection.profiles).toEqual([presetProfile(REMAPPED_ID)]);
    expect(merged.aiCorrection.activeProfileId).toBe(REMAPPED_ID);
  });

  test("fails fast when the injected ID factory returns a non-UUID", () => {
    const current = currentSettings();
    current.aiCorrection.profiles = [customProfile(PRESET_ID)];

    expect(() =>
      mergePortableSettings(current, portableWithPreset(), () => "not-a-uuid"),
    ).toThrow();
  });

  test("fails fast when the ID factory repeats an occupied UUID without modifying inputs", () => {
    const current = currentSettings();
    current.aiCorrection.profiles = [customProfile(PRESET_ID)];
    const portable = portableWithPreset();
    const currentBefore = structuredClone(current);
    const portableBefore = structuredClone(portable);
    const createId = vi.fn(() => {
      if (createId.mock.calls.length > 4) throw new Error("test runaway guard");
      return PRESET_ID;
    });

    expect(() => mergePortableSettings(current, portable, createId)).toThrow(
      "ID factory repeated an occupied profile UUID.",
    );
    expect(createId).toHaveBeenCalledTimes(2);
    expect(current).toEqual(currentBefore);
    expect(portable).toEqual(portableBefore);
  });

  test("continues through distinct occupied UUIDs without an arbitrary retry limit", () => {
    const current = currentSettings();
    current.aiCorrection.profiles = [
      customProfile(PRESET_ID),
      customProfile(CUSTOM_ID),
      customProfile(LOCAL_PRESET_ID),
    ];
    const createId = vi
      .fn()
      .mockReturnValueOnce(CUSTOM_ID)
      .mockReturnValueOnce(LOCAL_PRESET_ID)
      .mockReturnValueOnce(REMAPPED_ID);

    const merged = mergePortableSettings(current, portableWithPreset(), createId);

    expect(createId).toHaveBeenCalledTimes(3);
    expect(merged.aiCorrection.profiles.at(-1)).toEqual(presetProfile(REMAPPED_ID));
    expect(merged.aiCorrection.activeProfileId).toBe(REMAPPED_ID);
  });

  test("does not retain unsupported active profiles when imported active is missing", () => {
    const portable = PortableSettingsSchema.parse({
      ...portableWithPreset(),
      aiCorrection: { ...portableWithPreset().aiCorrection, activeProfileId: MISSING_ID },
    });
    const customActive = currentSettings();
    customActive.aiCorrection.profiles = [customProfile(), presetProfile(LOCAL_PRESET_ID)];
    customActive.aiCorrection.activeProfileId = CUSTOM_ID;
    expect(
      mergePortableSettings(customActive, portable, () => REMAPPED_ID).aiCorrection.activeProfileId,
    ).toBeNull();

    customActive.aiCorrection.activeProfileId = LOCAL_PRESET_ID;
    expect(
      mergePortableSettings(customActive, portable, () => REMAPPED_ID).aiCorrection.activeProfileId,
    ).toBeNull();
  });

  test("validates portable input without modifying either input", () => {
    const current = currentSettings();
    const portable = portableWithPreset();
    const currentBefore = structuredClone(current);
    const portableBefore = structuredClone(portable);

    mergePortableSettings(current, portable, () => REMAPPED_ID);

    expect(current).toEqual(currentBefore);
    expect(portable).toEqual(portableBefore);
    expect(() =>
      mergePortableSettings(
        current,
        { ...portable, backup: { intervalMinutes: 30, folder: "D:\\leak" } } as PortableSettings,
        () => REMAPPED_ID,
      ),
    ).toThrow();
  });

  test("round-trips portable semantics through parse and merge", () => {
    const source = currentSettings();
    source.aiCorrection.activeProfileId = PRESET_ID;
    source.referenceMarkLocatorEnabled = false;
    const portable = PortableSettingsSchema.parse(projectPortableSettings(source));

    const merged = mergePortableSettings(currentSettings(), portable, () => REMAPPED_ID);

    expect(projectPortableSettings(merged)).toEqual(portable);
  });

  test("imports legacy portable settings with the locator enabled by default", () => {
    const portable = projectPortableSettings(currentSettings());
    const legacyPortable = structuredClone(portable) as Record<string, unknown>;
    delete legacyPortable.referenceMarkLocatorEnabled;

    const parsed = PortableSettingsSchema.parse(legacyPortable);

    expect(parsed.referenceMarkLocatorEnabled).toBe(true);
  });
});

test("importing portable settings preserves this device's saved drawing defaults", () => {
  const current = structuredClone(DEFAULT_APP_SETTINGS);
  current.drawingAnnotationDefaults = { fontSize: 18, lineWidth: 0.5 };
  const merged = mergePortableSettings(
    current,
    projectPortableSettings(DEFAULT_APP_SETTINGS),
    () => "00000000-0000-4000-8000-000000000001",
  );
  expect(merged.drawingAnnotationDefaults).toEqual(current.drawingAnnotationDefaults);
});

test("remaps imported profiles against retired credential identities after legacy settings were filtered", () => {
  const current = currentSettings();
  current.aiCorrection.profiles = [];
  current.aiCorrection.activeProfileId = null;
  current.aiCorrection.retiredProfileIds = [PRESET_ID];
  const merged = mergePortableSettings(current, portableWithPreset(PRESET_ID), () => REMAPPED_ID);
  expect(merged.aiCorrection.profiles[0]?.profileId).toBe(REMAPPED_ID);
  expect(merged.aiCorrection.retiredProfileIds).toEqual([PRESET_ID]);
});

test("can read an old backup with removed providers without making them callable", () => {
  const original = portableWithPreset();
  const legacy = PortableSettingsSchema.parse({
    ...original,
    aiCorrection: {
      ...original.aiCorrection,
      profiles: [
        {
          ...presetProfile(),
          providerId: "openai",
          baseUrl: "https://api.openai.com/v1",
          model: "old-model",
        },
      ],
    },
  });
  const current = currentSettings();
  current.aiCorrection.profiles = [];
  current.aiCorrection.activeProfileId = null;
  const merged = mergePortableSettings(current, legacy, () => REMAPPED_ID);
  expect(merged.aiCorrection.profiles).toEqual([]);
  expect(merged.aiCorrection.activeProfileId).toBeNull();
  expect(merged.aiCorrection.enabled).toBe(false);
  expect(merged.aiCorrection.retiredProfileIds).toContain(PRESET_ID);
});

test("portable migration preserves the target device update-network preference", () => {
  const source = { ...DEFAULT_APP_SETTINGS, autoCheckUpdates: true };
  const target = { ...DEFAULT_APP_SETTINGS, autoCheckUpdates: false };
  const portable = projectPortableSettings(source);
  expect(portable).not.toHaveProperty("autoCheckUpdates");
  expect(mergePortableSettings(target, portable, () => REMAPPED_ID).autoCheckUpdates).toBe(false);
});
