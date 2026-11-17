import { type CSSProperties, useEffect, useState } from "react";
import type { AssetDescriptor, PatentBookDocument } from "../../../shared/document/model";
import type { JsonObject } from "../../../shared/ipc/primitives";
import { PATENT_PAGE_MARGIN_CSS_VARS } from "../../../shared/settings/page-margins";
import type { EditorCommandBus } from "../app/command-bus";
import { TableRailPanel } from "../editor/table/table-rail-panel";
import { FindReplacePanel } from "../editor/ui/find-replace-panel";
import {
  TransientFunctionRailSlot,
  useRetainedTransientVisibility,
} from "../shared/transient-function-rail-slot";
import type { FindRailSession } from "./editors/book-editor";
import { PatentBookRichTextEditor } from "./editors/patent-book-rich-text-editor";
import { PatentGlobalFunctionRail } from "./patent-global-function-rail";
import type { PatentSession } from "./patent-reducer";
import { ORDINARY_DOCUMENT_CAPABILITIES } from "./patent-toolbar-capabilities";

export function auxiliaryDocumentEditorId(sessionId: string, auxiliaryDocumentId: string): string {
  return `${sessionId}:auxiliary:${auxiliaryDocumentId}`;
}

type AuxiliaryDocumentEditorProps = {
  session: PatentSession;
  auxiliaryDocumentId: string;
  commandBus: EditorCommandBus;
  zoomPercent?: number;
  findSession?: FindRailSession | null;
  findQuery?: string;
  findReplacement?: string;
  findOptions?: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    searchMode?: "literal" | "wildcard" | "regex";
    useRegex?: boolean;
  };
  onFindOptionsChange?(options: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    searchMode?: "literal" | "wildcard" | "regex";
    useRegex?: boolean;
  }): void;
  onOpenFindRail?(mode: "find" | "replace", selectedText?: string): void;
  onFindModeChange?(mode: "find" | "replace" | null): void;
  onFindQueryChange?(value: string): void;
  onFindReplacementChange?(value: string): void;
  inactiveSelectionVisible?: boolean;
  onDocumentChange(
    auxiliaryDocumentId: string,
    document: PatentBookDocument,
    editorState: JsonObject,
    assets: AssetDescriptor[],
  ): void;
  onRetrySave?(): void | Promise<void>;
};

export function AuxiliaryDocumentEditor({
  session,
  auxiliaryDocumentId,
  commandBus,
  zoomPercent = 100,
  findSession,
  findQuery,
  findReplacement,
  findOptions,
  onFindOptionsChange,
  onOpenFindRail,
  onFindModeChange,
  onFindQueryChange,
  onFindReplacementChange,
  inactiveSelectionVisible = false,
  onDocumentChange,
  onRetrySave,
}: AuxiliaryDocumentEditorProps) {
  const auxiliary = session.patent.auxiliaryDocuments.find(
    (document) => document.auxiliaryDocumentId === auxiliaryDocumentId,
  );
  const editorId = auxiliaryDocumentEditorId(session.sessionId, auxiliaryDocumentId);
  const [tablePanelVisible, setTablePanelVisible] = useState(
    () => commandBus.getTableSelection(editorId).kind !== "none",
  );
  useEffect(() => {
    setTablePanelVisible(commandBus.getTableSelection(editorId).kind !== "none");
    return commandBus.subscribeTableSelection(editorId, (selection) =>
      setTablePanelVisible(selection.kind !== "none"),
    );
  }, [commandBus, editorId]);
  const findReplacePanelVisible =
    findSession?.target.kind === "auxiliary" &&
    findSession.target.patentId === session.patentId &&
    findSession.target.auxiliaryDocumentId === auxiliaryDocumentId &&
    findSession.editorId === editorId;
  const functionRailVisible = tablePanelVisible || findReplacePanelVisible;
  const functionRailRetained = useRetainedTransientVisibility(functionRailVisible);
  if (!auxiliary) return null;
  const findReplacePanel = findReplacePanelVisible ? (
    <div data-function-rail-owner={findSession.scope}>
      <FindReplacePanel
        editor={commandBus.getEditor(editorId)}
        mode={findSession.mode}
        query={findQuery ?? ""}
        replacement={findReplacement ?? ""}
        options={findOptions ?? {}}
        onOptionsChange={onFindOptionsChange ?? (() => undefined)}
        onShortcut={(mode) => onFindModeChange?.(findSession.mode === mode ? null : mode)}
        onQueryChange={onFindQueryChange ?? (() => undefined)}
        onReplacementChange={onFindReplacementChange ?? (() => undefined)}
        onClose={() => onFindModeChange?.(null)}
      />
    </div>
  ) : null;
  return (
    <div
      className="patent-book-editor-layout auxiliary-document-editor-layout"
      data-patent-text-projection={editorId}
    >
      <div
        className="patent-page-with-rail"
        data-structure-ruler-offset={functionRailRetained ? "true" : undefined}
        style={
          {
            "--patent-page-zoom": zoomPercent / 100,
            "--patent-book-page-width": `${auxiliary.document.page.widthMm}mm`,
            "--patent-book-page-min-height": `${auxiliary.document.page.heightMm}mm`,
            [PATENT_PAGE_MARGIN_CSS_VARS.top]: `${auxiliary.document.page.marginTopMm}mm`,
            [PATENT_PAGE_MARGIN_CSS_VARS.right]: `${auxiliary.document.page.marginRightMm}mm`,
            [PATENT_PAGE_MARGIN_CSS_VARS.bottom]: `${auxiliary.document.page.marginBottomMm}mm`,
            [PATENT_PAGE_MARGIN_CSS_VARS.left]: `${auxiliary.document.page.marginLeftMm}mm`,
          } as CSSProperties
        }
      >
        <div className="patent-page-zoom-frame">
          <div
            className="auxiliary-document-editor"
            data-auxiliary-document-id={auxiliaryDocumentId}
          >
            <PatentBookRichTextEditor
              editorId={editorId}
              bookKind="description"
              document={auxiliary.document}
              displayTitle={auxiliary.title}
              documentKind="auxiliary"
              patentParagraphRules={false}
              availableAssetIds={new Set(session.patent.assets.map((asset) => asset.assetId))}
              sessionId={session.sessionId}
              assets={session.patent.assets}
              commandBus={commandBus}
              capabilities={ORDINARY_DOCUMENT_CAPABILITIES}
              saveState={session.auxiliarySaveStates[auxiliaryDocumentId] ?? "saved"}
              inactiveSelectionVisible={inactiveSelectionVisible}
              onFindModeChange={(mode, selectedText) => {
                if (mode) onOpenFindRail?.(mode, selectedText);
                else onFindModeChange?.(null);
              }}
              onDocumentChange={(document, assets = []) =>
                onDocumentChange(
                  auxiliaryDocumentId,
                  document,
                  structuredClone(auxiliary.editorState),
                  assets,
                )
              }
              {...(onRetrySave ? { onRetrySave } : {})}
            />
          </div>
        </div>
        {functionRailRetained ? (
          <PatentGlobalFunctionRail
            bookKind="description"
            title={auxiliary.title}
            measurementKey={zoomPercent}
            {...(findReplacePanel ? { onCollapse: () => onFindModeChange?.(null) } : {})}
          >
            <TableRailPanel commandBus={commandBus} editorId={editorId} />
            <TransientFunctionRailSlot open={findReplacePanel !== null}>
              {findReplacePanel}
            </TransientFunctionRailSlot>
          </PatentGlobalFunctionRail>
        ) : null}
      </div>
    </div>
  );
}
