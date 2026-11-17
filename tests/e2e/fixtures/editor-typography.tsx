import type { Editor } from "@tiptap/core";
import { redoDepth, undoDepth } from "@tiptap/pm/history";
import { type CSSProperties, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorCommandBus } from "../../../src/renderer/src/app/command-bus";
import { ColorPicker } from "../../../src/renderer/src/editor/ui/color-picker";
import { useDualPaneZoomLimit } from "../../../src/renderer/src/patents/dual-pane-zoom-limit";
import { useSmoothDocumentZoom } from "../../../src/renderer/src/patents/use-smooth-document-zoom";
import { calculateDualPaneFit } from "../../../src/renderer/src/patents/use-window-layout";
import "../../../src/renderer/src/editor/editor.css";
import { setReferenceMarkKeywordDecorations } from "../../../src/renderer/src/editor/extensions/reference-mark-keyword-decorations";
import { ImageSelectionFrame } from "../../../src/renderer/src/editor/image/image-selection-frame";
import { tiptapToPatentBookDocument } from "../../../src/renderer/src/editor/model-adapter";
import { DocumentStructureRuler } from "../../../src/renderer/src/patents/document-structure-ruler";
import { DrawingWorkbench } from "../../../src/renderer/src/patents/editors/drawing-workbench";
import { PatentBookRichTextEditor } from "../../../src/renderer/src/patents/editors/patent-book-rich-text-editor";
import { PatentFunctionRailScope } from "../../../src/renderer/src/patents/function-rail/function-rail-context";
import { PatentGlobalFunctionRail } from "../../../src/renderer/src/patents/patent-global-function-rail";
import { capabilitiesForPatentBook } from "../../../src/renderer/src/patents/patent-toolbar-capabilities";
import { usePatentEditorFocus } from "../../../src/renderer/src/patents/use-patent-editor-focus";
import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../../../src/shared/document/defaults";
import { createBlankPatent } from "../../../src/shared/patent/defaults";
import type { TypographyHarness, TypographyLine } from "./editor-typography-contract";

const kind =
  new URLSearchParams(location.search).get("book") === "abstract"
    ? "abstract"
    : new URLSearchParams(location.search).get("book") === "description"
      ? "description"
      : "claims";
const editorId = `typography:${kind}`;
const bus = new EditorCommandBus();
const assets = new Set<string>();
if (new URLSearchParams(location.search).has("inline-image"))
  assets.add("00000000-0000-4000-8000-000000000812");
const capabilities = capabilitiesForPatentBook(kind);
const initialBook = createBlankPatent({ patentType: "utility-model", name: "排版测试" }).books.find(
  (book) => book.kind === kind,
);
if (!initialBook) throw new Error("missing fixture book");
const initial = initialBook.document;

