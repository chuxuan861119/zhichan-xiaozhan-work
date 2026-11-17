import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";
import { writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

test("Mac PDF retains original Han and literal radical code points through the real export service", async ({
  workbench,
}) => {
  test.skip(process.platform !== "darwin", "Mac CoreText PDF regression");
  const text = "同系统验收：重新导入后继续编辑。一种电动汽车电池冷却机构。真实部首：⼊⼀⻋。";
  const patent = createBlankPatent({ patentType: "invention", name: "PDF 字符保真" });
  const book = patent.books.find((item) => item.kind === "description");
  if (!book) throw new Error("Missing description book");
  book.document.content = [
    {
      id: crypto.randomUUID(),
      type: "paragraph",
      attrs: {
        alignment: "left",
        paragraphIndentMm: 0,
        lineSpacing: 1.5,
        defaultFontFamily: "PingFang SC",
        defaultFontSizePt: 14,
      },
      content: [{ type: "text", text, marks: [] }],
    },
  ];
  const source = join(workbench.root, "input.patdoc"),
    output = join(workbench.root, "output.pdf");
  await writePatdoc(source, { patent, assets: [] });
  const app = await workbench.launch(source);
  try {
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePath }),
      });
    }, output);
    const page = await app.firstWindow();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
          const list = await api.patents.list("active");
          return list.ok ? list.value.length : 0;
        }),
      )
      .toBe(1);
    const result = await page.evaluate(async () => {
      const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
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
          suggestedName: "PDF 字符保真",
          mode: "single",
          bookKind: "description",
        });
      } finally {
        await api.patents.release(opened.value.sessionId);
      }
    });
    expect(result.ok).toBe(true);
    const loadingTask = getDocument({
      data: new Uint8Array(await readFile(output)),
      useSystemFonts: true,
    });
    const pdf = await loadingTask.promise;
    try {
      let extracted = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const content = await (await pdf.getPage(i)).getTextContent();
        extracted += content.items.map((item) => ("str" in item ? item.str : "")).join("");
      }
      expect(extracted.replace(/\s+/gu, "")).toContain(text);
    } finally {
      await loadingTask.destroy();
    }
  } finally {
    await app.close().catch(() => undefined);
  }
});
