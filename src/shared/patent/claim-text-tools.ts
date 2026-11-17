export const CLAIM_NUMBER_PREFIX = /^\s*(\d+)[.．、]\s*/u;

export type ClaimTextRange = Readonly<{
  number: number;
  prefixEnd: number;
  startParagraphIndex: number;
  endParagraphIndex: number;
  lastNonEmptyParagraphIndex: number;
  paragraphTexts: readonly string[];
  text: string;
}>;

export type ClaimTextStructure = Readonly<{
  claims: readonly ClaimTextRange[];
  unnumberedPrefaceParagraphIndexes: readonly number[];
}>;

export type ClaimStructureWarning = Readonly<{
  kind: "unnumbered-preface" | "missing-ending" | "internal-full-stop" | "trailing-text";
  paragraphIndex: number;
  claimNumber: number | null;
  message: string;
}>;

export function parseClaimParagraphs(paragraphs: readonly string[]): ClaimTextStructure {
  const starts = paragraphs.flatMap((text, paragraphIndex) => {
    const match = CLAIM_NUMBER_PREFIX.exec(text);
    const number = match ? Number(match[1]) : Number.NaN;
    return match && Number.isSafeInteger(number)
      ? [{ paragraphIndex, number, prefixEnd: match[0].length }]
      : [];
  });
  const firstStart = starts[0]?.paragraphIndex ?? paragraphs.length;
  const unnumberedPrefaceParagraphIndexes = paragraphs.flatMap((text, paragraphIndex) =>
    paragraphIndex < firstStart && text.trim().length > 0 ? [paragraphIndex] : [],
  );
  const claims = starts.map((start, index): ClaimTextRange => {
    const endParagraphIndex = starts[index + 1]?.paragraphIndex ?? paragraphs.length;
    const paragraphTexts = paragraphs.slice(start.paragraphIndex, endParagraphIndex);
    let lastNonEmptyParagraphIndex = start.paragraphIndex;
    for (
      let paragraphIndex = endParagraphIndex - 1;
      paragraphIndex >= start.paragraphIndex;
      paragraphIndex -= 1
    ) {
      if ((paragraphs[paragraphIndex] ?? "").trim().length > 0) {
        lastNonEmptyParagraphIndex = paragraphIndex;
        break;
      }
    }
    return {
      number: start.number,
      prefixEnd: start.prefixEnd,
      startParagraphIndex: start.paragraphIndex,
      endParagraphIndex,
      lastNonEmptyParagraphIndex,
      paragraphTexts,
      text: paragraphTexts
        .filter((text) => text.trim().length > 0)
        .join("\n")
        .trim(),
    };
  });
  return { claims, unnumberedPrefaceParagraphIndexes };
}

export function claimStructureWarnings(structure: ClaimTextStructure): ClaimStructureWarning[] {
  const warnings: ClaimStructureWarning[] = structure.unnumberedPrefaceParagraphIndexes.map(
    (paragraphIndex) => ({
      kind: "unnumbered-preface",
      paragraphIndex,
      claimNumber: null,
      message: "权利要求书开头存在未编号内容，请补充编号或删除。",
    }),
  );
  for (const claim of structure.claims) {
    const effectiveParagraphs = claim.paragraphTexts
      .map((text, offset) => ({
        text: text.trim(),
        paragraphIndex: claim.startParagraphIndex + offset,
      }))
      .filter((item) => item.text.length > 0);
    const finalText = effectiveParagraphs.at(-1)?.text ?? "";
    const firstPeriod = effectiveParagraphs.find((item) => item.text.includes("。"));
    const periodHasFollowingParagraph =
      firstPeriod !== undefined &&
      effectiveParagraphs.some((item) => item.paragraphIndex > firstPeriod.paragraphIndex);
    const periodInsideFinalParagraph = finalText.includes("。") && !finalText.endsWith("。");
    if (periodHasFollowingParagraph) {
      warnings.push({
        kind: "trailing-text",
        paragraphIndex: firstPeriod.paragraphIndex,
        claimNumber: claim.number,
        message: `权利要求${claim.number}在末尾句号后仍有内容，请检查分段。`,
      });
    } else if (periodInsideFinalParagraph || (finalText.match(/。/gu)?.length ?? 0) > 1) {
      warnings.push({
        kind: "internal-full-stop",
        paragraphIndex: claim.lastNonEmptyParagraphIndex,
        claimNumber: claim.number,
        message: `权利要求${claim.number}内部存在中文句号“。”，请只在末尾保留句号。`,
      });
    }
    if (!claim.text.endsWith("。")) {
      warnings.push({
        kind: "missing-ending",
        paragraphIndex: claim.lastNonEmptyParagraphIndex,
        claimNumber: claim.number,
        message: `权利要求${claim.number}末尾缺少中文句号“。”。`,
      });
    }
  }
  return warnings;
}

function patentNameOrBlank(patentName: string | null): string {
  return patentName && patentName.trim().length > 0 ? patentName.trim() : "______";
}

export function createDependentClaimTemplate(
  claimNumber: number,
  parentClaimNumber: number,
  patentName: string | null,
): string {
  return `${claimNumber}. 根据权利要求${parentClaimNumber}所述的${patentNameOrBlank(
    patentName,
  )}，其特征在于：`;
}

export function renumberClaimParagraphs(paragraphs: readonly string[]): string[] {
  const starts = new Map(
    parseClaimParagraphs(paragraphs).claims.map((claim, index) => [
      claim.startParagraphIndex,
      index + 1,
    ]),
  );
  return paragraphs.map((paragraph, index) => {
    const claimNumber = starts.get(index);
    return claimNumber === undefined
      ? paragraph
      : paragraph.replace(CLAIM_NUMBER_PREFIX, `${claimNumber}. `);
  });
}
