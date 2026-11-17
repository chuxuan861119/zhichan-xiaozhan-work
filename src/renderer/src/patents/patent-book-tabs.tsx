import { X } from "lucide-react";
import { type DragEvent, useState } from "react";
import {
  availablePatentBookKinds,
  DRAWING_BOOK_KINDS,
  PATENT_BOOK_LABELS,
  type PatentBookKind,
} from "../../../shared/patent/model";
import { MotionPresence } from "../app/motion-presence";
import { confirmAppAction } from "../shared/app-dialog";
import { SpatialPresence } from "../shared/spatial-presence";
import { StandardDialog } from "../shared/standard-dialog";
import { isSupportedDrawingImage } from "./editors/drawing-image-import";
import type { PatentSession } from "./patent-reducer";
import type { WorkspaceTabDragBindings, WorkspaceTabDragSource } from "./patent-workspace-tab-drag";

type PatentBookTabsProps = {
  session: PatentSession;
  inactive?: boolean;
  onActivateBook(patentId: string, bookKind: PatentBookKind): void;
  onSetDrawingBooksEnabled(patentId: string, enabled: boolean): Promise<boolean>;
  onDropDrawingFiles?(patentId: string, files: File[]): Promise<boolean>;
  workspaceTabDrag?: WorkspaceTabDragBindings;
};

const ADD_DRAWING_BOOKS_CONFIRMATION = "重新添加说明书附图和摘要附图？将创建两本新的空白附图书。";
const REMOVE_DRAWING_BOOKS_TITLE = "删除说明书附图和摘要附图";
const REMOVE_DRAWING_BOOKS_MESSAGE =
  "将移除全部附图图片、清空附图标记和同步设置；权利要求书、说明书、说明书摘要的文字会保留。";

function isDrawingBook(kind: PatentBookKind): boolean {
  return DRAWING_BOOK_KINDS.includes(kind as (typeof DRAWING_BOOK_KINDS)[number]);
}

