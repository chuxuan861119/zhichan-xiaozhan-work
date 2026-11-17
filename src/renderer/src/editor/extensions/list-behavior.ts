import { Extension, getTextBetween, getTextSerializersFromSchema } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { toggleFlatList } from "./flat-list-commands";

export const ListBehavior = Extension.create({
  name: "listBehavior",
  priority: 1000,
  addExtensions() {
    // Commands are merged in extension order, so override the core command last.
    return [
      Extension.create({
        name: "flatListCommands",
        priority: 1,
        addCommands() {
          return {
            sinkListItem: () => () => false,
            toggleList: (listType, itemType, _keepMarks, attributes) =>
              toggleFlatList(listType, itemType, attributes),
            liftListItem:
              (itemType) =>
              ({ tr, ...props }) => {
                const type = tr.selection.$from.node(1)?.type;
                return type
                  ? toggleFlatList(type, itemType, undefined, true)({ tr, ...props })
                  : false;
              },
          };
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    return { Tab: () => this.editor.isActive("listItem") };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          transformCopied: (slice) => {
            const originals = new Map<string, ProseMirrorNode>();
            this.editor.state.doc.forEach((node) => {
              if (node.type.name === "orderedList") originals.set(node.attrs.nodeId, node);
            });
            const transform = (fragment: Fragment): Fragment => {
              const nodes: ProseMirrorNode[] = [];
              fragment.forEach((node) => {
                let attrs = node.attrs;
                const original = originals.get(node.attrs.nodeId);
                const firstItem = node.firstChild;
                if (node.type.name === "orderedList" && original && firstItem) {
                  original.forEach((item, _offset, index) => {
                    if (item.attrs.nodeId === firstItem.attrs.nodeId)
                      attrs = { ...attrs, start: Number(original.attrs.start ?? 1) + index };
                  });
                }
                nodes.push(
                  node.isLeaf ? node : node.type.create(attrs, transform(node.content), node.marks),
                );
              });
              return Fragment.fromArray(nodes);
            };
            return new Slice(transform(slice.content), slice.openStart, slice.openEnd);
          },
          clipboardTextSerializer: () => {
            const { doc, selection, schema } = this.editor.state;
            const textSerializers = getTextSerializersFromSchema(schema);
            return [...selection.ranges]
              .sort((a, b) => a.$from.pos - b.$from.pos)
              .map(({ $from, $to }) => {
                let hasList = false;
                doc.nodesBetween($from.pos, $to.pos, (n) => {
                  if (n.type.name === "listItem") hasList = true;
                });
                if (!hasList)
                  return getTextBetween(doc, { from: $from.pos, to: $to.pos }, { textSerializers });
                const lines: string[] = [];
                doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
                  if (!node.isTextblock) return;
                  const from = Math.max(0, $from.pos - pos - 1);
                  const to = Math.min(node.content.size, $to.pos - pos - 1);
                  if (to < from) return false;
                  let prefix = "";
                  const resolved = doc.resolve(pos);
                  if (
                    resolved.parent.type.name === "listItem" &&
                    resolved.index() === 0 &&
                    $from.pos <= pos + 1
                  ) {
                    const list = resolved.node(resolved.depth - 1);
                    prefix =
                      list.type.name === "orderedList"
                        ? `${Number(list.attrs.start ?? 1) + resolved.index(resolved.depth - 1)}. `
                        : "• ";
                  }
                  lines.push(prefix + getTextBetween(node, { from, to }, { textSerializers }));
                  return false;
                });
                return lines.join("\n");
              })
              .join("\n\n");
          },
        },
      }),
    ];
  },
});
