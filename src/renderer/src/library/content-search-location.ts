import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { ContentSearchLocation } from "../../../shared/library/content-search";
import { contentSearchText } from "../../../shared/library/content-search-text";
import { prefersReducedMotion as isMotionReduced } from "../shared/motion-preference";

type SearchMatch = {
  from: number;
  to: number;
  annotation?: { kind: "name" | "note"; from: number; to: number };
};

let cached:
  | {
      doc: ProseMirrorNode;
      indexed: ReturnType<typeof contentSearchText.collect>;
      positions: number[];
    }
  | undefined;

function indexDocument(doc: ProseMirrorNode) {
  if (cached?.doc === doc) return cached;
  const indexed = contentSearchText.collect(doc.toJSON());
  const textPositions: number[] = [];
  const tables = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (
      ["inlineMath", "blockMath", "figure", "inlineFigure", "chemicalStructure"].includes(
        node.type.name,
      )
    )
      return false;
    if (node.type.name === "table") tables.set(node.attrs.nodeId, pos);
    if (node.isText) textPositions.push(pos);
    return true;
  });
  let textIndex = 0;
  const positions = indexed.spans.map((span) =>
    span.annotation ? (tables.get(span.nodeId ?? "") ?? -1) : (textPositions[textIndex++] ?? -1),
  );
  cached = { doc, indexed, positions };
  return cached;
}

