import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Editor, JSONContent } from "@tiptap/core";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("insert dependent claims through the toolbar, undo/redo and reopen the saved patent", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  let application = await workbench.launch();
  try {
    let page = await application.firstWindow();
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("从权连续引用验收");
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    let claims = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
    await claims.evaluate((root) => {
      const editor = (root as HTMLElement & { editor: Editor }).editor;
      const paragraph = (text: string): JSONContent => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      });
      editor.commands.setContent({
        type: "doc",
        content: [
          paragraph("    1. 一种装置，其特征在于：包括："),
          paragraph("箱体与盖板。"),
          { type: "paragraph", content: [{ type: "hardBreak" }, { type: "hardBreak" }] },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "    2. 根据权利" },
              { type: "hardBreak" },
              { type: "text", text: "要求1所述的一种装置，其特征在于：连接件。" },
            ],
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "3. 根据权利要求1，或 " },
              { type: "text", text: "2", marks: [{ type: "bold" }, { type: "italic" }] },
              { type: "text", text: " 任一项所述的一种装置，其特征在于：螺钉。" },
            ],
          },
        ],
      });
      editor.commands.setTextSelection(2);
    });
    const read = () =>
      claims.evaluate((root) => (root as HTMLElement & { editor: Editor }).editor.getJSON());
    const snapshots = [await read()];
    const insert = page
      .getByRole("group", { name: "权利要求书工具" })
      .getByRole("button", { name: "插入从权", exact: true });
    for (let i = 0; i < 3; i++) {
      await insert.click();
      snapshots.push(await read());
    }
    await expect(claims).toContainText("权利要求1，或 5 任一项");
    expect((await read()).content?.slice(0, 3)).toEqual(snapshots[0]?.content?.slice(0, 3));
    expect(
      (await read()).content?.at(-1)?.content?.find((n) => "text" in n && n.text === "5")?.marks,
    ).toEqual(expect.arrayContaining([{ type: "bold" }, { type: "italic" }]));
    for (let i = 2; i >= 0; i--) {
      await claims.evaluate((root) =>
        (root as HTMLElement & { editor: Editor }).editor.commands.undo(),
      );
      expect(await read()).toEqual(snapshots[i]);
    }
    for (let i = 1; i <= 3; i++) {
      await claims.evaluate((root) =>
        (root as HTMLElement & { editor: Editor }).editor.commands.redo(),
      );
      expect(await read()).toEqual(snapshots[i]);
    }
    const expected = await read();
    await claims.focus();
    await page.keyboard.press("Control+s");
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const list = await window.patentApi.patents.list("active");
          if (!list.ok) return false;
          const patent = list.value.find((item) => item.name === "从权连续引用验收");
          if (!patent) return false;
          const opened = await window.patentApi.patents.open(patent.patentId);
          if (!opened.ok) return false;
          try {
            return JSON.stringify(
              opened.value.patent.books.find((book) => book.kind === "claims")?.document.content,
            ).includes("螺钉");
          } finally {
            await window.patentApi.patents.release(opened.value.sessionId);
          }
        }),
      )
      .toBe(true);
    await application.close();
    application = await workbench.launch();
    page = await application.firstWindow();
    await dismissWorkbenchWelcome(page);
    const libraryPatent = page.getByText("从权连续引用验收", { exact: true }).first();
    if (await page.getByTestId("patent-library").isVisible()) await libraryPatent.dblclick();
    const tab = page.getByRole("tab", { name: "权利要求书", exact: true });
    if (!(await tab.isVisible())) await libraryPatent.dblclick();
    await tab.click();
    claims = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
    const restored = await read();
    const plain = (doc: JSONContent) =>
      doc.content?.map((node) => node.content?.map((inline) => inline.text ?? "").join(""));
    expect(plain(restored)).toEqual(plain(expected));
    expect(restored.content?.map((n) => n.content)).toEqual(
      expected.content?.map((n) => n.content),
    );

    await page
      .getByRole("toolbar", { name: "常用工具" })
      .getByRole("button", { name: "本地检查", exact: true })
      .click();
    const checkPanel = page.getByRole("complementary", { name: "本地检查", exact: true });
    await checkPanel.getByRole("button", { name: "全文检查", exact: true }).click();
    await expect(checkPanel.getByRole("tablist", { name: "本地检查筛选" })).toBeVisible();
    await expect(checkPanel).not.toContainText("引用编号无法");
    await expect(checkPanel).not.toContainText("引用了不存在");
    await checkPanel.getByRole("button", { name: "关闭本地检查", exact: true }).click();
    expect(await read()).toEqual(restored);

    const output = join(workbench.root, "claims-reopened.pdf");
    await application.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePath }),
      });
    }, output);
    const exported = await page.evaluate(async () => {
      const api = window.patentApi;
      const list = await api.patents.list("active");
      if (!list.ok || !list.value[0]) throw new Error("Missing patent");
      const opened = await api.patents.open(list.value[0].patentId);
      if (!opened.ok) throw new Error("Cannot open patent");
      try {
        await api.documents.activate({
          sessionId: opened.value.sessionId,
          documentId: opened.value.patentId,
        });
        return await api.exports.patentPdf({
          sessionId: opened.value.sessionId,
          patentId: opened.value.patentId,
          expectedRevision: opened.value.patent.revision,
          suggestedName: "从权连续引用验收",
          mode: "single",
          bookKind: "claims",
        });
      } finally {
        await api.patents.release(opened.value.sessionId);
      }
    });
    expect(exported.ok).toBe(true);
    const loading = getDocument({ data: new Uint8Array(await readFile(output)) });
    try {
      const pdf = await loading.promise;
      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const content = await (await pdf.getPage(i)).getTextContent();
        text += content.items.map((item) => ("str" in item ? item.str : "")).join("");
      }
      for (const paragraph of plain(expected) ?? []) {
        expect(text.replace(/\s/gu, "")).toContain(paragraph?.replace(/\s/gu, ""));
      }
    } finally {
      await loading.destroy();
    }
  } finally {
    await application.close();
  }
});
