import { z } from "zod";

const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, "请输入六位十六进制颜色，例如 #ffffff。");

function rgb(hex: string): number[] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

export function colorLuminance(hex: string): number {
  const channels = rgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}

export function colorsAreDistinct(first: string, second: string): boolean {
  const a = rgb(first);
  const b = rgb(second);
  return Math.hypot(...a.map((channel, index) => channel - (b[index] ?? 0))) >= 32;
}

export function mixColor(first: string, second: string, amount: number): string {
  const a = rgb(first);
  return `#${rgb(second)
    .map((channel, index) =>
      Math.round((a[index] ?? 0) * (1 - amount) + channel * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export const EditorColorsSchema = z
  .object({
    page: HexColorSchema,
    canvas: HexColorSchema,
    panel: HexColorSchema,
    panelFollowsPage: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (colorLuminance(value.page) < 0.65) {
      ctx.addIssue({
        code: "custom",
        path: ["page"],
        message: "页面颜色太深，请选择浅色，保证黑色文字清晰可读。",
      });
    }
    if (!colorsAreDistinct(value.page, value.canvas)) {
      ctx.addIssue({
        code: "custom",
        path: ["canvas"],
        message: "页面与空背景颜色过于接近，请拉开色差。",
      });
    }
  });
export type EditorColors = z.infer<typeof EditorColorsSchema>;

export type EditorColorField = "page" | "canvas" | "panel";
export type EditorColorOption = { name: string; color: string };

const PAPER_COLORS: EditorColorOption[] = [
  { name: "纯白", color: "#ffffff" },
  { name: "柔白", color: "#fafafa" },
  { name: "浅灰", color: "#f1f2f4" },
  { name: "暖灰", color: "#f3f0eb" },
  { name: "米白", color: "#faf4e6" },
  { name: "奶油", color: "#fff7df" },
  { name: "浅杏", color: "#fff0e4" },
  { name: "浅桃", color: "#fff0ed" },
  { name: "浅粉", color: "#fceef3" },
  { name: "浅紫", color: "#f3effb" },
  { name: "浅蓝", color: "#edf4fc" },
  { name: "冰蓝", color: "#eaf7fc" },
  { name: "浅青", color: "#eaf7f5" },
  { name: "薄荷", color: "#edf8ed" },
  { name: "浅绿", color: "#e7f1e5" },
  { name: "浅黄", color: "#f8f7e6" },
  { name: "珍珠", color: "#f5f5ef" },
  { name: "象牙", color: "#fffff0" },
  { name: "亚麻", color: "#faf0e6" },
  { name: "贝壳", color: "#fff5ee" },
  { name: "樱白", color: "#fff5f8" },
  { name: "丁香", color: "#f7f0ff" },
  { name: "霜蓝", color: "#f0f8ff" },
  { name: "玉白", color: "#f0fff4" },
];

const SURFACE_COLORS: EditorColorOption[] = [
  { name: "纯白", color: "#ffffff" },
  { name: "米白", color: "#faf4e6" },
  { name: "浅绿", color: "#e7f1e5" },
  { name: "雾灰", color: "#dfe2e7" },
  { name: "银灰", color: "#cbd0d8" },
  { name: "暖灰", color: "#d8d2cb" },
  { name: "书卷", color: "#ded5c3" },
  { name: "灰绿", color: "#c5d5c4" },
  { name: "灰青", color: "#c5d9d7" },
  { name: "灰蓝", color: "#c7d6e8" },
  { name: "灰紫", color: "#d5cde2" },
  { name: "灰粉", color: "#e4cfd4" },
  { name: "石板", color: "#667085" },
  { name: "深蓝灰", color: "#384456" },
  { name: "深灰", color: "#30343b" },
  { name: "炭黑", color: "#25282e" },
  { name: "浅银", color: "#e8eaed" },
  { name: "沙灰", color: "#c5b9a5" },
  { name: "豆绿", color: "#aabda8" },
  { name: "海灰", color: "#9fbabd" },
  { name: "雾蓝", color: "#a6bad2" },
  { name: "暮紫", color: "#b9abc7" },
  { name: "藕灰", color: "#c5aeb5" },
  { name: "墨绿", color: "#354b43" },
];

/** Use the persistence validator so a visible choice never creates an invalid draft. */
export function availableEditorColors(
  colors: EditorColors,
  field: EditorColorField,
  savedColor?: string,
): EditorColorOption[] {
  const options = [...(field === "page" ? PAPER_COLORS : SURFACE_COLORS)];
  for (const [name, color] of [
    ["当前颜色", colors[field]],
    ["已保存颜色", savedColor],
  ] as const) {
    if (color && !options.some((option) => option.color === color.toLowerCase())) {
      options.push({ name, color: color.toLowerCase() });
    }
  }
  return options.filter(
    ({ color }) => EditorColorsSchema.safeParse({ ...colors, [field]: color }).success,
  );
}

export const DEFAULT_EDITOR_COLORS: EditorColors = {
  page: "#ffffff",
  canvas: "#dfe2e7",
  panel: "#ffffff",
  panelFollowsPage: false,
};
export const EDITOR_COLOR_PRESETS = [
  { name: "经典白", colors: DEFAULT_EDITOR_COLORS },
  {
    name: "柔和灰",
    colors: { page: "#f5f5f3", canvas: "#d5d8da", panel: "#fafaf8", panelFollowsPage: false },
  },
  {
    name: "暖纸",
    colors: { page: "#faf4e6", canvas: "#ded5c3", panel: "#fdf9f0", panelFollowsPage: false },
  },
  {
    name: "浅竹绿",
    colors: { page: "#eef5eb", canvas: "#cfdacb", panel: "#f6f9f3", panelFollowsPage: false },
  },
  {
    name: "雾蓝",
    colors: { page: "#f0f4fa", canvas: "#ced7e3", panel: "#f7f9fc", panelFollowsPage: false },
  },
  {
    name: "暗夜蓝",
    colors: { page: "#f0f4fa", canvas: "#142b49", panel: "#1c3b60", panelFollowsPage: false },
  },
] satisfies { name: string; colors: EditorColors }[];

/** Derived display tokens never enter a document or its export content. */
export function editorColorTokens(colors: EditorColors): Record<string, string> {
  const panel = colors.panelFollowsPage ? colors.page : colors.panel;
  const lightText = colorLuminance(panel) < 0.18;
  const ink = lightText ? "#ffffff" : "#000000";
  const readable = (candidate: string) => {
    const a = colorLuminance(panel);
    const b = colorLuminance(candidate);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5 ? candidate : ink;
  };
  const accent = readable(lightText ? "#a8cfff" : "#164f9e");
  // Precompose a neutral mask into the canvas only, never overlay document content.
  const mask = colorLuminance(colors.canvas) < 0.18 ? "#ffffff" : "#000000";
  const masked = mixColor(colors.canvas, mask, 0.16);
  const inactive = colorsAreDistinct(colors.page, masked)
    ? masked
    : mixColor(colors.canvas, mask === "#ffffff" ? "#000000" : "#ffffff", 0.16);
  const canvasInk = (background: string) => {
    const luminance = colorLuminance(background);
    const preferred = luminance < 0.18 ? "#e2e8f0" : "#475569";
    const foreground = colorLuminance(preferred);
    if ((Math.max(luminance, foreground) + 0.05) / (Math.min(luminance, foreground) + 0.05) >= 4.5)
      return preferred;
    return luminance > 0.179 ? "#000000" : "#ffffff";
  };
  return {
    "--editor-display-page": colors.page,
    "--editor-display-canvas": colors.canvas,
    "--editor-display-active-canvas": colors.canvas,
    "--editor-display-inactive-canvas": inactive,
    "--editor-display-canvas-ink": canvasInk(colors.canvas),
    "--editor-display-inactive-canvas-ink": canvasInk(inactive),
    "--editor-display-panel": panel,
    "--editor-display-panel-ink": ink,
    "--editor-display-panel-muted": readable(mixColor(panel, ink, 0.75)),
    "--editor-display-panel-line": mixColor(panel, ink, 0.22),
    "--editor-display-panel-surface": mixColor(panel, ink, 0.06),
    "--editor-display-panel-hover": mixColor(panel, ink, 0.12),
    "--editor-display-panel-accent": accent,
    "--editor-display-panel-selected": mixColor(panel, accent, 0.18),
    "--editor-display-panel-danger": readable(lightText ? "#ffb4b4" : "#9c2020"),
    "--editor-display-panel-success": readable(lightText ? "#a8e6c3" : "#14532d"),
    "--editor-display-panel-warning": readable(lightText ? "#ffdc9a" : "#713f12"),
  };
}
