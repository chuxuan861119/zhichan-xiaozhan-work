import type { CSSProperties } from "react";
import type { CanonicalDocument, PageSettings } from "../../../shared/document/model";
import { EDITOR_PAGE_CSS_VARS } from "../../../shared/settings/page-margins";
import type { EditorCommandBus } from "../app/command-bus";
import { PatentEditor } from "../editor/PatentEditor";
import type { DocumentSession } from "./document-reducer";

type EditorWorkspaceProps = {
  sessions: DocumentSession[];
  activeSessionId: string;
  commandBus: EditorCommandBus;
  onModelChange(sessionId: string, model: CanonicalDocument): void;
  onTextCounts(sessionId: string, counts: DocumentSession["textCounts"]): void;
  zoomPercent: number;
};

/** 把文档 page 的几何与边距注入 `.editor-paper` 的 CSS 变量（值一律 mm 字符串）。 */
function injectPageCssVars(page: PageSettings): CSSProperties {
  return {
    [EDITOR_PAGE_CSS_VARS.width]: `${page.widthMm}mm`,
    [EDITOR_PAGE_CSS_VARS.height]: `${page.heightMm}mm`,
    [EDITOR_PAGE_CSS_VARS.marginTop]: `${page.marginTopMm}mm`,
    [EDITOR_PAGE_CSS_VARS.marginRight]: `${page.marginRightMm}mm`,
    [EDITOR_PAGE_CSS_VARS.marginBottom]: `${page.marginBottomMm}mm`,
    [EDITOR_PAGE_CSS_VARS.marginLeft]: `${page.marginLeftMm}mm`,
  } as CSSProperties;
}

export function EditorWorkspace({
  sessions,
  activeSessionId,
  commandBus,
  onModelChange,
  onTextCounts,
  zoomPercent,
}: EditorWorkspaceProps) {
  return (
    <main
      className="editor-workspace"
      aria-label="文档编辑区"
      style={zoomPercent !== 100 ? { zoom: `${zoomPercent}%` } : undefined}
    >
      {sessions.map((session) => (
        <div
          className={`editor-session ${session.sessionId === activeSessionId ? "is-active" : ""}`}
          aria-hidden={session.sessionId !== activeSessionId}
          key={session.sessionId}
        >
          <div className="editor-paper" style={injectPageCssVars(session.model.page)}>
            <PatentEditor
              session={session}
              commandBus={commandBus}
              onModelChange={onModelChange}
              onTextCounts={onTextCounts}
            />
          </div>
        </div>
      ))}
    </main>
  );
}
