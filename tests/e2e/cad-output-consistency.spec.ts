import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";

type ProbeResult = {
  error: string | null;
  unchanged: boolean;
  widthMm?: number;
  renderedWidthMm?: number;
  heightMm?: number;
  fontMm?: number;
};

test("CAD output retains physical lettering after portrait fitting and reports new overlaps", async () => {
  const compiled = await build({
    entryPoints: [resolve("tests/e2e/fixtures/cad-output-consistency.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    plugins: [
      {
        name: "worker-url",
        setup(b) {
          b.onResolve({ filter: /\?url$/ }, (args) => ({
            path: args.path,
            namespace: "worker-url",
          }));
          b.onLoad({ filter: /.*/, namespace: "worker-url" }, () => ({
            contents: 'export default ""',
            loader: "js",
          }));
        },
      },
    ],
  });
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent("<body></body>");
    await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
    const run = (args: [boolean, number?, number?, boolean?, boolean?, boolean?]) =>
      page.evaluate(
        (args) =>
          (
            window as unknown as {
              cadOutputConsistencyProbe(
                ...args: (boolean | number | undefined)[]
              ): Promise<ProbeResult>;
            }
          ).cadOutputConsistencyProbe(...args),
        args,
      );
    for (const tall of [false, true]) {
      for (const dpi of [300, 600]) {
        const result = await run([tall, 1, dpi]);
        expect.soft(result.error).toBeNull();
        if (result.error) continue;
        expect(result.unchanged).toBe(true);
        expect.soft(result.widthMm).toBe(result.renderedWidthMm);
        expect(result.heightMm).toBeLessThanOrEqual(200.1);
        expect.soft(result.fontMm).toBeCloseTo(7, 1);
        if (!tall) expect(result.widthMm).toBe(120);
      }
    }
    const gui = await run([false, 1.5]);
    const cli = await run([false, 1.5, 300, false, true]);
    if (gui.fontMm === undefined || cli.fontMm === undefined)
      throw new Error("Missing rendered labels");
    expect(gui.fontMm).toBeCloseTo(10.5, 1);
    expect.soft(cli.fontMm).toBeCloseTo(gui.fontMm, 2);
    const collision = await run([false, 1, 300, true]);
    expect(collision.error).toMatch(/12.*13.*重叠/);
    expect(collision.unchanged).toBe(true);
    const cliCollision = await run([false, 1, 300, true, true]);
    expect(cliCollision.error).toMatch(/12.*13.*重叠/);
    expect(cliCollision.unchanged).toBe(true);
    for (const dpi of [300, 600]) {
      const narrow = await run([true, 1, dpi, false, false, true]);
      expect.soft(narrow.error).toBeNull();
      if (!narrow.error) {
        expect(narrow.heightMm).toBeLessThanOrEqual(200.1);
        expect(narrow.widthMm).toBeGreaterThanOrEqual(10);
        expect(narrow.unchanged).toBe(true);
      }
    }
  } finally {
    await browser.close();
  }
});
