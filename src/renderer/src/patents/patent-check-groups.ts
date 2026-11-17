import type { InspectionIssue, PatentIssueCode } from "../../../shared/patent-inspection/types";

const titles: Partial<Record<PatentIssueCode, string>> = {
  "claim-ordinary-image": "权利要求书中包含图片",
  "reference-mark-number-mismatch": "部件名称与标记编号不一致",
  "unbalanced-text-pair": "括号或引号未成对",
  "duplicate-drafting-content": "内容可能重复粘贴",
  "table-number-duplicate": "表格编号重复",
  "table-reference-missing": "未找到引用的表格",
  "formula-invalid-syntax": "数学公式格式有误",
  "cross-book-reference": "核对跨文档引用",
  "unfinished-editing-marker": "还有未处理的编辑标记",
  "asset-unreadable": "图片资源无法读取",
  "empty-required-book": "文档尚未填写",
  "missing-description-chapter": "说明书章节缺失或未填写",
  "description-chapter-duplicate": "说明书有重复章节",
  "description-chapter-order": "核对说明书章节顺序",
  "unresolved-template-placeholder": "还有模板内容未填写",
  "abstract-too-long": "摘要超过300字",
  "patent-name-too-long": "专利名称较长",
  "promotional-language": "部分表述过于宣传化",
  "repeated-punctuation": "存在重复标点",
  "claim-numbering-warning": "权利要求编号需检查",
  "claim-reference-warning": "权利要求引用有误",
  "claim-paragraph-ending": "权利要求句号使用需检查",
  "claim-keyword-reference-warning": "核对权利要求的主题名称",
  "claim-multiple-reference-choice": "引用多项权利要求时未说明任选一项",
  "claim-multiple-reference-base": "多项引用的引用关系需检查",
  "claim-reference-cycle": "权利要求存在循环引用",
  "utility-model-method-wording": "实用新型中出现方法表述",
  "terminology-mismatch": "部分用语与专利类型不符",
  "drawing-missing-figure": "正文引用了不存在的附图",
  "drawing-duplicate-label": "附图说明的图号重复",
  "drawing-explanation-mismatch": "附图说明的图号需核对",
  "drawing-explanation-sync-paused": "附图与附图说明未对应",
  "missing-figure-explanation": "尚未添加说明书附图",
  "missing-abstract-drawing": "尚未选择摘要附图",
  "missing-drawing-explanation-heading": "缺少“附图说明”标题",
  "missing-drawing-book": "缺少附图文档",
  "drawing-reference-without-drawing-books": "已关闭附图文档，但正文仍提到附图",
  "reference-mark-missing-in-description": "说明书缺少部分部件名称",
  "reference-mark-description-mismatch": "说明书中的附图标记与标记列表不同",
  "table-fixed-row-height-warning": "表格使用固定行高",
  "numeric-range-reversed": "核对数值范围",
  "numeric-percentage-total": "百分比合计需核对",
  "numeric-quantity-mapping": "核对一一对应的数量",
  "numeric-unit-mismatch": "核对参数的单位",
  "numeric-subrange-out-of-bounds": "核对子范围是否超出总范围",
  "formula-literal-zero-denominator": "公式分母为0",
  "formula-undefined-symbol": "核对公式符号的说明",
  "formula-duplicate-definition": "核对符号的不同取值",
};

export type CheckPriority = "fix" | "review" | "suggestion";

export function checkIssuePriority(issue: InspectionIssue): CheckPriority {
  if (
    issue.legacyCode === "table-fixed-row-height-warning" ||
    issue.legacyCode === "description-chapter-order" ||
    issue.legacyCode === "description-chapter-duplicate" ||
    (issue.legacyCode === "patent-name-too-long" && issue.severity === "suggestion")
  )
    return "suggestion";
  if (issue.confidence !== "certain") return "review";
  return issue.severity === "suggestion" ? "suggestion" : "fix";
}

const recommendations: Partial<Record<PatentIssueCode, string>> = {
  "empty-required-book": "补充文档内容。",
  "unresolved-template-placeholder": "填写空白，或删除不用的模板段落。",
  "claim-numbering-warning": "按顺序修正编号后重新检查。",
  "claim-reference-warning": "核对引用的权利要求编号。",
  "claim-multiple-reference-choice": "使用“或”“任一项”等择一引用表述。",
  "claim-multiple-reference-base": "调整引用，避免多项从属权利要求再引用多项从属权利要求。",
  "claim-reference-cycle": "调整引用关系，断开循环。",
  "claim-keyword-reference-warning": "核对名称是否一致；同义表述可忽略。",
  "utility-model-method-wording": "确认保护的是产品结构，还是方法步骤。",
  "numeric-percentage-total": "核对百分数，以及各组分是否重叠。",
  "numeric-quantity-mapping": "核对两侧数量是否确实需要一一对应。",
  "numeric-unit-mismatch": "核对参数名称和单位。",
  "numeric-subrange-out-of-bounds": "核对总范围和优选范围。",
  "formula-undefined-symbol": "核对符号含义是否已说明。",
  "formula-duplicate-definition": "确认不同取值的适用条件。",
  "table-fixed-row-height-warning": "导出预览有遮挡时，再调整行高。",
  "description-chapter-order": "采用其他合理顺序时可忽略。",
  "description-chapter-duplicate": "核对是否需要合并重复章节。",
  "abstract-too-long": "压缩摘要正文，保留技术方案要点。",
  "patent-name-too-long": "精简名称；超过25字但不超过60字时，核对是否确有必要。",
  "missing-figure-explanation": "添加产品结构附图。",
  "missing-abstract-drawing": "从说明书附图中选择摘要附图。",
  "missing-drawing-explanation-heading": "核对说明书是否需要补充“附图说明”章节。",
  "missing-drawing-book": "重新添加对应的附图文档。",
  "drawing-reference-without-drawing-books": "添加对应附图文档，或删除不需要的附图引用。",
  "drawing-duplicate-label": "合并重复说明，或修正对应图号。",
  "drawing-explanation-mismatch": "核对说明图号与附图顺序。",
  "drawing-explanation-sync-paused": "核对附图说明是否缺失、重复或顺序有误。",
  "drawing-abstract-selection-mismatch": "重新核对摘要附图的选择。",
  "reference-mark-description-mismatch": "核对说明书中的部件名称和编号。",
  "numeric-range-reversed": "核对范围的上下限和单位。",
  "formula-literal-zero-denominator": "修正公式分母。",
};