function Harness() {
  const dualWidth = Number(new URLSearchParams(location.search).get("dualWidth"));
  const dualFit = dualWidth
    ? calculateDualPaneFit({ contentWidth: dualWidth, contentHeight: 900, isMaximized: true })
    : null;
  const [document, setDocument] = useState(initial);
  const [zoom, setZoom] = useState(dualFit?.fitZoomPercent ?? 100);
  const [imageWidth, setImageWidth] = useState(80);
  const params = new URLSearchParams(location.search);
  const linked = params.has("linked");
  const retained = params.has("retained");
  const smooth = params.has("smooth");
  const [zoomViewport, setZoomViewport] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (smooth || dualWidth) setZoomViewport(window.document.querySelector(".editor-workspace"));
  }, [smooth, dualWidth]);
  useSmoothDocumentZoom(zoomViewport, zoom, smooth);
  useDualPaneZoomLimit(
    zoomViewport,
    zoom,
    dualFit ? (max) => setZoom((value) => Math.min(value, max)) : undefined,
    editorId,
    dualFit ? setZoom : undefined,
  );
  const zoomControl = (
    <select
      aria-label="测试缩放"
      value={zoom}
      onChange={(event) => setZoom(Number(event.target.value))}
    >
      {[50, 80, 100, 125, 150, 200].map((value) => (
        <option key={value} value={value}>
          {value}%
        </option>
      ))}
    </select>
  );
  usePatentEditorFocus({ activeEditorId: editorId, enabled: true, commandBus: bus });
  const content = (
    <PatentBookRichTextEditor
      editorId={editorId}
      bookKind={kind}
      document={document}
      availableAssetIds={assets}
      commandBus={bus}
      capabilities={capabilities}
      onDocumentChange={setDocument}
      activeSelectionVisible={retained}
    />
  );
  if (params.get("layout") === "image") {
    return (
      <>
        {zoomControl}
        <div style={{ padding: 100 }}>
          <div style={{ zoom: zoom / 100 }}>
            <ImageSelectionFrame
              selected
              widthMm={imageWidth}
              aspectRatio={2}
              onResizeCommit={setImageWidth}
              onDelete={() => {}}
            >
              <span>附图尺寸测试</span>
            </ImageSelectionFrame>
          </div>
        </div>
      </>
    );
  }
  if (params.get("layout") === "drawings") {
    const figures = Array.from({ length: 9 }, (_, index) => ({
      figureId: `figure-${index + 1}`,
      assetId: `asset-${index + 1}`,
      widthMm: 80,
    }));
    return (
      <>
        <PatentFunctionRailScope scopeKey="single">
          <main className="editor-workspace patent-editor-workspace" style={{ height: 700 }}>
            <DrawingWorkbench
              sessionId="drawing-layout-test"
              figures={figures}
              zoomPercent={zoom}
              sync={{
                status: "active",
                headingId: "drawing-heading",
                linked: figures.map((figure, index) => ({
                  figureId: figure.figureId,
                  index,
                  paragraph: {
                    id: `explanation-${index}`,
                    type: "paragraph",
                    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
                    content: [
                      { type: "text", text: `图${index + 1}为装置的结构示意图。`, marks: [] },
                    ],
                  },
                })),
                legend: null,
              }}
              unlinked={[]}
              onReorderFigures={() => {}}
              onResizeFigure={() => {}}
              onChange={() => undefined}
              onDeleteFigure={() => {}}
            />
          </main>
        </PatentFunctionRailScope>
        <footer style={{ position: "fixed", bottom: 0 }}>{zoomControl}</footer>
      </>
    );
  }
  if (params.get("layout") === "page") {
    const page = (
      <main
        className="editor-workspace patent-editor-workspace"
        style={{ height: "700px", width: dualFit?.paneWidth }}
      >
        <div className="patent-book-editor-layout">
          <div
            className="patent-page-with-rail"
            data-structure-ruler-offset={linked ? undefined : "true"}
            data-structure-ruler={linked ? "true" : undefined}
            style={
              {
                "--patent-page-zoom": zoom / 100,
                ...(dualFit ? { "--patent-book-page-width": `${initial.page.widthMm}mm` } : {}),
              } as CSSProperties
            }
          >
            {linked && kind !== "abstract" ? (
              <DocumentStructureRuler
                document={document}
                bookKind={kind}
                editorId={editorId}
                commandBus={bus}
                measurementKey={zoom}
              />
            ) : null}
            <div className="patent-page-zoom-frame">{content}</div>
            {linked ? (
              <PatentGlobalFunctionRail bookKind={kind} title="测试" measurementKey={zoom}>
                <button type="button">测试工具</button>
              </PatentGlobalFunctionRail>
            ) : null}
          </div>
        </div>
      </main>
    );
    const scopedPage = linked ? (
      <PatentFunctionRailScope
        scopeKey={dualFit ? "left" : "single"}
        initialSpace={dualFit?.initialRailSpace}
      >
        {page}
      </PatentFunctionRailScope>
    ) : (
      page
    );
    return (
      <>
        {dualFit ? (
          <div className="dual-document-pane" data-pane="left" style={{ width: dualFit.paneWidth }}>
            {scopedPage}
          </div>
        ) : (
          scopedPage
        )}
        <footer style={{ position: "fixed", bottom: 0 }}>
          {zoomControl}
          <input aria-label="面板输入框" />
        </footer>
      </>
    );
  }
  return (
    <main data-patent-text-projection={editorId} style={{ padding: "40px", minHeight: "100vh" }}>
      {new URLSearchParams(location.search).has("colors") ? (
        <div className="tool-bar">
          <ColorPicker
            onSelect={(color, preserveSelection, focusEditor) =>
              bus.setColor(editorId, color, preserveSelection, focusEditor)
            }
          />
          <ColorPicker
            kind="highlight"
            onSelect={(color, preserveSelection, focusEditor) =>
              bus.setHighlightColor(editorId, color, preserveSelection, focusEditor)
            }
          />
        </div>
      ) : null}
      <article
        id="paper"
        style={{ width: "570px", margin: "auto", padding: "48px 80px", background: "white" }}
      >
        {content}
      </article>
      <input aria-label="面板输入框" />
    </main>
  );
}

