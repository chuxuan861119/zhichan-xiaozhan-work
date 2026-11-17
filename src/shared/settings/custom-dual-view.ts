import { z } from "zod";
import {
  PATENT_WORKSPACE_TOOL_LABELS,
  type PatentWorkspaceTool,
} from "../patent/document-target.js";
import { PATENT_BOOK_LABELS, type PatentBookKind } from "../patent/model.js";
import type { CustomDualViewShortcutId, ShortcutSettings } from "./shortcuts.js";

export const CUSTOM_DUAL_VIEW_BOOK_KINDS = [
  "claims",
  "description",
  "description-drawings",
  "abstract",
] as const;

export const CustomDualViewBookKindSchema = z.enum(CUSTOM_DUAL_VIEW_BOOK_KINDS);
export type CustomDualViewBookKind = z.infer<typeof CustomDualViewBookKindSchema>;

export const CUSTOM_DUAL_VIEW_KINDS = [
  ...CUSTOM_DUAL_VIEW_BOOK_KINDS,
  "flowchart",
  "drawing-markup",
] as const;
export const CustomDualViewKindSchema = z.enum(CUSTOM_DUAL_VIEW_KINDS);
export type CustomDualViewKind = z.infer<typeof CustomDualViewKindSchema>;

export const CustomDualViewPresetSchema = z
  .object({
    // Keep persisted field names so existing presets and shortcuts restore unchanged.
    leftBookKind: CustomDualViewKindSchema,
    rightBookKind: CustomDualViewKindSchema,
  })
  .strict()
  .refine((preset) => preset.leftBookKind !== preset.rightBookKind, {
    message: "左右两侧不能选择相同文档。",
  });
export type CustomDualViewPreset = z.infer<typeof CustomDualViewPresetSchema>;

export const CustomDualViewPresetsSchema = z.array(CustomDualViewPresetSchema);
export const DEFAULT_CUSTOM_DUAL_VIEW_PRESETS: CustomDualViewPreset[] = [];

export const CUSTOM_DUAL_VIEW_SHORTCUT_IDS = [
  "open-custom-dual-view-1",
  "open-custom-dual-view-2",
  "open-custom-dual-view-3",
] as const;

export function customDualViewShortcutId(index: number): CustomDualViewShortcutId {
  return `open-custom-dual-view-${index + 1}`;
}

const SHORT_LABELS: Record<CustomDualViewKind, string> = {
  claims: "权",
  description: "说",
  "description-drawings": "图",
  abstract: "摘",
  flowchart: "流",
  "drawing-markup": "CAD",
};

export function isCustomDualViewToolKind(kind: CustomDualViewKind): kind is PatentWorkspaceTool {
  return kind === "flowchart" || kind === "drawing-markup";
}

export function isCustomDualViewPresetAvailable(
  preset: CustomDualViewPreset,
  availableBookKinds: readonly PatentBookKind[],
): boolean {
  return [preset.leftBookKind, preset.rightBookKind].every(
    (kind) => isCustomDualViewToolKind(kind) || availableBookKinds.includes(kind),
  );
}

export function customDualViewShortLabel(preset: CustomDualViewPreset): [string, string] {
  return [SHORT_LABELS[preset.leftBookKind], SHORT_LABELS[preset.rightBookKind]];
}

export function customDualViewFullLabel(preset: CustomDualViewPreset): string {
  const label = (kind: CustomDualViewKind) =>
    isCustomDualViewToolKind(kind) ? PATENT_WORKSPACE_TOOL_LABELS[kind] : PATENT_BOOK_LABELS[kind];
  return `${label(preset.leftBookKind)}｜${label(preset.rightBookKind)}`;
}

export function compactCustomDualViewSlots(
  presets: readonly CustomDualViewPreset[],
  shortcuts: ShortcutSettings,
  removedIndex: number,
): { presets: CustomDualViewPreset[]; shortcuts: ShortcutSettings } {
  const nextPresets = presets.filter((_, index) => index !== removedIndex);
  const nextShortcuts = { ...shortcuts };
  nextPresets.forEach((_, index) => {
    const sourceIndex = index < removedIndex ? index : index + 1;
    nextShortcuts[customDualViewShortcutId(index)] =
      shortcuts[customDualViewShortcutId(sourceIndex)] ?? null;
  });
  nextShortcuts[customDualViewShortcutId(nextPresets.length)] = null;
  return { presets: nextPresets, shortcuts: nextShortcuts };
}
