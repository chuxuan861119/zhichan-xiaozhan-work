import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";
process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

for (const pending of ["edit", "pick"])
  for (const cancel of [false, true])
    test(`Mac pending ${pending} preserves selection order (cancel=${cancel})`, async ({
      workbench,
    }) => {
      test.skip(process.platform !== "darwin", "Mac input adaptation only");
      test.setTimeout(180_000);
      const app = await workbench.launch(),
        page = await app.firstWindow();
      await dismissWorkbenchWelcome(page);
      await page.getByRole("button", { name: "新建专利", exact: true }).click();
      const creation = page.getByRole("dialog", { name: "新建专利" });
      await creation.getByRole("radio", { name: "实用新型", exact: true }).check();
      await creation.getByRole("button", { name: "创建专利", exact: true }).click();
      await expect(creation).toBeHidden();
      const later = page.getByRole("button", { name: "稍后设置", exact: true });
      if (await later.isVisible()) await later.click();
      await page.getByRole("button", { name: "插入", exact: true }).click();
      await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
      const ws = page.getByRole("region", { name: "CAD标号", exact: true });
      await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
      const opener = page.getByRole("button", { name: "展开功能栏", exact: true });
      if (await opener.isVisible()) await opener.click();
      const pin = page.getByRole("button", { name: "固定", exact: true });
      if (await pin.isVisible()) await pin.click();
      const panel = page.getByRole("region", { name: "CAD实体编辑", exact: true });
      const canvas = ws.getByRole("application", { name: "CAD标号画布", exact: true });
      await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
        timeout: 60_000,
      });

      const saved = async () => {
        await expect(ws).toHaveAttribute("data-cad-pending", "false");
        await expect(ws.locator('[data-save-state="saved"]')).toBeVisible();
      };
      await panel.getByRole("button", { name: "矩形", exact: true }).click();
      await canvas.click({ position: { x: 200, y: 350 } });
      await canvas.click({ position: { x: 400, y: 500 } });
      await saved();
      await canvas.press("Escape");
      await page.evaluate((pending) => {
        const state = window as unknown as { releaseCadEdit: () => void };
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message: unknown, ...rest: unknown[]) {
          if ((message as { method?: string }).method === pending) {
            Worker.prototype.postMessage = post;
            state.releaseCadEdit = () => Reflect.apply(post, this, [message, ...rest]);
            return;
          }
          return Reflect.apply(post, this, [message, ...rest]);
        };
      }, pending);
      await panel.getByRole("button", { name: "直线", exact: true }).click();
      await canvas.click({ position: { x: 500, y: 500 } });
      await canvas.click({ position: { x: 700, y: 500 } });
      await canvas.press("Enter");
      if (pending === "edit") await expect(ws).toHaveAttribute("data-cad-pending", "true");
      else await saved();
      await canvas.click({ position: { x: 300, y: 350 } });
      if (pending === "edit") {
        if (cancel) await canvas.press("Escape");
        await page.evaluate(() =>
          (window as unknown as { releaseCadEdit: () => void }).releaseCadEdit(),
        );
      }
      if (!cancel) await panel.getByRole("button", { name: "阵列选项", exact: true }).click();
      if (!cancel) {
        await page.getByRole("menuitemradio", { name: "路径阵列", exact: true }).click();
        await canvas.click({ position: { x: 600, y: 500 } });
      }
      if (pending === "pick") {
        if (cancel) await canvas.press("Escape");
        await page.evaluate(() =>
          (window as unknown as { releaseCadEdit: () => void }).releaseCadEdit(),
        );
      }
      await saved();
      if (cancel) {
        await expect(
          page.getByRole("spinbutton", { name: "项目数（含源对象）", exact: true }),
        ).toHaveCount(0);
        await expect(panel.getByText(/^\d+ 个对象已选中$/)).toHaveCount(0);
      } else {
        await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "应用", exact: true }).click();
        await saved();
        await canvas.press("Escape");
        await canvas.press("Meta+a");
        await expect(panel.getByText("7 个对象已选中", { exact: true })).toBeVisible();
        await canvas.press("Meta+z");
        await saved();
      }
      await canvas.press("Meta+a");
      await expect(panel.getByText("2 个对象已选中", { exact: true })).toBeVisible();
      await app.close();
    });
