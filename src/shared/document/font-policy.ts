/** System fonts are referenced by name; only Source Han Serif is distributed. */
export const BUNDLED_DOCUMENT_FONT = "Source Han Serif CN";

export function documentFontPlatform(): string {
  const runtime = globalThis as typeof globalThis & { documentFontPlatform?: string };
  return (
    runtime.documentFontPlatform ?? (typeof navigator === "undefined" ? "" : navigator.platform)
  );
}

export function defaultDocumentFont(platform = documentFontPlatform()): string {
  if (platform === "darwin" || /^Mac/iu.test(platform)) return "PingFang SC";
  if (platform === "openharmony" || platform === "ohos") return "HarmonyOS Sans SC";
  return "SimSun";
}

export function documentFontOptions(platform = documentFontPlatform()) {
  const systemFont = defaultDocumentFont(platform);
  const options =
    systemFont === "SimSun"
      ? [
          { value: "SimSun", label: "宋体" },
          { value: "FangSong", label: "仿宋" },
          { value: "KaiTi", label: "楷体" },
        ]
      : [
          {
            value: systemFont,
            label:
              systemFont === "PingFang SC" ? "苹方（系统自带）" : "HarmonyOS Sans SC（系统自带）",
          },
        ];
  return [...options, { value: BUNDLED_DOCUMENT_FONT, label: "思源宋体" }];
}

const DISPLAY_FONT_ALIASES = new Map([
  ["宋体", "SimSun"],
  ["仿宋", "FangSong"],
  ["楷体", "KaiTi"],
  ["思源宋体", BUNDLED_DOCUMENT_FONT],
  ["SourceHanSerifCN", BUNDLED_DOCUMENT_FONT],
  ["HarmonyOS Sans", "HarmonyOS Sans SC"],
]);

/** Display a stored/imported name using only fonts offered on this platform. */
export function displayDocumentFont(
  font: string | undefined,
  platform = documentFontPlatform(),
): string {
  const normalized = DISPLAY_FONT_ALIASES.get(font ?? "") ?? font;
  return documentFontOptions(platform).some((option) => option.value === normalized)
    ? (normalized as string)
    : defaultDocumentFont(platform);
}

const DOCX_FONTS = new Map([
  ["SimSun", "SimSun"],
  ["宋体", "SimSun"],
  ["FangSong", "FangSong"],
  ["仿宋", "FangSong"],
  ["KaiTi", "KaiTi"],
  ["楷体", "KaiTi"],
  ["SimHei", "SimHei"],
  ["Microsoft YaHei", "Microsoft YaHei"],
  [BUNDLED_DOCUMENT_FONT, "SimSun"],
  ["思源宋体", "SimSun"],
  ["SourceHanSerifCN", "SimSun"],
  ["HarmonyOS Sans SC", "SimSun"],
  ["HarmonyOS Sans", "SimSun"],
  ["PingFang SC", "SimSun"],
  ["system-ui", "SimSun"],
  ["-apple-system", "SimSun"],
]);

/** Null retains the exporter's existing warning for an unknown imported font. */
export function docxDocumentFont(font: string, platform = "win32"): string | null {
  const mapped = DOCX_FONTS.get(font);
  if (!mapped) return null;
  return defaultDocumentFont(platform) === "SimSun" && ["FangSong", "KaiTi"].includes(mapped)
    ? mapped
    : "SimSun";
}

/** Blank body text uses 14 pt on every platform; templates and explicit sizes prevail. */
export function defaultDocumentFontSizePt(_platform?: string): number {
  return 14;
}
