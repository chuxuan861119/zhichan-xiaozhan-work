import type { Command } from "@tiptap/core";
import { Fragment, type NodeType, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { AllSelection, type EditorState, type Selection, TextSelection } from "@tiptap/pm/state";
import { randomUuid } from "../../../../shared/id";

function overlaps(selection: Selection, from: number, to: number): boolean {
  return selection.empty
    ? selection.from >= from && selection.from <= to
    : selection.from < to && selection.to > from;
}

type SelectedBlock = { node: ProseMirrorNode; pos: number; items?: number[] };

function selectedBlocks(state: Pick<EditorState, "doc" | "selection">): SelectedBlock[] | null {
  const { doc, selection } = state;
  if (!(selection instanceof TextSelection || selection instanceof AllSelection)) return null;
  const result: SelectedBlock[] = [];
  let unsupported = false;
  doc.forEach((node, pos) => {
    if (!overlaps(selection, pos + 1, pos + node.nodeSize - 1)) return;
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      result.push({ node, pos });
    } else if (node.type.name === "bulletList" || node.type.name === "orderedList") {
      const items: number[] = [];
      node.forEach((item, offset, index) => {
        let selected = false;
        item.forEach((paragraph, paragraphOffset) => {
          const start = pos + offset + paragraphOffset + 3;
          if (overlaps(selection, start, start + paragraph.content.size)) selected = true;
        });
        if (selected) items.push(index);
      });
      if (items.length) result.push({ node, pos, items });
    } else {
      unsupported = true;
    }
  });
  // The trailing paragraph is an editing exit, not an extra item in a bulk type change.
  const last = result.at(-1);
  if (
    selection instanceof AllSelection &&
    last?.node.type.name === "paragraph" &&
    last.node.content.size === 0 &&
    last.node === doc.lastChild &&
    result.at(-2)?.items
  )
    result.pop();
  return unsupported || !result.length ? null : result;
}

export function canToggleFlatList(state: Pick<EditorState, "doc" | "selection">): boolean {
  return selectedBlocks(state) !== null;
}

