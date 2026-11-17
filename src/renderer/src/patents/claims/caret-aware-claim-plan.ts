import {
  CLAIM_NUMBER_PREFIX,
  type ClaimTextRange,
  parseClaimParagraphs,
} from "../../../../shared/patent/claim-text-tools";
import {
  CLAIM_REFERENCE_MARKER_SOURCE,
  type ClaimReferenceExpression,
  claimReferenceExpressions,
} from "./claim-reference-expression";

const CHARACTERISTIC_PHRASE = "其特征在于";

export type ClaimPlanFailureCode =
  | "NO_ACTIVE_CLAIM"
  | "NO_INDEPENDENT_CLAIM"
  | "EMPTY_INDEPENDENT_NAME"
  | "INVALID_NUMBERING"
  | "AMBIGUOUS_REFERENCE";

type TextReplacement = {
  paragraphIndex: number;
  from: number;
  to: number;
  text: string;
};

export type ClaimInsertionPlan = {
  insertionIndex: number;
  reuseEmptyParagraph: boolean;
  replacementText: string;
  referenceReviewRanges: readonly { from: number; to: number }[];
  paragraphNumberReplacements: readonly TextReplacement[];
  referenceReplacements: readonly TextReplacement[];
};

export type ClaimInsertionPlanResult =
  | { ok: true; value: ClaimInsertionPlan }
  | { ok: false; error: { code: ClaimPlanFailureCode; message: string } };

function failure(code: ClaimPlanFailureCode, message: string): ClaimInsertionPlanResult {
  return { ok: false, error: { code, message } };
}

/** 提取文档中权利要求标号的既有分隔符与尾随空格风格（如 "."+" " 或 "、"+""），默认半角点+空格。 */
function claimSeparatorStyle(paragraphs: readonly string[]): {
  separator: string;
  trailing: string;
} {
  for (const paragraph of paragraphs) {
    const match = /^\s*\d+([.．、])(\s*)/u.exec(paragraph);
    if (match) return { separator: match[1] ?? ".", trailing: match[2] ?? "" };
  }
  return { separator: ".", trailing: " " };
}

function isDependentClaim(claim: ClaimTextRange): boolean {
  const characteristicIndex = claim.text.indexOf(CHARACTERISTIC_PHRASE);
  const preamble = claim.text.slice(
    CLAIM_NUMBER_PREFIX.exec(claim.text)?.[0].length ?? 0,
    characteristicIndex < 0 ? undefined : characteristicIndex,
  );
  return new RegExp(`${CLAIM_REFERENCE_MARKER_SOURCE}\\s*\\d+`, "u").test(preamble);
}

function independentClaimName(claim: ClaimTextRange): string | null {
  const preamble = claim.text.replace(CLAIM_NUMBER_PREFIX, "");
  const commaCandidates = [preamble.indexOf("，"), preamble.indexOf(",")].filter(
    (index) => index >= 0,
  );
  const commaIndex = commaCandidates.length > 0 ? Math.min(...commaCandidates) : -1;
  const characteristicIndex = preamble.indexOf(CHARACTERISTIC_PHRASE);
  const boundaries = [commaIndex, characteristicIndex].filter((index) => index >= 0);
  const end = boundaries.length ? Math.min(...boundaries) : -1;
  const name = (end >= 0 ? preamble.slice(0, end) : "").trim();
  return name.length > 0 ? name : null;
}

