import { join } from "node:path";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";
import { stableUuid, writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

test("macOS Finder event imports a patent, installs native menus and keeps document fonts", async ({
  workbench,
}) => {
  test.skip(process.platform !== "darwin", "macOS integration");
  let nextId = 900_000;
  const patent = createBlankPatent(
    { patentType: "invention", name: "Mac文件关联验证" },
    {
      now: () => new Date("2026-10-02T00:00:00Z"),
      createId: () => stableUuid(nextId++),
    },
  );
  const path = join(workbench.root, "文件 关联.patdoc");
  await writePatdoc(path, { patent, assets: [] });
  const application = await workbench.launch();
  const page = await application.firstWindow();
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await application.evaluate(({ app }, file) => {
    app.emit("open-file", { preventDefault() {} }, file);
  }, path);
  await expect(page.getByRole("tab", { name: "Mac文件关联验证" })).toBeVisible();
  const roles = await application.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.items.flatMap(
      (item) => item.submenu?.items.map((child) => child.role) ?? [],
    ),
  );
  expect(roles).toContain("quit");
  expect(
    await application.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        ?.items.find((item) => item.label === "编辑")
        ?.submenu?.items.map((item) => item.label),
    ),
  ).toContain("粘贴");
  expect(await page.evaluate(() => document.documentElement.dataset.platform)).toBe("mac");
  expect(
    await page.evaluate(
      () => document.querySelector("#document-fonts, #mac-document-fonts")?.textContent,
    ),
  ).toContain("SourceHanSerifCN-Regular");
  if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1")
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => w.isVisible()),
      ),
    ).toBe(false);
});
