import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { type CSSProperties, type KeyboardEvent, type MouseEvent, useEffect, useRef } from "react";
import { PATENT_BOOK_LABELS } from "../../../../shared/patent/model";
import { PATENT_PAGE_MARGIN_CSS_VARS } from "../../../../shared/settings/page-margins";
import { createPatentExtensions } from "../../editor/extensions";
import { ORDINARY_DOCUMENT_CAPABILITIES } from "../../patents/patent-toolbar-capabilities";
import type { SnapshotBookDiff } from "./snapshot-book-diff";
import { createSnapshotDiffExtensions } from "./snapshot-diff-extensions";

type Props = Readonly<{
  displayTitle?: string;
  diff: SnapshotBookDiff;
  documentId: string;
  currentRevision: number;
  onChangeSelected(changeId: string): void;
  onEditorReady?(editor: Editor): void;
}>;

const INTERACTIVE_TARGET_SELECTOR =
  'button,input,select,textarea,a[href],[contenteditable="true"],[role="button"]';

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_TARGET_SELECTOR) !== null;
}

export function SnapshotBookPreview({
  displayTitle,
  diff,
  documentId,
  currentRevision,
  onChangeSelected,
  onEditorReady,
}: Props) {
  const documentIdRef = useRef(documentId);
  const currentRevisionRef = useRef(currentRevision);
  documentIdRef.current = documentId;
  currentRevisionRef.current = currentRevision;
  const editor = useEditor({
    editable: false,
    extensions: [
      ...createPatentExtensions(`snapshot-preview:${documentId}:${currentRevision}`, {
        capabilities: ORDINARY_DOCUMENT_CAPABILITIES,
        readOnly: true,
        loadAssetPreview: (assetId, sourceRevision) =>
          window.patentApi.snapshot.previewAsset({
            documentType: "patent",
            documentId: documentIdRef.current,
            revision: sourceRevision ?? currentRevisionRef.current,
            assetId,
          }),
      }),
      ...createSnapshotDiffExtensions(),
    ],
    content: diff.previewContent,
    editorProps: {
      attributes: {
        role: "document",
        "aria-label": `${displayTitle ?? PATENT_BOOK_LABELS[diff.bookKind]}快照内容`,
        class: "patent-prosemirror snapshot-preview-prosemirror",
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    onEditorReady?.(editor);
    if (JSON.stringify(editor.getJSON()) === JSON.stringify(diff.previewContent)) return;
    const nextDocument = editor.schema.nodeFromJSON(diff.previewContent);
    editor.view.dispatch(
      editor.state.tr
        .replaceWith(0, editor.state.doc.content.size, nextDocument.content)
        .setMeta("addToHistory", false)
        .setMeta("preventUpdate", true),
    );
  }, [diff.previewContent, editor, onEditorReady]);

  const selectChange = (target: EventTarget | null) => {
    const element =
      target instanceof Element ? target.closest<HTMLElement>("[data-snapshot-change-id]") : null;
    const changeId = element?.dataset.snapshotChangeId;
    if (changeId) onChangeSelected(changeId);
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.target)) return;
    selectChange(event.target);
  };
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const formula =
      event.target instanceof Element
        ? event.target.closest("[data-type='inline-math'], [data-type='block-math']")
        : null;
    if (!formula?.hasAttribute("data-snapshot-change-id")) return;
    event.preventDefault();
    event.stopPropagation();
    selectChange(formula);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isInteractiveTarget(event.target)) return;
    const element =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-snapshot-change-id]")
        : null;
    if (!element) return;
    event.preventDefault();
    selectChange(element);
  };
  const page = diff.currentDocument.page;

  return (
    <section
      className="patent-book-editor-layout snapshot-book-preview"
      aria-label="快照变更导航区域"
      onClickCapture={onClickCapture}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <div
        className="patent-page-with-rail"
        data-snapshot-change-id={
          diff.changes.find((change) => change.nodeType === "page-settings")?.id
        }
        style={
          {
            "--patent-book-page-width": `${page.widthMm}mm`,
            "--patent-book-page-min-height": `${page.heightMm}mm`,
            [PATENT_PAGE_MARGIN_CSS_VARS.top]: `${page.marginTopMm}mm`,
            [PATENT_PAGE_MARGIN_CSS_VARS.right]: `${page.marginRightMm}mm`,
            [PATENT_PAGE_MARGIN_CSS_VARS.bottom]: `${page.marginBottomMm}mm`,
            [PATENT_PAGE_MARGIN_CSS_VARS.left]: `${page.marginLeftMm}mm`,
          } as CSSProperties
        }
      >
        <div className="patent-page-zoom-frame">
          <div className="patent-book-rich-text" data-book-kind={diff.bookKind}>
            <header className="patent-book-page-header">{PATENT_BOOK_LABELS[diff.bookKind]}</header>
            <div className="patent-book-editor-body">
              <EditorContent editor={editor} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