export function issueRecommendation(issue: InspectionIssue): string | null {
  if (issue.legacyCode === "missing-description-chapter")
    return issue.identityKey?.startsWith("missing:")
      ? "核对章节标题；采用其他合理结构时可忽略。"
      : "补充这一章节的正文。";
  if (issue.legacyCode === "claim-paragraph-ending")
    return issue.identityKey?.endsWith("missing-period")
      ? "在本项权利要求末尾补充句号。"
      : "核对段内句号，保留末尾句号。";
  if (issue.legacyCode === "drawing-missing-figure")
    return issue.identityKey?.startsWith("explanation:")
      ? "在说明书中补充对应图号的附图说明。"
      : "添加所引用的附图，或修正正文图号。";
  return recommendations[issue.legacyCode] ?? issue.recommendation;
}

export function conciseIssueSummary(issue: InspectionIssue, detailed = false): string {
  if (issue.legacyCode === "missing-drawing-explanation-heading")
    return titles[issue.legacyCode] ?? issue.summary;
  const text = issue.summary.replace(/，请人工检查。$/u, "，请核对。");
  return !detailed && text.length > 36 ? (titles[issue.legacyCode] ?? text) : text;
}

export type CheckIssueGroup = {
  key: string;
  title: string;
  issue: InspectionIssue;
  members: InspectionIssue[];
};

export function groupCheckIssues(issues: readonly InspectionIssue[]): CheckIssueGroup[] {
  const groups = new Map<string, CheckIssueGroup>();
  const hasSpecificDrawingProblem = issues.some(
    (issue) =>
      (issue.legacyCode === "drawing-missing-figure" &&
        issue.identityKey?.startsWith("explanation:")) ||
      issue.legacyCode === "drawing-duplicate-label" ||
      issue.legacyCode === "drawing-explanation-mismatch",
  );
  for (const issue of issues) {
    // The report retains the general warning; its concrete causes are shown once in the UI.
    if (issue.legacyCode === "drawing-explanation-sync-paused" && hasSpecificDrawingProblem)
      continue;
    // One rule can report both missing figures and missing captions. They require different fixes.
    const subtype =
      issue.legacyCode === "claim-paragraph-ending"
        ? issue.identityKey?.endsWith("missing-period")
          ? "missing-ending"
          : "internal-period"
        : issue.legacyCode === "missing-description-chapter"
          ? issue.identityKey?.startsWith("missing:")
            ? "missing-heading"
            : "empty-body"
          : issue.legacyCode === "drawing-missing-figure"
            ? issue.identityKey?.startsWith("explanation:") ||
              /^图\d+缺少附图说明/u.test(issue.summary)
              ? "caption"
              : "reference"
            : issue.legacyCode === "drawing-abstract-selection-mismatch"
              ? (issue.identityKey?.split(":")[0] ?? "selection")
              : "";
    const key = `${issue.ruleId}:${issue.legacyCode}:${checkIssuePriority(issue)}:${subtype}`;
    const group = groups.get(key);
    if (group) {
      group.members.push(issue);
      const rank = { error: 0, warning: 1, suggestion: 2 };
      if (rank[issue.severity] < rank[group.issue.severity]) group.issue = issue;
    } else groups.set(key, { key, title: conciseIssueSummary(issue), issue, members: [issue] });
  }
  for (const group of groups.values()) {
    if (group.members.length === 1) continue;
    if (group.key.endsWith(":caption")) {
      const figures = [
        ...new Set(
          group.members
            .map((issue) => /^图\d+/u.exec(issue.summary)?.[0])
            .filter((figure): figure is string => figure !== undefined),
        ),
      ].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
      group.title = `${figures.slice(0, 8).join("、")}${figures.length > 8 ? `等${figures.length}幅图` : ""}缺少附图说明`;
    } else
      group.title = `${titles[group.issue.legacyCode] ?? conciseIssueSummary(group.issue)}（${group.members.length}处）`;
  }
  const priorityOrder = { fix: 0, review: 1, suggestion: 2 };
  return [...groups.values()].sort(
    (left, right) =>
      priorityOrder[checkIssuePriority(left.issue)] -
      priorityOrder[checkIssuePriority(right.issue)],
  );
}
