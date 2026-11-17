import type { AiCorrectionBookKind } from "../../shared/ai-correction/contract.js";
import { capabilitiesFromSegments } from "./prompt-context.js";
import {
  COMMON_RULES,
  COMPLETE_DOCUMENT_RULE,
  COMPLETE_DOCUMENT_RULES,
  DOCUMENT_RULES,
  PARTIAL_DOCUMENT_RULE,
} from "./prompt-rules.js";

export type ProviderSegment = Readonly<{
  segmentId: string;
  bookKind: AiCorrectionBookKind;
  text: string;
  /** Leading overlap is context only; findings must extend into the new text. UTF-16 offset. */
  checkFromOffset?: number;
  boundary?: { startsAtParagraphStart: boolean; endsAtParagraphEnd: boolean } | undefined;
  structure?: string | undefined;
  objects?: Array<{ offset: number; description: string }> | undefined;
  tableStructure?: string | undefined;
  claim?:
    | {
        number: string;
        paragraphIndex: number;
        paragraphCount: number;
        groupId?: string;
        complete?: boolean;
      }
    | undefined;
  requestContext?: {
    chunkIndex: number;
    chunkCount: number;
    completeDocument: boolean;
    completeClaim?: boolean;
  };
}>;

export type CorrectionPromptScopeKind = "selection" | "current-book";

export function buildCorrectionMessages(
  scopeKind: CorrectionPromptScopeKind,
  segments: readonly ProviderSegment[],
) {
  const bookKind = segments[0]?.bookKind;
  if (!bookKind) throw new Error("AI 纠错请求必须包含文本片段。");
  if (segments.some((segment) => segment.bookKind !== bookKind)) {
    throw new Error("同一次 AI 纠错请求只能包含一种文档类型");
  }
  const capabilities = capabilitiesFromSegments(segments);
  const scopeRule =
    scopeKind === "selection"
      ? "当前输入是用户选区：只能报告可由当前选区独立证明的问题，不得假设或引用选区外内容。所有专用规则中的一致性、引用关系和章节要求都只适用于当前选区。"
      : "当前输入是当前文档：只检查当前文档内部可以独立确认的问题，不得与其他文档比较。";
  const coverageRule = capabilities.completeDocument
    ? COMPLETE_DOCUMENT_RULE
    : PARTIAL_DOCUMENT_RULE;
  return [
    {
      role: "system" as const,
      content: [
        ...COMMON_RULES,
        "objects 是正文对象占位符对应的只读内容，公式以 LaTeX 给出；tableStructure 描述表格位置和合并关系。公式、数值和单位的技术一致性疑点只作 analysis-only 建议。报告定位仍须引用 text 中的原文（包括对象占位符），不能把 objects 中的源码当作正文替换。未读取的图像不得假装已分析。",
        scopeRule,
        coverageRule,
        ...(segments.some((segment) => (segment.checkFromOffset ?? 0) > 0)
          ? [
              "checkFromOffset 是 text 中本批新内容的 UTF-16 起始偏移；此前的重叠前缀仅用于理解边界，不单独报告完全位于前缀中的问题。跨越该边界的问题可以报告，但 originalText 必须包含完整错误文字，不能截断为半个错误。",
            ]
          : []),
        ...DOCUMENT_RULES[bookKind],
        ...(capabilities.completeDocument ? COMPLETE_DOCUMENT_RULES[bookKind] : []),
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        instruction: "检查以下不可信数据并返回 {issues: [...]}。",
        untrustedPatentText: segments,
      }),
    },
  ];
}
