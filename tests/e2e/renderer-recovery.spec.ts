import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

test("native recovery restores a failed React tree while page navigation stays blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "patent-renderer-recovery-"));
  await build({
    entryPoints: ["tests/e2e/fixtures/renderer-recovery-main.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile: join(root, "main.cjs"),
  });
  await build({
    entryPoints: ["tests/e2e/fixtures/renderer-recovery-view.tsx"],
    bundle: true,
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    outfile: join(root, "view.js"),
  });
  await writeFile(
    join(root, "index.html"),
    '<html><body><div id="root"></div><script src="view.js"></script></body></html>',
  );
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.RECOVERY_PRELOAD = resolve("out/preload/index.cjs");
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({
    args: [join(root, "main.cjs"), `--user-data-dir=${join(root, "profile")}`],
    env,
  });
  try {
    const page = await application.firstWindow();
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isVisible(),
      ),
    ).toBe(false);
    for (const label of ["选项一", "选项二", "选项三", "选项四", "选项一"]) {
      const checkbox = page.getByRole("checkbox", { name: label, exact: true });
      const checked = await checkbox.isChecked();
      await checkbox.click();
      expect(await checkbox.isChecked()).toBe(!checked);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole("button", { name: "模拟界面错误" }).click();
      await expect(page.getByRole("heading", { name: "编辑界面发生错误" })).toBeVisible();
      const boot = await page.locator("body").getAttribute("data-boot");
      // This is the old recovery path; the same production navigation guards block it.
      const blocked = await application.evaluate(async ({ BrowserWindow }) => {
        const wc = BrowserWindow.getAllWindows()[0]!.webContents;
        const denied = new Promise<boolean>((resolve) =>
          wc.once("will-frame-navigate", (event) => resolve(event.defaultPrevented)),
        );
        await wc.executeJavaScript("window.location.reload()");
        return denied;
      });
      expect(blocked).toBe(true);
      expect(await page.locator("body").getAttribute("data-boot")).toBe(boot);
      await page.getByRole("button", { name: "重新加载界面" }).dispatchEvent("click");
      await expect(page.getByRole("button", { name: "模拟界面错误" })).toBeVisible();
      expect(await page.locator("body").getAttribute("data-boot")).not.toBe(boot);
    }
  } finally {
    await application.close();
  }
});
