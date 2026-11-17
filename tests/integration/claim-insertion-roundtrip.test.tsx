import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "@xmldom/xmldom";
import type { PatentPatdocPayload } from "../../src/main/documents/patdoc-format";
import { readPatdoc } from "../../src/main/documents/patdoc-reader";
import { writePatdoc } from "../../src/main/documents/patdoc-writer";
import { readDocxPackageBuffer } from "../../src/main/docx-import/docx-package-reader";
import { createPatentDocxPackage } from "../../src/main/exports/patent-docx-exporter";
import { renderPatentPrintHtml } from "../../src/main/exports/patent-print-template";
import type { LibraryDatabase } from "../../src/main/library/library-database";
import { LibraryMigrationService } from "../../src/main/library/library-migration-service";
import { PatentService } from "../../src/main/library/patent-service";
import { createPatentExtensions } from "../../src/renderer/src/editor/extensions";
import { insertDependentClaimAtSelection as insert } from "../../src/renderer/src/patents/claims/claim-editor-operations";
import type { PatentBookDocument } from "../../src/shared/document/model";
import {
  canonicalToTiptap,
  tiptapToPatentBookDocument,
} from "../../src/shared/document/model-adapter";
import { inspectPatent } from "../../src/shared/patent/validation";
import { buildPatentFactIndex } from "../../src/shared/patent-inspection/facts";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../src/shared/settings/model";

