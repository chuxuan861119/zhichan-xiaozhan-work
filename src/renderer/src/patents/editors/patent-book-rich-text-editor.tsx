import { memo, useMemo, useRef } from "react";
import type { AssetDescriptor, PatentBookDocument } from "../../../../shared/document/model";
import type { LibrarySaveState } from "../../../../shared/library/model";
import { PATENT_BOOK_LABELS, type PatentBookKind } from "../../../../shared/patent/model";
import type { ReferenceMarkIssueLocation } from "../../../../shared/patent/reference-mark-issue-locator";
import type { EditorCommandBus } from "../../app/command-bus";
import { createPatentExtensions } from "../../editor/extensions";
import type { ReferenceMarkKeywordDecoration } from "../../editor/extensions/reference-mark-keyword-decorations";
import type { FormulaDrawingRequest } from "../../editor/formula-drawing-request";
import { createIncrementalPatentBookAdapter } from "../../editor/model-adapter";
import {
  type RichTextEditorCapabilities,
  RichTextEditorCore,
  type RichTextEditorCoreProps,
  type TextCounts,
} from "../../editor/rich-text-editor-core";

import { usePatentAutomationSession } from "../patent-context";

type TextPatentBookKind = Extract<PatentBookKind, "claims" | "description" | "abstract">;

const MemoizedBookCore = memo(RichTextEditorCore<PatentBookDocument>);
const EMPTY_LOCATIONS: readonly ReferenceMarkIssueLocation[] = [];
const EMPTY_REFERENCE_MARKS: readonly ReferenceMarkKeywordDecoration[] = [];

// Route UI callbacks to the latest render without invalidating an unchanged editor body.
// Converters and extension factories retain identity-based invalidation, since they
// affect content reconciliation and must never be treated as UI-only callbacks.
function StableBookCore(props: RichTextEditorCoreProps<PatentBookDocument>) {
  const latest = useRef(props);
  latest.current = props;
  const names = Object.keys(props)
    .filter(
      (key) =>
        !["toTiptap", "fromTiptap", "extensionFactory"].includes(key) &&
        typeof props[key as keyof typeof props] === "function",
    )
    .sort()
    .join("|");
  const handlers = useMemo(
    () =>
      Object.fromEntries(
        names
          .split("|")
          .filter(Boolean)
          .map((key) => [
            key,
            (...args: unknown[]) =>
              (latest.current[key as keyof typeof props] as (...values: unknown[]) => unknown)(
                ...args,
              ),
          ]),
      ) as Partial<typeof props>,
    [names],
  );
  const capabilityKey = JSON.stringify(props.capabilities);
  // biome-ignore lint/correctness/useExhaustiveDependencies: immutable capabilities are equivalent by value.
  const capabilities = useMemo(() => props.capabilities, [capabilityKey]);
  const locations = props.referenceMarkIssueLocations?.length
    ? props.referenceMarkIssueLocations
    : EMPTY_LOCATIONS;
  return (
    <MemoizedBookCore
      {...props}
      {...handlers}
      capabilities={capabilities}
      referenceMarkIssueLocations={locations}
      referenceMarks={props.referenceMarks?.length ? props.referenceMarks : EMPTY_REFERENCE_MARKS}
    />
  );
}

export function patentBookEditorId(sessionId: string, kind: PatentBookKind): string {
  return `${sessionId}:${kind}`;
}

export type PatentBookRichTextEditorProps = {
  editorId: string;
  bookKind: TextPatentBookKind;
  document: PatentBookDocument;
  availableAssetIds: ReadonlySet<string>;
  sessionId?: string;
  assets?: readonly AssetDescriptor[];
  commandBus: EditorCommandBus;
  capabilities: RichTextEditorCapabilities;
  onDocumentChange(document: PatentBookDocument, assets?: AssetDescriptor[]): void;
  onTextCounts?(counts: TextCounts): void;
  onFindModeChange?(mode: "find" | "replace" | null, selectedText?: string): void;
  onNumberSelection?(): void;
  onInsertDependentClaim?(): void;
  saveState?: LibrarySaveState;
  onRetrySave?(): void | Promise<void>;
  onInsertFormulaDrawing?(request: FormulaDrawingRequest): void | Promise<void>;
  activeSelectionVisible?: boolean;
  inactiveSelectionVisible?: boolean;
  referenceMarkReviewKeyword?: string | null;
  referenceMarkReviewActiveIndex?: number | null;
  referenceMarkIssueLocations?: readonly ReferenceMarkIssueLocation[];
  referenceMarkIssueActiveLocationId?: string | null;
  referenceMarkLocatorEnabled?: boolean;
  referenceMarks?: readonly ReferenceMarkKeywordDecoration[];
  activeReferenceMarkId?: string | null;
  recentReferenceMarkId?: string | null;
  onReferenceMarkActivate?(referenceMarkId: string | null): void;
  displayTitle?: string;
  documentKind?: string;
  patentParagraphRules?: boolean;
};

