import { withBundledPrintFonts } from "./platform-print-fonts.js";
import { unicodeGlyphMap } from "./pdf-font-cmap.js";

vi.mock("../../shared/document/fonts/SourceHanSerifCN-Regular.otf?asset", () => ({
  default: "src/shared/document/fonts/SourceHanSerifCN-Regular.otf",
}));
vi.mock("../../shared/document/fonts/SourceHanSerifCN-SemiBold.otf?asset", () => ({
  default: "src/shared/document/fonts/SourceHanSerifCN-SemiBold.otf",
}));

test.each(["win32", "darwin", "openharmony", "ohos"])(
  "%s print supplies bundled fonts without changing content",
  (platform) => {
    const html =
      '<html><head></head><body><b style="font-family:SimSun">技术领域</b></body></html>';
    expect(withBundledPrintFonts(html, "linux")).toBe(html);
    const mac = withBundledPrintFonts(html, platform);
    // Boolean assertions avoid dumping megabytes of font data on failure.
    expect(mac.includes('src: url("data:font/otf;base64,')).toBe(platform === "darwin");
    expect(mac.includes('local("Songti SC")')).toBe(false);
    expect(
      mac.includes(platform === "darwin" ? 'font-family: "ZXWPDFSerif"' : "font-family:SimSun"),
    ).toBe(true);
    expect(
      mac.endsWith(
        html
          .slice(html.indexOf("<body>"))
          .replace("SimSun", platform === "darwin" ? "ZXWPDFSerif" : "SimSun"),
      ),
    ).toBe(true);
  },
);

test.each(["win32", "openharmony", "ohos"])(
  "%s system-font jobs do not transport unused bundled fonts",
  (platform) => {
    const html = '<html><head></head><body><p style="font-family:SimSun">原文</p></body></html>';
    const result = withBundledPrintFonts(html, platform);
    expect(result.length < 4096).toBe(true);
    expect(result.endsWith(html.slice(html.indexOf("<body>")))).toBe(true);
  },
);

test.each(["win32", "darwin", "openharmony"])(
  "%s treats user-written character entities as literal text",
  (platform) => {
    const html =
      '<html><head></head><body><p style="font-family:SourceHanSerifCN">&amp;#x4e00; &amp;#x110000;</p></body></html>';
    const result = withBundledPrintFonts(html, platform);
    expect(result.includes("U+26")).toBe(true);
    expect(result.includes("U+23")).toBe(true);
    expect(result.includes("U+4e00")).toBe(false);
  },
);

test.each(["Source Han Serif CN", "思源宋体", "SourceHanSerifCN"])(
  "includes only the used bundled family %s, including escaped declarations",
  (family) => {
    const encoded = [...family]
      .map((character) => `\\${character.codePointAt(0)?.toString(16)} `)
      .join("");
    const html = `<html><head></head><body><p style="font-family:&quot;${encoded}&quot;">正文不变</p></body></html>`;
    const result = withBundledPrintFonts(html, "win32");
    expect((result.match(/data:font\/otf;base64,/gu) ?? []).length).toBe(2);
    expect(result.includes(`font-family: "${family}"`)).toBe(true);
    expect(result.endsWith(html.slice(html.indexOf("<body>")))).toBe(true);
  },
);

test("Mac print remaps HTML-escaped native font declarations and preserves visible text", () => {
  const html =
    '<html><head></head><body><p style="font-family:&quot;PingFang SC&quot;;font-size:14pt">导入一汽车⼊</p></body></html>';
  const result = withBundledPrintFonts(html, "darwin");
  expect(result.includes("font-family:&quot;ZXWPDFSerif&quot;;")).toBe(true);
  expect(result.includes(">导入一汽车⼊</p>")).toBe(true);
  expect(result.includes('local("PingFang')).toBe(false);
});

test("bundled SVG text fonts are retained when declared as presentation attributes", () => {
  const html =
    '<html><head></head><body><svg><text font-family="思源宋体">图纸文字</text></svg></body></html>';
  const result = withBundledPrintFonts(html, "openharmony");
  expect((result.match(/data:font\/otf;base64,/gu) ?? []).length).toBe(2);
  expect(result.endsWith(html.slice(html.indexOf("<body>")))).toBe(true);
});

test("Mac print also resolves the canonical serializer's CSS hex font names", () => {
  const html = String.raw`<html><head></head><body><p style="font-family:&quot;\50 \69 \6e \67 \46 \61 \6e \67 \20 \53 \43 &quot;;font-size:14pt">导入</p></body></html>`;
  expect(
    withBundledPrintFonts(html, "darwin").includes("font-family:&quot;ZXWPDFSerif&quot;;"),
  ).toBe(true);
});

test.each(["win32", "openharmony", "ohos"])(
  "%s bundled print faces keep Han and literal radical code points distinct",
  (platform) => {
    const text = "一入支⼀⼊⽀";
    const html = `<html><head></head><body><p style="font-family:'Source Han Serif CN'">${text}</p></body></html>`;
    const result = withBundledPrintFonts(html, platform);
    const covered = new Set<number>();
    for (const payload of result.split("data:font/otf;base64,").slice(1)) {
      const cmap = unicodeGlyphMap(Buffer.from(payload.slice(0, payload.indexOf('"')), "base64"));
      expect(new Set(cmap.values()).size).toBe(cmap.size);
      for (const point of cmap.keys()) covered.add(point);
    }
    for (const character of text) expect(covered.has(character.codePointAt(0) ?? 0)).toBe(true);
  },
);
