import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
test("native strokes avoid recomposition and restore while another worker saves, with undo and reopen intact", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  const open = async () => {
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  };
  await open();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true }); if(await pin.isVisible()) await pin.click();
  const line = page
    .getByRole("region", { name: "CAD实体编辑" })
    .getByRole("button", { name: "直线", exact: true });
  await expect(line).toBeEnabled({ timeout: 60_000 });
  await expect(workspace).toHaveAttribute("data-cad-pending", "false");
  await page.evaluate(() => {
    const calls: { worker: number; method: string }[] = [];
    (window as any).cadWorkerCalls = calls;
    const ids = new WeakMap<Worker, number>();
    let count = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (data: any, ...rest: any[]) {
      if (!ids.has(this)) ids.set(this, ++count);
      calls.push({ worker: ids.get(this)!, method: data.method });
      return Reflect.apply(post, this, [data, ...rest]);
    };
  });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  await line.click();
  await canvas.click({ position: { x: 200, y: 200 } });
  for (let i = 0; i < 4; i++)
    await canvas.click({ position: { x: 250 + i * 45, y: 240 + (i % 2) * 40 } });
  await expect(workspace).toHaveAttribute("data-cad-pending", "false", { timeout: 30_000 });
  const calls = await page.evaluate(
    () => (window as any).cadWorkerCalls as { worker: number; method: string }[],
  );
  expect(calls.filter((c) => c.method === "edit")).toHaveLength(4);
  expect(calls.filter((c) => ["synchronize", "load", "restore"].includes(c.method))).toHaveLength(
    0,
  );
  const editor = calls.find((c) => c.method === "edit")!.worker;
  expect(calls.some((c) => c.method === "materialize" && c.worker !== editor)).toBe(true);
  expect(calls.some((c) => c.method === "materialize" && c.worker === editor)).toBe(false);
  const countLines = () =>
    page.evaluate(async () => {
      const list = await window.patentApi.patents.list("active");
      if (!list.ok) throw new Error(list.error.message);
      const opened = await window.patentApi.patents.open(list.value[0]!.patentId);
      if (!opened.ok) throw new Error(opened.error.message);
      const cad = opened.value.patent.drawingProjects[0]!.cad!;
      const source = await window.patentApi.assets.readDrawingSource(
        opened.value.sessionId,
        cad.assetId,
      );
      if (!source.ok) throw new Error(source.error.message);
      return new TextDecoder()
        .decode(source.value)
        .split(/\r?\n/u)
        .filter((s) => s === "LINE").length;
    });
  await expect.poll(countLines, { timeout: 15_000 }).toBe(4);
  await canvas.press("Escape");
  await canvas.press("Control+z");
  await expect.poll(countLines, { timeout: 15_000 }).toBe(3);
  await canvas.press("Control+Shift+z");
  await expect.poll(countLines, { timeout: 15_000 }).toBe(4);
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await expect(workspace).toBeHidden();
  await open();
  await expect.poll(countLines).toBe(4);
});
