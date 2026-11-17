import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";
import { writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

for (const font of ["SimSun", "Source Han Serif CN"]) {
  test(`PDF preserves Chinese text with selected ${font} fonts`, async ({ workbench }) => {
    const text = "字体选择回归：一种物料输送装置，底座连接支撑杆。原样部首：⼀⼊⽀。";
    const patent = createBlankPatent({ patentType: "invention", name: "打印字体选择" });
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
          defaultFontFamily: font,
          defaultFontSizePt: 14,
        },
        content: [{ type: "text", text, marks: [{ type: "bold" }] }],
      },
    ];
    const source = join(workbench.root, "font-input.patdoc");
    const output = join(workbench.root, "font-output.pdf");
    await writePatdoc(source, { patent, assets: [] });
    const app = await workbench.launchAllowMultipleInstances(source, "--headless");
    try {
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, output);
      const page = await app.firstWindow();
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const result = await window.patentApi.patents.list("active");
            return result.ok ? result.value.length : 0;
          }),
        )
        .toBe(1);
      const result = await page.evaluate(async () => {
        const api = window.patentApi;
        const list = await api.patents.list("active");
        if (!list.ok || !list.value[0]) throw new Error("Missing imported patent");
        const patentId = list.value[0].patentId;
        const opened = await api.patents.open(patentId);
        if (!opened.ok) throw new Error(opened.error.message);
        try {
          await api.documents.activate({ sessionId: opened.value.sessionId, documentId: patentId });
          return await api.exports.patentPdf({
            sessionId: opened.value.sessionId,
            patentId,
            expectedRevision: opened.value.patent.revision,
            suggestedName: "打印字体选择",
            mode: "single",
            bookKind: "description",
          });
        } finally {
          await api.patents.release(opened.value.sessionId);
        }
      });
      expect(result.ok).toBe(true);
      const loading = getDocument({
        data: new Uint8Array(await readFile(output)),
        useSystemFonts: true,
      });
      try {
        const pdf = await loading.promise;
        let extracted = "";
        for (let number = 1; number <= pdf.numPages; number++) {
          const content = await (await pdf.getPage(number)).getTextContent();
          extracted += content.items.map((item) => ("str" in item ? item.str : "")).join("");
        }
        expect(extracted.replace(/\s+/gu, "")).toContain(text);
      } finally {
        await loading.destroy();
      }
    } finally {
      await app.close();
    }
  });
}
