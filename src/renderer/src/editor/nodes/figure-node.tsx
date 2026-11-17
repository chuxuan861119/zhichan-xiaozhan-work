import { mergeAttributes, Node } from "@tiptap/core";
import { type NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppResult } from "../../../../shared/ipc/result";
import { ImageSelectionFrame } from "../image/image-selection-frame";
import { clampImageWidth } from "../image/image-transform";
import { useImageRotation } from "../image/use-image-rotation";

export type AssetPreviewLoader = (
  assetId: string,
  sourceRevision?: number,
) => Promise<AppResult<Uint8Array>>;

export const clampFigureWidth = clampImageWidth;

type FigureNodeViewProps = NodeViewProps & {
  sessionId: string;
  loadAssetPreview: AssetPreviewLoader | undefined;
  readOnly?: boolean;
  inline?: boolean;
};

export function FigureNodeView({
  node,
  editor,
  selected,
  updateAttributes,
  deleteNode,
  getPos,
  sessionId,
  loadAssetPreview,
  HTMLAttributes,
  readOnly = false,
  inline = false,
}: FigureNodeViewProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const sourceAspectRatio = Number(node.attrs.sourceAspectRatio);
  const [originalAspectRatio, setOriginalAspectRatio] = useState(() =>
    Number.isFinite(sourceAspectRatio) && sourceAspectRatio > 0 ? sourceAspectRatio : 1,
  );
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "error">("loading");
  const retryPreviewRef = useRef<() => void>(() => undefined);
  const assetId = String(node.attrs.assetId);
  const retryPreview = useCallback(() => retryPreviewRef.current(), []);

  useEffect(() => {
    if (Number.isFinite(sourceAspectRatio) && sourceAspectRatio > 0) {
      setOriginalAspectRatio(sourceAspectRatio);
    }
  }, [sourceAspectRatio]);

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
          const previewBytes = Uint8Array.from(result.value);
          objectUrl = URL.createObjectURL(
            new Blob([previewBytes.buffer as ArrayBuffer], { type: "image/png" }),
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
  const widthMm = clampFigureWidth(Number(node.attrs.widthMm));
  const rotationDeg = Number(node.attrs.rotationDeg ?? 0);
  const displayRotation = useImageRotation(rotationDeg, assetId);
  const quarterTurned = rotationDeg === 90 || rotationDeg === 270;
  const snapshotAttributes = node.attrs.snapshotChangeId
    ? {
        "data-snapshot-change-id": String(node.attrs.snapshotChangeId),
        "data-snapshot-change-kind": String(node.attrs.snapshotChangeKind),
        "aria-label": HTMLAttributes["aria-label"],
        tabIndex: 0,
      }
    : {};

  return (
    <NodeViewWrapper
      as={inline ? "span" : "div"}
      {...snapshotAttributes}
      className={`${inline ? "patent-inline-figure" : "patent-figure"} align-${alignment}`}
      data-drag-handle
      contentEditable={false}
      onClick={() => {
        if (readOnly) return;
        const position = getPos();
        if (typeof position === "number") editor.commands.setNodeSelection(position);
      }}
    >
      <ImageSelectionFrame
        as={inline ? "span" : "div"}
        selected={selected}
        widthMm={widthMm}
        aspectRatio={quarterTurned ? 1 / originalAspectRatio : originalAspectRatio}
        readOnly={readOnly}
        onResizeCommit={(nextWidthMm) => updateAttributes({ widthMm: nextWidthMm })}
        onDelete={deleteNode}
      >
        {previewUrl && previewState === "ready" ? (
          <img
            src={previewUrl}
            alt="专利图片"
            onLoad={(event) => {
              if (event.currentTarget.naturalHeight > 0) {
                setOriginalAspectRatio(
                  event.currentTarget.naturalWidth / event.currentTarget.naturalHeight,
                );
              }
            }}
            style={{
              transform: `translate(-50%, -50%) rotate(${displayRotation}deg)`,
              width: quarterTurned ? `${originalAspectRatio * 100}%` : "100%",
              height: quarterTurned ? `${100 / originalAspectRatio}%` : "100%",
            }}
          />
        ) : previewState === "error" ? (
          <div className="figure-preview-error">
            <span>图片预览加载失败。</span>
            <button type="button" aria-label="重试加载图片预览" onClick={retryPreview}>
              重试
            </button>
          </div>
        ) : (
          <div className="figure-preview-loading">正在载入图片…</div>
        )}
      </ImageSelectionFrame>
    </NodeViewWrapper>
  );
}

export const PatentFigure = Node.create<{
  sessionId: string;
  loadAssetPreview?: AssetPreviewLoader;
  readOnly: boolean;
}>({
  name: "figure",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { sessionId: "", readOnly: false };
  },

  addAttributes() {
    return {
      nodeId: { default: null },
      assetId: { default: null },
      widthMm: { default: 80 },
      alignment: { default: "center" },
      rotationDeg: { default: 0 },
      sourceAspectRatio: { default: 1, rendered: false },
      semanticRole: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "figure[data-patent-asset-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "figure",
      mergeAttributes(HTMLAttributes, {
        "data-patent-asset-id": HTMLAttributes.assetId,
        class: "patent-figure",
      }),
    ];
  },

  addNodeView() {
    const { sessionId, loadAssetPreview, readOnly } = this.options;
    return ReactNodeViewRenderer((props) => (
      <FigureNodeView
        {...props}
        sessionId={sessionId}
        loadAssetPreview={loadAssetPreview}
        readOnly={readOnly}
      />
    ));
  },
});
