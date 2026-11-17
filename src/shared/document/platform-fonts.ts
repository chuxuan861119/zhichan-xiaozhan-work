import { defaultDocumentFont } from "./font-policy.js";

export const BUNDLED_FONT_FAMILIES = [
  "Source Han Serif CN",
  "思源宋体",
  "SourceHanSerifCN",
] as const;

/** Rendering aliases only: stored font names and DOCX font semantics are unchanged. */
export function createDocumentFontCss(
  fonts: { regular: string; semibold: string },
  platform: string,
  bundledFamilies: readonly string[] = BUNDLED_FONT_FAMILIES,
): string {
  // Only the explicitly selected bundled font uses bundled bytes.
  const legacyAliases = platform === "darwin" || platform === "openharmony" || platform === "ohos";
  return `${bundledFamilies
    .map(
      (family) => `
@font-face { font-family: "${family}"; src: url("${fonts.regular}") format("opentype"); font-weight: 100 500; font-display: block; }
@font-face { font-family: "${family}"; src: url("${fonts.semibold}") format("opentype"); font-weight: 600 900; font-display: block; }
`,
    )
    .join("")}
${
  legacyAliases
    ? ["SimSun", "宋体"]
        .map(
          (family) => `
@font-face { font-family: "${family}"; src: ${platform === "darwin" ? 'local("PingFangSC-Regular"), ' : ""}local("${defaultDocumentFont(platform)}"); font-weight: 100 500; }
@font-face { font-family: "${family}"; src: local("${platform === "darwin" ? "PingFangSC-Semibold" : "HarmonyOS Sans SC Bold"}"), local("${defaultDocumentFont(platform)}"); font-weight: 600 900; }
`,
        )
        .join("")
    : ""
}
`;
}

export function createMacDocumentFontCss(fonts: { regular: string; semibold: string }): string {
  return createDocumentFontCss(fonts, "darwin");
}

export function withPlatformPrintFonts(html: string, platform: string, fontCss: string): string {
  if (!["win32", "darwin", "openharmony", "ohos"].includes(platform)) return html;
  const style = `<style>${fontCss}</style>`;
  return html.includes("</head>")
    ? html.replace("</head>", `${style}</head>`)
    : html.replace(/<body\b/iu, `<head>${style}</head><body`);
}
