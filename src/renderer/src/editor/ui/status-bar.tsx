import type { LibraryPatentSummary } from "../../../../shared/library/model";
import { platformEditorShortcut } from "../../../../shared/platform";
import { fixedShortcutsFor, shortcutTooltip } from "../../../../shared/settings/shortcuts";
import type { DocumentSession } from "../../documents/document-reducer";
import { SaveStateBadge } from "../../documents/save-state-badge";
import { formatPatentCounts } from "../../library/patent-counts";
import type { PatentSession } from "../../patents/patent-reducer";
import { isTextPatentBook } from "../../patents/use-patent-editor-focus";
import type { TextCounts } from "../rich-text-editor-core";

function releaseEditorFocus() {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && activeElement.closest("[contenteditable='true']")) {
    activeElement.blur();
  }
}

function ZoomControls({
  zoomPercent,
  maxZoomPercent = 200,
  zoomMode = "absolute",
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: {
  zoomPercent: number;
  maxZoomPercent?: number;
  zoomMode?: "absolute" | "fit-width";
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
}) {
  return (
    <span className="status-zoom">
      <button
        type="button"
        className="status-zoom-btn"
        aria-label="缩小"
        title={shortcutTooltip({
          label: "缩小",
          shortcuts: fixedShortcutsFor("缩小"),
          visibleLabel: false,
        })}
        disabled={zoomPercent <= 50}
        onClick={onZoomOut}
      >
        −
      </button>
      <button
        type="button"
        className="status-zoom-value"
        aria-label={`缩放 ${Math.round(zoomPercent)}%，点击重置`}
        title={
          zoomMode === "fit-width"
            ? platformEditorShortcut("恢复适应宽度（Ctrl+0）")
            : shortcutTooltip({
                label: "恢复为 100%",
                shortcuts: fixedShortcutsFor("恢复为 100%"),
                visibleLabel: true,
              })
        }
        onClick={onZoomReset}
      >
        {zoomMode === "fit-width"
          ? zoomPercent === 100
            ? "适应宽度"
            : `适应宽度 × ${Math.round(zoomPercent)}%`
          : `${Math.round(zoomPercent)}%`}
      </button>
      <button
        type="button"
        className="status-zoom-btn"
        aria-label="放大"
        title={shortcutTooltip({
          label: "放大",
          shortcuts: fixedShortcutsFor("放大"),
          visibleLabel: false,
        })}
        disabled={zoomPercent >= maxZoomPercent}
        onClick={onZoomIn}
      >
        +
      </button>
    </span>
  );
}

export function StatusBar({
  session,
  libraryPatents,
  patentSession = null,
  patentTextCounts,
  zoomPercent,
  maxZoomPercent,
  zoomMode,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: {
  session: DocumentSession | null;
  libraryPatents?: readonly Pick<LibraryPatentSummary, "patentType">[] | undefined;
  patentSession?: PatentSession | null;
  patentTextCounts?: TextCounts | null | undefined;
  zoomPercent: number;
  maxZoomPercent?: number;
  zoomMode?: "absolute" | "fit-width";
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
}) {
  const zoom = (
    <ZoomControls
      zoomPercent={zoomPercent}
      maxZoomPercent={maxZoomPercent ?? 200}
      zoomMode={zoomMode ?? "absolute"}
      onZoomIn={onZoomIn}
      onZoomOut={onZoomOut}
      onZoomReset={onZoomReset}
    />
  );

  if (libraryPatents !== undefined) {
    return (
      <footer className="status-bar" onPointerDownCapture={releaseEditorFocus}>
        <span>专利库</span>
        <span>{formatPatentCounts(libraryPatents)}</span>
        <span className="status-spacer" />
      </footer>
    );
  }

  if (patentSession) {
    return (
      <footer className="status-bar" onPointerDownCapture={releaseEditorFocus}>
        <span>{patentSession.patent.name ?? "未命名专利"}</span>
        <span className="status-save-state">
          <SaveStateBadge
            state={patentSession.aggregateSaveState}
            lastSavedAt={patentSession.lastSavedAt}
          />
          <span>修订 {patentSession.persistedRevision}</span>
        </span>
        {isTextPatentBook(patentSession.activeBookKind) && patentTextCounts !== undefined ? (
          <span>
            {patentTextCounts?.selectedCharacters
              ? `已选 ${patentTextCounts.selectedCharacters} / 共 ${patentTextCounts.totalCharacters} 字`
              : `字数：${patentTextCounts?.totalCharacters ?? 0}`}
          </span>
        ) : null}
        <span className="status-spacer" />
        {zoom}
      </footer>
    );
  }

  if (!session) {
    return (
      <footer className="status-bar" onPointerDownCapture={releaseEditorFocus}>
        <span>专利库</span>
        <span className="status-spacer" />
        {zoom}
      </footer>
    );
  }

  return (
    <footer className="status-bar" onPointerDownCapture={releaseEditorFocus}>
      <span>第 1 页，共 1 页</span>
      <span className="status-save-state">
        <SaveStateBadge state={session.saveState} lastSavedAt={session.lastSavedAt} />
        <span>修订 {session.persistedRevision}</span>
      </span>
      <span className="status-spacer" />
      <span>{session.textCounts.chineseCharacters} 汉字</span>
      <span>
        {session.textCounts.selectedCharacters > 0
          ? `已选 ${session.textCounts.selectedCharacters} / 共 ${session.textCounts.totalCharacters} 字符`
          : `${session.textCounts.totalCharacters} 字符`}
      </span>
      {zoom}
    </footer>
  );
}
