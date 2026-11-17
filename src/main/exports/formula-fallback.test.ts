import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { renderFormulaFallback } from "./formula-fallback.js";

describe("formula raster fallback", () => {
  test("rejects error output instead of turning it into a successful formula image", async () => {
    await expect(renderFormulaFallback(String.raw`\frac{1}{`)).rejects.toThrow(/公式/);
    await expect(renderFormulaFallback(String.raw`\unknownCommand{x}`)).rejects.toThrow(/公式/);
    expect((await renderFormulaFallback("x+1")).widthPx).toBeGreaterThan(0);
  });
  test("renders replacement formulas from vectors at the retained figure width", async () => {
    const result = await renderFormulaFallback("x^2+y^2", 87);
    expect(result.widthPx).toBeCloseTo((87 * 300) / 25.4, -1);
    expect((await sharp(result.png).metadata()).density).toBe(300);
  });
  test("imports the MathJax mhchem configuration explicitly", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/main/exports/formula-fallback.ts"),
      "utf8",
    );

    expect(source).toContain('import "mathjax-full/js/input/tex/mhchem/MhchemConfiguration.js";');
    expect(source).toMatch(/new Set\(\[\.\.\.AllPackages,\s*"mhchem"\]\)/u);
    expect(source).toMatch(/packages:\s*ENABLED_TEX_PACKAGES/u);
  });

  test("renders a deterministic transparent 300-DPI PNG with exact alt text", async () => {
    const source = String.raw`\frac{\alpha}{x}`;

    const first = await renderFormulaFallback(source);
    const second = await renderFormulaFallback(source);
    const metadata = await sharp(first.png).metadata();

    expect(first.altText).toBe(`复杂公式（LaTeX）：${source}`);
    expect(first.png).toEqual(second.png);
    expect(metadata.format).toBe("png");
    expect(metadata.hasAlpha).toBe(true);
    expect(metadata.density).toBe(300);
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.height).toBeGreaterThan(0);
    expect(metadata.width).toBeLessThanOrEqual(4096);
    expect(metadata.height).toBeLessThanOrEqual(4096);
  });

  test("bounds an unusually wide formula to the maximum raster size", async () => {
    const result = await renderFormulaFallback("x+".repeat(4_000));
    const metadata = await sharp(result.png).metadata();

    expect(metadata.width).toBeLessThanOrEqual(4096);
    expect(metadata.height).toBeLessThanOrEqual(4096);
  }, 15_000);

  test("renders a chemical equation through the explicitly enabled mhchem package", async () => {
    const result = await renderFormulaFallback(String.raw`\ce{SO4^2- + Ba^2+ -> BaSO4 v}`);
    const metadata = await sharp(result.png).metadata();

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.height).toBeGreaterThan(0);
  });
});
