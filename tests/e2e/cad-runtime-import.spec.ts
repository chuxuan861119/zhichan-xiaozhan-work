import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("repeated offline CAD imports through real IPC retain independent projects after reopening", async ({
  workbench,
}) => {
  test.setTimeout(90_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利" });
  await create.getByRole("textbox", { name: "专利名称" }).fill("离线CAD组件验收");
  await create.getByRole("radio", { name: "实用新型" }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).not.toBeVisible();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  const openCad = async () => {
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    return page.getByRole("region", { name: "CAD标号", exact: true });
  };
  const cad = await openCad();
  await cad.getByLabel("选择图纸文件").setInputFiles({
    name: "public-sample.dwg",
    mimeType: "image/vnd.dwg",
    buffer: await readFile(
      resolve(process.env.PATENT_DWG_TEST_FILE ?? "tests/fixtures/cad/sample_AC1032.dwg"),
    ),
  });
  await expect(cad.getByRole("button", { name: "标号", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await expect(cad.locator(".drawing-vector-preview")).toHaveAttribute(
    "data-render-state",
    "ready",
  );
  await expect(cad.locator(".drawing-heading")).toContainText("public-sample.dwg");
  const originalProject = await cad
    .locator(".drawing-project-row")
    .first()
    .getAttribute("data-project-id");
  await cad.getByLabel("选择图纸文件").setInputFiles({
    name: "repeated-sample.dwg",
    mimeType: "image/vnd.dwg",
    buffer: await readFile(
      resolve(process.env.PATENT_DWG_TEST_FILE ?? "tests/fixtures/cad/sample_AC1032.dwg"),
    ),
  });
  await expect(cad.locator(".drawing-project-row")).toHaveCount(2);
  await expect(cad.locator('.drawing-project-name[title="repeated-sample.dwg"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await cad.locator(".drawing-project-row").last().getAttribute("data-project-id")).not.toBe(
    originalProject,
  );
  await expect(cad.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
  await expect(cad.locator(".drawing-vector-preview")).toHaveAttribute(
    "data-render-state",
    "ready",
  );
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await page.getByRole("button", { name: "关闭离线CAD组件验收", exact: true }).click();
  await expect(page.getByRole("main", { name: "专利库", exact: true })).toBeVisible();
  await page.getByText("离线CAD组件验收", { exact: true }).first().dblclick();
  const restored = await openCad();
  await expect(restored.locator(".drawing-project-row")).toHaveCount(2);
  await expect(restored.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
  await expect(restored.locator(".drawing-vector-preview")).toHaveAttribute(
    "data-render-state",
    "ready",
  );
  await app.close();
});
