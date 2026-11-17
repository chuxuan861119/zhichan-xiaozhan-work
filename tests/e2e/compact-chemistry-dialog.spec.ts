import { copyFile, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

test("expanded chemistry dialog retains input and every symbol on small screens", async () => {
  const root = await mkdtemp(join(tmpdir(), "chemical-panel-layout-"));
  await build({
    entryPoints: ["tests/e2e/fixtures/compact-chemistry-dialog.tsx"],
    bundle: true,
    external: ["../chemistry/ketcher-editor"],
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    outfile: join(root, "view.js"),
  });
  await cp("node_modules/mathlive/fonts", join(root, "fonts"), { recursive: true });
  await copyFile("node_modules/mathlive/mathlive-fonts.css", join(root, "mathlive-fonts.css"));
  await cp("node_modules/katex/dist/fonts", join(root, "fonts"), { recursive: true });
  await copyFile("node_modules/katex/dist/katex.min.css", join(root, "katex.css"));
  await copyFile("tests/e2e/fixtures/formula-focus-main.cjs", join(root, "main.cjs"));
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="katex.css"><link rel="stylesheet" href="mathlive-fonts.css"></head><body><div id="root"></div><script type="module" src="view.js"></script></body></html>',
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
    const field = page.getByRole("textbox", { name: "化学方程式编辑器" });
    await expect(field).toBeVisible();
    await field.evaluate((element) => {
      const mathfield = element as HTMLElement & { value: string };
      mathfield.value = "H_{2}O";
      mathfield.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(page.locator(".chemistry-preview .katex")).toBeVisible();
    const previewBefore = await page.locator(".chemistry-preview").innerHTML();
    await page.getByRole("radio", { name: "独立方程式" }).check();
    await expect.poll(() => page.locator(".chemistry-preview").innerHTML()).toBe(previewBefore);
    await expect(page.locator("header .formula-position-switch")).toBeVisible();
    const titleGap = await page.locator(".formula-position-switch").evaluate((control) => {
      const title = control.parentElement?.querySelector("h2");
      if (!title) throw new Error("Missing dialog title");
      return control.getBoundingClientRect().left - title.getBoundingClientRect().right;
    });
    expect(titleGap).toBeGreaterThanOrEqual(8);
    expect(titleGap).toBeLessThanOrEqual(24);

    await expect(page.getByRole("tab", { name: "化学结构式", exact: true })).toHaveCount(0);
    const toggle = page.locator(".chemistry-toggle-panel");
    for (const size of [
      { width: 1366, height: 768 },
      { width: 1024, height: 768 },
      { width: 1280, height: 720 },
    ]) {
      await page.setViewportSize(size);
      await toggle.click();
      await expect(page.getByRole("region", { name: "化学方程式预览" })).toHaveCount(0);
      await expect
        .poll(() =>
          page
            .locator(".chemistry-periodic-collapse")
            .evaluate(
              (el) =>
                el.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length,
            ),
        )
        .toBe(0);
      const layout = await page.locator(".chemistry-dialog").evaluate((dialog) => {
        const nodes = [...dialog.querySelectorAll("math-field, .chemistry-symbols button")];
        return nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return {
            label: node.getAttribute("aria-label"),
            inside:
              rect.top >= 0 &&
              rect.bottom <= innerHeight &&
              rect.left >= 0 &&
              rect.right <= innerWidth,
            reachable: node.contains(hit),
          };
        });
      });
      expect(layout.length).toBe(12);
      expect(
        layout.filter((item) => !item.inside || !item.reachable),
        JSON.stringify({ size, layout }),
      ).toEqual([]);
      await expect(page.getByRole("radio", { name: "独立方程式" })).toBeChecked();
      await expect
        .poll(() => field.evaluate((el) => (el as HTMLElement & { value: string }).value))
        .toContain("H");
      await page.screenshot({
        path: test.info().outputPath(`chemistry-${size.width}-${size.height}.png`),
      });
      await toggle.click();
      await expect(page.locator(".chemistry-preview .katex")).toBeVisible();
    }
  } finally {
    await application.close();
  }
});