function editor(): Editor {
  const current = bus.getEditor(editorId);
  if (!current) throw new Error("editor is not mounted");
  return current;
}

function lines(): TypographyLine[] {
  const current = editor();
  const result: TypographyLine[] = [];
  current.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (let index = 0; index < node.text.length; index += 1) {
      const start = current.view.domAtPos(pos + index);
      const end = current.view.domAtPos(pos + index + 1);
      const range = window.document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const rect = Array.from(range.getClientRects()).at(-1);
      if (!rect?.width) continue;
      let line = result.find((candidate) => Math.abs(candidate.top - rect.top) < 4);
      if (!line) {
        line = {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          from: pos + index,
          to: pos + index + 1,
          text: "",
        };
        result.push(line);
      }
      line.right = Math.max(line.right, rect.right);
      line.to = pos + index + 1;
      line.text += node.text[index];
    }
  });
  return result;
}

function selection() {
  const selected = window.getSelection();
  const rect = selected?.rangeCount ? selected.getRangeAt(0).getClientRects()[0] : undefined;
  return {
    from: editor().state.selection.from,
    to: editor().state.selection.to,
    anchor: editor().state.selection.anchor,
    head: editor().state.selection.head,
    top: rect?.top ?? null,
    left: rect?.left ?? null,
    anchorOffset: selected?.anchorOffset,
    anchorText: selected?.anchorNode?.textContent,
  };
}

const typography = {
  ready: () => bus.has(editorId),
  lines,
  selection,
  load: (html: string) => editor().commands.setContent(html),
  bounds: () => {
    const rect = editor().view.dom.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  },
  align: (value: "left" | "right" | "center" | "justify") => editor().commands.setTextAlign(value),
  fontSize: (value: number) => bus.setFontSizePt(editorId, value),
  json: () => editor().getJSON(),
  saved: () => {
    const result = tiptapToPatentBookDocument(editor().getJSON(), initial, assets);
    if (!result.ok) throw new Error("invalid typography fixture document");
    return result.value;
  },
  text: () => editor().getText(),
  undo: () => editor().commands.undo(),
  redo: () => editor().commands.redo(),
  all: () => editor().commands.selectAll(),
  history: () => ({ undo: undoDepth(editor().state), redo: redoDepth(editor().state) }),
  clipboard: () => {
    const slice = editor().view.serializeForClipboard(editor().state.selection.content());
    return { text: slice.text, html: slice.dom.innerHTML };
  },
  paste: (html: string, text: string) => {
    const data = new DataTransfer();
    data.setData("text/html", html);
    data.setData("text/plain", text);
    editor().view.dom.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
    return lines();
  },
  keyword: (enabled: boolean) =>
    setReferenceMarkKeywordDecorations(editor(), {
      enabled,
      bookKind: kind,
      referenceMarks: [{ referenceMarkId: "test", keyword: "电池包主体", number: 1 }],
      activeReferenceMarkId: null,
      recentReferenceMarkId: null,
    }),
} satisfies TypographyHarness;

window.typography = typography;
const style = document.createElement("style");
style.textContent =
  "body{margin:0;background:#eee}.patent-prosemirror{min-height:160px}.patent-text-selection-gutter{display:none}.patent-book-page-header{text-align:center;margin-bottom:24px}";
document.head.append(style);
const root = document.getElementById("root");
if (!root) throw new Error("missing fixture root");
createRoot(root).render(<Harness />);
