import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const CHANGE_NODE_TYPES = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "pageBreak",
  "figure",
  "inlineFigure",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "blockMath",
  "inlineMath",
  "chemicalStructure",
];

function changeAttributes(HTMLAttributes: Record<string, unknown>): Record<string, string> {
  if (!HTMLAttributes.snapshotChangeId) return {};
  const labels: Record<string, string> = {
    insert: "新增内容",
    delete: "删除内容",
    format: "格式变化",
    structure: "结构变化",
  };
  return {
    "data-snapshot-change-id": String(HTMLAttributes.snapshotChangeId),
    "data-snapshot-change-kind": String(HTMLAttributes.snapshotChangeKind),
    "aria-label":
      typeof HTMLAttributes.snapshotChangeLabel === "string"
        ? HTMLAttributes.snapshotChangeLabel
        : (labels[String(HTMLAttributes.snapshotChangeKind)] ?? "快照变化"),
    tabindex: "0",
  };
}

function snapshotMark(name: "snapshotInsertion" | "snapshotDeletion" | "snapshotFormatChange") {
  return Mark.create({
    name,
    excludes: "",
    addAttributes() {
      return {
        snapshotChangeId: { default: null },
        snapshotChangeKind: { default: null },
        snapshotChangeLabel: { default: null },
        snapshotSourceRevision: { default: null, rendered: false },
      };
    },
    parseHTML() {
      return [{ tag: `span[data-snapshot-mark="${name}"]` }];
    },
    renderHTML({ HTMLAttributes }) {
      return [
        "span",
        mergeAttributes(changeAttributes(HTMLAttributes), { "data-snapshot-mark": name }),
        0,
      ];
    },
  });
}

const SnapshotNodeChanges = Extension.create({
  name: "snapshotNodeChanges",
  addGlobalAttributes() {
    return [
      {
        types: CHANGE_NODE_TYPES,
        attributes: {
          snapshotChangeId: {
            default: null,
            renderHTML: (attributes) => changeAttributes(attributes),
          },
          snapshotChangeKind: { default: null, rendered: false },
          snapshotChangeLabel: { default: null, rendered: false },
          snapshotSourceRevision: { default: null, rendered: false },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, position) => {
              if (!node.attrs.snapshotChangeId) return;
              decorations.push(
                Decoration.node(position, position + node.nodeSize, changeAttributes(node.attrs)),
              );
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

export function createSnapshotDiffExtensions() {
  return [
    snapshotMark("snapshotInsertion"),
    snapshotMark("snapshotDeletion"),
    snapshotMark("snapshotFormatChange"),
    SnapshotNodeChanges,
  ];
}
