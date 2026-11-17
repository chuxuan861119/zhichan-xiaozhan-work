import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";

test("CAD preview/export paints bound labels from the label-free patent SVG", async () => {
  const compiled = await build({
    entryPoints: [resolve("tests/e2e/fixtures/cad-native-label-preview.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    plugins: [
      {
        name: "worker-url",
        setup(builder) {
          builder.onResolve({ filter: /\?url$/ }, (args) => ({
            path: args.path,
            namespace: "worker-url",
          }));
          builder.onLoad({ filter: /.*/, namespace: "worker-url" }, () => ({
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
    for (const auto of [false, true]) {
      for (const mode of ["native", "clipped", "image", "overlay"] as const) {
        const components = await page.evaluate(
          async ({ mode, auto }) =>
            (
              window as unknown as {
                viewportProbe: (mode: string, auto: boolean) => Promise<number>;
              }
            ).viewportProbe(mode, auto),
          { mode, auto },
        );
        expect(components, `${mode}, automatic labels: ${auto}`).toBe(
          mode === "native" || mode === "overlay" ? 5 : 1,
        );
      }
    }
    const run = (native: boolean, auto: boolean, overlay: boolean, automation = false) =>
      page.evaluate(
        ([native, auto, overlay, automation]) =>
          (
            window as unknown as {
              nativeLabelProbe: (
                native: boolean,
                auto: boolean,
                overlay: boolean,
                automation: boolean,
              ) => Promise<{ calls: string[]; bytes: number }>;
            }
          ).nativeLabelProbe(native, auto, overlay, automation),
        [native, auto, overlay, automation] as const,
      );
    for (const overlay of [false, true]) {
      const bound = await run(true, false, overlay);
      const unbound = await run(false, false, overlay);
      expect(bound.calls.length).toBeGreaterThan(0);
      expect(bound.calls).toEqual(unbound.calls.map(() => "12"));
      expect(unbound.calls).toContain("13");
      const adjusted = await run(true, true, overlay);
      expect(adjusted.calls).toContain("12");
      expect(adjusted.calls.every((call) => call === "12")).toBe(true);
      expect(adjusted.bytes).toBeGreaterThan(100);
      expect((await run(true, true, overlay, true)).calls).toContain("12");
    }
  } finally {
    await browser.close();
  }
});