function referenceReplacements(
  paragraphs: readonly string[],
  parentNumber: number,
  parsed: readonly ClaimReferenceExpression[][],
): TextReplacement[] | null {
  const replacements: TextReplacement[] = [];

  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    for (const expression of parsed[paragraphIndex]!) {
      for (const part of expression.parts) {
        if (part.last && part.first.value <= parentNumber && part.last.value > parentNumber) {
          // Do not collapse an existing soft break while expanding a disjoint range.
          if (/\n/u.test(paragraph.slice(part.first.from, part.last.to))) return null;
          // Preserve the old reference set; the newly inserted claim is not an old target.
          const numbers = Array.from({ length: part.last.value - part.first.value + 1 }, (_, i) => {
            const n = part.first.value + i;
            return n > parentNumber ? n + 1 : n;
          });
          replacements.push({
            paragraphIndex,
            from: part.first.to,
            to: part.last.from,
            text: ["", ...numbers.slice(1, -1), ""].join("或"),
          });
          // Keep the original endpoints as separate edits so their marks do not collapse
          // into the style of the first number when the range is expanded.
          replacements.push({
            paragraphIndex,
            from: part.last.from,
            to: part.last.to,
            text: String(part.last.value + 1),
          });
          continue;
        }
        for (const token of part.last ? [part.first, part.last] : [part.first]) {
          if (token.value <= parentNumber) continue;
          replacements.push({
            paragraphIndex,
            // Replace the number itself, not adjacent spaces with potentially different marks.
            from: token.from,
            to: token.to,
            text: `${paragraph[token.from - 1] === " " ? "" : " "}${token.value + 1}${paragraph[token.to] === " " ? "" : " "}`,
          });
        }
      }
    }
  }

  return replacements;
}

