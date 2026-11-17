import { copyFile, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

const mode = "modeless";
test("IME composition inserts each letter once in the real math editor", async () => {
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
    await page.goto(`${page.url()}?mode=${mode}`);
    for (const stylesheet of ["src/renderer/src/app/app.css", "src/renderer/src/editor/editor.css"])
      await page.addStyleTag({ content: await readFile(stylesheet, "utf8") });
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isVisible(),
      ),
    ).toBe(false);
    const field = page.getByRole("textbox", { name: "可视公式编辑器" });
    const titleGap = await page.locator(".formula-position-switch").evaluate((control) => {
      const title = control.parentElement?.querySelector("h2");
      if (!title) throw new Error("Missing dialog title");
      return control.getBoundingClientRect().left - title.getBoundingClientRect().right;
    });
    expect(titleGap).toBeGreaterThanOrEqual(8);
    expect(titleGap).toBeLessThanOrEqual(24);

    await expect(field).toBeFocused();
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
    });
    await session.send("Input.imeSetComposition", {
      text: "a",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await session.send("Input.insertText", { text: "a" });
    await expect
      .poll(() => field.evaluate((el) => (el as HTMLElement & { value: string }).value))
      .toBe("a");
    await page.keyboard.type("b");
    await expect
      .poll(() => field.evaluate((el) => (el as HTMLElement & { value: string }).value))
      .toBe("ab");
    await expect(page.locator(".formula-preview .katex")).toBeVisible();
    const previewBefore = await page.locator(".formula-preview").innerHTML();
    await page.getByRole("radio", { name: "独立公式" }).check();
    await expect.poll(() => page.locator(".formula-preview").innerHTML()).toBe(previewBefore);
    await page.getByRole("radio", { name: "行内公式" }).check();
    await expect.poll(() => page.locator(".formula-preview").innerHTML()).toBe(previewBefore);
    await session.detach();
  } finally {
    await application.close();
  }
});
