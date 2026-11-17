import { useState } from "react";
import type { CanonicalDocument } from "../../../shared/document/model";
import type { EditorCommandBus } from "../app/command-bus";
import type { DocumentSession } from "../documents/document-reducer";
import { TransientFunctionRailSlot } from "../shared/transient-function-rail-slot";
import { createPatentExtensions } from "./extensions";
import { canonicalToTiptap, tiptapToCanonical } from "./model-adapter";
import { RichTextEditorCore } from "./rich-text-editor-core";
import { ChemicalStructureRailPanel } from "./ui/chemical-structure-rail-panel";
import { FindReplacePanel } from "./ui/find-replace-panel";

type PatentEditorProps = {
  session: DocumentSession;
  commandBus: EditorCommandBus;
  onModelChange(sessionId: string, model: CanonicalDocument): void;
  onTextCounts?(
    sessionId: string,
    counts: { chineseCharacters: number; totalCharacters: number; selectedCharacters: number },
  ): void;
};

export function PatentEditor({
  session,
  commandBus,
  onModelChange,
  onTextCounts,
}: PatentEditorProps) {
  const [findMode, setFindMode] = useState<"find" | "replace" | null>(null);
  const [findQuery, setFindQuery] = useState("");
  const [findReplacement, setFindReplacement] = useState("");
  const [findOptions, setFindOptions] = useState<{
    caseSensitive: boolean;
    wholeWord: boolean;
    searchMode: "literal" | "wildcard" | "regex";
    useRegex: boolean;
  }>({
    caseSensitive: false,
    wholeWord: false,
    searchMode: "literal",
    useRegex: false,
  });

  return (
    <>
      <RichTextEditorCore
        editorId={session.sessionId}
        title={session.model.title}
        document={session.model}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        extensionFactory={createPatentExtensions}
        importImages={(images, operationId) =>
          window.patentApi.assets.importMany({
            sessionId: session.sessionId,
            operationId,
            images: images.map((image) => ({
              originalName: image.originalName,
              declaredMediaType: image.mediaType || null,
              bytes: image.bytes,
            })),
          })
        }
        addImageAsset={(document, descriptor) =>
          document.assets.some((asset) => asset.assetId === descriptor.assetId)
            ? document
            : { ...document, assets: [...document.assets, descriptor] }
        }
        toTiptap={(document) => canonicalToTiptap(document)}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={(model) => onModelChange(session.sessionId, model)}
        onTextCounts={(counts) => onTextCounts?.(session.sessionId, counts)}
        onFindModeChange={(mode, selectedText) => {
          setFindMode(mode);
          if (selectedText) setFindQuery(selectedText);
        }}
      />
      <ChemicalStructureRailPanel
        commandBus={commandBus}
        editorId={session.sessionId}
        contentWidthMm={
          session.model.page.widthMm -
          session.model.page.marginLeftMm -
          session.model.page.marginRightMm
        }
      />
      <TransientFunctionRailSlot open={findMode !== null}>
        {findMode ? (
          <FindReplacePanel
            editor={commandBus.getEditor(session.sessionId)}
            mode={findMode}
            query={findQuery}
            replacement={findReplacement}
            options={findOptions}
            onOptionsChange={(options) => setFindOptions((current) => ({ ...current, ...options }))}
            onModeChange={setFindMode}
            onShortcut={(mode) => setFindMode((current) => (current === mode ? null : mode))}
            onQueryChange={setFindQuery}
            onReplacementChange={setFindReplacement}
            onClose={() => setFindMode(null)}
          />
        ) : null}
      </TransientFunctionRailSlot>
    </>
  );
}
