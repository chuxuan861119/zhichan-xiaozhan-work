import { z } from "zod";
import {
  editorShortcutBinding,
  isHarmonyPlatform,
  isMacPlatform,
  platformEditorShortcut,
  platformShortcut,
} from "../platform.js";

export const CUSTOM_SHORTCUT_ACTIONS = [
  { id: "clear-extra-formatting", group: "全局", label: "清除多余格式" },
  { id: "check-problems", group: "全局", label: "本地检查" },
  { id: "ai-correction", group: "全局", label: "AI 纠错" },
  { id: "assign-reference-number", group: "附图标记", label: "顺序编号" },
  { id: "assign-custom-reference-number", group: "附图标记", label: "自定义编号" },
  { id: "insert-dependent-claim", group: "权利要求书", label: "插入从权" },
  { id: "supplement-reference-numbers", group: "说明书", label: "增补编号" },
  { id: "toggle-drawing-sort", group: "说明书附图", label: "附图排序" },
  { id: "import-drawing-images", group: "说明书附图", label: "导入图片" },
  { id: "insert-marked-drawing", group: "CAD标号", label: "插入附图" },
  { id: "open-custom-dual-view-1", group: "同屏双显", label: "自定义双屏 1" },
  { id: "open-custom-dual-view-2", group: "同屏双显", label: "自定义双屏 2" },
  { id: "open-custom-dual-view-3", group: "同屏双显", label: "自定义双屏 3" },
] as const;

export type ShortcutActionId = (typeof CUSTOM_SHORTCUT_ACTIONS)[number]["id"];

export type CustomDualViewShortcutId = `open-custom-dual-view-${number}`;
export type ConfigurableShortcutActionId = ShortcutActionId | CustomDualViewShortcutId;

export type ShortcutSettings = Record<ShortcutActionId, string | null> &
  Record<string, string | null>;

export const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = {
  "clear-extra-formatting": null,
  "check-problems": null,
  "ai-correction": null,
  "assign-reference-number": null,
  "assign-custom-reference-number": null,
  "insert-dependent-claim": null,
  "supplement-reference-numbers": null,
  "toggle-drawing-sort": null,
  "import-drawing-images": null,
  "insert-marked-drawing": null,
  "open-custom-dual-view-1": null,
  "open-custom-dual-view-2": null,
  "open-custom-dual-view-3": null,
};

export const FIXED_SHORTCUTS = [
  { group: "编辑", label: "复制", shortcuts: ["Ctrl+C"] },
  { group: "编辑", label: "剪切", shortcuts: ["Ctrl+X"] },
  { group: "编辑", label: "粘贴", shortcuts: ["Ctrl+V"] },
  { group: "编辑", label: "全选", shortcuts: ["Ctrl+A"] },
  { group: "编辑", label: "撤销", shortcuts: ["Ctrl+Z"] },
  { group: "编辑", label: "重做", shortcuts: ["Ctrl+Y", "Ctrl+Shift+Z"] },
  { group: "字符格式", label: "加粗", shortcuts: ["Ctrl+B"] },
  { group: "字符格式", label: "斜体", shortcuts: ["Ctrl+I"] },
  { group: "字符格式", label: "下划线", shortcuts: ["Ctrl+U"] },
  { group: "字符格式", label: "下标", shortcuts: ["Ctrl+,"] },
  { group: "字符格式", label: "上标", shortcuts: ["Ctrl+."] },
  { group: "段落格式", label: "正文", shortcuts: ["Ctrl+Alt+0"] },
  { group: "段落格式", label: "标题 1", shortcuts: ["Ctrl+Alt+1"] },
  { group: "段落格式", label: "标题 2", shortcuts: ["Ctrl+Alt+2"] },
  { group: "段落格式", label: "标题 3", shortcuts: ["Ctrl+Alt+3"] },
  { group: "段落格式", label: "有序列表", shortcuts: ["Ctrl+Shift+7"] },
  { group: "段落格式", label: "无序列表", shortcuts: ["Ctrl+Shift+8"] },
  { group: "段落格式", label: "左对齐", shortcuts: ["Ctrl+Shift+L"] },
  { group: "段落格式", label: "居中", shortcuts: ["Ctrl+Shift+E"] },
  { group: "段落格式", label: "右对齐", shortcuts: ["Ctrl+Shift+R"] },
  { group: "段落格式", label: "两端对齐", shortcuts: ["Ctrl+Shift+J"] },
  { group: "查找与文档", label: "查找", shortcuts: ["Ctrl+F"] },
  { group: "查找与文档", label: "保存", shortcuts: ["Ctrl+S"] },
  { group: "查找与文档", label: "替换", shortcuts: ["Ctrl+H"] },
  { group: "查找与文档", label: "下一个文档", shortcuts: ["Ctrl+Tab"] },
  { group: "查找与文档", label: "上一个文档", shortcuts: ["Ctrl+Shift+Tab"] },
  { group: "视图", label: "放大", shortcuts: ["Ctrl+=", "Ctrl+Shift+="] },
  { group: "视图", label: "缩小", shortcuts: ["Ctrl+-"] },
  { group: "视图", label: "恢复 100%", shortcuts: ["Ctrl+0"] },
] as const;

