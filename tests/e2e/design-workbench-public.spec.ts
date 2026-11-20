import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { expect, test, waitForMainWindow } from "./helpers/workbench.js";

test("creates, saves, reopens and exports a design patent from the desktop workbench", async ({
  workbench,
}) => {
  const name = "桌面收纳盒（演示）";
  const productUse = "用于收纳桌面文具。";
  const image = join(workbench.root, "主视图.png");
  const destination = join(workbench.root, "exports");
  await mkdir(destination);
  await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="520" height="330"><rect width="520" height="330" fill="white"/><rect x="70" y="70" width="380" height="180" rx="24" fill="#dde5ef" stroke="#263747" stroke-width="5"/><path d="M75 118h370" stroke="#263747" stroke-width="5"/><rect x="232" y="95" width="56" height="13" rx="6" fill="#263747"/></svg>',
    ),
  )
    .png()
    .toFile(image);

  const app = await workbench.launch();
  await app.evaluate(
    ({ dialog }, { image, destination }) => {
      dialog.showOpenDialog = (async (...args: unknown[]) => {
        const options = args.at(-1) as { properties?: string[] };
        return {
          canceled: false,
          filePaths: [options.properties?.includes("openDirectory") ? destination : image],
        };
      }) as typeof dialog.showOpenDialog;
    },
    { image, destination },
  );
  const page = await waitForMainWindow(app);
  await page.getByRole("tab", { name: "专利库", exact: true }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利" });
  await create.getByRole("textbox", { name: "专利名称" }).fill(name);
  await create.getByRole("radio", { name: "外观设计" }).check();
  await create.getByRole("button", { name: "创建专利" }).click();
  let design = page.getByRole("main", { name: "外观设计工作台" });
  await expect(design.getByRole("heading", { name })).toBeVisible();
  await design.getByRole("button", { name: "导入图片" }).click();
  await expect(design.getByRole("button", { name: /^(设为|已选)代表图$/ })).toBeVisible();
  const representative = design.getByRole("button", { name: "设为代表图", exact: true });
  if (await representative.isVisible()) await representative.click();
  await design.getByRole("tab", { name: "简要说明" }).click();
  await design.getByLabel("产品用途（必填）").fill(productUse);
  await expect(design.getByRole("region", { name: "简要说明实时预览" })).toContainText(productUse);
  await design.getByRole("button", { name: "检查并导出" }).click();
  const review = design.getByRole("dialog", { name: "导出前检查" });
  await review.getByLabel("我已了解上述提示，确认继续导出").check();
  await review.getByRole("button", { name: "选择位置并导出" }).click();
  try {
    await expect
      .poll(async () =>
        (await readdir(destination, { recursive: true })).some((entry) => entry.endsWith(".docx")),
      )
      .toBe(true);
  } catch (error) {
    console.log((await page.locator("body").innerText()).slice(-2600));
    throw error;
  }
  await app.close();

  const next = await workbench.launch();
  const reopened = await waitForMainWindow(next);
  await reopened.getByRole("tab", { name: "专利库", exact: true }).click();
  await reopened.getByRole("button", { name: "外观设计", exact: true }).click();
  await reopened.getByText(name, { exact: true }).first().dblclick();
  design = reopened.getByRole("main", { name: "外观设计工作台" });
  await design.getByRole("tab", { name: "简要说明" }).click();
  await expect(design.getByLabel("产品用途（必填）")).toHaveValue(productUse);
  if (process.env.WORK_OPEN_SOURCE_DESIGN_SCREENSHOT) {
    await reopened.screenshot({
      path: process.env.WORK_OPEN_SOURCE_DESIGN_SCREENSHOT,
      animations: "disabled",
    });
  }
});