export function planDependentClaimInsertion(input: {
  paragraphs: readonly string[];
  cursorParagraphIndex: number;
  cursorParagraphIsEmpty: boolean;
}): ClaimInsertionPlanResult {
  const structure = parseClaimParagraphs(input.paragraphs);
  const claims = [...structure.claims];
  if (structure.unnumberedPrefaceParagraphIndexes.length > 0) {
    const cursorIsInPreface = structure.unnumberedPrefaceParagraphIndexes.includes(
      input.cursorParagraphIndex,
    );
    return failure(
      cursorIsInPreface ? "NO_ACTIVE_CLAIM" : "INVALID_NUMBERING",
      cursorIsInPreface
        ? "未能确定光标所在的权利要求，请将光标放入目标权利要求后重试。"
        : "权利要求书开头存在未编号文字，请先整理编号后重试。",
    );
  }

  if (claims.some((claim, index) => claim.number !== index + 1)) {
    return failure(
      "INVALID_NUMBERING",
      "权利要求编号必须从 1 开始连续递增，请先手动整理编号后重试。",
    );
  }

  const currentText = input.paragraphs[input.cursorParagraphIndex];
  if (currentText === undefined) {
    return failure(
      "NO_ACTIVE_CLAIM",
      "未能确定光标所在的权利要求，请将光标放入目标权利要求后重试。",
    );
  }

  const parent = claims.find(
    (claim) =>
      input.cursorParagraphIndex >= claim.startParagraphIndex &&
      input.cursorParagraphIndex < claim.endParagraphIndex,
  );
  if (!parent || (input.cursorParagraphIsEmpty && currentText.trim().length !== 0)) {
    return failure(
      "NO_ACTIVE_CLAIM",
      "未能确定光标所在的权利要求，请将光标放入目标权利要求后重试。",
    );
  }

  if (claims.every(isDependentClaim)) {
    return failure(
      "NO_INDEPENDENT_CLAIM",
      "未找到光标所属的独立权利要求，请先检查前方权利要求格式。",
    );
  }

  const parsed = input.paragraphs.map(claimReferenceExpressions);
  if (parsed.some((value) => value === null)) {
    return failure(
      "AMBIGUOUS_REFERENCE",
      "存在无法完整识别的权利要求引用，未修改原文。请整理引用文字后重试。",
    );
  }
  const expressions = parsed as ClaimReferenceExpression[][];
  const roots = new Map<number, Set<number>>();
  const multipleDependent = new Set<number>();
  for (const claim of claims) {
    const paragraphExpressions = expressions
      .slice(claim.startParagraphIndex, claim.endParagraphIndex)
      .flat();
    const wholeClaimExpressions = claimReferenceExpressions(claim.text);
    const signature = (items: ClaimReferenceExpression[]) =>
      JSON.stringify(
        items.map((item) => item.parts.map((part) => [part.first.value, part.last?.value])),
      );
    // A reference may span paragraph boundaries even when each paragraph parses alone.
    // No cross-paragraph replacement is supported: refuse before any renumbering.
    if (
      !wholeClaimExpressions ||
      signature(wholeClaimExpressions) !== signature(paragraphExpressions)
    ) {
      return failure(
        "AMBIGUOUS_REFERENCE",
        "引用跨越段落或无法完整识别，未修改原文。请将同一引用整理到一个段落后重试。",
      );
    }
    const refs = paragraphExpressions.flatMap((item) => item.numbers);
    if (refs.some((n) => n >= claim.number || n < 1)) {
      return failure(
        "AMBIGUOUS_REFERENCE",
        `权利要求${claim.number}存在自引用、引用后项或不存在的引用，未修改原文。`,
      );
    }
    if (!isDependentClaim(claim)) roots.set(claim.number, new Set([claim.number]));
    else {
      const preamble = claim.text.split(CHARACTERISTIC_PHRASE)[0]!;
      const parentRefs = claimReferenceExpressions(preamble);
      if (!parentRefs?.length)
        return failure("AMBIGUOUS_REFERENCE", "无法确定引用关系，未修改原文。");
      const targets = new Set(parentRefs.flatMap((item) => item.numbers));
      if (targets.size > 1) {
        if ([...targets].some((n) => multipleDependent.has(n))) {
          return failure(
            "AMBIGUOUS_REFERENCE",
            `权利要求${claim.number}为多项从属，引用了另一多项从属权利要求，未修改原文。请先调整引用关系。`,
          );
        }
        multipleDependent.add(claim.number);
      }
      roots.set(claim.number, new Set([...targets].flatMap((n) => [...(roots.get(n) ?? [])])));
    }
  }
  const names = new Set(
    [...(roots.get(parent.number) ?? [])].map((n) => independentClaimName(claims[n - 1]!)),
  );
  if (names.size > 1)
    return failure(
      "AMBIGUOUS_REFERENCE",
      "引用涉及不同主题的独立权利要求，无法确定名称，未修改原文。",
    );
  const name = [...names][0];
  if (name?.includes("\uFFFC"))
    return failure(
      "EMPTY_INDEPENDENT_NAME",
      "权利要求名称中包含非文字内容，无法可靠提取名称，未修改原文。",
    );
  if (!name) {
    return failure("EMPTY_INDEPENDENT_NAME", "缺少独立权利要求名称。");
  }

  const references = referenceReplacements(input.paragraphs, parent.number, expressions);
  if (!references) {
    return failure("AMBIGUOUS_REFERENCE", "存在无法可靠识别的权利要求引用，请整理引用文字后重试。");
  }

  const insertionIndex = parent.lastNonEmptyParagraphIndex + 1;
  const reuseEmptyParagraph = input.paragraphs[insertionIndex]?.trim().length === 0;
  const nextNumber = parent.number + 1;
  const parentReference = String(parent.number);
  // 标号分隔符与尾随空格保持文档既有风格（"."+" "、"．"+" "或"、"+""），新插入段与受影响段不改变。
  const { separator, trailing } = claimSeparatorStyle(input.paragraphs);
  const replacementText = `${nextNumber}${separator}${trailing}根据权利要求 ${parentReference} 所述的${name}，其特征在于：`;
  const referenceStart = replacementText.indexOf("权利要求") + "权利要求".length;

  return {
    ok: true,
    value: {
      insertionIndex,
      reuseEmptyParagraph,
      replacementText,
      referenceReviewRanges: [
        { from: referenceStart, to: referenceStart + parentReference.length + 2 },
      ],
      paragraphNumberReplacements: claims
        .filter((claim) => claim.startParagraphIndex > parent.startParagraphIndex)
        .map((claim) => {
          const originalPrefix =
            input.paragraphs[claim.startParagraphIndex]?.slice(0, claim.prefixEnd) ?? "";
          const numberPrefix = /\d+[.．、]/u.exec(originalPrefix)!;
          return {
            paragraphIndex: claim.startParagraphIndex,
            from: numberPrefix.index,
            to: numberPrefix.index + numberPrefix[0].length,
            // 仅替换编号数字，保留原分隔符与空格风格。
            text: numberPrefix[0].replace(/\d+/u, String(claim.number + 1)),
          };
        }),
      referenceReplacements: references,
    },
  };
}
