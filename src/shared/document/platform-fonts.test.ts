import { createMacDocumentFontCss, withPlatformPrintFonts } from "./platform-fonts.js";

const css = createMacDocumentFontCss({ regular: "regular.otf", semibold: "semibold.otf" });

test("Songti aliases use local Mac fonts instead of bundled Source Han faces", () => {
  expect(css).toContain('font-family: "SimSun"; src: local("PingFangSC-Regular")');
  expect(css).toContain('font-family: "宋体"; src: local("PingFangSC-Regular")');
  expect(css).not.toContain('font-family: "SimSun"; src: url(');
});

test("Mac print fonts match editor aliases without changing the stored document text", () => {
  const html =
    '<!doctype html><html><body><p style="font-family:SimSun">测试正文</p></body></html>';
  expect(withPlatformPrintFonts(html, "linux", css)).toBe(html);
  const mac = withPlatformPrintFonts(html, "darwin", css);
  expect(mac.startsWith("<!doctype html>")).toBe(true);
  expect(mac).toContain(`<head><style>${css}</style></head>`);
  expect(mac).toContain('<p style="font-family:SimSun">测试正文</p>');
});

test("adds font resources inside an existing head without changing text or bold marks", () => {
  const html =
    '<html><head><title>说明书</title></head><body><strong style="font-family:SimSun">技术领域</strong></body></html>';
  const mac = withPlatformPrintFonts(html, "darwin", css);
  expect(mac).toContain(`<title>说明书</title><style>${css}</style></head>`);
  expect(mac.slice(mac.indexOf("<body>"))).toBe(html.slice(html.indexOf("<body>")));
});
