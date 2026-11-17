import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { type AssetPreviewLoader, FigureNodeView } from "./figure-node";

export const PatentInlineFigure = Node.create<{
  sessionId: string;
  loadAssetPreview?: AssetPreviewLoader;
  readOnly: boolean;
}>({
  name: "inlineFigure",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
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
    };
  },

  parseHTML() {
    return [{ tag: "span[data-patent-inline-asset-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-patent-inline-asset-id": HTMLAttributes.assetId,
        class: "patent-inline-figure",
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
        inline
      />
    ));
  },
});
