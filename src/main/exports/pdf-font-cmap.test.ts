import { readFileSync } from "node:fs";
import { pdfFontVariants, unicodeGlyphMap } from "./pdf-font-cmap.js";

test("PDF font maps preserve ordinary Han and literal radicals even when their glyphs coincide", () => {
  const original = readFileSync("src/shared/document/fonts/SourceHanSerifCN-Regular.otf");
  const text = "导入一汽车⼊⼀⻋𠮷";
  const originalMap = unicodeGlyphMap(original);
  const variants = pdfFontVariants(original, new Set([...text].map((c) => c.codePointAt(0) ?? 0)));
  const restored = new Map<number, number>();
  for (const variant of variants) {
    const map = unicodeGlyphMap(variant.bytes);
    expect(new Set(map.values()).size).toBe(map.size);
    for (const [point, glyph] of map) restored.set(point, glyph);
  }
  for (const c of text) {
    const point = c.codePointAt(0) ?? 0;
    if (originalMap.has(point)) expect(restored.get(point)).toBe(originalMap.get(point));
  }
  expect(variants.length).toBeGreaterThan(1);
  expect(
    original.equals(readFileSync("src/shared/document/fonts/SourceHanSerifCN-Regular.otf")),
  ).toBe(true);
});
