import { writeFile } from "node:fs/promises";
import { begin, end } from "./helpers/cad-performance-probe.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";
process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
test("all modification families commit and undo with live previews", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(300000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const ws = page.getByRole("region", { name: "CAD标号", exact: true });
  await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: "展开功能栏", exact: true });
  if (await opener.isVisible()) await opener.click();
  const panel = page.getByRole("region", { name: "CAD实体编辑", exact: true });
  const canvas = ws.getByRole("application", { name: "CAD标号画布", exact: true });
  const tool = (name: string) => panel.getByRole("button", { name, exact: true }).click();
  await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
    timeout: 60000,
  });
  const saved = async () => {
    await expect(ws).toHaveAttribute("data-cad-pending", "false");
    await expect(ws.locator('[data-save-state="saved"]')).toBeVisible();
  };
  const click = ([x, y]: number[]) => canvas.click({ position: { x: x!, y: y! } });
  const cancel = async () => {
    await canvas.press("Escape");
    await canvas.press("Escape");
  };
  for (const [a, b] of [
    [
      [150, 250],
      [150, 450],
    ],
    [
      [150, 450],
      [450, 450],
    ],
    [
      [450, 450],
      [450, 250],
    ],
  ]) {
    await tool("直线");
    await click(a!);
    await click(b!);
    await canvas.press("Enter");
    await saved();
  }
  const count = async () => {
    await canvas.press("Control+a");
    // Undo may still be swapping the native scene when the first key arrives.
    // Return immediately so expect.poll can retry after that scene is ready.
    const text = (await panel.getByText(/^\d+ 个对象已选中$/).allTextContents()).join("");
    return Number(text.match(/\d+/)?.[0] ?? 0);
  };
  expect(await count()).toBe(3);
  await cancel();
  const selected = () => canvas.press("Control+a");
  const finish = async () => {
    await saved();
  };
  const undo = async () => {
    await cancel();
    await canvas.press("Control+z");
    await saved();
    await expect.poll(count).toBe(3);
    await cancel();
  };
  const results: Awaited<ReturnType<typeof end>>[] = [];
  for (const name of ["移动", "复制", "旋转", "缩放", "镜像"]) {
    await selected();
    await tool(name);
    await click([250, 250]);
    if (name === "镜像")
      await page.getByRole("checkbox", { name: "删除源对象", exact: true }).uncheck();
    const bounds = (await canvas.boundingBox())!;
    await begin(page, ".cad-gesture-preview");
    for (let i = 0; i < 36; i++) {
      await page.mouse.move(
        bounds.x + 350 + 10 * Math.sin(i / 5),
        bounds.y + 300 + 10 * Math.cos(i / 5),
      );
      await page.waitForTimeout(8);
    }
    results.push(await end(page, name));
    await expect(canvas.locator(".cad-gesture-preview")).toBeVisible();
    await click([350, 300]);
    await finish();
    await cancel();
    await expect.poll(count).toBe(name === "复制" || name === "镜像" ? 6 : 3);
    await undo();
  }
  for (const method of ["矩形阵列", "环形阵列", "路径阵列"]) {
    await canvas.click({ position: { x: 150, y: 350 } });
    await tool("阵列选项");
    await page.getByRole("menuitemradio", { name: method, exact: true }).click();
    if (method !== "矩形阵列") await click(method === "路径阵列" ? [300, 450] : [300, 300]);
    const field = page.getByRole("spinbutton", {
      name: method === "矩形阵列" ? "列数" : "项目数（含源对象）",
      exact: true,
    });
    await begin(page, ".cad-gesture-preview");
    for (const n of ["3", "8", "16", "4"]) {
      await field.fill(n);
      await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
    }
    results.push(await end(page, method));
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await finish();
    await cancel();
    await expect.poll(count).toBeGreaterThan(3);
    await undo();
  }
  await selected();
  await tool("编组");
  await saved();
  await expect(panel.getByRole("button", { name: "取消编组", exact: true })).toBeEnabled();
  await tool("取消编组");
  await saved();
  await expect(panel.getByRole("button", { name: "取消编组", exact: true })).toBeDisabled();
  await cancel();
  await selected();
  await tool("合并线段");
  await finish();
  await cancel();
  await expect.poll(count).toBe(1);
  await undo();
  await selected();
  await tool("删除");
  await finish();
  await cancel();
  await expect(panel.getByText(/^\d+ 个对象已选中$/)).toHaveCount(0);
  await undo();
  await writeFile(
    testInfo.outputPath("modify-tools-performance.json"),
    JSON.stringify(results, null, 2),
  );
  console.info(JSON.stringify(results));
});
