import { readFileSync } from "node:fs";
import regularFontPath from "../../shared/document/fonts/SourceHanSerifCN-Regular.otf?asset";
import semiboldFontPath from "../../shared/document/fonts/SourceHanSerifCN-SemiBold.otf?asset";
import {
  BUNDLED_FONT_FAMILIES,
  createDocumentFontCss,
  withPlatformPrintFonts,
} from "../../shared/document/platform-fonts.js";
import { pdfFontVariants, unicodeGlyphMap } from "./pdf-font-cmap.js";

// Only two installed immutable font files; no document text or per-job output is retained.
const bundledFonts = new Map<string, { bytes: Buffer; glyphs: ReadonlyMap<number, number> }>();
function bundledFont(path: string) {
  let font = bundledFonts.get(path);
  if (!font) {
    const bytes = readFileSync(path);
    font = { bytes, glyphs: unicodeGlyphMap(bytes) };
    bundledFonts.set(path, font);
  }
  return font;
}

function pdfFontCss(html: string, families: readonly string[]): string {
  const text = html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<[^>]*>/gu, "")
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);|&#(?:x([0-9a-f]+)|(\d+));/giu,
      (entity, key: string | undefined, hex: string | undefined, decimal: string | undefined) => {
        if (key)
          return (
            { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }[key] ?? entity
          );
        const point = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
        return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point)
          : "\uFFFD";
      },
    );
  const points = new Set([...text, ..."0123456789"].map((c) => c.codePointAt(0) ?? 0));
  return [regularFontPath, semiboldFontPath]
    .flatMap((path, index) =>
      pdfFontVariants(bundledFont(path).bytes, points, bundledFont(path).glyphs).flatMap(
        (variant) =>
          families.map(
            (family) =>
              `@font-face { font-family: "${family}"; src: url("data:font/otf;base64,${variant.bytes.toString("base64")}") format("opentype"); font-weight: ${index === 0 ? "100 500" : "600 900"}; font-display: block; unicode-range: ${variant.points.map((point) => `U+${point.toString(16)}`).join(",")}; }`,
          ),
      ),
    )
    .join("\n");
}

function usedBundledFontFamilies(html: string) {
  const declarations = [
    ...html.matchAll(/font-family\s*[:=]\s*((?:&(?:quot|apos);|[^;<>}])+)/giu),
  ].map((match) =>
    (match[1] ?? "")
      .replace(/\\([0-9a-f]{1,6})\s?/giu, (_escape, hex) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
      .toLowerCase(),
  );
  return BUNDLED_FONT_FAMILIES.filter((family) =>
    declarations.some((declaration) => declaration.includes(family.toLowerCase())),
  );
}

export function requiresPrintFontWorker(html: string, platform: string): boolean {
  return (
    platform === "darwin" ||
    (["win32", "openharmony", "ohos"].includes(platform) &&
      usedBundledFontFamilies(html).length > 0)
  );
}

export function withBundledPrintFonts(html: string, platform: string): string {
  if (!["win32", "darwin", "openharmony", "ohos"].includes(platform)) return html;
  if (platform === "darwin") {
    // Restrict only print faces, never editor/stored font names or DOCX declarations.
    const css = pdfFontCss(html, ["ZXWPDFSerif"]);
    const normalized = html.replace(
      /(font-family\s*:\s*)((?:&(?:quot|apos);|[^;<>}])+)/giu,
      (_match, prefix, value: string) => {
        // cssString escapes every code point; decode only this known font value.
        const decoded = value.replace(/\\([0-9a-f]{1,6})\s?/giu, (_escape, hex) =>
          String.fromCodePoint(Number.parseInt(hex, 16)),
        );
        const names = /Source Han Serif CN|SourceHanSerifCN|思源宋体|PingFang SC|SimSun|宋体/gu;
        return prefix + (names.test(decoded) ? decoded.replace(names, "ZXWPDFSerif") : value);
      },
    );
    return withPlatformPrintFonts(normalized, platform, css);
  }
  const families = usedBundledFontFamilies(html);
  const nativeAliases = createDocumentFontCss({ regular: "", semibold: "" }, platform, []);
  return withPlatformPrintFonts(
    html,
    platform,
    nativeAliases + (families.length ? pdfFontCss(html, families) : ""),
  );
}
