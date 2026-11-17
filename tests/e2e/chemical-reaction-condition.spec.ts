import { expect, test } from "./helpers/workbench.js";

// Renderer-only modules are not imported by the Node test project.
type ChemicalMathField = HTMLElement & {
  value: string;
  lastOffset: number;
  selection: { ranges: Array<[number, number]> };
  getValue(range: [number, number], format: string): string;
  executeCommand(command: string): boolean;
};

for (const reversible of [false, true]) {
  test(`edits a ${reversible ? "reversible" : "single"} condition arrow in place with real MathLive`, async ({
    workbench,
  }) => {
    const application = await workbench.launchAllowMultipleInstances("--headless");
    try {
      const page = await application.firstWindow();
      await page.setViewportSize({ width: 1600, height: 1000 });
      const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
      if (await welcome.isVisible())
        await welcome.getByRole("button", { name: "暂不创建" }).click();
      await page.getByRole("button", { name: "新建专利" }).click();
      const createDialog = page.getByRole("dialog", { name: "新建专利" });
      await createDialog.getByRole("textbox", { name: "专利名称" }).fill("反应条件编辑测试");
      await createDialog.getByRole("radio", { name: "发明", exact: true }).check();
      await createDialog.getByRole("button", { name: "创建专利" }).click();
      await expect(createDialog).toBeHidden({ timeout: 30_000 });
      const backup = page.getByRole("button", { name: "稍后设置" });
      if (await backup.isVisible()) await backup.click();
      await page.getByRole("button", { name: "插入化学方程式", exact: true }).click();
      const field = page.locator('math-field[aria-label="化学方程式编辑器"]');
      await expect
        .poll(() =>
          field.evaluate((element) => typeof (element as ChemicalMathField).executeCommand),
        )
        .toBe("function");
      const original = await field.evaluate((element) => {
        const editor = element as ChemicalMathField;
        editor.value = "A+B";
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        editor.selection = { ranges: [[1, 1]] };
        return editor.value;
      });
      const readSource = () => field.evaluate((element) => (element as ChemicalMathField).value);
      await page.getByRole("button", { name: "反应条件", exact: true }).click();
      await page.getByLabel("箭头上方（催化剂优先）").fill("MnO₂");
      await page.getByRole("button", { name: "＋ 添加箭头下方条件" }).click();
      await page.getByLabel("箭头下方（辅助条件）").fill("加热");
      await page.getByRole("button", { name: "收起", exact: true }).click();
      await page.getByRole("button", { name: "＋ 添加箭头下方条件" }).click();
      await expect(page.getByLabel("箭头下方（辅助条件）")).toHaveValue("加热");
      if (reversible) await page.getByTitle("当前为单向箭头，点击切换为双向箭头").click();
      await page.getByRole("button", { name: "插入条件箭头" }).click();
      const command = reversible ? "xrightleftharpoons" : "xrightarrow";
      const arrow = `\\${command}[加热]{MnO_2}`;
      await expect.poll(readSource).toContain(arrow);
      const inserted = await readSource();
      expect(inserted.indexOf(arrow)).toBeGreaterThan(inserted.indexOf("A"));
      expect(inserted.indexOf(arrow)).toBeLessThan(inserted.indexOf("+B"));
      const range = await field.evaluate((element, token) => {
        const editor = element as ChemicalMathField;
        for (let end = 2; end <= (editor.lastOffset ?? 0); end += 1) {
          if (editor.getValue([1, end], "latex") === token) {
            editor.selection = { ranges: [[1, end]] };
            return [1, end];
          }
        }
        throw new Error("Cannot select the inserted arrow");
      }, arrow);
      await page.getByRole("button", { name: "反应条件", exact: true }).click();
      await expect(page.getByLabel("箭头上方（催化剂优先）")).toHaveValue("MnO_2");
      await expect(page.getByLabel("箭头下方（辅助条件）")).toHaveValue("加热");
      await page.getByLabel("箭头上方（催化剂优先）").fill("Pt");
      await page.getByRole("button", { name: "保存条件" }).click();
      const edited = await readSource();
      expect(edited).toBe(inserted.replace("MnO_2", "Pt"));
      await field.evaluate((element) => (element as ChemicalMathField).executeCommand?.("undo"));
      await expect.poll(readSource).toBe(inserted);
      await field.evaluate((element, selection) => {
        (element as ChemicalMathField).selection = { ranges: [selection as [number, number]] };
      }, range);
      await page.getByRole("button", { name: "反应条件", exact: true }).click();
      await page.getByLabel("箭头上方（催化剂优先）").fill("Ni");
      await page
        .getByRole("dialog", { name: "反应条件", exact: true })
        .getByRole("button", { name: "取消", exact: true })
        .click();
      await expect.poll(readSource).toBe(inserted);
      await field.evaluate((element) => (element as ChemicalMathField).executeCommand?.("undo"));
      await expect.poll(readSource).toBe(original);
      // Replacing an entire selected arrow with itself is a no-op, not an append.
      const sameArrow = await field.evaluate((element) => {
        const editor = element as ChemicalMathField;
        editor.value = String.raw`\rightarrow`;
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        editor.selection = { ranges: [[0, editor.lastOffset]] };
        return editor.value;
      });
      await page.getByRole("button", { name: "生成", exact: true }).click();
      await expect.poll(async () => (await readSource()).trim()).toBe(sameArrow.trim());
      await field.evaluate((element) => {
        const editor = element as ChemicalMathField;
        editor.selection = { ranges: [[0, editor.lastOffset]] };
      });
      await page.getByRole("button", { name: "生成", exact: true }).click();
      await expect.poll(async () => (await readSource()).trim()).toBe(sameArrow.trim());
    } finally {
      await application.close();
    }
  });
}
