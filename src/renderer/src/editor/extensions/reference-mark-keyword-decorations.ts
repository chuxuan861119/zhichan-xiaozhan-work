import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { descriptionReferenceNumberSuffix } from "../../../../shared/patent/reference-mark-description-number";
import { findLiteralMatches } from "../find-replace";

export type ReferenceMarkKeywordDecoration = Readonly<{
  referenceMarkId: string;
  keyword: string;
  number: number;
}>;

export type ReferenceMarkKeywordDecorationConfig = Readonly<{
  enabled: boolean;
  bookKind: "claims" | "description" | "abstract";
  referenceMarks: readonly ReferenceMarkKeywordDecoration[];
  activeReferenceMarkId: string | null;
  recentReferenceMarkId: string | null;
}>;

export type ReferenceMarkKeywordDecorationMatch = Readonly<{
  from: number;
  to: number;
  referenceMarkId: string;
  keyword: string;
  state: "passive" | "recent" | "active";
}>;

type DecorationState = {
  config: ReferenceMarkKeywordDecorationConfig;
  matches: ReferenceMarkKeywordDecorationMatch[];
  decorations: DecorationSet;
};

const EMPTY_CONFIG: ReferenceMarkKeywordDecorationConfig = {
  enabled: false,
  bookKind: "claims",
  referenceMarks: [],
  activeReferenceMarkId: null,
  recentReferenceMarkId: null,
};

const referenceMarkKeywordDecorationKey = new PluginKey<DecorationState>(
  "referenceMarkKeywordDecorations",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function fullWidthDigits(value: number): string {
  return String(value).replace(/[0-9]/gu, (digit) =>
    String.fromCharCode("０".charCodeAt(0) + Number(digit)),
  );
}

function textblockEnd(document: ProseMirrorNode, position: number): number {
  const resolved = document.resolve(position);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    if (resolved.node(depth).isTextblock) return resolved.end(depth);
  }
  return position;
}

function extendThroughClaimsNumber(document: ProseMirrorNode, to: number, number: number): number {
  const end = textblockEnd(document, to);
  if (end <= to) return to;
  const suffix = document.textBetween(to, Math.min(end, to + 64), "", "");
  const ascii = escapeRegExp(String(number));
  const fullWidth = escapeRegExp(fullWidthDigits(number));
  const match = suffix.match(
    new RegExp(
      `^[\\t \\u3000]*(?:\\([\\t \\u3000]*(?:${ascii}|${fullWidth})[\\t \\u3000]*\\)|（[\\t \\u3000]*(?:${ascii}|${fullWidth})[\\t \\u3000]*）)`,
      "u",
    ),
  );
  return match?.[0] ? to + match[0].length : to;
}

function extendThroughDescriptionNumber(document: ProseMirrorNode, to: number): number {
  const end = textblockEnd(document, to);
  const suffix = descriptionReferenceNumberSuffix(document.textBetween(to, end, "", "\uFFFC"));
  return to + (suffix?.text.length ?? 0);
}

function findMatches(
  document: ProseMirrorNode,
  config: ReferenceMarkKeywordDecorationConfig,
): ReferenceMarkKeywordDecorationMatch[] {
  if (!config.enabled || config.referenceMarks.length === 0) return [];
  const candidates = config.referenceMarks.flatMap((mark, registrationIndex) => {
    if (!mark.keyword) return [];
    return findLiteralMatches(document, escapeRegExp(mark.keyword), {
      caseSensitive: true,
      searchMode: "regex",
    }).map((match) => ({
      from: match.from,
      to:
        config.bookKind === "claims"
          ? extendThroughClaimsNumber(document, match.to, mark.number)
          : extendThroughDescriptionNumber(document, match.to),
      referenceMarkId: mark.referenceMarkId,
      keyword: mark.keyword,
      keywordLength: Array.from(mark.keyword).length,
      registrationIndex,
    }));
  });
  candidates.sort(
    (left, right) =>
      right.keywordLength - left.keywordLength ||
      left.registrationIndex - right.registrationIndex ||
      left.from - right.from,
  );
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (selected.some((match) => candidate.from < match.to && candidate.to > match.from)) continue;
    selected.push(candidate);
  }
  selected.sort((left, right) => left.from - right.from || left.to - right.to);
  return selected.map(({ from, to, referenceMarkId, keyword }) => ({
    from,
    to,
    referenceMarkId,
    keyword,
    state:
      referenceMarkId === config.activeReferenceMarkId
        ? "active"
        : referenceMarkId === config.recentReferenceMarkId
          ? "recent"
          : "passive",
  }));
}

function createState(
  document: ProseMirrorNode,
  config: ReferenceMarkKeywordDecorationConfig,
): DecorationState {
  const matches = findMatches(document, config);
  return {
    config,
    matches,
    decorations: DecorationSet.create(
      document,
      matches.map((match) =>
        Decoration.inline(match.from, match.to, {
          class: `reference-mark-keyword-block is-${match.state}`,
          "data-reference-mark-id": match.referenceMarkId,
          "data-reference-mark-keyword": match.keyword,
          "data-reference-mark-keyword-state": match.state,
        }),
      ),
    ),
  };
}

export const ReferenceMarkKeywordDecorations = Extension.create({
  name: "referenceMarkKeywordDecorations",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: referenceMarkKeywordDecorationKey,
        state: {
          init: (_, state) => createState(state.doc, EMPTY_CONFIG),
          apply(transaction, previous) {
            const config = transaction.getMeta(referenceMarkKeywordDecorationKey) as
              | ReferenceMarkKeywordDecorationConfig
              | undefined;
            if (!config && !transaction.docChanged) return previous;
            return createState(transaction.doc, config ?? previous.config);
          },
        },
        props: {
          decorations(state) {
            return (
              referenceMarkKeywordDecorationKey.getState(state)?.decorations ?? DecorationSet.empty
            );
          },
        },
      }),
    ];
  },
});

function normalizeConfig(
  config: ReferenceMarkKeywordDecorationConfig,
): ReferenceMarkKeywordDecorationConfig {
  return {
    ...config,
    referenceMarks: config.referenceMarks.map((mark) => ({ ...mark })),
  };
}

export function setReferenceMarkKeywordDecorations(
  editor: Editor,
  config: ReferenceMarkKeywordDecorationConfig,
): void {
  if (editor.isDestroyed) return;
  const normalized = normalizeConfig(config);
  const current = referenceMarkKeywordDecorationKey.getState(editor.state)?.config;
  if (current && JSON.stringify(current) === JSON.stringify(normalized)) return;
  editor.view.dispatch(editor.state.tr.setMeta(referenceMarkKeywordDecorationKey, normalized));
}

export function referenceMarkKeywordDecorationSnapshot(
  editor: Editor,
): ReferenceMarkKeywordDecorationMatch[] {
  return [...(referenceMarkKeywordDecorationKey.getState(editor.state)?.matches ?? [])];
}