const FIXED_SHORTCUT_LABEL_ALIASES: Readonly<Record<string, string>> = {
  粗体: "加粗",
  项目符号: "无序列表",
  编号: "有序列表",
  "恢复为 100%": "恢复 100%",
};

export function fixedShortcutsFor(label: string): readonly string[] {
  const settingsLabel = FIXED_SHORTCUT_LABEL_ALIASES[label] ?? label;
  return FIXED_SHORTCUTS.find((item) => item.label === settingsLabel)?.shortcuts ?? [];
}

export function shortcutTooltip({
  label,
  shortcuts,
  visibleLabel,
  unavailableReason,
  binding = "fixed",
}: {
  label: string;
  shortcuts: readonly string[];
  visibleLabel: boolean;
  unavailableReason?: string | undefined;
  binding?: "fixed" | "custom";
}): string {
  const shortcutText = Array.from(
    new Set(
      shortcuts.map((shortcut) =>
        binding === "custom" ? platformShortcut(shortcut) : platformEditorShortcut(shortcut),
      ),
    ),
  ).join(" / ");
  const availableTitle = visibleLabel
    ? shortcutText || "未设置快捷键"
    : `${label}（${shortcutText}）`;
  if (!unavailableReason) return availableTitle;
  const shortcutDetails = visibleLabel ? `快捷键：${shortcutText || "未设置"}` : availableTitle;
  return `${unavailableReason}\n${shortcutDetails}`;
}

type ShortcutInput = {
  code: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
};

type NormalizedShortcut = { ok: true; value: string } | { ok: false; message: string };

const KEY_LABELS: Record<string, string> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Delete: "Delete",
  End: "End",
  Enter: "Enter",
  Equal: "=",
  Escape: "Escape",
  Home: "Home",
  Insert: "Insert",
  Minus: "-",
  PageDown: "PageDown",
  PageUp: "PageUp",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Space: "Space",
  Tab: "Tab",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
};

for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") KEY_LABELS[`Key${letter}`] = letter;
for (const digit of "0123456789") KEY_LABELS[`Digit${digit}`] = digit;
for (let index = 1; index <= 12; index += 1) KEY_LABELS[`F${index}`] = `F${index}`;

const CODE_BY_LABEL = new Map(Object.entries(KEY_LABELS).map(([code, label]) => [label, code]));
const MODIFIER_CODES = new Set([
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
]);
const RESERVED_SHORTCUTS = new Set(["Alt+F4", "Alt+Tab", "Ctrl+Alt+Delete", "Ctrl+Shift+Escape"]);
const MAC_RESERVED_SHORTCUTS = new Set([
  "Ctrl+Q",
  "Ctrl+Shift+Q",
  "Ctrl+H",
  "Ctrl+Alt+H",
  "Ctrl+M",
  "Ctrl+Alt+M",
  "Ctrl+Tab",
  "Ctrl+Shift+Tab",
  "Ctrl+Space",
  "Ctrl+Alt+Space",
  "Ctrl+Alt+Escape",
  "Ctrl+Shift+3",
  "Ctrl+Shift+4",
  "Ctrl+Shift+5",
  "Control+ArrowUp",
  "Control+ArrowDown",
  "Control+ArrowLeft",
  "Control+ArrowRight",
]);

