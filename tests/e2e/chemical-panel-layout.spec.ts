import { copyFile, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

test("chemical panels show every card without horizontal scrolling", async () => {
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
    for (const width of [1400, 1000, 800]) {
      await page.setViewportSize({ width, height: 900 });
      for (const tab of ["离子", "化学式", "同位素"]) {
        await page.getByRole("tab", { name: tab, exact: true }).click();
        await expect(page.locator(".periodic-formula-btn").first()).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await expect
          .poll(() =>
            page
              .locator(".chemical-periodic-panel")
              .evaluate(
                (panel) =>
                  panel
                    .getAnimations({ subtree: true })
                    .filter((animation) => animation.playState === "running").length,
              ),
          )
          .toBe(0);
        const layout = await page.locator(".chemistry-periodic-tray").evaluate((tray) => {
          const container = tray.parentElement;
          if (!container) throw new Error("元素面板容器未挂载");
          const bounds = container.getBoundingClientRect();
          const cards = [...tray.querySelectorAll<HTMLElement>(".periodic-formula-btn")];
          return {
            overflow: Math.max(
              tray.scrollWidth - tray.clientWidth,
              tray.getBoundingClientRect().right - bounds.right,
            ),
            verticalOverflow: tray.scrollHeight - tray.clientHeight,
            clipped: cards
              .filter((card) => {
                const rect = card.getBoundingClientRect();
                return (
                  rect.left < bounds.left - 1 ||
                  rect.right > bounds.right + 1 ||
                  rect.bottom > bounds.bottom + 1 ||
                  rect.top < bounds.top - 1
                );
              })
              .map((card) => card.title),
            contentClipped: cards
              .filter((card) =>
                [
                  ...card.querySelectorAll<HTMLElement>(
                    ":scope > span, :scope > .periodic-formula-preview",
                  ),
                ].some((span) => {
                  const content = (
                    span.querySelector(".katex-html") ?? span
                  ).getBoundingClientRect();
                  const button = card.getBoundingClientRect();
                  return content.left < button.left - 1 || content.right > button.right + 1;
                }),
              )
              .map((card) => card.title),
          };
        });
        expect(layout.overflow, `${width}px ${tab}: ${JSON.stringify(layout)}`).toBeLessThanOrEqual(
          1,
        );
        expect(layout.verticalOverflow).toBeLessThanOrEqual(1);
        expect(layout.clipped).toEqual([]);
        expect(layout.contentClipped).toEqual([]);
        if (width === 800 && tab === "化学式") {
          await page.screenshot({ path: test.info().outputPath("chemical-formulas-800.png") });
        }
        const last = page.locator(".periodic-formula-btn").last();
        const title = await last.getAttribute("title");
        await last.click();
        await expect(page.getByLabel("插入结果")).toHaveText(title?.split(": ")[1] ?? "");
      }
    }
  } finally {
    await application.close();
  }
});
