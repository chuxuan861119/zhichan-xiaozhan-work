import type { PatentBookKind } from "../../../shared/patent/model";
import type { TextCounts } from "../editor/rich-text-editor-core";
import type { PatentBookTarget } from "./patent-workspace-layout";

const TEXT_BOOK_KINDS = new Set<PatentBookKind>(["claims", "description", "abstract"]);

export type PatentTextCountsByTarget = Readonly<Record<string, TextCounts>>;

export function patentTextCountsKey(
  target: Pick<PatentBookTarget, "patentId" | "bookKind">,
): string {
  return `${target.patentId}:${target.bookKind}`;
}

export function selectPatentTextCounts(
  byTarget: PatentTextCountsByTarget,
  target: PatentBookTarget | null,
): TextCounts | null {
  if (!target || !TEXT_BOOK_KINDS.has(target.bookKind)) return null;
  return byTarget[patentTextCountsKey(target)] ?? null;
}