function makeEditor(content: JSONContent) {
  const editor = new Editor({
    extensions: createPatentExtensions("claim-roundtrip", { patentParagraphRules: true }),
    content,
  });
  const tr = editor.state.tr.setMeta("addToHistory", false);
  editor.state.doc.descendants((node, pos) => {
    if ("nodeId" in node.attrs && !node.attrs.nodeId)
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, nodeId: crypto.randomUUID() });
  });
  editor.view.dispatch(tr);
  return editor;
}
function convert(editor: Editor, base: PatentBookDocument) {
  const result = tiptapToPatentBookDocument(editor.getJSON(), base, new Set());
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

test("continuous insertion survives database reopen, PATDOC roundtrip and single/combined DOCX export", async () => {
  const root = await mkdtemp(join(tmpdir(), "claim-insertion-roundtrip-"));
  let database: LibraryDatabase | undefined;
  let editor: Editor | undefined;
  try {
    const prepared = await new LibraryMigrationService(root).prepare();
    if (prepared.status !== "ready") throw new Error("library initialization failed");
    database = prepared.database;
    const service = new PatentService({ database });
    const opened = await service.create({
      patentType: "invention",
      name: "引用完整性验证",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
    const claims = opened.patent.books.find((book) => book.kind === "claims");
    if (!claims) throw new Error("missing claims");
    const p = (text: string): JSONContent => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    });
    editor = makeEditor({
      type: "doc",
      content: [
        p("    1. 一种装置，其特征在于：包括："),
        {
          type: "paragraph",
          content: [
            { type: "text", text: "箱体；" },
            { type: "hardBreak" },
            { type: "text", text: "满足" },
            { type: "inlineMath", attrs: { latex: "E=mc^2" } },
            { type: "text", text: "。" },
          ],
        },
        { type: "paragraph", content: [{ type: "hardBreak" }, { type: "hardBreak" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "2. 根据权利" },
            { type: "hardBreak" },
            { type: "text", text: "要求1所述的一种装置，其特征在于：盖板。" },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "3. 根据权利要求 " },
            { type: "text", text: "2", marks: [{ type: "bold" }, { type: "italic" }] },
            { type: "text", text: " 所述的一种装置，其特征在于：连接件。" },
          ],
        },
        p("4. 根据权利要求1—3任一项所述的一种装置，其特征在于：螺钉。"),
        p("5. 根据权利要求2，或3所述的一种装置，其特征在于：底座。"),
      ],
    });
    const originalNodes = editor.getJSON().content?.slice(0, 3);
    editor.commands.setTextSelection(2);
    const snapshots = [editor.getJSON()];
    for (let i = 0; i < 3; i++) {
      expect(insert(editor).ok).toBe(true);
      snapshots.push(editor.getJSON());
    }
    for (let i = 2; i >= 0; i--) {
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(snapshots[i]);
    }
    for (let i = 1; i <= 3; i++) {
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(snapshots[i]);
    }
    expect(editor.getJSON().content?.slice(0, 3)).toEqual(originalNodes);
    const document = convert(editor, claims.document);
    await service.applyBookEdit({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      expectedRevision: opened.revision,
      bookKind: "claims",
      document,
      editorState: {},
    });
    editor.destroy();
    editor = undefined;
    database.close();
    database = undefined;

    const reopened = await new LibraryMigrationService(root).prepare();
    if (reopened.status !== "ready") throw new Error("library reopen failed");
    database = reopened.database;
    const restored = await new PatentService({ database }).open(opened.patentId);
    const restoredClaims = restored.patent.books.find((book) => book.kind === "claims");
    expect(restoredClaims?.document.content).toEqual(document.content);
    if (!restoredClaims) throw new Error("missing restored claims");
    editor = makeEditor(canonicalToTiptap(restoredClaims.document));
    expect(convert(editor, restoredClaims.document).content).toEqual(document.content);
    // Continue from a reopened, already-renumbered dependent claim.
    editor.state.doc.forEach((node, pos) => {
      if (node.textContent.startsWith("4.")) editor?.commands.setTextSelection(pos + 1);
    });
    expect(insert(editor).ok).toBe(true);
    restoredClaims.document = convert(editor, restoredClaims.document);
    expect(restoredClaims.document.content.slice(0, 3)).toEqual(document.content.slice(0, 3));
    const connection = editor
      .getJSON()
      .content?.find((n) => n.content?.some((c) => c.text?.includes("连接件")));
    expect(connection?.content?.find((n) => n.text === "6")?.marks).toEqual(
      expect.arrayContaining([{ type: "bold" }, { type: "italic" }]),
    );

    const path = join(root, "claims.patdoc");
    await writePatdoc(path, { patent: restored.patent, assets: [] });
    const archive = await readPatdoc<PatentPatdocPayload>(path);
    expect(archive.patent.books.find((book) => book.kind === "claims")?.document).toEqual(
      restoredClaims.document,
    );
    const expectedText = restoredClaims.document.content.flatMap((block) =>
      block.type === "paragraph"
        ? [block.content.map((n) => (n.type === "text" ? n.text : "")).join("")]
        : [],
    );
    expect(expectedText.at(-2)?.replace(/\s/gu, "")).toContain("权利要求1或6或7任一项");
    expect(expectedText.at(-1)?.replace(/\s/gu, "")).toContain("权利要求6，或7所述");
    const originalArchive = structuredClone(archive.patent);
    const facts = buildPatentFactIndex(archive.patent, "full");
    expect(facts.claims.at(-2)?.referencedNumbers).toEqual([1, 6, 7]);
    expect(facts.claims.at(-1)?.referencedNumbers).toEqual([6, 7]);
    expect(
      inspectPatent(archive.patent).issues.filter((issue) =>
        [
          "claim-reference-warning",
          "claim-multiple-reference-choice",
          "claim-multiple-reference-base",
          "claim-reference-cycle",
        ].includes(issue.legacyCode),
      ),
    ).toEqual([]);
    expect(archive.patent).toEqual(originalArchive);
    for (const mode of ["single", "combined"] as const) {
      const exported = await createPatentDocxPackage(
        mode === "single"
          ? { patent: archive.patent, mode, bookKind: "claims" }
          : { patent: archive.patent, mode },
      );
      expect(exported.issues.filter((issue) => issue.severity === "error")).toEqual([]);
      const pkg = await readDocxPackageBuffer(exported.buffer, "claims.docx");
      const xml = Buffer.from(pkg.parts.get("word/document.xml") ?? []).toString("utf8");
      const dom = new DOMParser().parseFromString(xml, "application/xml");
      const paragraphs = Array.from(dom.getElementsByTagName("w:p")).map((p) =>
        Array.from(p.getElementsByTagName("w:t"))
          .map((t) => t.textContent)
          .join(""),
      );
      for (const text of expectedText) expect(paragraphs).toContain(text);
      expect(xml).toContain("<m:oMath");
      expect(xml).toContain("<w:br");
      const numberRuns = Array.from(dom.getElementsByTagName("w:r")).filter(
        (run) =>
          Array.from(run.getElementsByTagName("w:t"))
            .map((t) => t.textContent)
            .join("") === "6",
      );
      expect(
        numberRuns.some(
          (run) =>
            run.getElementsByTagName("w:b").length > 0 &&
            run.getElementsByTagName("w:i").length > 0,
        ),
      ).toBe(true);
    }
    const printHtml = await renderPatentPrintHtml({
      patent: archive.patent,
      mode: "single",
      bookKind: "claims",
      assets: [],
    });
    const printDom = new window.DOMParser().parseFromString(printHtml, "text/html");
    const printText = printDom.body.textContent ?? "";
    expect(printText.replace(/\s/gu, "")).toContain("权利要求1或6或7任一项");
    expect(printText).toContain("连接件");
  } finally {
    editor?.destroy();
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
