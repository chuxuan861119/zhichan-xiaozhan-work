import { type Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { TextMatch } from "../find-replace";

type HighlightState = {
  matches: TextMatch[];
  active: TextMatch | null;
};

type StoredHighlights = HighlightState & { decorations: DecorationSet; mapped?: true };
const findReplaceHighlightKey = new PluginKey<StoredHighlights>("findReplaceHighlights");

function highlight(doc: import("@tiptap/pm/model").Node, match: TextMatch, active: boolean) {
  const className = `find-replace-match${active ? " is-active" : ""}`;
  const node = doc.nodeAt(match.from);
  return node?.isAtom && match.to === match.from + node.nodeSize
    ? Decoration.node(match.from, match.to, { class: className })
    : Decoration.inline(match.from, match.to, { class: className });
}

function sameMatch(left: TextMatch | null, right: TextMatch | null) {
  return left?.from === right?.from && left?.to === right?.to;
}

export const FindReplaceHighlights = Extension.create({
  name: "findReplaceHighlights",

  addProseMirrorPlugins() {
    return [
      new Plugin<StoredHighlights>({
        key: findReplaceHighlightKey,
        state: {
          init: () => ({ matches: [], active: null, decorations: DecorationSet.empty }),
          apply(transaction, current) {
            const next = transaction.getMeta(findReplaceHighlightKey) as HighlightState | undefined;
            if (!next)
              return transaction.docChanged
                ? {
                    matches: [],
                    active: null,
                    mapped: true,
                    decorations: current.decorations.map(transaction.mapping, transaction.doc),
                  }
                : current;
            if (
              !current.mapped &&
              !transaction.docChanged &&
              (next.matches === current.matches ||
                (next.matches.length === current.matches.length &&
                  next.matches.every((match, index) => sameMatch(match, current.matches[index]!))))
            ) {
              if (sameMatch(current.active, next.active)) return current;
              let decorations = current.decorations;
              for (const match of [current.active, next.active]) {
                if (!match) continue;
                decorations = decorations.remove(
                  decorations
                    .find(match.from, match.to)
                    .filter((item) => item.from === match.from && item.to === match.to),
                );
                decorations = decorations.add(transaction.doc, [
                  highlight(transaction.doc, match, sameMatch(match, next.active)),
                ]);
              }
              return { ...next, decorations };
            }
            return {
              ...next,
              decorations: DecorationSet.create(
                transaction.doc,
                next.matches.map((match) =>
                  highlight(transaction.doc, match, sameMatch(match, next.active)),
                ),
              ),
            };
          },
        },
        props: {
          decorations(state) {
            return findReplaceHighlightKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export function setFindReplaceHighlights(
  editor: Editor,
  matches: TextMatch[],
  active: TextMatch | null,
): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(findReplaceHighlightKey, { matches, active }));
}