function spanAt(spans: ReturnType<typeof contentSearchText.collect>["spans"], offset: number) {
  let low = 0,
    high = spans.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (spans[mid]!.end <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

function commonSuffix(left: string, right: string): number {
  let count = 0;
  while (
    count < left.length &&
    count < right.length &&
    left.at(-count - 1) === right.at(-count - 1)
  )
    count++;
  return count;
}

function commonPrefix(left: string, right: string): number {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count++;
  return count;
}

export function resolveContentSearchMatch(
  doc: ProseMirrorNode,
  query: string,
  snippet?: string,
  location?: ContentSearchLocation,
): SearchMatch | undefined {
  const { indexed, positions } = indexDocument(doc);
  const matches = [...contentSearchText.matches(indexed.text, query)];
  if (!matches.length) return;
  const at =
    location?.queryOffset ??
    (snippet ? contentSearchText.matches(snippet, query).next().value?.from : undefined) ??
    -1;
  const before = snippet && at >= 0 ? snippet.slice(0, at).toLowerCase() : "";
  const after = snippet && at >= 0 ? snippet.slice(at + query.length).toLowerCase() : "";
  const mapMatch = (match: (typeof matches)[number]): SearchMatch | undefined => {
    const start = spanAt(indexed.spans, match.from);
    const end = spanAt(indexed.spans, match.to - 1);
    const span = indexed.spans[start];
    const endSpan = indexed.spans[end];
    const position = positions[start];
    if (!span || !endSpan || position === undefined || position < 0) return;
    if (span.annotation)
      return {
        from: position,
        to: position + 1,
        annotation: {
          kind: span.annotation,
          from: match.from - span.start,
          to: match.to - span.start,
        },
      };
    return {
      from: position + match.from - span.start,
      to: positions[end]! + match.to - endSpan.start,
    };
  };
  const sameBlock = location?.nodeId
    ? matches.filter((match) => {
        const span = indexed.spans[spanAt(indexed.spans, match.from)];
        return span?.nodeId === location.nodeId && span?.annotation === location.annotation;
      })
    : [];
  if (location?.nodeId && location.textOffset !== undefined) {
    const exact = sameBlock.find((match) => {
      const span = indexed.spans[spanAt(indexed.spans, match.from)];
      if (!span) return false;
      return (
        span?.nodeId === location.nodeId &&
        span.annotation === location.annotation &&
        span.textOffset + match.from - span.start === location.textOffset
      );
    });
    if (exact) {
      const localBefore = before.split("\n").at(-1) ?? "";
      const localAfter = after.split("\n")[0] ?? "";
      const left = indexed.text
        .slice(Math.max(0, exact.from - before.length), exact.from)
        .replaceAll("\u0000", "\n")
        .toLowerCase();
      const right = indexed.text
        .slice(exact.to, exact.to + after.length)
        .replaceAll("\u0000", "\n")
        .toLowerCase();
      if (!snippet || (left.endsWith(localBefore) && right.startsWith(localAfter)))
        return mapMatch(exact);
    }
  }
  const ordinalMatch = matches[location?.occurrence ?? 0];
  if (!snippet || at < 0) {
    if (location?.nodeId) return sameBlock.length === 1 ? mapMatch(sameBlock[0]!) : undefined;
    return mapMatch(ordinalMatch ?? matches[0]!);
  }
  const text = indexed.text.replaceAll("\u0000", "\n");
  const localBefore = before.split("\n").at(-1) ?? "";
  const localAfter = after.split("\n")[0] ?? "";
  const identities = new Set(sameBlock);
  // Context is primary (a split can move the passage to another node). Stable
  // identity breaks ties, never an old global ordinal for identity-backed hits.
  const context = (match: (typeof matches)[number]) => {
    const left = commonSuffix(
      before,
      text.slice(Math.max(0, match.from - before.length), match.from).toLowerCase(),
    );
    const right = commonPrefix(after, text.slice(match.to, match.to + after.length).toLowerCase());
    return { left, right, score: left + right };
  };
  let best = ordinalMatch ?? matches[0]!;
  let bestContext = context(best);
  let ambiguous = false;
  for (const match of matches) {
    if (match === best) continue;
    const current = context(match);
    const betterIdentity = identities.has(match) && !identities.has(best);
    if (
      current.score > bestContext.score ||
      (current.score === bestContext.score && betterIdentity)
    ) {
      best = match;
      bestContext = current;
      ambiguous = false;
    } else if (
      current.score === bestContext.score &&
      identities.has(match) === identities.has(best)
    ) {
      ambiguous = true;
    }
  }
  if (location?.nodeId && ambiguous) return;
  // A shared punctuation mark or one-character suffix is not enough to relocate
  // a deleted passage. Require meaningful context, even for a sole remaining hit.
  const meaningful = (value: string) => value.replace(/[^\p{L}\p{N}]/gu, "").length;
  const available = meaningful(before + after);
  const matched = meaningful(
    before.slice(before.length - bestContext.left) + after.slice(0, bestContext.right),
  );
  if (matched < Math.min(4, available)) return;
  if (localBefore || localAfter) {
    if (
      !(localBefore && bestContext.left >= localBefore.length) &&
      !(localAfter && bestContext.right >= localAfter.length)
    )
      return;
  } else if (location?.nodeId && !identities.has(best)) return;
  if (!available && !identities.has(best) && location?.nodeId) return;
  return mapMatch(best);
}

/** Attribute-backed table text is outside ProseMirror; use its existing editor without changing data. */
export function selectContentSearchAnnotation(editor: Editor, match: SearchMatch): boolean {
  if (!match.annotation) return false;
  const dom = editor.view.nodeDOM(match.from);
  if (!(dom instanceof HTMLElement)) return false;
  const root = dom.querySelector<HTMLElement>(`.table-annotation--${match.annotation.kind}`);
  const input = root?.querySelector<HTMLTextAreaElement>(".table-annotation__input");
  if (!root || root.hidden || !input) return false;
  root.classList.add("is-editing");
  input.style.height = "auto";
  input.style.height = `${Math.max(input.scrollHeight, 24)}px`;
  input.focus({ preventScroll: true });
  input.setSelectionRange(match.annotation.from, match.annotation.to);
  root.scrollIntoView({ behavior: isMotionReduced() ? "auto" : "smooth", block: "center" });
  return true;
}