export function PatentBookTabs({
  session,
  inactive = false,
  onActivateBook,
  onSetDrawingBooksEnabled,
  onDropDrawingFiles,
  workspaceTabDrag,
}: PatentBookTabsProps) {
  const [switchingDrawingBooks, setSwitchingDrawingBooks] = useState(false);
  const [drawingBooksConfirmationOpen, setDrawingBooksConfirmationOpen] = useState(false);
  const [drawingFileDropActive, setDrawingFileDropActive] = useState(false);
  const canManageDrawingBooks = session.patent.patentType === "invention";
  const drawingBooksEnabled = session.patent.drawingBooksEnabled;
  const bookKinds = availablePatentBookKinds(session.patent);

  const requestDrawingBooksEnabled = async (enabled: boolean) => {
    if (!enabled) {
      setDrawingBooksConfirmationOpen(true);
      return;
    }
    const confirmation = ADD_DRAWING_BOOKS_CONFIRMATION;
    if (!(await confirmAppAction(confirmation))) return;
    setSwitchingDrawingBooks(true);
    try {
      await onSetDrawingBooksEnabled(session.patentId, enabled);
    } finally {
      setSwitchingDrawingBooks(false);
    }
  };

  const confirmDrawingBooksRemoval = async () => {
    setDrawingBooksConfirmationOpen(false);
    setSwitchingDrawingBooks(true);
    try {
      await onSetDrawingBooksEnabled(session.patentId, false);
    } finally {
      setSwitchingDrawingBooks(false);
    }
  };

  const handleDrawingFileDragOver = (event: DragEvent<HTMLButtonElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDrawingFileDropActive(true);
  };

  const handleDrawingFileDrop = async (event: DragEvent<HTMLButtonElement>) => {
    const files = Array.from(event.dataTransfer.files).filter(isSupportedDrawingImage);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    setDrawingFileDropActive(false);
    onActivateBook(session.patentId, "description-drawings");
    await onDropDrawingFiles?.(session.patentId, files);
  };

  return (
    <>
      <div className="patent-book-tabs" role="tablist" aria-label="五书标签栏">
        {bookKinds.map((bookKind) => {
          const active = !inactive && session.activeBookKind === bookKind;
          const showRemoveButton =
            canManageDrawingBooks && drawingBooksEnabled && isDrawingBook(bookKind);
          const showAddButton =
            canManageDrawingBooks && !drawingBooksEnabled && bookKind === "abstract";
          const dragSource: WorkspaceTabDragSource = {
            key: `book:${session.patentId}:${bookKind}`,
            label: PATENT_BOOK_LABELS[bookKind],
            target: { patentId: session.patentId, bookKind },
          };
          const tab = (
            <button
              type="button"
              role="tab"
              aria-label={PATENT_BOOK_LABELS[bookKind]}
              aria-selected={active}
              className={`patent-book-tabs__tab ${active ? "is-active" : ""}${
                bookKind === "description-drawings" && drawingFileDropActive
                  ? " is-file-drop-target"
                  : ""
              }`}
              onDragOver={
                bookKind === "description-drawings" && onDropDrawingFiles
                  ? handleDrawingFileDragOver
                  : undefined
              }
              onDragLeave={
                bookKind === "description-drawings" && onDropDrawingFiles
                  ? (event) => {
                      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                      setDrawingFileDropActive(false);
                    }
                  : undefined
              }
              onDrop={
                bookKind === "description-drawings" && onDropDrawingFiles
                  ? (event) => void handleDrawingFileDrop(event)
                  : undefined
              }
              onPointerDown={(event) =>
                workspaceTabDrag?.start({
                  source: dragSource,
                  sourceElement: event.currentTarget,
                  pointerId: event.pointerId,
                  button: event.button,
                  clientX: event.clientX,
                  clientY: event.clientY,
                })
              }
              onClick={() => {
                if (workspaceTabDrag?.consumeClick(dragSource.key)) return;
                onActivateBook(session.patentId, bookKind);
              }}
            >
              <span>{PATENT_BOOK_LABELS[bookKind]}</span>
            </button>
          );
          return (
            <div className="patent-book-tabs__item" key={bookKind}>
              {showRemoveButton ? (
                <div className={`patent-book-tabs__tab-shell ${active ? "is-active" : ""}`}>
                  {tab}
                  <button
                    type="button"
                    className="patent-book-tabs__drawing-action patent-book-tabs__drawing-action--remove"
                    aria-label={REMOVE_DRAWING_BOOKS_TITLE}
                    title={REMOVE_DRAWING_BOOKS_TITLE}
                    disabled={switchingDrawingBooks}
                    onClick={() => void requestDrawingBooksEnabled(false)}
                  >
                    <X size={13} strokeWidth={1.7} aria-hidden="true" />
                  </button>
                </div>
              ) : (
                tab
              )}
              <SpatialPresence>
                {showAddButton ? (
                  <button
                    type="button"
                    className="patent-book-tabs__drawing-action patent-book-tabs__drawing-action--add"
                    aria-label="添加附图"
                    disabled={switchingDrawingBooks}
                    onClick={() => void requestDrawingBooksEnabled(true)}
                  >
                    + 添加附图
                  </button>
                ) : null}
              </SpatialPresence>
            </div>
          );
        })}
      </div>
      <MotionPresence>
        {drawingBooksConfirmationOpen ? (
          <StandardDialog
            open
            title={REMOVE_DRAWING_BOOKS_TITLE}
            dialogRole="alertdialog"
            size="s"
            className="patent-book-tabs__drawing-delete-dialog"
            onCancel={() => setDrawingBooksConfirmationOpen(false)}
            footer={
              <>
                <button type="button" onClick={() => setDrawingBooksConfirmationOpen(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="standard-dialog__danger-button"
                  onClick={() => void confirmDrawingBooksRemoval()}
                >
                  确认删除
                </button>
              </>
            }
          >
            <div className="patent-book-tabs__drawing-delete-warning" role="alert">
              <strong>⚠ 此操作不可撤销</strong>
              <p>{REMOVE_DRAWING_BOOKS_MESSAGE}</p>
            </div>
          </StandardDialog>
        ) : null}
      </MotionPresence>
    </>
  );
}