function isFunctionKey(code: string): boolean {
  return /^F(?:[1-9]|1[0-2])$/u.test(code);
}

function modifiersFor(input: ShortcutInput, platform?: string): string[] {
  const mac = isMacPlatform(platform);
  return [
    ...((mac ? input.metaKey : input.ctrlKey) ? ["Ctrl"] : []),
    ...(mac && input.ctrlKey ? ["Control"] : []),
    ...(input.altKey ? ["Alt"] : []),
    ...(input.shiftKey ? ["Shift"] : []),
  ];
}

export function normalizeShortcutInput(
  input: ShortcutInput,
  platform?: string,
): NormalizedShortcut {
  if (isMacPlatform(platform) && input.metaKey) {
    if (input.ctrlKey || ["KeyQ", "KeyH", "KeyM", "Space", "Tab"].includes(input.code)) {
      return { ok: false, message: "该系统保留快捷键不能设置。" };
    }
  }
  if (input.metaKey && !isMacPlatform(platform))
    return {
      ok: false,
      message: isHarmonyPlatform(platform)
        ? "不支持鸿蒙键作为应用快捷键。"
        : "不支持 Windows 键作为快捷键。",
    };
  if (MODIFIER_CODES.has(input.code)) return { ok: false, message: "请在修饰键之外再按一个键。" };
  const key = KEY_LABELS[input.code];
  if (!key) return { ok: false, message: "该按键暂不支持作为快捷键。" };
  const modifiers = modifiersFor(input, platform);
  if (!isFunctionKey(input.code) && !input.ctrlKey && !input.metaKey && !input.altKey) {
    return {
      ok: false,
      message: isMacPlatform(platform)
        ? "普通键需配合 Command、Control 或 Option。"
        : "普通键需配合 Ctrl 或 Alt。",
    };
  }
  const value = [...modifiers, key].join("+");
  if (isMacPlatform(platform) && MAC_RESERVED_SHORTCUTS.has(value))
    return { ok: false, message: "该系统保留快捷键不能设置。" };
  if (isHarmonyPlatform(platform) && value === "Alt+Shift+F4")
    return { ok: false, message: "该系统保留快捷键不能设置。" };
  if (RESERVED_SHORTCUTS.has(value)) return { ok: false, message: "该系统保留快捷键不能设置。" };
  return { ok: true, value };
}

export function isValidShortcutString(value: string): boolean {
  const parts = value.split("+");
  const key = parts.at(-1);
  if (!key) return false;
  const code = CODE_BY_LABEL.get(key);
  if (!code) return false;
  const modifiers = new Set(parts.slice(0, -1));
  if (modifiers.size !== parts.length - 1) return false;
  if ([...modifiers].some((modifier) => !["Ctrl", "Control", "Alt", "Shift"].includes(modifier)))
    return false;
  if (modifiers.has("Ctrl") && modifiers.has("Control")) return false;
  const normalized = normalizeShortcutInput(
    {
      code,
      ctrlKey: modifiers.has("Ctrl") || modifiers.has("Control"),
      altKey: modifiers.has("Alt"),
      shiftKey: modifiers.has("Shift"),
    },
    "win32",
  );
  return normalized.ok && normalized.value === value.replaceAll("Control", "Ctrl");
}

function comparableShortcut(shortcut: string, platform?: string): string {
  return isMacPlatform(platform) ? shortcut : shortcut.replaceAll("Control", "Ctrl");
}

export function shortcutMatchesInput(
  shortcut: string,
  input: ShortcutInput,
  platform?: string,
): boolean {
  const normalized = normalizeShortcutInput(input, platform);
  return normalized.ok && comparableShortcut(shortcut, platform) === normalized.value;
}

