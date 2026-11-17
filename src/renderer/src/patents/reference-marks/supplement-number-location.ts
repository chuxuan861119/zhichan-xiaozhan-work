import type { Editor } from "@tiptap/core";
import type { BlockNode, PatentBookDocument } from "../../../../shared/document/model";
import { prefersReducedMotion as isMotionReduced } from "../../shared/motion-preference";

function textBlocks(document: PatentBookDocument) {
  const result: Array<{ id: string; text: string }> = [];
  const visit = (block: BlockNode) => {
    if (block.type === "paragraph" || block.type === "heading") {
      result.push({
        id: block.id,
        text: block.content.map((node) => (node.type === "text" ? node.text : "\uFFFC")).join(""),
      });
    } else if (block.type === "table") {
      for (const row of block.rows) for (const cell of row.cells) cell.content.forEach(visit);
    } else if (block.type === "ordered-list" || block.type === "bullet-list") {
      for (const item of block.items) item.content.forEach(visit);
    }
  };
  document.content.forEach(visit);
  return result;
}

export function firstSupplementNumberLocation(
  before: PatentBookDocument,
  after: PatentBookDocument,
  keywords: readonly string[],
) {
  const old = new Map(textBlocks(before).map((block) => [block.id, block.text]));
  for (const block of textBlocks(after)) {
    const previous = old.get(block.id);
    if (previous === undefined || previous === block.text) continue;
    let offset = 0;
    while (offset < previous.length && previous[offset] === block.text[offset]) offset++;
    const keyword = [...keywords]
      .sort((a, b) => b.length - a.length)
      .find((word) => previous.slice(0, offset).endsWith(word));
    return {
      blockId: block.id,
      offset: Math.max(0, offset - (keyword?.length ?? 0)),
      text: block.text,
    };
  }
  return null;
}

export function scrollToSupplementNumber(
  editor: Editor,
  location: NonNullable<ReturnType<typeof firstSupplementNumberLocation>>,
): boolean {
  const workspace = editor.view.dom.closest<HTMLElement>(".editor-workspace");
  if (!workspace) return false;
  let position: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (
      node.attrs.nodeId === location.blockId &&
      node.textBetween(0, node.content.size, "", "\uFFFC") === location.text
    ) {
      position = pos + 1 + Math.min(location.offset, node.content.size);
      return false;
    }
    return true;
  });
  if (position === null) return false;
  const target = editor.view.coordsAtPos(position);
  const bounds = workspace.getBoundingClientRect();
  const reducedMotion = isMotionReduced();
  workspace.scrollBy({
    top: target.top - bounds.top - bounds.height * 0.28,
    behavior: reducedMotion ? "auto" : "smooth",
  });
  return true;
}
