import { copyFile, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

for (const mode of ["modeless", "modal"] as const) {
  test(`Greek keyboard stays above the ${mode} formula dialog and accepts input`, async () => {
    const root = await mkdtemp(join(tmpdir(), "patent-formula-keyboard-layer-"));
    await build({
      entryPoints: ["tests/e2e/fixtures/formula-focus-view.tsx"],
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
      outfile: join(root, "view.js"),
    });
    await cp("node_modules/mathlive/fonts", join(root, "fonts"), { recursive: true });
    await copyFile("node_modules/mathlive/mathlive-fonts.css", join(root, "mathlive-fonts.css"));
    await copyFile("tests/e2e/fixtures/formula-focus-main.cjs", join(root, "main.cjs"));
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="mathlive-fonts.css"></head><body><div id="root"></div><script type="module" src="view.js"></script></body></html>',
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
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(page.url() + "?mode=" + mode);
      for (const stylesheet of [
        "src/renderer/src/app/app.css",
        "src/renderer/src/editor/editor.css",
      ])
        await page.addStyleTag({ content: await readFile(stylesheet, "utf8") });
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isVisible(),
        ),
      ).toBe(false);
      const field = page.getByRole("textbox", { name: "可视公式编辑器" });
      await expect(
        page
          .locator(".formula-dialog-footer-tools")
          .getByRole("button", { name: "希腊字母", exact: true }),
      ).toBeVisible();
      const titleGap = await page.locator(".formula-position-switch").evaluate((control) => {
        const title = control.parentElement?.querySelector("h2");
        if (!title) throw new Error("Missing dialog title");
        return control.getBoundingClientRect().left - title.getBoundingClientRect().right;
      });
      expect(titleGap).toBeGreaterThanOrEqual(8);
      expect(titleGap).toBeLessThanOrEqual(24);

      await expect(field).toBeFocused();
      await page.getByRole("button", { name: "希腊字母", exact: true }).click();
      const alpha = page.locator('.MLK__layer.is-visible [data-keycap-value="\\\\alpha"]');
      await expect(alpha).toBeVisible();
      const bounds = await alpha.boundingBox();
      if (!bounds) throw new Error("希腊字母按键未显示");
      const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      // Reproduce overlap during dialog motion, while retaining the real stacking contexts.
      const originalStyle = await page.locator(".formula-dialog").evaluate((dialog, point) => {
        const surface = dialog as HTMLElement;
        const original = surface.style.cssText;
        surface.style.cssText =
          "position: fixed; left: 0; top: " +
          (point.y - 60) +
          "px; width: 100vw; height: 140px; max-height: none; translate: none; transform: none; transition: none;";
        return original;
      }, point);
      expect(
        await page.locator(".formula-dialog").evaluate((dialog, point) => {
          const rect = dialog.getBoundingClientRect();
          return (
            point.x > rect.left &&
            point.x < rect.right &&
            point.y > rect.top &&
            point.y < rect.bottom
          );
        }, point),
      ).toBe(true);
      expect(
        await page.evaluate(
          (point) => Boolean(document.elementFromPoint(point.x, point.y)?.closest(".ML__keyboard")),
          point,
        ),
      ).toBe(true);
      await alpha.click();
      await expect
        .poll(() => field.evaluate((element) => (element as HTMLElement & { value: string }).value))
        .toContain("\\alpha");
      await page.locator(".formula-dialog").evaluate((dialog, original) => {
        (dialog as HTMLElement).style.cssText = original;
      }, originalStyle);
      await page.evaluate(() => window.mathVirtualKeyboard.hide({ animate: false }));
      await expect(page.locator(".ML__keyboard.is-visible")).toHaveCount(0);
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "插入数学公式" })).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() =>
            getComputedStyle(document.body).getPropertyValue("--keyboard-zindex").trim(),
          ),
        )
        .toBe("");
    } finally {
      await application.close();
    }
  });
}
