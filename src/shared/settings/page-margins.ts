import { z } from "zod";
import type { PageSettings } from "../document/model.js";

/**
 * 页边距领域模块：schema、Word 默认值、预设、投影同步与组合校验工具。
 *
 * 约定：
 * - 数据层统一使用 mm（与 `PageSettings.margin*Mm` 对齐），UI 层才做 cm 换算；
 * - `AppSettings.pageMargins` 是唯一权威来源，`document.page.margin*Mm` 是其持久化投影；
 * - 单边约束 0 ~ 60mm 由 schema 保证；覆盖 Word“宽”预设的 50.8mm；四边之和约束依赖纸张尺寸，在渲染层 Dialog 校验。
 */

export const PAGE_MARGIN_MIN_MM = 0;
export const PAGE_MARGIN_MAX_MM = 60;

/** 单边约束：0 ~ 60mm，覆盖 Word“宽”预设的 50.8mm；字段名与 PageSettings 对齐（margin*Mm）。 */
export const PageMarginsSchema = z
  .object({
    marginTopMm: z.number().nonnegative().max(PAGE_MARGIN_MAX_MM),
    marginRightMm: z.number().nonnegative().max(PAGE_MARGIN_MAX_MM),
    marginBottomMm: z.number().nonnegative().max(PAGE_MARGIN_MAX_MM),
    marginLeftMm: z.number().nonnegative().max(PAGE_MARGIN_MAX_MM),
  })
  .strict();
export type PageMargins = z.infer<typeof PageMarginsSchema>;

/** Word A4 普通模板默认：上下 25.4mm、左右 31.7mm（唯一常量定义处）。 */
export const DEFAULT_PAGE_MARGINS: PageMargins = {
  marginTopMm: 25.4,
  marginRightMm: 31.7,
  marginBottomMm: 25.4,
  marginLeftMm: 31.7,
};

/**
 * P2：Word 预设（cm 值，与中文用户习惯一致）。选择后由 Dialog 换算为 mm 填充四边。
 * - normal: 普通（上下 2.54 / 左右 3.17）
 * - narrow: 窄（四边 1.27）
 * - moderate: 适中（上下 2.54 / 左右 1.91）
 * - wide: 宽（上下 2.54 / 左右 5.08）
 */
export const WORD_MARGIN_PRESETS_CM = {
  normal: { label: "普通", top: 2.54, right: 3.17, bottom: 2.54, left: 3.17 },
  narrow: { label: "窄", top: 1.27, right: 1.27, bottom: 1.27, left: 1.27 },
  moderate: { label: "适中", top: 2.54, right: 1.91, bottom: 2.54, left: 1.91 },
  wide: { label: "宽", top: 2.54, right: 5.08, bottom: 2.54, left: 5.08 },
} as const;
export type WordMarginPresetKey = keyof typeof WORD_MARGIN_PRESETS_CM;

/** 把全局边距写入 PageSettings（投影同步核心工具）。 */
export function applyPageMarginsToPage(page: PageSettings, margins: PageMargins): PageSettings {
  return {
    ...page,
    marginTopMm: margins.marginTopMm,
    marginRightMm: margins.marginRightMm,
    marginBottomMm: margins.marginBottomMm,
    marginLeftMm: margins.marginLeftMm,
  };
}

/** 校验 margin 值是否与给定页面兼容；返回中文错误文案或 null。 */
export function validatePageMargins(
  margins: PageMargins,
  pageWidthMm: number,
  pageHeightMm: number,
): string | null {
  const values = [
    margins.marginTopMm,
    margins.marginRightMm,
    margins.marginBottomMm,
    margins.marginLeftMm,
  ];
  if (values.some((value) => !Number.isFinite(value))) {
    return "页边距必须是有效数字。";
  }
  if (values.some((value) => value < PAGE_MARGIN_MIN_MM)) {
    return `页边距不能小于 ${PAGE_MARGIN_MIN_MM}mm。`;
  }
  if (values.some((value) => value > PAGE_MARGIN_MAX_MM)) {
    return `单边页边距不能超过 ${PAGE_MARGIN_MAX_MM}mm。`;
  }
  if (!Number.isFinite(pageWidthMm) || !Number.isFinite(pageHeightMm)) {
    return "页面尺寸无效，无法校验页边距。";
  }
  if (margins.marginTopMm + margins.marginBottomMm > pageHeightMm - 10) {
    return "上、下边距之和过大，页面至少需保留 10mm 内容区。";
  }
  if (margins.marginLeftMm + margins.marginRightMm > pageWidthMm - 10) {
    return "左、右边距之和过大，页面至少需保留 10mm 内容区。";
  }
  return null;
}

/** 通用文档白页 CSS 变量名（注入 `.editor-paper`）。 */
export const EDITOR_PAGE_CSS_VARS = {
  width: "--editor-page-width",
  height: "--editor-page-height",
  marginTop: "--editor-page-margin-top",
  marginRight: "--editor-page-margin-right",
  marginBottom: "--editor-page-margin-bottom",
  marginLeft: "--editor-page-margin-left",
} as const;

/** 专利书册白页 CSS 变量名（注入 `.patent-page-with-rail`）。 */
export const PATENT_PAGE_MARGIN_CSS_VARS = {
  top: "--patent-page-margin-top",
  right: "--patent-page-margin-right",
  bottom: "--patent-page-margin-bottom",
  left: "--patent-page-margin-left",
} as const;
