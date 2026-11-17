import { Editor } from "@tiptap/core";
import { DecorationSet } from "@tiptap/pm/view";
import { createPatentExtensions } from "../extensions";
import { createPatentTableRowNodeView } from "./table-row-node-view";

function mutation(type: "attributes" | "childList", target: Node): MutationRecord {
  return {
    type,
    target,
    addedNodes: document.createDocumentFragment().childNodes,
    removedNodes: document.createDocumentFragment().childNodes,
    attributeName: type === "attributes" ? "style" : null,
    attributeNamespace: null,
    nextSibling: null,
    previousSibling: null,
    oldValue: null,
  };
}

test("row view preserves rendered attributes and only ignores its own presentation mutations", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<table><tr data-row-height-mm="20" data-row-height-rule="exact"><td>甲</td></tr></table>',
  });
  try {
    const row = editor.state.doc.firstChild?.firstChild;
    if (!row) throw new Error("Missing row");
    const nodeView = createPatentTableRowNodeView(row);
    const dom = nodeView.dom as HTMLElement;
    expect(dom.tagName).toBe("TR");
    expect(nodeView.contentDOM).toBe(dom);
    expect(dom.style.getPropertyValue("--patent-row-height")).toBe("20mm");
    expect(nodeView.ignoreMutation?.(mutation("attributes", dom))).toBe(true);
    expect(nodeView.ignoreMutation?.({ type: "selection", target: dom })).toBe(false);
    expect(nodeView.ignoreMutation?.(mutation("childList", dom))).toBe(false);
    expect(nodeView.ignoreMutation?.(mutation("attributes", document.createElement("td")))).toBe(
      false,
    );
    const next = row.type.create({ ...row.attrs, nodeId: "row-id", rowHeightMm: 30 }, row.content);
    expect(nodeView.update?.(next, [], DecorationSet.empty)).toBe(true);
    expect(dom.style.getPropertyValue("--patent-row-height")).toBe("30mm");
    expect(dom.getAttribute("data-nodeid")).toBe("row-id");
    const cleared = row.type.create(
      { ...next.attrs, rowHeightMm: null, rowHeightRule: null },
      row.content,
    );
    expect(nodeView.update?.(cleared, [], DecorationSet.empty)).toBe(true);
    expect(dom.hasAttribute("data-row-height-mm")).toBe(false);
    expect(dom.style.getPropertyValue("--patent-row-height")).toBe("");
  } finally {
    editor.destroy();
  }
});
