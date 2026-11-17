import { isVectorSvgSafeForExport, sanitizeVectorSvg } from "./vector-image-safety.js";

test("allows static paths, labels and local clip references", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><defs><clipPath id="clip"><rect width="100" height="60"/></clipPath></defs><path clip-path="url(#clip)" d="M0 0L100 60"/><text x="20" y="40">X</text></svg>';
  expect(isVectorSvgSafeForExport(svg)).toBe(true);
  expect(sanitizeVectorSvg(svg)).toContain(">X</text>");
});

test.each([
  "<script>alert(1)</script>",
  '<image href="https://example.invalid/image.png"/>',
  '<path onclick="alert(1)" d="M0 0L10 10"/>',
  "<foreignObject><div>HTML</div></foreignObject>",
])("rejects executable or external vector content for direct export: %s", (content) => {
  expect(isVectorSvgSafeForExport(`<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`)).toBe(
    false,
  );
});

test("rejects entity declarations and malformed SVG", () => {
  expect(() =>
    sanitizeVectorSvg('<!DOCTYPE svg [<!ENTITY e SYSTEM "file:///private">]><svg/>'),
  ).toThrow();
  expect(isVectorSvgSafeForExport("not svg")).toBe(false);
});
