import { join } from "node:path";
import type { Editor } from "@tiptap/core";
import { createPatdocFidelityPayload } from "../fixtures/patdoc-fidelity.js";
import { writePatdoc } from "./helpers/documents.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("patent editor chemical clipboard retains editable structure", async ({ workbench }) => {
  const source = join(workbench.root, "chemical-audit.patdoc");
  await writePatdoc(source, await createPatdocFidelityPayload());
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    await dismissWorkbenchWelcome(page);
    await app.evaluate(
      ({ dialog }, filePath) =>
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [filePath] }),
        }),
      source,
    );
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
    await page.getByRole("button", { name: "继续导入", exact: true }).click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await expect(editor.getByRole("img", { name: "化学结构式" })).toBeVisible();
    const result = await editor.evaluate((element) => {
      const e = (element as HTMLElement & { editor: Editor }).editor;
      let position = -1,
        before = 0;
      let sourceAttributes: Record<string, unknown> = {};
      e.state.doc.descendants((n, p) => {
        if (n.type.name === "chemicalStructure") {
          before++;
          position = p;
          sourceAttributes = n.attrs;
        }
      });
      if (position < 0) throw new Error("No structure");
      e.commands.setNodeSelection(position);
      const clipboardData = new DataTransfer();
      element.dispatchEvent(
        new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }),
      );
      const types = [...clipboardData.types];
      e.commands.setTextSelection(1);
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
      let after = 0;
      const attributes: Record<string, unknown>[] = [];
      e.state.doc.descendants((n) => {
        if (n.type.name === "chemicalStructure") {
          after++;
          attributes.push(n.attrs);
        }
      });
      return { before, after, types, sourceAttributes, attributes };
    });
    expect(result.after).toBe(result.before + 1);
    const { nodeId: sourceNodeId, ...sourceContent } = result.sourceAttributes;
    for (const attributes of result.attributes) {
      const { nodeId, ...content } = attributes;
      expect(content).toEqual(sourceContent);
      expect(typeof nodeId).toBe("string");
    }
    expect(new Set(result.attributes.map((attributes) => attributes.nodeId)).size).toBe(
      result.after,
    );
    expect(result.attributes.some((attributes) => attributes.nodeId === sourceNodeId)).toBe(true);
  } finally {
    await app.close();
  }
});