const OptionalShortcutSchema = z.string().refine(isValidShortcutString).nullable();

const ShortcutSettingsObjectSchema = z
  .object({
    "clear-extra-formatting": OptionalShortcutSchema,
    "check-problems": OptionalShortcutSchema,
    "ai-correction": OptionalShortcutSchema,
    "assign-reference-number": OptionalShortcutSchema,
    "assign-custom-reference-number": OptionalShortcutSchema,
    "insert-dependent-claim": OptionalShortcutSchema,
    "supplement-reference-numbers": OptionalShortcutSchema,
    "toggle-drawing-sort": OptionalShortcutSchema,
    "import-drawing-images": OptionalShortcutSchema,
    "insert-marked-drawing": OptionalShortcutSchema,
    "open-custom-dual-view-1": OptionalShortcutSchema,
    "open-custom-dual-view-2": OptionalShortcutSchema,
    "open-custom-dual-view-3": OptionalShortcutSchema,
  })
  .catchall(OptionalShortcutSchema);

function validateShortcutSettingKeys(
  settings: Record<string, unknown>,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  const knownIds = new Set<string>(CUSTOM_SHORTCUT_ACTIONS.map((action) => action.id));
  for (const key of Object.keys(settings)) {
    if (knownIds.has(key) || /^open-custom-dual-view-[1-9]\d*$/u.test(key)) continue;
    ctx.addIssue({ code: "custom", message: "未知的快捷键设置。", path: [key] });
  }
}

export const ShortcutSettingsSchema = ShortcutSettingsObjectSchema.extend({
  "supplement-reference-numbers": OptionalShortcutSchema.default(null),
  "insert-marked-drawing": OptionalShortcutSchema.default(null),
}).superRefine(validateShortcutSettingKeys);
export const PartialShortcutSettingsSchema = ShortcutSettingsObjectSchema.partial().superRefine(
  validateShortcutSettingKeys,
);

export type ShortcutConflict = { label: string; shortcut: string } | null;

export function shortcutConflicts(
  settings: ShortcutSettings,
  actionId: ConfigurableShortcutActionId,
  shortcut: string | null,
  platform?: string,
): ShortcutConflict {
  if (shortcut === null) return null;
  if (isHarmonyPlatform(platform) && shortcut === "Alt+Shift+F4")
    return { label: "系统保留快捷键", shortcut };
  const fixed = FIXED_SHORTCUTS.find((item) =>
    item.shortcuts.some(
      (candidate) =>
        comparableShortcut(editorShortcutBinding(candidate, platform), platform) ===
          comparableShortcut(shortcut, platform) ||
        (isMacPlatform(platform) && candidate === "Ctrl+Y" && shortcut === "Ctrl+Y"),
    ),
  );
  if (fixed) return { label: fixed.label, shortcut };
  if (isMacPlatform(platform)) {
    const native = {
      "Ctrl+N": "新建专利",
      "Ctrl+O": "导入 PATDOC",
      "Ctrl+P": "打印",
      "Ctrl+W": "关闭窗口",
      "Ctrl+,": "设置",
    };
    const label = native[shortcut as keyof typeof native];
    if (label) return { label, shortcut };
    if (MAC_RESERVED_SHORTCUTS.has(shortcut)) return { label: "系统保留快捷键", shortcut };
  }
  const configuredId = Object.entries(settings).find(
    ([candidateId, candidateShortcut]) =>
      candidateId !== actionId &&
      candidateShortcut !== null &&
      comparableShortcut(candidateShortcut, platform) === comparableShortcut(shortcut, platform),
  )?.[0];
  if (!configuredId) return null;
  const configured = CUSTOM_SHORTCUT_ACTIONS.find((action) => action.id === configuredId);
  const presetNumber = /^open-custom-dual-view-(\d+)$/u.exec(configuredId)?.[1];
  return {
    label: configured?.label ?? `自定义双屏 ${presetNumber}`,
    shortcut,
  };
}
