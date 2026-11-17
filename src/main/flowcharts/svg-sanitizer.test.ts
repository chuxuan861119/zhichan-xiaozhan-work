import { SvgSanitizer, type SvgSanitizerError } from "./svg-sanitizer.js";

const sanitizer = new SvgSanitizer();

test("keeps inherited diagram labels black instead of inheriting a white shape fill", () => {
  const result = sanitizer.sanitize(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><g fill="#000000"><text x="5" y="25">开始</text></g></svg>',
    { borderMm: 0 },
  );
  expect(result.svg).toContain('<text x="5" y="25" fill="#000000">开始');
});

test.each(['fill="none"', 'style="fill:none"'])(
  "preserves intentionally invisible labels inherited through %s",
  (paint) => {
    const result = sanitizer.sanitize(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><g ${paint}><text x="5" y="25"><tspan>隐藏</tspan></text></g></svg>`,
      { borderMm: 0 },
    );
    expect(result.svg).not.toContain('fill="#000000"');
  },
);

test("maps diagram colors to patent black and white while preserving dashes", () => {
  const result = sanitizer.sanitize(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect x="1" y="1" width="20" height="10" fill="#ff0000" stroke="#00ff00" stroke-width="0.05" stroke-dasharray="4 2"/><text x="5" y="25" fill="#0000ff">步骤</text></svg>',
    { borderMm: 2, outputWidthMm: 150 },
  );
  expect(result.svg).toContain('fill="#FFFFFF"');
  expect(result.svg).toContain('stroke="#000000"');
  expect(result.svg).toContain('stroke-width="0.2"');
  expect(result.svg).toContain('stroke-dasharray="4 2"');
  expect(result.svg).toContain('fill="#000000">步骤');
  expect(result.svg).toContain('viewBox="-1.369');
});

test("uses the standard patent figure width when calculating an omitted output width", () => {
  const result = sanitizer.sanitize(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50"/></svg>',
    { borderMm: 2 },
  );

  expect(result.svg).toContain('viewBox="-2.631');
});

test("keeps the physical margin unchanged when the displayed figure is rotated", () => {
  const result = sanitizer.sanitize(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50"/></svg>',
    { borderMm: 2, outputWidthMm: 54, rotationDeg: 90 },
  );
  expect(result.svg).toContain('viewBox="-2 -2 104 54"');
});

test("removes gradients after converting their painted objects to black and white", () => {
  const result = sanitizer.sanitize(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="100" height="50" fill="url(#g)" stroke="url(#g)"/></svg>',
    { borderMm: 0, outputWidthMm: 150 },
  );
  expect(result.svg).not.toMatch(/linearGradient|<stop|url\(#g\)/u);
  expect(result.svg).toContain('fill="#FFFFFF"');
  expect(result.svg).toContain('stroke="#000000"');
});

test("accepts benign attributes emitted by the bundled draw.io SVG exporter", () => {
  const result = sanitizer.sanitize(
    '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 121 61"><g data-cell-id="2"><rect width="120" height="60" fill="#fff" stroke="#000" pointer-events="all"/></g></svg>',
    { borderMm: 0 },
  );

  expect(result.svg).toContain('version="1.1"');
  expect(result.svg).toContain('data-cell-id="2"');
  expect(result.svg).toContain('pointer-events="all"');
});

test("removes shadow effects and warns when local raster images need high contrast conversion", () => {
  const result = sanitizer.sanitize(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" filter="url(#shadow)"/><image href="data:image/png;base64,AA==" width="2" height="2"/></svg>',
    { borderMm: 0 },
  );
  expect(result.svg).not.toContain("filter=");
  expect(result.warnings).toContain("位图已按专利附图规则转换为高对比度效果，请检查细节。");
});

test.each([
  ['<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>', "UNSAFE_SVG"],
  ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "UNSAFE_SVG"],
  ['<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>', "UNSAFE_SVG"],
  [
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/a.png"/></svg>',
    "EXTERNAL_RESOURCE",
  ],
  ['<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="evil()"/></svg>', "UNSAFE_SVG"],
  ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>', "EMPTY_SVG"],
])("rejects unsafe or empty SVG with stable code", (source, code) => {
  expect(() => sanitizer.sanitize(source, { borderMm: 0 })).toThrowError(
    expect.objectContaining<Partial<SvgSanitizerError>>({
      code: code as SvgSanitizerError["code"],
    }),
  );
});

test("rejects border values outside the supported 0 to 20 mm range", () => {
  expect(() =>
    sanitizer.sanitize('<svg><rect width="1" height="1"/></svg>', { borderMm: 21 }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_BORDER" }));
});

test("rejects SVG that exceeds the explicit source or node complexity limits", () => {
  expect(() =>
    sanitizer.sanitize(
      `<svg xmlns="http://www.w3.org/2000/svg">${'<path d="M0 0"/>'.repeat(50_001)}</svg>`,
      { borderMm: 0 },
    ),
  ).toThrowError(expect.objectContaining({ code: "SVG_TOO_COMPLEX" }));

  expect(() => sanitizer.sanitize(" ".repeat(20 * 1024 * 1024 + 1), { borderMm: 0 })).toThrowError(
    expect.objectContaining({ code: "SVG_TOO_LARGE" }),
  );
});
