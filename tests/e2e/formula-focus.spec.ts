import { copyFile, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

declare global {
  interface Window {
    mathVirtualKeyboard: {
      visible: boolean;
      boundingRect: DOMRect;
      hide(options: { animate: boolean }): void;
    };
  }
}

test("mathfield owns initial focus and keeps the caret through typing, tools and reopening", async () => {
  // Multiple close/reopen cycles run in a hidden renderer; keep per-assertion timeouts unchanged.
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "patent-formula-focus-"));
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
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
    await page.reload();
    for (const stylesheet of ["src/renderer/src/app/app.css", "src/renderer/src/editor/editor.css"])
      await page.addStyleTag({ content: await readFile(stylesheet, "utf8") });
    await expect(page.locator("math-field")).toHaveCount(1);
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isVisible(),
      ),
    ).toBe(false);
    const field = page.getByRole("textbox", { name: "可视公式编辑器" });
    await expect(field).toBeFocused();
    await page.waitForTimeout(500);
    const initialDialogLayout = await page.locator(".formula-dialog").evaluate((dialog) => ({
      top: dialog.getBoundingClientRect().top,
      maxHeight: getComputedStyle(dialog).maxHeight,
    }));
    await page.getByRole("button", { name: "希腊字母", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.mathVirtualKeyboard.visible)).toBe(true);
    const readKeyboardLayout = () =>
      page.evaluate(() => {
        const dialogElement = document.querySelector<HTMLElement>(".formula-dialog");
        const dialog = dialogElement?.getBoundingClientRect();
        const keyboard = window.mathVirtualKeyboard.boundingRect;
        if (!dialog || !dialogElement || keyboard.height <= 0)
          throw new Error("公式窗口或虚拟键盘未显示");
        return {
          dialogTop: dialog.top,
          dialogBottom: dialog.bottom,
          keyboardTop: keyboard.top,
          overlap: dialog.bottom - keyboard.top + 12,
          dialogMaxHeight: getComputedStyle(dialogElement).maxHeight,
        };
      });
    await expect.poll(async () => (await readKeyboardLayout()).overlap).toBeLessThanOrEqual(0);
    const keyboardLayout = await readKeyboardLayout();
    expect(keyboardLayout.dialogTop, JSON.stringify(keyboardLayout)).toBeGreaterThanOrEqual(12);
    expect(keyboardLayout.dialogBottom, JSON.stringify(keyboardLayout)).toBeLessThanOrEqual(
      keyboardLayout.keyboardTop - 12,
    );
    expect(keyboardLayout.dialogMaxHeight).toContain("px");
    await page.evaluate(() => window.mathVirtualKeyboard.hide({ animate: false }));
    await expect.poll(() => page.evaluate(() => window.mathVirtualKeyboard.visible)).toBe(false);
    await expect
      .poll(() =>
        page
          .locator(".formula-dialog")
          .evaluate(
            (dialog, initialTop) => Math.abs(dialog.getBoundingClientRect().top - initialTop),
            initialDialogLayout.top,
          ),
      )
      .toBeLessThan(1);
    await expect(page.locator(".formula-dialog")).toHaveCSS(
      "max-height",
      initialDialogLayout.maxHeight,
    );
    await field.focus();
    await expect(field).toBeFocused();
    await expect(page.getByRole("button", { name: "撤回", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "前进", exact: true })).toHaveCount(0);
    // Do not focus via locator.fill/press: real typing must work immediately.
    await page.keyboard.type("abc");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("x");
    await expect
      .poll(() => field.evaluate((element) => (element as HTMLElement & { value: string }).value))
      .toBe("abxc");
    await expect(field).toBeFocused();
    await page.getByRole("button", { name: "矩阵", exact: true }).click();
    const matrix = page.getByRole("dialog", { name: "插入矩阵" });
    await matrix.getByRole("spinbutton", { name: "行数" }).fill("3");
    await expect(matrix.getByRole("spinbutton", { name: "行数" })).toBeFocused();
    await matrix.getByRole("button", { name: "取消", exact: true }).click();
    await expect(field).toBeFocused();
    await page.getByRole("button", { name: "求和", exact: true }).click();
    await expect(field).toBeFocused();
    const value = await field.evaluate(
      (element) => (element as HTMLElement & { value: string }).value,
    );
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "打开公式" }).click();
    await expect(field).toBeFocused();
    expect(
      await field.evaluate((element) => (element as HTMLElement & { value: string }).value),
    ).toBe(value);
    await page.getByRole("textbox", { name: "其他输入框" }).click();
    await expect(page.getByRole("textbox", { name: "其他输入框" })).toBeFocused();
    await page.getByRole("button", { name: "编辑公式 A" }).click();
    await expect(field).toBeFocused();
    const readLatex = () =>
      field.evaluate((element) => (element as HTMLElement & { value: string }).value);
    await expect.poll(readLatex).toBe("a");
    await page.keyboard.press("End");
    await page.keyboard.type("+1");
    const editedA = await readLatex();
    await page.keyboard.press("Control+z");
    expect(await readLatex()).not.toBe(editedA);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(readLatex).toBe(editedA);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "编辑数学公式" })).toHaveCount(0);
    await page.getByRole("button", { name: "编辑公式 A" }).click();
    await expect.poll(readLatex).toBe(editedA);
    await page.getByRole("button", { name: "编辑公式 B" }).click();
    await expect(field).toBeFocused();
    await expect.poll(readLatex).toBe("b");
    await expect(page.getByRole("radio", { name: "独立公式" })).toBeChecked();
    await page.getByRole("button", { name: "矩阵", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "插入矩阵" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "编辑数学公式" })).toHaveCount(1);
    await expect(field).toBeFocused();
    expect(pageErrors).toEqual([]);
    for (const [input, expected] of [
      ["x^2", /^x\^(2|\{2\})$/],
      ["x_1", /^x_(1|\{1\})$/],
      ["25%", /^25\\%$/],
      ["x^2+1", /^x\^(2|\{2\})\+1$/],
    ] as const) {
      await field.evaluate((element) => {
        (element as HTMLElement & { value: string }).value = "";
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await field.focus();
      await page.keyboard.type(input);
      expect(await readLatex()).toMatch(expected);
    }
    for (const label of ["一阶导数", "二阶导数"]) {
      await field.evaluate((element) => {
        const mathfield = element as HTMLElement & {
          value: string;
          executeCommand(command: string): void;
        };
        mathfield.value = "f";
        element.dispatchEvent(new Event("input", { bubbles: true }));
        mathfield.executeCommand("selectAll");
      });
      await page.getByRole("button", { name: "上下标", exact: true }).click();
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect(page.locator(".formula-preview math msup")).toHaveCount(1);
      await expect(page.locator(".formula-preview math mi").first()).toHaveText("f");
    }
    // Imported compound Office Math must remain editable and pass the real dialog validation.
    for (const source of [
      String.raw`f^{\mathrm{\prime}}`,
      String.raw`f^{\mathrm{\prime}\mathrm{\prime}}`,
      String.raw`A^{\mathrm{\dagger}}`,
      String.raw`\mathrm{90}\mathrm{\degree}`,
      String.raw`\phi+\varphi`,
      String.raw`\left(\genfrac{}{}{0pt}{}{n}{k}\right)`,
      "{x^{2}}^{3}",
      String.raw`\alpha x+\beta y`,
      String.raw`\left\{\begin{array}{ll}x&x>0\\0&x<0\end{array}\right.`,
      String.raw`\left\{\frac{a}{b}\middle|x>0\right\}`,
    ]) {
      await field.evaluate((element, value) => {
        (element as HTMLElement & { value: string }).value = value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }, source);
      await expect(page.locator(".formula-preview .katex")).toHaveCount(1);
      await page.getByRole("button", { name: "确定", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "编辑数学公式" })).toHaveCount(0);
      await page.getByRole("button", { name: "打开公式" }).click();
      await expect(field).toBeFocused();
      await expect(page.locator(".formula-preview .katex")).toHaveCount(1);
    }
    expect(pageErrors).toEqual([]);
  } finally {
    await application.close();
  }
});