// Flat lists are top-level blocks; unsupported containers must fail before changing any attributes.
export function toggleFlatList(
  listTypeOrName: string | NodeType,
  itemTypeOrName: string | NodeType,
  attributes?: Record<string, unknown>,
  liftOnly = false,
): Command {
  return ({ tr, state, dispatch }) => {
    const listType =
      typeof listTypeOrName === "string" ? state.schema.nodes[listTypeOrName] : listTypeOrName;
    const itemType =
      typeof itemTypeOrName === "string" ? state.schema.nodes[itemTypeOrName] : itemTypeOrName;
    const paragraphType = state.schema.nodes.paragraph;
    if (
      !listType ||
      !itemType ||
      !paragraphType ||
      !["bulletList", "orderedList"].includes(listType.name)
    )
      return false;
    const blocks = selectedBlocks(tr);
    if (!blocks || (liftOnly && blocks.some((block) => !block.items))) return false;
    const meaningful = blocks.filter((block) => block.items || block.node.content.size > 0);
    const remove =
      liftOnly ||
      (meaningful.length > 0 && meaningful.every((block) => block.node.type === listType));
    // Splitting an ordered list must not produce an invalid canonical start.
    if (
      blocks.some(({ node, items }) => {
        const last = items?.at(-1);
        return (
          last !== undefined &&
          node.type.name === "orderedList" &&
          Number(node.attrs.start ?? 1) + last + 1 > 1_000_000 &&
          last < node.childCount - 1
        );
      })
    )
      return false;
    if (!dispatch) return true;

    const oldSelection = tr.selection;
    const endpoints = [oldSelection.$anchor, oldSelection.$head].map((position) => ({
      id: position.parent.attrs.nodeId as string | undefined,
      offset: position.parentOffset,
    }));
    const replacement: ProseMirrorNode[] = [];
    const changedLists = new Set<ProseMirrorNode>();
    const flexibleStarts = new Set<ProseMirrorNode>();
    const markChanged = (node: ProseMirrorNode) => {
      changedLists.add(node);
      if (attributes?.start === undefined) flexibleStarts.add(node);
      return node;
    };
    const joinLists = (left: ProseMirrorNode, right: ProseMirrorNode): ProseMirrorNode | null => {
      if (
        left.type !== listType ||
        right.type !== listType ||
        (!changedLists.has(left) && !changedLists.has(right))
      )
        return null;
      let start = Number(left.attrs.start ?? 1);
      if (listType.name === "orderedList" && !flexibleStarts.has(right)) {
        const rightStart = Number(right.attrs.start ?? 1);
        if (flexibleStarts.has(left) && rightStart > left.childCount) {
          start = rightStart - left.childCount;
        } else if (rightStart !== start + left.childCount) {
          return null;
        }
      }
      const joined = left.type.create(
        { ...left.attrs, ...(listType.name === "orderedList" ? { start } : {}) },
        left.content.append(right.content),
        left.marks,
      );
      changedLists.add(joined);
      if (flexibleStarts.has(left) && flexibleStarts.has(right)) flexibleStarts.add(joined);
      return joined;
    };
    let pending: ProseMirrorNode[] = [];
    const flush = () => {
      if (!pending.length) return;
      replacement.push(
        markChanged(listType.create({ ...attributes, nodeId: randomUuid() }, pending)),
      );
      pending = [];
    };
    for (const { node, items } of blocks) {
      if (!items) {
        if (remove) {
          flush();
          replacement.push(node);
        } else {
          const paragraph = paragraphType.create(node.attrs, node.content, node.marks);
          pending.push(itemType.create({ nodeId: randomUuid() }, paragraph));
        }
        continue;
      }
      flush();
      const first = items[0];
      const last = items.at(-1);
      if (first === undefined || last === undefined) return false;
      let retainedId = false;
      const listFragment = (from: number, to: number, type: NodeType) => {
        if (from === to) return;
        const children = Array.from({ length: to - from }, (_, index) => node.child(from + index));
        const attrs = {
          ...node.attrs,
          ...(type === listType && node.type !== listType ? attributes : {}),
          nodeId: retainedId ? randomUuid() : node.attrs.nodeId,
          ...(type.name === "orderedList"
            ? {
                start:
                  node.type === type
                    ? Number(node.attrs.start ?? 1) + from
                    : (attributes?.start ?? 1),
              }
            : {}),
        };
        retainedId = true;
        const fragment = type.create(attrs, children, node.marks);
        replacement.push(
          type === listType && node.type !== listType ? markChanged(fragment) : fragment,
        );
      };
      listFragment(0, first, node.type);
      if (remove) {
        for (let index = first; index <= last; index++) {
          node.child(index).forEach((paragraph) => {
            replacement.push(paragraph);
          });
        }
      } else {
        listFragment(first, last + 1, listType);
      }
      listFragment(last + 1, node.childCount, node.type);
    }
    flush();
    const firstBlock = blocks[0];
    const lastBlock = blocks.at(-1);
    if (!firstBlock || !lastBlock) return false;
    const joined: ProseMirrorNode[] = [];
    for (const node of replacement) {
      const previous = joined.at(-1);
      const merged = previous ? joinLists(previous, node) : null;
      if (merged) joined[joined.length - 1] = merged;
      else joined.push(node);
    }
    let from = firstBlock.pos;
    let to = lastBlock.pos + lastBlock.node.nodeSize;
    const before = tr.doc.resolve(from).nodeBefore;
    const first = joined[0];
    const mergedBefore = before && first ? joinLists(before, first) : null;
    if (mergedBefore && before) {
      joined[0] = mergedBefore;
      from -= before.nodeSize;
    }
    const after = tr.doc.resolve(to).nodeAfter;
    const last = joined.at(-1);
    const mergedAfter = last && after ? joinLists(last, after) : null;
    if (mergedAfter && after) {
      joined[joined.length - 1] = mergedAfter;
      to += after.nodeSize;
    }
    tr.replaceWith(from, to, Fragment.fromArray(joined));
    if (oldSelection instanceof AllSelection) {
      tr.setSelection(new AllSelection(tr.doc));
    } else {
      const positions = endpoints.map(({ id, offset }) => {
        let result: number | undefined;
        if (id)
          tr.doc.descendants((node, pos) => {
            if (node.isTextblock && node.attrs.nodeId === id)
              result = pos + 1 + Math.min(offset, node.content.size);
          });
        return result;
      });
      if (positions[0] !== undefined && positions[1] !== undefined) {
        tr.setSelection(TextSelection.create(tr.doc, positions[0], positions[1]));
      }
    }
    tr.scrollIntoView();
    return true;
  };
}
