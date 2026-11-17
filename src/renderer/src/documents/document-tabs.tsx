import { Plus, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { DialogCloseIcon } from "../shared/dialog-close-icon";
import type { DocumentSession } from "./document-reducer";
import { SaveStateBadge } from "./save-state-badge";

type DocumentTabsProps = {
  sessions: DocumentSession[];
  activeSessionId: string;
  libraryActive?: boolean;
  onActivate(sessionId: string): void;
  onRequestClose(sessionId: string): void;
  onReorder(fromIndex: number, toIndex: number): void;
  onNewDocument(): void;
  onOpenLibrary?(): void;
};

export function DocumentTabs({
  sessions,
  activeSessionId,
  libraryActive = false,
  onActivate,
  onRequestClose,
  onReorder,
  onNewDocument,
  onOpenLibrary,
}: DocumentTabsProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let targetIndex: number | null = null;
    if (event.key === "ArrowLeft") targetIndex = (index - 1 + sessions.length) % sessions.length;
    if (event.key === "ArrowRight") targetIndex = (index + 1) % sessions.length;
    if (event.key === "Home") targetIndex = 0;
    if (event.key === "End") targetIndex = sessions.length - 1;
    if (targetIndex === null) return;

    event.preventDefault();
    const target = sessions[targetIndex];
    if (!target) return;
    onActivate(target.sessionId);
    document.querySelector<HTMLElement>(`[data-session-id="${target.sessionId}"]`)?.focus();
  };

  return (
    <div className="title-tab-row">
      <div className="document-tabs" role="tablist" aria-label="打开的文档">
        {onOpenLibrary ? (
          <div className={`document-tab library-tab ${libraryActive ? "is-active" : ""}`}>
            <button
              className="tab-label library-tab-label"
              type="button"
              role="tab"
              aria-selected={libraryActive}
              tabIndex={libraryActive ? 0 : -1}
              onClick={onOpenLibrary}
            >
              <span className="tab-title">文档库</span>
            </button>
          </div>
        ) : null}
        {sessions.map((session, index) => (
          <div
            className={`document-tab ${
              !libraryActive && session.sessionId === activeSessionId ? "is-active" : ""
            }`}
            key={session.sessionId}
          >
            <button
              className="tab-label"
              type="button"
              role="tab"
              draggable
              data-session-id={session.sessionId}
              aria-selected={!libraryActive && session.sessionId === activeSessionId}
              tabIndex={!libraryActive && session.sessionId === activeSessionId ? 0 : -1}
              onClick={() => onActivate(session.sessionId)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              onDragStart={(event) => event.dataTransfer.setData("text/tab-index", String(index))}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const fromIndex = Number(event.dataTransfer.getData("text/tab-index"));
                if (Number.isInteger(fromIndex)) onReorder(fromIndex, index);
              }}
            >
              <span className="tab-title">{session.model.title}</span>
              <SaveStateBadge state={session.saveState} lastSavedAt={session.lastSavedAt} />
            </button>
            <button
              type="button"
              className="tab-close dialog-close-button"
              aria-label={`关闭 ${session.model.title}`}
              onClick={() => onRequestClose(session.sessionId)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <button
        className="new-tab-button"
        type="button"
        onClick={onNewDocument}
        aria-label="新建文档"
      >
        <Plus size={17} aria-hidden="true" />
      </button>
      <div className="window-drag-space" aria-hidden="true" />
    </div>
  );
}

type CloseDecisionDialogProps = {
  documentTitle: string;
  onSave(): void;
  onDiscard(): void;
  onCancel(): void;
};

export function CloseDecisionDialog({
  documentTitle,
  onSave,
  onDiscard,
  onCancel,
}: CloseDecisionDialogProps) {
  return (
    <div className="dialog-backdrop">
      <section
        className="close-dialog dialog-with-standard-close"
        role="dialog"
        aria-modal="true"
        aria-label="保存更改"
      >
        <button
          type="button"
          className="dialog-close-button dialog-close-button--corner dialog-close-control"
          aria-label="取消保存更改"
          onClick={onCancel}
        >
          <DialogCloseIcon />
        </button>
        <h2>保存更改</h2>
        <p>是否保存对“{documentTitle}”所做的更改？</p>
        <div className="dialog-actions">
          <button className="primary-button" type="button" onClick={onSave}>
            保存
          </button>
          <button type="button" onClick={onDiscard}>
            不保存
          </button>
          <button type="button" onClick={onCancel}>
            取消
          </button>
        </div>
      </section>
    </div>
  );
}
