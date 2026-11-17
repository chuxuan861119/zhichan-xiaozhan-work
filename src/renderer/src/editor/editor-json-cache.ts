import type { JSONContent } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";

/** Private serializer for immutable ProseMirror nodes. Consumers must not mutate its output. */
export function createEditorJsonCache() {
  const cache = new WeakMap<Node, JSONContent>();
  const read = (node: Node): JSONContent => {
    const previous = cache.get(node);
    if (previous) return previous;
    const json: JSONContent = { type: node.type.name };
    if (Object.keys(node.attrs).length) json.attrs = { ...node.attrs };
    if (node.content.size) {
      const content: JSONContent[] = [];
      node.forEach((child) => {
        content.push(read(child));
      });
      json.content = content;
    }
    if (node.marks.length) json.marks = node.marks.map((mark) => mark.toJSON());
    if (node.isText) json.text = node.text ?? "";
    cache.set(node, json);
    return json;
  };
  return read;
}
