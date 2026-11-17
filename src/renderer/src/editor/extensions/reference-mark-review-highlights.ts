import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { cutsProtectedKeyword } from "../../../../shared/patent/reference-mark-text";
import { findLiteralMatches, type TextMatch } from "../find-replace";

type ReviewHighlightState = {
  query: string;
  activeIndex: number | null;
  matches: TextMatch[];
  decorations: DecorationSet;
  options: ReviewHighlightOptions;
};

export type ReviewHighlightOptions = Readonly<{
  protectedSearches?: readonly string[];
  excludedNodeIds?: readonly string[];
}>;

type ReviewHighlightMeta = {
  query: string;
  activeIndex: number | null;
  options: ReviewHighlightOptions;
};

const referenceMarkReviewHighlightKey = new PluginKey<ReviewHighlightState>(
  "referenceMarkReviewHighlights",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function exactMatches(
  document: ProseMirrorNode,
  query: string,
  options: ReviewHighlightOptions,
): TextMatch[] {
  if (!query) return [];
  const matches = findLiteralMatches(document, escapeRegExp(query), {
    caseSensitive: true,
    searchMode: "regex",
  });
  const protectedRanges = (options.protectedSearches ?? []).flatMap((search) =>
    search
      ? findLiteralMatches(document, escapeRegExp(search), {
          caseSensitive: true,
          searchMode: "regex",
        })
      : [],
  );
  const excludedNodeIds = new Set(options.excludedNodeIds ?? []);
  return matches.filter((match) => {
    if (
      protectedRanges.some((range) =>
        cutsProtectedKeyword(match.from, match.to, range.from, range.to),
      )
    )
      return false;
    if (excludedNodeIds.size === 0) return true;
    const resolved = document.resolve(match.from);
    for (let depth = resolved.depth; depth >= 0; depth -= 1) {
      const nodeId = resolved.node(depth).attrs.nodeId;
      if (typeof nodeId === "string" && excludedNodeIds.has(nodeId)) return false;
    }
    return true;
  });
}

function createState(
  document: ProseMirrorNode,
  query: string,
  activeIndex: number | null,
  options: ReviewHighlightOptions = {},
): ReviewHighlightState {
  const matches = exactMatches(document, query, options);
  const normalizedActiveIndex =
    activeIndex !== null && activeIndex >= 0 && activeIndex < matches.length ? activeIndex : null;
  return {
    query,
    activeIndex: normalizedActiveIndex,
    matches,
    options,
    decorations: DecorationSet.create(
      document,
      matches.map((match, index) => {
        const active = index === normalizedActiveIndex;
        return Decoration.inline(match.from, match.to, {
          class: `reference-mark-review-match${active ? " is-active" : ""}`,
          ...(active ? { "data-reference-mark-review-active": "true" } : {}),
        });
      }),
    ),
  };
}

export const ReferenceMarkReviewHighlights = Extension.create({
  name: "referenceMarkReviewHighlights",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: referenceMarkReviewHighlightKey,
        state: {
          init: (_, state) => createState(state.doc, "", null, {}),
          apply(transaction, previous) {
            const meta = transaction.getMeta(referenceMarkReviewHighlightKey) as
              | ReviewHighlightMeta
              | undefined;
            if (!meta && !transaction.docChanged) return previous;
            return createState(
              transaction.doc,
              meta?.query ?? previous.query,
              meta ? meta.activeIndex : previous.activeIndex,
              meta?.options ?? previous.options,
            );
          },
        },
        props: {
          decorations(state) {
            return (
              referenceMarkReviewHighlightKey.getState(state)?.decorations ?? DecorationSet.empty
            );
          },
        },
      }),
    ];
  },
});

export function setReferenceMarkReviewHighlights(
  editor: Editor,
  query: string | null,
  activeIndex: number | null = null,
  options: ReviewHighlightOptions = {},
): void {
  if (editor.isDestroyed) return;
  const current = referenceMarkReviewHighlightKey.getState(editor.state);
  const normalizedQuery = query ?? "";
  const normalizedOptions = {
    protectedSearches: [...(options.protectedSearches ?? [])],
    excludedNodeIds: [...(options.excludedNodeIds ?? [])],
  };
  if (
    current?.query === normalizedQuery &&
    current.activeIndex === activeIndex &&
    JSON.stringify(current.options) === JSON.stringify(normalizedOptions)
  )
    return;
  editor.view.dispatch(
    editor.state.tr.setMeta(referenceMarkReviewHighlightKey, {
      query: normalizedQuery,
      activeIndex,
      options: normalizedOptions,
    } satisfies ReviewHighlightMeta),
  );
}

export function referenceMarkReviewMatchCount(editor: Editor): number {
  return referenceMarkReviewHighlightKey.getState(editor.state)?.matches.length ?? 0;
}
