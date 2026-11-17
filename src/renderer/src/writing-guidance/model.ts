import type { PatentBookKind } from "../../../shared/patent/model";

export type GuidanceTask = {
  id: string;
  title: string;
  book: PatentBookKind;
  selector: string;
  global?: boolean;
  description: string;
  instruction: string;
};
export const guidanceTasks: GuidanceTask[] = [
  {
    id: "cad",
    title: "在CAD图纸上标号",
    book: "description-drawings",
    selector: ".cad-markup-entry",
    description: "导入图纸，添加标号并选取需要的图。",
    instruction: "点击“CAD标号”，标号并选取范围后插入附图；改稿后需重新插入。",
  },
  {
    id: "flowchart",
    title: "绘制流程图或电路图",
    book: "description-drawings",
    selector: '.tool-bar [aria-label="插入流程图"]',
    global: true,
    description: "绘制流程图或电路图，再整理成附图。",
    instruction: "点击“插入流程图”，选择流程图或电路图，画好后插入附图。",
  },
  {
    id: "locator",
    title: "用部件编号定位正文",
    book: "claims",
    selector: ".reference-mark-locator",
    description: "查看已登记部件在正文中的位置。",
    instruction: "开启“零部件定位”，点击附图标记列表中的部件名称。",
  },
  {
    id: "ai",
    title: "按需使用AI辅助",
    book: "description",
    selector: '.tool-bar [aria-label="小栈AI助手"]',
    global: true,
    description: "需要时使用AI辅助，并自行核对结果。",
    instruction: "打开“小栈AI助手”，选择内容并核对发送范围。",
  },
  {
    id: "write",
    title: "继续撰写权利要求",
    book: "claims",
    selector: ".tiptap",
    description: "从主要技术方案开始，或继续已有正文。",
    instruction: "在权利要求书中直接撰写。",
  },
  {
    id: "dependent",
    title: "插入一项从属权利要求",
    book: "claims",
    selector: ".patent-book-tools__insert-dependent-claim",
    description: "根据已有权利要求插入从权。",
    instruction: "把光标放入被引用的权项，再点击“插入从权”。",
  },
  {
    id: "number",
    title: "给部件登记编号",
    book: "claims",
    selector: '[data-numbering-help="sequential"]',
    description: "选中部件名称，为它登记编号。",
    instruction: "选中部件名称，再点击“顺序编号”；已有图纸编号可选“自定义编号”。",
  },
  {
    id: "convert",
    title: "复用权利要求生成草稿",
    book: "claims",
    selector: ".claims-description-tool > button",
    description: "把权利要求转换为说明书草稿。",
    instruction: "打开“说明书”工具，预览并复制内容，再到说明书粘贴。找不到章节标题仍可复制。",
  },
  {
    id: "description",
    title: "直接完善说明书",
    book: "description",
    selector: ".tiptap",
    description: "可以直接续写说明书。",
    instruction: "在说明书中继续撰写，需要时参考左侧章节标尺。",
  },
  {
    id: "dual",
    title: "并排对照写作",
    book: "description",
    selector: ".patent-split-controls",
    global: true,
    description: "对照另一份文档写说明书。",
    instruction: "点击“同屏双显”，选择要对照的文档。",
  },
  {
    id: "supplement",
    title: "增补遗漏的部件编号",
    book: "description",
    selector: ".patent-book-tools__supplement-reference-numbers",
    description: "给已登记的部件补上遗漏编号。",
    instruction: "点击“增补编号”，再核对处理结果。",
  },
  {
    id: "figures",
    title: "添加与整理附图",
    book: "description-drawings",
    selector: ".drawings-editor",
    description: "导入图片，或用CAD和流程图成图。",
    instruction: "添加图片后核对图序和清晰度。",
  },
  {
    id: "explanation",
    title: "看图填写附图说明",
    book: "description-drawings",
    selector: ".drawing-explanation-card textarea",
    description: "对照附图填写每张图的说明。",
    instruction: "每项以对应“图N”开头，最多200字；填完点击“填入说明书”。",
  },
  {
    id: "marks",
    title: "填入附图标记列表",
    book: "description",
    selector: ".reference-mark-panel",
    description: "整理部件名称与编号的对应关系。",
    instruction: "核对附图标记列表，再点击“填入说明书”。",
  },
  {
    id: "abstract",
    title: "完善说明书摘要",
    book: "abstract",
    selector: ".tiptap",
    description: "根据正文完善说明书摘要。",
    instruction: "在摘要中撰写，完成后对照正文核对。",
  },
  {
    id: "abstract-figure",
    title: "选择摘要附图",
    book: "abstract-drawing",
    selector: ".patent-book-tools__abstract-drawing-select",
    description: "从说明书附图中选择一张。",
    instruction: "在功能栏选择摘要附图；没有图片时先添加附图。",
  },
  {
    id: "check",
    title: "检查并人工复核",
    book: "description",
    selector: ".patent-book-tools__problem-check-button",
    description: "用本地检查发现问题并逐项核对。",
    instruction: "点击“本地检查”，查看并核对检查结果。",
  },
  {
    id: "export",
    title: "保存后预览导出",
    book: "description",
    selector: '.tool-bar [aria-label="导出"]',
    global: true,
    description: "确认已保存，再检查导出文件。",
    instruction: "点击“导出”，核对最终文件的图片、公式和分页。",
  },
];
export const guidanceGroups = [
  { title: "权利要求与编号", ids: ["write", "dependent", "number"] },
  { title: "生成说明书草稿", ids: ["convert"] },
  { title: "完善说明书", ids: ["description", "dual", "supplement"] },
  { title: "图纸与附图说明", ids: ["figures", "explanation", "marks"] },
  { title: "完成与复核", ids: ["abstract", "abstract-figure", "check", "export"] },
];

export function visibleGuidanceTarget(root: ParentNode, selector: string): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>(selector)].find((el) => {
      if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.top < window.innerHeight - 30 &&
        r.right > 0 &&
        r.left < window.innerWidth
      );
    }) ?? null
  );
}
export function guidancePosition(
  rect: DOMRect | null,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const maxTop = Math.max(12, viewportHeight - height - 36);
  if (!rect) return { left: Math.max(12, viewportWidth - width - 22), top: Math.min(124, maxTop) };
  const candidates = [
    { left: rect.right + 16, top: rect.top },
    { left: rect.left - width - 16, top: rect.top },
    { left: rect.left, top: rect.bottom + 16 },
    { left: rect.left, top: rect.top - height - 16 },
  ];
  return (
    candidates.find(
      (p) => p.left >= 12 && p.left + width <= viewportWidth - 12 && p.top >= 42 && p.top <= maxTop,
    ) ?? { left: Math.max(12, viewportWidth - width - 22), top: Math.min(124, maxTop) }
  );
}
