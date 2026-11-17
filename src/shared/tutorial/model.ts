import { z } from "zod";
import { appResultSchema } from "../ipc/result.js";
import type { CanonicalPatent, PatentBookKind } from "../patent/model.js";

export const TutorialLessonIdSchema = z.enum([
  "clear-format",
  "dependent-claim",
  "sequential-number",
  "custom-number",
  "supplement-number",
  "invention-content",
  "embodiments",
  "cad-label",
  "figure-sort",
]);
export type TutorialLessonId = z.infer<typeof TutorialLessonIdSchema>;
export const TutorialContextSchema = z
  .object({
    sessionId: z.string().uuid(),
    lessonId: TutorialLessonIdSchema,
    patentId: z.string().uuid(),
    baseline: z
      .object({
        paragraphId: z.string().uuid(),
        figureOrder: z.array(z.string().uuid()).max(3),
      })
      .strict(),
  })
  .strict();
export type TutorialContext = z.infer<typeof TutorialContextSchema>;
export const TutorialContextResultSchema = appResultSchema(TutorialContextSchema.nullable());
export const TutorialPreparedResultSchema = appResultSchema(TutorialContextSchema);

export type TutorialLesson = Readonly<{
  id: TutorialLessonId;
  title: string;
  group: string;
  summary: string;
  book: PatentBookKind;
  selector: string;
  steps: readonly string[];
  result: string;
}>;
export const TUTORIAL_LESSONS: readonly TutorialLesson[] = [
  {
    id: "clear-format",
    title: "清除多余格式",
    group: "文字整理",
    summary: "让粘贴的正文恢复统一排版",
    book: "description",
    selector: ".patent-book-tools__clear-extra-formatting",
    steps: [
      "观察示例正文中的彩色、斜体和下划线。",
      "点击工具栏的“清除多余格式”，按提示确认。",
      "核对文字保留，正文恢复统一格式。",
    ],
    result: "文字保留，多余格式已清除。",
  },
  {
    id: "dependent-claim",
    title: "插入从权",
    group: "权利要求",
    summary: "快速生成从属权利要求的引用句式",
    book: "claims",
    selector: ".patent-book-tools__insert-dependent-claim",
    steps: [
      "将光标放在第一项权利要求末尾。",
      "点击“插入从权”，按工具提示选择引用。",
      "检查新增的从属权利要求，继续补充技术特征。",
    ],
    result: "已插入引用前项的从属权利要求。",
  },
  {
    id: "sequential-number",
    title: "顺序编号",
    group: "附图标记",
    summary: "选中部件名称，一次登记并写入标号",
    book: "claims",
    selector: '[data-numbering-help="sequential"]',
    steps: [
      "在权利要求书中选中“底座”二字。",
      "在“附图标记”中点击“顺序编号”。",
      "检查标记列表和正文：底座对应编号 1。",
    ],
    result: "底座—1 已登记并写入正文。",
  },
  {
    id: "custom-number",
    title: "自定义编号",
    group: "附图标记",
    summary: "按照自己的图纸指定部件编号",
    book: "claims",
    selector: '[data-numbering-help="custom"]',
    steps: [
      "在权利要求书中选中“夹持板”三字。",
      "点击“自定义编号”，输入 10 后确认。",
      "检查正文及标记列表中的“夹持板—10”。",
    ],
    result: "夹持板—10 已登记并写入正文。",
  },
  {
    id: "supplement-number",
    title: "增补编号",
    group: "附图标记",
    summary: "为正文中遗漏的同名部件补上已有编号",
    book: "description",
    selector: ".patent-book-tools__supplement-reference-numbers",
    steps: [
      "标记列表已有“底座—1”，具体实施方式仍未标号。",
      "点击“增补编号”，检查工具提示后确认。",
      "核对具体实施方式中的两处“底座”都补上编号。",
    ],
    result: "已有标记保留，遗漏编号已补齐。",
  },
  {
    id: "invention-content",
    title: "转换成发明内容",
    group: "权利要求",
    summary: "把权利要求转换为说明书章节草稿",
    book: "claims",
    selector: ".claims-description-tool > button",
    steps: [
      "在转换菜单选择“发明内容”，检查生成预览。",
      "点击复制，跳转到说明书的“发明内容”章节。",
      "将草稿粘贴到标题下，并核对、修改技术表达。",
    ],
    result: "发明内容草稿已写入说明书。",
  },
  {
    id: "embodiments",
    title: "转换成具体实施方式",
    group: "权利要求",
    summary: "生成便于继续扩写的实施方式起稿",
    book: "claims",
    selector: ".claims-description-tool > button",
    steps: [
      "在转换菜单选择“具体实施方式”，检查预览。",
      "点击复制，跳转到说明书的对应章节。",
      "将草稿粘贴到标题下，后续还需补充实施细节。",
    ],
    result: "具体实施方式草稿已写入说明书。",
  },
  {
    id: "cad-label",
    title: "CAD 标号",
    group: "图纸",
    summary: "在教学图纸中练习引线和部件标号",
    book: "description-drawings",
    selector: ".cad-markup-entry",
    steps: [
      "点击“CAD 标号”，打开已准备的教学图纸。",
      "选择标号工具，按画布提示绘制引线并放置编号。",
      "完成一个标号，观察图纸中的编号和引线。",
    ],
    result: "教学图纸已新增有效标号。",
  },
  {
    id: "figure-sort",
    title: "附图排序",
    group: "图纸",
    summary: "调整附图顺序，让图号与说明一致",
    book: "description-drawings",
    selector: ".drawing-sort-button",
    steps: [
      "示例附图目前顺序为局部图、整体图、侧视图。",
      "使用“附图排序”，或拖动附图列表调整顺序。",
      "将顺序改为：整体图 → 侧视图 → 局部图。",
    ],
    result: "三张附图已按整体、侧面、局部排列。",
  },
];
export function tutorialLesson(id: TutorialLessonId): TutorialLesson {
  return TUTORIAL_LESSONS.find((lesson) => lesson.id === id)!;
}

