import { mergeAttributes, Node } from "@tiptap/core";
import { type NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetPreviewLoader } from "./figure-node";

export type ChemicalStructureEditRequest = {
  nodeId: string;
  ketSource: string;
  editorMode?: "molecule" | "macromolecule";
  position: number;
};

export function clampChemicalStructureWidth(widthMm: number): number {
  return Math.min(165, Math.max(10, widthMm));
}

type ChemicalStructureNodeViewProps = NodeViewProps & {
  sessionId: string;
  onEdit: ((request: ChemicalStructureEditRequest) => void) | undefined;
  loadAssetPreview?: AssetPreviewLoader;
  readOnly?: boolean;
};

export function ChemicalStructureNodeView({
  node,
  editor,
  selected,
  getPos,
  sessionId,
  onEdit,
  loadAssetPreview,
  HTMLAttributes,
  readOnly = false,
}: ChemicalStructureNodeViewProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "error">("loading");
  const retryPreviewRef = useRef<() => void>(() => undefined);
  const assetId = String(node.attrs.previewAssetId);

  const retryPreview = useCallback(() => retryPreviewRef.current(), []);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    const loadPreview = () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
      setPreviewUrl(null);
      setPreviewState("loading");
      const sourceRevision =
        typeof node.attrs.snapshotSourceRevision === "number"
          ? node.attrs.snapshotSourceRevision
          : undefined;
      const request = loadAssetPreview
        ? loadAssetPreview(assetId, sourceRevision)
        : window.patentApi.assets.getPreview(sessionId, assetId);
      void request
        .then((result) => {
          if (!active) return;
          if (!result.ok) {
            setPreviewState("error");
            return;
          }
          const bytes = Uint8Array.from(result.value);
          objectUrl = URL.createObjectURL(
            new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" }),
          );
          setPreviewUrl(objectUrl);
          setPreviewState("ready");
        })
        .catch(() => {
          if (active) setPreviewState("error");
        });
    };
    retryPreviewRef.current = loadPreview;
    loadPreview();
    return () => {
      active = false;
      retryPreviewRef.current = () => undefined;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, loadAssetPreview, node.attrs.snapshotSourceRevision, sessionId]);

  const alignment = node.attrs.alignment as "left" | "center" | "right";
  const widthMm = clampChemicalStructureWidth(Number(node.attrs.widthMm));
  const snapshotAttributes = node.attrs.snapshotChangeId
    ? {
        "data-snapshot-change-id": String(node.attrs.snapshotChangeId),
        "data-snapshot-change-kind": String(node.attrs.snapshotChangeKind),
        "aria-label": HTMLAttributes["aria-label"],
        tabIndex: 0,
      }
    : {};
  const select = () => {
    if (readOnly) return;
    const position = getPos();
    if (typeof position === "number") editor.commands.setNodeSelection(position);
  };
  const requestEdit = () => {
    if (readOnly) return;
    const position = getPos();
    if (typeof position !== "number") return;
    onEdit?.({
      nodeId: String(node.attrs.nodeId),
      ketSource: String(node.attrs.ketSource),
      editorMode: node.attrs.editorMode === "macromolecule" ? "macromolecule" : "molecule",
      position,
    });
  };

  return (
    <NodeViewWrapper
      {...snapshotAttributes}
      className={`chemical-structure align-${alignment}${selected ? " is-selected" : ""}`}
      data-drag-handle
      contentEditable={false}
      onClick={select}
      onDoubleClick={requestEdit}
    >
      {previewUrl && previewState === "ready" ? (
        <img src={previewUrl} alt="化学结构式" style={{ width: `${widthMm}mm` }} />
      ) : previewState === "error" ? (
        <div className="chemical-structure-preview-error" style={{ width: `${widthMm}mm` }}>
          <span>结构式预览加载失败。</span>
          <button type="button" onClick={retryPreview}>
            重试
          </button>
        </div>
      ) : (
        <div className="chemical-structure-preview-loading" style={{ width: `${widthMm}mm` }}>
          正在载入结构式预览…
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const ChemicalStructure = Node.create<{
  sessionId: string;
  onEdit?: (request: ChemicalStructureEditRequest) => void;
  loadAssetPreview?: AssetPreviewLoader;
  readOnly: boolean;
}>({
  name: "chemicalStructure",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { sessionId: "", readOnly: false };
  },

  addAttributes() {
    return {
      nodeId: {
        default: null,
        renderHTML: () => ({}),
      },
      ketSource: { default: null, renderHTML: () => ({}) },
      editorMode: {
        default: "molecule",
        renderHTML: () => ({}),
      },
      previewAssetId: {
        default: null,
        renderHTML: () => ({}),
      },
      widthMm: {
        default: 80,
        renderHTML: () => ({}),
      },
      alignment: {
        default: "center",
        renderHTML: () => ({}),
      },
    };
  },

  renderHTML({ node }) {
    return [
      "figure",
      mergeAttributes({
        "data-chemical-structure-node-id": node.attrs.nodeId,
        "data-chemical-structure-preview-id": node.attrs.previewAssetId,
        "data-chemical-structure-width-mm": node.attrs.widthMm,
        "data-chemical-structure-alignment": node.attrs.alignment,
        class: "chemical-structure",
      }),
    ];
  },

  addNodeView() {
    const { sessionId, onEdit, loadAssetPreview, readOnly } = this.options;
    return ReactNodeViewRenderer((props) => (
      <ChemicalStructureNodeView
        {...props}
        sessionId={sessionId}
        onEdit={onEdit}
        {...(loadAssetPreview ? { loadAssetPreview } : {})}
        readOnly={readOnly}
      />
    ));
  },
});
