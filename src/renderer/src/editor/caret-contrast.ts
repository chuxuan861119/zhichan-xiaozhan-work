export const DEFAULT_EDITOR_CARET_COLOR = "#1d4ed8";

const LIGHT_EDITOR_CARET_COLOR = "#FFFFFF";

function parseHexColor(color: string | null | undefined): [number, number, number] | null {
  const match = color?.trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;
  const hex = match[1];
  if (!hex) return null;
  const value = Number.parseInt(hex, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function channelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  return (
    0.2126 * channelToLinear(red) + 0.7152 * channelToLinear(green) + 0.0722 * channelToLinear(blue)
  );
}

function contrastRatio(firstLuminance: number, secondLuminance: number): number {
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

const DEFAULT_EDITOR_CARET_LUMINANCE = relativeLuminance([0x1d, 0x4e, 0xd8]);
const LIGHT_EDITOR_CARET_LUMINANCE = relativeLuminance([0xff, 0xff, 0xff]);

/**
 * Chooses a native caret color that remains visible over app-known highlight
 * backgrounds. Unknown or light backgrounds use the brand blue caret.
 */
export function getEditorCaretColor(backgroundColor?: string | null): string {
  const parsed = parseHexColor(backgroundColor);
  if (!parsed) return DEFAULT_EDITOR_CARET_COLOR;
  const backgroundLuminance = relativeLuminance(parsed);
  return contrastRatio(LIGHT_EDITOR_CARET_LUMINANCE, backgroundLuminance) >
    contrastRatio(DEFAULT_EDITOR_CARET_LUMINANCE, backgroundLuminance)
    ? LIGHT_EDITOR_CARET_COLOR
    : DEFAULT_EDITOR_CARET_COLOR;
}
