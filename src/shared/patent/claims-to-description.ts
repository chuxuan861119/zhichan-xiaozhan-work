import { DEFAULT_INVENTION_CONTENT_PREFIX } from "../settings/invention-content.js";
import { claimStructureWarnings, parseClaimParagraphs } from "./claim-text-tools.js";
import {
  type ClaimsRichParagraph,
  type DraftSpan,
  draftParagraphs,
  replaceDraft,
  sliceDraft,
} from "./claims-rich-text.js";
import { classifyDescriptionChapterBlock } from "./description.js";
import type { CanonicalPatent } from "./model.js";
import { locateReferenceMarkIssues } from "./reference-mark-issue-locator.js";

export type ClaimsDescriptionTarget = "invention-content" | "detailed-embodiments";
export const CLAIMS_DESCRIPTION_LABELS: Record<ClaimsDescriptionTarget, string> = {
  "invention-content": "发明内容",
  "detailed-embodiments": "具体实施方式",
};
export type ClaimsDescriptionResult =
  | {
      ok: true;
      text: string;
      paragraphs: ClaimsRichParagraph[];
      /** Heading node to jump to, or null when the description has no single matching heading. */
      targetNodeId: string | null;
      claimCount: number;
    }
  | { ok: false; message: string };

/** Produces a detached formatted draft. Neither book nor reference registrations are mutated. */
export function prepareClaimsForDescription(
  patent: CanonicalPatent,
  target: ClaimsDescriptionTarget,
  dependentPrefix = DEFAULT_INVENTION_CONTENT_PREFIX,
): ClaimsDescriptionResult {
  const fail = (message: string): ClaimsDescriptionResult => ({ ok: false, message });
  const claimsBook = patent.books.find((book) => book.kind === "claims");
  const description = patent.books.find((book) => book.kind === "description");
  const headings =
    description?.document.content.filter(
      (block) => classifyDescriptionChapterBlock(block) === target,
    ) ?? [];
  // A missing or duplicated heading only decides whether the caller can jump to it. It must not
  // block the conversion: the text stays copyable and the user pastes it where it belongs.
  const heading = headings.length === 1 ? headings[0] : undefined;
  if (!claimsBook) return fail("未找到权利要求书。");

  const paragraphs: string[] = [];
  const styledParagraphs: DraftSpan[][] = [];
  for (const block of claimsBook.document.content) {
    if (block.type === "page-break") continue;
    if (block.type !== "paragraph" && block.type !== "heading") {
      return fail("权利要求书含表格、列表或图文对象，无法无损转换为纯文本，请手动整理后复制。");
    }
    if (block.content.some((node) => node.type !== "text" && node.type !== "hard-break")) {
      return fail("权利要求书含公式或图片，暂不支持转换，请手动整理后复制。");
    }
    paragraphs.push(
      block.content.map((node) => (node.type === "text" ? node.text : "\n")).join(""),
    );
    styledParagraphs.push(
      block.content.map((node) => ({
        text: node.type === "text" ? node.text : "\n",
        marks: node.type === "text" ? node.marks : [],
        attrs: block.attrs,
        hardBreak: node.type === "hard-break",
      })),
    );
  }
  const structure = parseClaimParagraphs(paragraphs);
  if (!structure.claims.length) return fail("未识别到权利要求编号，请使用“1.”等序号分隔各项。");
  if (
    structure.unnumberedPrefaceParagraphIndexes.some(
      (index) => ![patent.name, "权利要求书"].includes(paragraphs[index]!.trim()),
    )
  ) {
    return fail("权利要求编号前存在无法识别的内容，请先检查标题和分组。");
  }
  const structureWarning = claimStructureWarnings({
    ...structure,
    unnumberedPrefaceParagraphIndexes: [],
  })[0];
  if (structureWarning) return fail(`无法可靠分组：${structureWarning.message}`);
  if (structure.claims.some((claim, index) => claim.number !== index + 1)) {
    return fail("权利要求编号不连续或重复，请先检查分组和序号。");
  }
  if (paragraphs.some((text) => /_{3,}|＿{3,}/u.test(text)))
    return fail("权利要求书仍有未填写的模板内容，请先补充完整。");

  const claimsOnly = { ...patent, books: [claimsBook] };
  for (const mark of patent.referenceMarks) {
    const issue = locateReferenceMarkIssues(claimsOnly, mark.referenceMarkId).find(
      (item) => item.reason !== "nonstandard-number",
    );
    // Full-width digits/parentheses are safely normalized below; broken associations are not.
    if (issue) {
      return fail(
        `附图标记“${mark.keyword}”与编号${mark.number}不一致（${issue.text}），请先修正。`,
      );
    }
  }

  const output: string[] = [];
  const richOutput: ClaimsRichParagraph[] = [];
  for (const claim of structure.claims) {
    let rich: DraftSpan[] = [];
    for (let i = claim.startParagraphIndex; i < claim.endParagraphIndex; i++) {
      const runs = styledParagraphs[i]!;
      if (i > claim.startParagraphIndex) {
        const attrs = runs[0]?.attrs ?? styledParagraphs[claim.startParagraphIndex]![0]!.attrs;
        rich.push({ text: "\n", marks: [], attrs, paragraphBreak: true });
      }
      rich.push(...runs);
    }
    rich = sliceDraft(rich, claim.prefixEnd);
    const lines = [...claim.paragraphTexts];
    lines[0] = lines[0]!.slice(claim.prefixEnd);
    let text = lines.join("\n").trim();
    const untrimmed = lines.join("\n");
    const trimStart = untrimmed.length - untrimmed.trimStart().length;
    rich = sliceDraft(rich, trimStart, trimStart + text.length);
    const dependent = /^(?:根据|如|按照|依照)\s*权利要求/u.test(text);
    if (dependent) {
      const head = text.match(
        /^(?:根据|如|按照|依照)\s*权利要求\s*([\d\s、，,或和及至到～~—–-]+)(?:(?:中)?(?:任意|任一|任意一|任意一项|任一项|一项))?\s*所述(?:的)?\s*([^，,；;：:\n]+)[，,]\s*/u,
      );
      const refs = head?.[1]?.match(/\d+/gu)?.map(Number) ?? [];
      if (!head || !refs.length || refs.some((number) => number < 1 || number >= claim.number)) {
        return fail(
          `权利要求${claim.number}的引用开头无法可靠识别，请先核对引用编号和“所述的…”部分。`,
        );
      }
      if (/包括|包含|设有|设置有|具有|连接有|安装有/u.test(head[2] ?? "")) {
        return fail(
          `权利要求${claim.number}的主题名称与技术特征之间缺少明确分隔，请核对引用开头后再转换。`,
        );
      }
      text = text.slice(head[0].length);
      rich = sliceDraft(rich, head[0].length);
    } else if (claim.number > 1 && !/^(?:一种|一项|一个|一套|用于)/u.test(text)) {
      return fail(`权利要求${claim.number}无法判定为独立项或从属项，请先检查分组和引用开头。`);
    }
    const connective = /其特征在于\s*[:：，,]?\s*/gu;
    if ([...text.matchAll(connective)].length > 1)
      return fail(`权利要求${claim.number}存在多个“其特征在于”，请先检查分组。`);
    const edits: { start: number; length: number; text: string }[] = [];
    text = text.replace(connective, (matched, offset: number) => {
      const prefix = text.slice(0, offset).trimEnd();
      const replacement = prefix && !/[，,；;：:]$/u.test(prefix) ? "，" : "";
      edits.push({ start: offset, length: matched.length, text: replacement });
      return replacement;
    });
    rich = replaceDraft(rich, edits);
    edits.length = 0;
    // Numeric parentheses are removed only when attached to the exact registered keyword.
    let ambiguous: string | null = null;
    text = text.replace(
      /[（(][\t \u3000]*([0-9０-９]+)[\t \u3000]*[)）]/gu,
      (matched: string, digits: string, offset: number) => {
        const prefix = text.slice(0, offset).trimEnd();
        const number = Number(
          digits.replace(/[０-９]/gu, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0)),
        );
        const mark = patent.referenceMarks
          .filter((entry) => prefix.endsWith(entry.keyword))
          .sort((a, b) => b.keyword.length - a.keyword.length)[0];
        if (
          !mark ||
          mark.number !== number ||
          (matched[0] === "(" ? !matched.endsWith(")") : !matched.endsWith("）"))
        ) {
          ambiguous = matched;
          return matched;
        }
        const replacement = target === "invention-content" ? "" : String(number);
        if (target === "invention-content") {
          edits.push({ start: offset, length: matched.length, text: "" });
        } else {
          const digitOffset = matched.indexOf(digits);
          edits.push({ start: offset, length: digitOffset, text: "" });
          if (digits !== replacement)
            edits.push({ start: offset + digitOffset, length: digits.length, text: replacement });
          edits.push({
            start: offset + digitOffset + digits.length,
            length: matched.length - digitOffset - digits.length,
            text: "",
          });
        }
        return replacement;
      },
    );
    if (ambiguous)
      return fail(
        `权利要求${claim.number}中的“${ambiguous}”无法确定为正确的附图编号，请先核对登记关键词和编号。`,
      );
    if (!text.replace(/[\s，,；;：:。.]/gu, ""))
      return fail(`权利要求${claim.number}转换后没有有效内容，请先补充正文。`);
    rich = replaceDraft(rich, edits);
    const prefix = dependent && target === "invention-content" ? dependentPrefix : "";
    if (prefix && rich[0]) rich.unshift({ ...rich[0], text: prefix, paragraphBreak: false });
    richOutput.push(...draftParagraphs(rich));
    output.push(`${prefix}${text}`);
  }
  const text = output.join("\n");
  if (text.length > 2 * 1024 * 1024) return fail("转换内容超过剪贴板大小限制，请分段手动整理。");
  return {
    ok: true,
    text,
    paragraphs: richOutput,
    targetNodeId: heading?.id ?? null,
    claimCount: output.length,
  };
}
