import { describe, expect, test, vi } from "vitest";
import {
  CUSTOM_SHORTCUT_ACTIONS,
  DEFAULT_SHORTCUT_SETTINGS,
  FIXED_SHORTCUTS,
  normalizeShortcutInput,
  PartialShortcutSettingsSchema,
  ShortcutSettingsSchema,
  shortcutConflicts,
  shortcutMatchesInput,
  shortcutTooltip,
} from "./shortcuts.js";

test.each(["win32", "darwin", "openharmony"])(
  "custom hint keys remain literal on %s",
  (platform) => {
    vi.stubGlobal("documentFontPlatform", platform);
    try {
      expect(
        shortcutTooltip({
          label: "测试",
          shortcuts: ["Ctrl+,"],
          visibleLabel: true,
          binding: "custom",
        }),
      ).toBe(platform === "darwin" ? "⌘+," : "Ctrl+,");
      expect(shortcutTooltip({ label: "下标", shortcuts: ["Ctrl+,"], visibleLabel: true })).toBe(
        platform === "darwin" ? "⌘+⌥+," : "Ctrl+,",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

test("Mac records physical Control separately and keeps bindings portable", () => {
  expect(normalizeShortcutInput({ code: "KeyK", ctrlKey: true }, "darwin")).toEqual({
    ok: true,
    value: "Control+K",
  });
  expect(normalizeShortcutInput({ code: "KeyK", metaKey: true }, "darwin")).toEqual({
    ok: true,
    value: "Ctrl+K",
  });
  expect(PartialShortcutSettingsSchema.parse({ "check-problems": "Control+K" })).toEqual({
    "check-problems": "Control+K",
  });
  expect(shortcutMatchesInput("Control+K", { code: "KeyK", ctrlKey: true }, "darwin")).toBe(true);
  expect(shortcutMatchesInput("Control+K", { code: "KeyK", metaKey: true }, "darwin")).toBe(false);
  expect(shortcutMatchesInput("Ctrl+K", { code: "KeyK", ctrlKey: true }, "darwin")).toBe(false);
  expect(shortcutMatchesInput("Control+K", { code: "KeyK", ctrlKey: true }, "win32")).toBe(true);
});

test.each([
  ["Ctrl+W", "关闭窗口"],
  ["Ctrl+,", "设置"],
  ["Ctrl+Alt+,", "下标"],
  ["Control+Tab", "下一个文档"],
])("reserves the actual Mac binding %s", (shortcut, label) => {
  expect(
    shortcutConflicts(DEFAULT_SHORTCUT_SETTINGS, "check-problems", shortcut!, "darwin"),
  ).toEqual({ label, shortcut });
});

test("physical Control aliases are checked against Windows bindings", () => {
  expect(
    shortcutConflicts(DEFAULT_SHORTCUT_SETTINGS, "check-problems", "Control+B", "win32"),
  ).toEqual({ label: "加粗", shortcut: "Control+B" });
  expect(
    shortcutConflicts(DEFAULT_SHORTCUT_SETTINGS, "check-problems", "Control+B", "darwin"),
  ).toBeNull();
});

test.each([
  { code: "ArrowUp", ctrlKey: true },
  { code: "Digit3", metaKey: true, shiftKey: true },
  { code: "KeyF", ctrlKey: true, metaKey: true },
])("rejects a Mac system shortcut %j", (event) => {
  expect(normalizeShortcutInput(event, "darwin").ok).toBe(false);
});

describe("shortcut settings", () => {
  test("loads old settings without resetting separately updated shortcuts", () => {
    const legacy = { ...DEFAULT_SHORTCUT_SETTINGS } as Record<string, string | null>;
    delete legacy["supplement-reference-numbers"];
    expect(ShortcutSettingsSchema.parse(legacy)["supplement-reference-numbers"]).toBeNull();
    expect(PartialShortcutSettingsSchema.parse({ "check-problems": "F7" })).toEqual({
      "check-problems": "F7",
    });
  });
  test("accepts modifier shortcuts and bare F1 through F12", () => {
    expect(normalizeShortcutInput({ code: "KeyK", ctrlKey: true })).toEqual({
      ok: true,
      value: "Ctrl+K",
    });
    expect(normalizeShortcutInput({ code: "F8" })).toEqual({
      ok: true,
      value: "F8",
    });
    expect(normalizeShortcutInput({ code: "F12", altKey: true, shiftKey: true })).toEqual({
      ok: true,
      value: "Alt+Shift+F12",
    });
  });

  test("rejects bare ordinary keys, modifier-only keys and reserved Windows shortcuts", () => {
    expect(normalizeShortcutInput({ code: "KeyK" })).toEqual({
      ok: false,
      message: "普通键需配合 Ctrl 或 Alt。",
    });
    expect(normalizeShortcutInput({ code: "ControlLeft", ctrlKey: true })).toMatchObject({
      ok: false,
    });
    expect(normalizeShortcutInput({ code: "F4", altKey: true })).toMatchObject({
      ok: false,
    });
    expect(normalizeShortcutInput({ code: "KeyK", metaKey: true })).toMatchObject({ ok: false });
  });

  test("reports fixed and custom conflicts using the conflicting action label", () => {
    expect(
      shortcutConflicts(DEFAULT_SHORTCUT_SETTINGS, "clear-extra-formatting", "Ctrl+B"),
    ).toEqual({
      label: "加粗",
      shortcut: "Ctrl+B",
    });
    const configured = {
      ...DEFAULT_SHORTCUT_SETTINGS,
      "toggle-drawing-sort": "F8",
    };
    expect(shortcutConflicts(configured, "import-drawing-images", "F8")).toEqual({
      label: "附图排序",
      shortcut: "F8",
    });
  });

  test("keeps supported actions without the removed page-break shortcut", () => {
    expect(CUSTOM_SHORTCUT_ACTIONS.find((action) => action.id === "check-problems")?.label).toBe(
      "本地检查",
    );
    expect(CUSTOM_SHORTCUT_ACTIONS.map((action) => action.id)).toEqual([
      "clear-extra-formatting",
      "check-problems",
      "ai-correction",
      "assign-reference-number",
      "assign-custom-reference-number",
      "insert-dependent-claim",
      "supplement-reference-numbers",
      "toggle-drawing-sort",
      "import-drawing-images",
      "insert-marked-drawing",
      "open-custom-dual-view-1",
      "open-custom-dual-view-2",
      "open-custom-dual-view-3",
    ]);
    expect(FIXED_SHORTCUTS.map((shortcut) => shortcut.label)).not.toContain("插入分页");
    expect(FIXED_SHORTCUTS).toEqual(
      expect.arrayContaining([
        { group: "查找与文档", label: "下一个文档", shortcuts: ["Ctrl+Tab"] },
        {
          group: "查找与文档",
          label: "上一个文档",
          shortcuts: ["Ctrl+Shift+Tab"],
        },
      ]),
    );
  });

  test("accepts numbered dual-view shortcuts while rejecting unrelated setting keys", () => {
    expect(
      PartialShortcutSettingsSchema.parse({
        "supplement-reference-numbers": "F9",
      }),
    ).toEqual({
      "supplement-reference-numbers": "F9",
    });
    expect(
      ShortcutSettingsSchema.parse({
        ...DEFAULT_SHORTCUT_SETTINGS,
        "open-custom-dual-view-4": "F9",
      })["open-custom-dual-view-4"],
    ).toBe("F9");
    expect(
      PartialShortcutSettingsSchema.parse({
        "open-custom-dual-view-12": "Ctrl+K",
      }),
    ).toEqual({
      "open-custom-dual-view-12": "Ctrl+K",
    });
    expect(() => PartialShortcutSettingsSchema.parse({ unrelatedShortcut: "F9" })).toThrow();
  });
});

test("retains the drawing insert shortcut and defaults older settings to unassigned", () => {
  const legacy = { ...DEFAULT_SHORTCUT_SETTINGS };
  delete (legacy as Record<string, unknown>)["insert-marked-drawing"];
  expect(ShortcutSettingsSchema.parse(legacy)["insert-marked-drawing"]).toBeNull();
  expect(PartialShortcutSettingsSchema.parse({ "insert-marked-drawing": "F8" })).toEqual({
    "insert-marked-drawing": "F8",
  });
});
test("Mac Command input uses the portable primary-modifier setting", () => {
  expect(normalizeShortcutInput({ code: "KeyJ", metaKey: true }, "darwin")).toEqual({
    ok: true,
    value: "Ctrl+J",
  });
  expect(normalizeShortcutInput({ code: "KeyQ", metaKey: true }, "darwin").ok).toBe(false);
  expect(normalizeShortcutInput({ code: "KeyJ", metaKey: true }, "win32").ok).toBe(false);
});

test.each(["win32", "darwin", "harmony"])("reserves saving on %s", (platform) => {
  expect(
    shortcutConflicts(DEFAULT_SHORTCUT_SETTINGS, "check-problems", "Ctrl+S", platform),
  ).toEqual({ label: "保存", shortcut: "Ctrl+S" });
});

test.each([
  ["Ctrl+N", "新建专利"],
  ["Ctrl+O", "导入 PATDOC"],
  ["Ctrl+P", "打印"],
  ["Ctrl+Alt+F", "替换"],
])("reserves Mac native shortcut %s", (shortcut, label) => {
  expect(
    shortcutConflicts(DEFAULT_SHORTCUT_SETTINGS, "check-problems", shortcut!, "darwin"),
  ).toEqual({ label, shortcut });
});

test("keeps Windows Ctrl+Alt+F available when it does not conflict", () => {
  expect(
    shortcutConflicts(DEFAULT_SHORTCUT_SETTINGS, "check-problems", "Ctrl+Alt+F", "win32"),
  ).toBeNull();
});

test.each(["openharmony", "ohos"])(
  "%s rejects application exit and names the system key",
  (platform) => {
    expect(normalizeShortcutInput({ code: "F4", altKey: true, shiftKey: true }, platform).ok).toBe(
      false,
    );
    expect(normalizeShortcutInput({ code: "KeyS", metaKey: true }, platform)).toEqual({
      ok: false,
      message: "不支持鸿蒙键作为应用快捷键。",
    });
    expect(normalizeShortcutInput({ code: "KeyS", ctrlKey: true }, platform)).toEqual({
      ok: true,
      value: "Ctrl+S",
    });
  },
);

test("portable Windows settings remain valid while conflicting with Harmony reserved keys", () => {
  expect(PartialShortcutSettingsSchema.parse({ "check-problems": "Alt+Shift+F4" })).toEqual({
    "check-problems": "Alt+Shift+F4",
  });
  expect(
    shortcutConflicts(DEFAULT_SHORTCUT_SETTINGS, "check-problems", "Alt+Shift+F4", "openharmony"),
  ).toEqual({ label: "系统保留快捷键", shortcut: "Alt+Shift+F4" });
  expect(shortcutConflicts(DEFAULT_SHORTCUT_SETTINGS, "check-problems", "Ctrl+S")).toEqual({
    label: "保存",
    shortcut: "Ctrl+S",
  });
});