function paragraphs(patent: CanonicalPatent, kind: PatentBookKind) {
  return (
    patent.books
      .find((book) => book.kind === kind)
      ?.document.content.filter((node) => node.type === "paragraph") ?? []
  );
}
function plainText(node: ReturnType<typeof paragraphs>[number]): string {
  return node.content.map((item) => (item.type === "text" ? item.text : "")).join("");
}
export function tutorialCompleted(
  context: TutorialContext,
  patent: CanonicalPatent | null,
  copiedTarget: string | null = null,
): boolean {
  if (!patent || patent.patentId !== context.patentId) return false;
  const body = paragraphs(patent, "description");
  const exercise = patent.books
    .flatMap((book) => paragraphs(patent, book.kind))
    .find((node) => node.id === context.baseline.paragraphId);
  const text = exercise ? plainText(exercise) : "";
  switch (context.lessonId) {
    case "clear-format":
      return (
        !!exercise &&
        text === "底座上设置夹持板，调节杆带动夹持板移动。" &&
        exercise.content.every((item) => item.type !== "text" || item.marks.length === 0)
      );
    case "dependent-claim":
      return paragraphs(patent, "claims").some((node) =>
        /(?:根据|如)权利要求\s*1\s*所述/u.test(plainText(node)),
      );
    case "sequential-number":
    case "custom-number": {
      const keyword = context.lessonId === "custom-number" ? "夹持板" : "底座";
      const number = context.lessonId === "custom-number" ? 10 : 1;
      return (
        patent.referenceMarks.some((mark) => mark.keyword === keyword && mark.number === number) &&
        new RegExp(`${keyword}[（(]?${number}(?!\\d)`, "u").test(text)
      );
    }
    case "supplement-number":
      return (
        patent.referenceMarks.some((mark) => mark.keyword === "底座" && mark.number === 1) &&
        (text.match(/底座[（(]?1(?!\d)/gu)?.length ?? 0) >= 2
      );
    case "invention-content":
    case "embodiments": {
      const title = context.lessonId === "invention-content" ? "发明内容" : "具体实施方式";
      const start = body.findIndex((node) => plainText(node).trim() === title);
      if (copiedTarget !== title || start < 0) return false;
      const next = body
        .slice(start + 1)
        .findIndex((node) => /^(?:发明内容|具体实施方式|附图说明)$/u.test(plainText(node).trim()));
      const section = body
        .slice(start + 1, next < 0 ? undefined : start + 1 + next)
        .map(plainText)
        .join("");
      return section.includes("底座") && section.includes("夹持板") && section.includes("调节杆");
    }
    case "cad-label":
      return patent.drawingProjects.some((project) =>
        project.annotations.some(
          (annotation) => annotation.text.trim().length > 0 && annotation.points.length >= 2,
        ),
      );
    case "figure-sort":
      return (
        context.baseline.figureOrder.length === 3 &&
        patent.figures.length === 3 &&
        patent.figures.every(
          (figure, index) => figure.figureId === context.baseline.figureOrder[index],
        )
      );
  }
}
