import { copyFile, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

test("chemical tab content uses standard timing and keeps the header stable", async () => {
  const root = await mkdtemp(join(tmpdir(), "chemical-panel-layout-"));
  await build({
    entryPoints: ["tests/e2e/fixtures/chemical-panel-layout.tsx"],
    bundle: true,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    outfile: join(root, "view.js"),
  });
  await cp("node_modules/katex/dist/fonts", join(root, "fonts"), { recursive: true });
  await copyFile("node_modules/katex/dist/katex.min.css", join(root, "katex.css"));
  await copyFile("tests/e2e/fixtures/formula-focus-main.cjs", join(root, "main.cjs"));
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="katex.css"></head><body><div id="root"></div><script type="module" src="view.js"></script></body></html>',
  );
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({
    args: [join(root, "main.cjs"), `--user-data-dir=${join(root, "profile")}`],
    env,
  });
  try {
    const page = await application.firstWindow();
    for (const stylesheet of ["src/renderer/src/app/app.css", "src/renderer/src/editor/editor.css"])
      await page.addStyleTag({ content: await readFile(stylesheet, "utf8") });
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isVisible(),
      ),
    ).toBe(false);
    for (const target of ["离子", "化学式", "同位素", "元素周期表"]) {
      const { frames, targetHeight } = await page.evaluate(async (target) => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
          (el) => el.textContent === target,
        );
        if (!button) throw new Error("Missing tab");
        const content = document.querySelector<HTMLElement>(".periodic-tab-content");
        if (!content) throw new Error("Missing tab content");
        let targetHeight: number | null = null;
        const start = performance.now();
        const frames: { time: number; height: number; width: number }[] = [];
        button.click();
        await new Promise<void>((resolve) => {
          const sample = () => {
            if (targetHeight === null) {
              for (const animation of content.getAnimations()) {
                const effect = animation.effect as KeyframeEffect | null;
                const keyframes = effect?.getKeyframes();
                const height = keyframes?.at(-1)?.height;
                if (typeof height === "string") targetHeight = Number.parseFloat(height);
              }
            }
            const bounds = content.getBoundingClientRect();
            frames.push({
              time: performance.now() - start,
              height: bounds.height,
              width: bounds.width,
            });
            if (performance.now() - start < 650) requestAnimationFrame(sample);
            else resolve();
          };
          requestAnimationFrame(sample);
        });
        return { frames, targetHeight };
      }, target);
      expect(targetHeight).not.toBeNull();
      const settled = frames.filter((frame) => frame.time > 550);
      expect(
        Math.max(...settled.map((frame) => Math.abs(frame.height - (targetHeight ?? 0)))),
        JSON.stringify({ target, targetHeight, frames }),
      ).toBeLessThanOrEqual(1);
    }
    for (const tab of ["离子", "化学式", "同位素", "元素周期表"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await expect(page.locator(".periodic-tab-outgoing")).toHaveCount(1);
      expect(
        await page
          .locator(".periodic-tab-outgoing")
          .evaluate((el) => (el as HTMLElement).inert && el.getAttribute("aria-hidden") === "true"),
      ).toBe(true);
      const timing = await page
        .locator(".periodic-tab-content")
        .evaluate((el) => el.getAnimations().map((a) => a.effect?.getTiming()));
      expect(timing.some((t) => t?.duration === 400 && t.easing === "ease-in-out")).toBe(true);
      expect(
        await page.locator(".periodic-panel-header").evaluate((el) => el.getAnimations().length),
      ).toBe(0);
    }
    await expect
      .poll(() =>
        page
          .locator(".periodic-tab-content")
          .evaluate((el) => el.getAnimations().filter((a) => a.playState === "running").length),
      )
      .toBe(0);
    await expect(page.locator(".periodic-tab-outgoing")).toHaveCount(0);
    await page.evaluate(() => {
      document.documentElement.dataset.reducedMotion = "true";
    });
    await page.getByRole("tab", { name: "离子", exact: true }).click();
    expect(
      await page.locator(".periodic-tab-content").evaluate((el) => el.getAnimations().length),
    ).toBe(0);
  } finally {
    await application.close();
  }
});
