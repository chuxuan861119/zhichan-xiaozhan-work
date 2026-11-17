import { join } from "node:path";
import { createBlankDocument } from "../../src/shared/document/defaults.js";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { createChemicalPatentPayload } from "../fixtures/chemical-content.js";
import { writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

test("keeps document English intact while Chinese structure controls edit and persist the drawing", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(120_000);
  const payload = await createChemicalPatentPayload("结构式安全回归");
  const book = payload.patent.books.find((candidate) => candidate.kind === "description");
  if (!book) throw new Error("Missing description fixture");
  const paragraph = createBlankDocument("fixture").content[0];
  if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph fixture");
  paragraph.content = [{ type: "text", text: "Gold", marks: [] }];
  book.document.content.unshift(paragraph);
  const structure = book.document.content.find((node) => node.type === "chemical-structure");
  if (structure?.type !== "chemical-structure") throw new Error("Missing structure fixture");
  structure.ketSource = JSON.stringify({
    root: { nodes: [{ $ref: "mol0" }] },
    mol0: {
      type: "molecule",
      atoms: [
        { label: "C", location: [0, 0, 0] },
        { label: "O", location: [1, 0, 0] },
      ],
      bonds: [{ type: 1, atoms: [0, 1] }],
    },
  });
  const source = join(workbench.root, "structure.patdoc");
  await writePatdoc(source, payload);
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    const welcome = page.getByRole("dialog", { name: /^欢迎使用/u });
    await expect(welcome).toBeVisible();
    await welcome.getByRole("button", { name: "关闭欢迎提示", exact: true }).click();
    await expect(welcome).toBeHidden();
    await app.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [path] }),
      });
    }, source);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
    await page
      .getByRole("dialog", { name: "PATDOC 导入须知" })
      .getByRole("button", { name: "继续导入" })
      .click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    await expect(editor).toBeVisible();
    const image = editor.getByRole("img", { name: "化学结构式" });
    await image.click();
    const rail = page.getByRole("region", { name: "结构式设置" });
    await expect(rail).toBeVisible();
    await expect(editor.getByRole("group", { name: "结构式工具" })).toHaveCount(0);
    const width = rail.getByRole("spinbutton", { name: "结构式宽度（毫米）" });
    await width.fill("60");
    await width.press("Enter");
    await expect(image).toHaveAttribute("style", /width: 60mm/u);
    await rail.getByRole("button", { name: "编辑结构式" }).click();
    const dialog = page.getByRole("dialog", { name: "编辑化学结构式" });
    await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeEnabled({
      timeout: 35_000,
    });
    await expect(editor.getByText("Gold", { exact: true })).toHaveCount(1);
    const shell = dialog.getByRole("region", { name: "化学结构编辑器" });
    await expect(shell.getByRole("button", { name: /元素周期表/u })).toBeVisible();
    await shell.getByRole("button", { name: /元素周期表/u }).click();
    await expect(shell.getByText("元素周期表", { exact: true })).toBeVisible();
    await expect(shell.getByText("No", { exact: true })).toBeVisible();
    await expect(shell.getByRole("button", { name: "取消", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("localized-structure.png") });
    await shell.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(image).toBeVisible();
    await expect(editor.getByText("Gold", { exact: true })).toHaveCount(1);
    await image.dblclick();
    await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeEnabled({
      timeout: 35_000,
    });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "关闭结构式安全回归", exact: true }).click();
    const persisted = await page.evaluate(async () => {
      const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
      const listed = await api.patents.list("active");
      if (!listed.ok) throw new Error("Cannot list patents");
      const summary = listed.value.find((item) => item.name === "结构式安全回归");
      if (!summary) throw new Error("Missing saved patent");
      const reopened = await api.patents.open(summary.patentId);
      if (!reopened.ok) throw new Error("Cannot reopen saved patent");
      try {
        const content =
          reopened.value.patent.books.find((item) => item.kind === "description")?.document
            .content ?? [];
        const drawing = content.find((item) => item.type === "chemical-structure");
        return {
          widthMm: drawing?.type === "chemical-structure" ? drawing.widthMm : null,
          paragraphs: content.flatMap((item) =>
            item.type === "paragraph"
              ? item.content.flatMap((inline) => (inline.type === "text" ? [inline.text] : []))
              : [],
          ),
        };
      } finally {
        await api.patents.release(reopened.value.sessionId);
      }
    });
    expect(persisted.widthMm).toBe(60);
    expect(persisted.paragraphs).toContain("Gold");
    expect(persisted.paragraphs).not.toContain("金");
  } finally {
    await app.close();
  }
  expect(
    (await workbench.readObservedRequestUrls()).filter((url) => /^(?:https?|wss?):/iu.test(url)),
  ).toEqual([]);
  expect(await workbench.readObservedConnections()).toEqual([]);
});