export function PatentBookRichTextEditor({
  editorId,
  bookKind,
  document,
  availableAssetIds,
  sessionId,
  assets = [],
  commandBus,
  capabilities,
  onDocumentChange,
  onTextCounts,
  onFindModeChange,
  onNumberSelection,
  onInsertDependentClaim,
  saveState,
  onRetrySave,
  onInsertFormulaDrawing,
  activeSelectionVisible = false,
  inactiveSelectionVisible = false,
  referenceMarkReviewKeyword = null,
  referenceMarkReviewActiveIndex = null,
  referenceMarkIssueLocations = [],
  referenceMarkIssueActiveLocationId = null,
  referenceMarkLocatorEnabled = false,
  referenceMarks = [],
  activeReferenceMarkId = null,
  recentReferenceMarkId = null,
  onReferenceMarkActivate = () => undefined,
  displayTitle,
  documentKind,
  patentParagraphRules = true,
}: PatentBookRichTextEditorProps) {
  const automation = usePatentAutomationSession(sessionId);
  const assetSnapshot = useRef<AssetDescriptor[]>([]);
  const lastPropAssets = useRef<string | null>(null);
  const gutterPointer = useRef<{
    pointerId: number;
    startY: number;
    dragged: boolean;
  } | null>(null);
  const suppressNextGutterClick = useRef(false);
  const propAssetIds = assets.map((asset) => asset.assetId).join("|");
  const propAssetKey = JSON.stringify(assets);
  if (lastPropAssets.current !== propAssetKey) {
    lastPropAssets.current = propAssetKey;
    assetSnapshot.current = Array.from(assets, (asset) => structuredClone(asset));
  }
  const availableAssetKey = [...availableAssetIds].sort().join("|");
  // Parent save/count renders create fresh arrays and Sets, but must not trigger
  // the core's whole-document reconciliation when asset membership is unchanged.
  // biome-ignore lint/correctness/useExhaustiveDependencies: asset metadata changes invalidate canonical normalization even when IDs stay unchanged.
  const converters = useMemo(() => {
    const knownIds = [...availableAssetKey.split("|"), ...propAssetIds.split("|")].filter(Boolean);
    return createIncrementalPatentBookAdapter(
      () => assetSnapshot.current,
      () => new Set([...knownIds, ...assetSnapshot.current.map((asset) => asset.assetId)]),
    );
  }, [availableAssetKey, propAssetIds, propAssetKey]);
  const extensionFactory = useMemo(
    () =>
      ((currentSessionId, options) =>
        createPatentExtensions(currentSessionId, {
          ...options,
          patentParagraphRules,
        })) as NonNullable<RichTextEditorCoreProps<PatentBookDocument>["extensionFactory"]>,
    [patentParagraphRules],
  );
  const textCountProps = onTextCounts ? { onTextCounts } : {};
  return (
    <div className="patent-book-rich-text" data-book-kind={documentKind ?? bookKind}>
      <header className="patent-book-page-header">
        {displayTitle ?? PATENT_BOOK_LABELS[bookKind]}
      </header>
      <div className="patent-book-editor-body">
        <div
          className="patent-text-selection-gutter"
          data-patent-selection-gutter={editorId}
          title="单击选中行；双击选中段落；三击选中全文"
          aria-hidden="true"
          onPointerDown={(event) => {
            event.preventDefault();
            suppressNextGutterClick.current = false;
            gutterPointer.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              dragged: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const pointer = gutterPointer.current;
            if (!pointer || pointer.pointerId !== event.pointerId) return;
            if (Math.abs(event.clientY - pointer.startY) < 4) return;
            pointer.dragged = true;
            commandBus.selectVisualLinesFromCoordinates(editorId, pointer.startY, event.clientY);
          }}
          onPointerUp={(event) => {
            const pointer = gutterPointer.current;
            if (!pointer || pointer.pointerId !== event.pointerId) return;
            gutterPointer.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            if (!pointer.dragged) return;
            suppressNextGutterClick.current = true;
            commandBus.selectVisualLinesFromCoordinates(editorId, pointer.startY, event.clientY);
          }}
          onClick={(event) => {
            event.preventDefault();
            if (suppressNextGutterClick.current) {
              suppressNextGutterClick.current = false;
              return;
            }
            if (event.detail >= 3) commandBus.selectAll(editorId);
            else if (event.detail === 2)
              commandBus.selectParagraphFromCoordinates(editorId, {
                x: event.clientX,
                y: event.clientY,
              });
            else
              commandBus.selectVisualLinesFromCoordinates(editorId, event.clientY, event.clientY);
          }}
        />
        <StableBookCore
          editable={!automation.readOnly}
          editorId={editorId}
          {...(sessionId ? { extensionSessionId: sessionId } : {})}
          title={document.title}
          document={document}
          commandBus={commandBus}
          {...(onNumberSelection ? { onNumberSelection } : {})}
          {...(onInsertDependentClaim ? { onInsertDependentClaim } : {})}
          capabilities={capabilities}
          activeSelectionVisible={activeSelectionVisible}
          inactiveSelectionVisible={inactiveSelectionVisible}
          referenceMarkReviewKeyword={referenceMarkReviewKeyword}
          referenceMarkReviewActiveIndex={referenceMarkReviewActiveIndex}
          referenceMarkIssueLocations={referenceMarkIssueLocations}
          referenceMarkIssueActiveLocationId={referenceMarkIssueActiveLocationId}
          referenceMarkLocatorEnabled={referenceMarkLocatorEnabled}
          referenceMarkBookKind={bookKind}
          referenceMarks={referenceMarks}
          activeReferenceMarkId={activeReferenceMarkId}
          recentReferenceMarkId={recentReferenceMarkId}
          onReferenceMarkActivate={onReferenceMarkActivate}
          extensionFactory={extensionFactory}
          toTiptap={converters.toTiptap}
          fromTiptap={converters.fromTiptap}
          getAssetDescriptors={() => assetSnapshot.current}
          {...(sessionId
            ? {
                importImage: (image: {
                  originalName: string;
                  mediaType: string;
                  bytes: Uint8Array<ArrayBuffer>;
                }) =>
                  window.patentApi.assets.importBytes({
                    sessionId,
                    originalName: image.originalName,
                    declaredMediaType: image.mediaType || null,
                    bytes: image.bytes,
                  }),
                importImages: (
                  images: {
                    originalName: string;
                    mediaType: string;
                    bytes: Uint8Array<ArrayBuffer>;
                  }[],
                  operationId: string,
                ) =>
                  window.patentApi.assets.importMany({
                    sessionId,
                    operationId,
                    images: images.map((image) => ({
                      originalName: image.originalName,
                      declaredMediaType: image.mediaType || null,
                      bytes: image.bytes,
                    })),
                  }),
                addImageAsset: (
                  currentDocument: PatentBookDocument,
                  descriptor: AssetDescriptor,
                ) => {
                  if (
                    !assetSnapshot.current.some((asset) => asset.assetId === descriptor.assetId)
                  ) {
                    assetSnapshot.current = [...assetSnapshot.current, structuredClone(descriptor)];
                  }
                  return currentDocument;
                },
              }
            : {})}
          onDocumentChange={(updatedDocument) =>
            onDocumentChange(updatedDocument, structuredClone(assetSnapshot.current))
          }
          {...textCountProps}
          {...(onFindModeChange ? { onFindModeChange } : {})}
          {...(saveState ? { saveState } : {})}
          {...(onRetrySave ? { onRetrySave } : {})}
          {...(onInsertFormulaDrawing ? { onInsertFormulaDrawing } : {})}
          key={`${editorId}:${bookKind}:${automation.epoch}`}
        />
      </div>
    </div>
  );
}
