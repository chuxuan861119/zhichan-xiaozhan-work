import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

test("mixed selection stays blank and selecting five applies to the entire selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "patent-mixed-format-"));
  await build({
    entryPoints: ["tests/e2e/fixtures/mixed-selection-format-view.tsx"],
    bundle: true,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    loader: { ".png": "file", ".woff": "file", ".woff2": "file", ".ttf": "file" },
    define: { "process.env.NODE_ENV": '"development"' },
    outfile: join(root, "view.js"),
  });
  await copyFile("tests/e2e/fixtures/formula-focus-main.cjs", join(root, "main.cjs"));
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script type="module" src="view.js"></script></body></html>',
  );
  const env = Object.fromEntries(
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() =>
      Object.defineProperty(globalThis, "documentFontPlatform", {
        value: "darwin",
        configurable: true,
      }),
    );
    await page.reload();
    await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
    await expect(page.locator(".tiptap")).toHaveText("甲乙");
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isVisible(),
      ),
    ).toBe(false);
    const size = page.locator(".tool-bar").getByRole("combobox", { name: "字号", exact: true });
    const font = page.locator(".tool-bar").getByRole("combobox", { name: "字体", exact: true });
    const state = () =>
      page.getByLabel("格式状态").evaluate((element) => JSON.parse(element.textContent ?? "{}"));
    await page.getByRole("button", { name: "选择单一文字" }).click();
    await expect(size).toHaveValue("10.5");
    const miniMenu = page.locator(".editor-selection-menu:not([data-spatial-paint])");
    const miniFont = miniMenu.locator('select[aria-label="字体"]');
    const mainLabel = font.locator(".toolbar-selected-label");
    const miniLabel = miniFont.locator(".toolbar-selected-label");
    await expect(miniFont).toBeVisible();
    await expect(miniLabel).toHaveText("苹方（系统自带）");
    await expect(mainLabel).toHaveText("苹方（系统自带）");
    for (const label of [mainLabel, miniLabel]) {
      await expect(label).toHaveCSS("white-space", "nowrap");
      await expect(label).toHaveCSS("font-size", "12px");
      await expect(label).toHaveCSS("overflow", "hidden");
      const bounds = await label.evaluate((element) => {
        const select = element.closest("select");
        if (!select) throw new Error("Missing select");
        return {
          label: element.getBoundingClientRect().toJSON(),
          select: select.getBoundingClientRect().toJSON(),
          fontSize: parseFloat(getComputedStyle(element).fontSize),
        };
      });
      expect(bounds.label.height).toBeLessThanOrEqual(bounds.fontSize * 1.5);
      expect(bounds.label.right).toBeLessThanOrEqual(bounds.select.right - 14);
    }
    await expect(miniLabel).toHaveClass(/is-overflowing/);
    await miniMenu.screenshot({ path: join(root, "font-components.png") });
    console.log(`Font comparison screenshot: ${join(root, "font-components.png")}`);
    await page.getByRole("button", { name: "选择混合文字" }).click();
    await expect(size).toHaveValue("");
    await expect(font).toHaveValue("");
    await expect(miniFont).toHaveValue("");
    await expect(miniLabel).toHaveText("");
    expect(await size.locator("selectedcontent").textContent()).toBe("");
    await size.selectOption("10.5");
    await expect(size).toHaveValue("10.5");
    expect(await state()).toMatchObject({ from: 1, to: 3, format: { fontSizePt: 10.5 } });
    const fontSizes = await page
      .locator(".tiptap p span")
      .evaluateAll((spans) => spans.map((span) => getComputedStyle(span).fontSize));
    expect(fontSizes).toEqual(["14px", "14px"]);
    await page.getByRole("button", { name: "选择单一文字" }).click();
    await page.getByRole("button", { name: "选择混合文字" }).click();
    await expect(miniMenu).not.toHaveAttribute("inert");
    await expect(miniFont).toBeVisible();
    await miniFont.selectOption("Source Han Serif CN");
    await expect(font).toHaveValue("Source Han Serif CN");
    await expect(miniFont).toHaveValue("Source Han Serif CN");
    await expect(miniLabel).toHaveText("思源宋体");
    expect(await state()).toMatchObject({
      from: 1,
      to: 3,
      format: { fontFamily: "Source Han Serif CN" },
    });
    await size.selectOption("14");
    await expect(size).toHaveValue("14");
    await expect(page.locator(".tiptap")).toHaveText("甲乙");
    expect(await state()).toMatchObject({ from: 1, to: 3, format: { fontSizePt: 14 } });
    expect(errors).toEqual([]);
  } finally {
    await application.close();
  }
});
