import { DOMSerializer, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

/** Row-height previews are presentation only, not edits to reparse from the DOM. */
export function createPatentTableRowNodeView(node: ProseMirrorNode): NodeView {
  const render = (row: ProseMirrorNode): HTMLElement => {
    const toDOM = row.type.spec.toDOM;
    if (!toDOM) throw new Error("Missing table row renderer");
    return DOMSerializer.renderSpec(document, toDOM(row)).dom as HTMLElement;
  };
  const dom = render(node);
  return {
    dom,
    contentDOM: dom,
    update(nextNode) {
      if (nextNode.type !== node.type) return false;
      const rendered = render(nextNode);
      for (const attribute of [...dom.attributes]) {
        if (!rendered.hasAttribute(attribute.name)) dom.removeAttribute(attribute.name);
      }
      for (const attribute of [...rendered.attributes]) {
        if (dom.getAttribute(attribute.name) !== attribute.value)
          dom.setAttribute(attribute.name, attribute.value);
      }
      return true;
    },
    ignoreMutation(mutation) {
      return mutation.type === "attributes" && mutation.target === dom;
    },
  };
}
