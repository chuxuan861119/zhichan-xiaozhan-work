import {
  PAGE_MARGIN_MAX_MM,
  PAGE_MARGIN_MIN_MM,
  type PageMargins,
} from "../../../shared/settings/page-margins";

/** 页边距 Dialog 的四个输入字段。 */
export type PageMarginField = "top" | "right" | "bottom" | "left";

export const PAGE_MARGIN_FIELDS: readonly PageMarginField[] = ["top", "right", "bottom", "left"];

export const PAGE_MARGIN_FIELD_LABELS: Record<PageMarginField, string> = {
  top: "上",
  right: "右",
  bottom: "下",
  left: "左",
};

/** mm → cm，保留 2 位小数（避免浮点噪声，如 25.4/10）。 */
export function mmToCm(mm: number): number {
  return Math.round((mm / 10) * 100) / 100;
}

/** cm → mm，保留 2 位小数（避免浮点噪声，如 3.17*10）。 */
export function cmToMm(cm: number): number {
  return Math.round(cm * 10 * 100) / 100;
}

/** 把数值格式化为 2 位小数字符串（如 2.54）。 */
export function formatCmInput(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/**
 * 解析用户输入的 cm 文本；非法（空、非数字、科学计数法等）返回 null。
 * 允许负数，由调用方按字段给出「不能小于 0」提示。
 */
export function parseCmInput(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (!/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 从四个 cm 输入构建 PageMargins（mm）。
 * 任一字段非法时返回 margins: null + 逐字段错误文案；全部合法才返回 mm 值。
 */
export function pageMarginsFromCmInput(input: Record<PageMarginField, string>): {
  margins: PageMargins | null;
  fieldErrors: Record<PageMarginField, string | null>;
} {
  const parsed = {
    top: parseCmInput(input.top),
    right: parseCmInput(input.right),
    bottom: parseCmInput(input.bottom),
    left: parseCmInput(input.left),
  };
  const fieldErrors: Record<PageMarginField, string | null> = {
    top: null,
    right: null,
    bottom: null,
    left: null,
  };
  for (const field of PAGE_MARGIN_FIELDS) {
    const valueCm = parsed[field];
    if (valueCm === null) {
      fieldErrors[field] = "请输入有效数字。";
      continue;
    }
    const valueMm = cmToMm(valueCm);
    if (valueMm < PAGE_MARGIN_MIN_MM) {
      fieldErrors[field] = `不能小于 ${PAGE_MARGIN_MIN_MM}mm。`;
    } else if (valueMm > PAGE_MARGIN_MAX_MM) {
      fieldErrors[field] = `不能超过 ${PAGE_MARGIN_MAX_MM}mm。`;
    }
  }
  if (PAGE_MARGIN_FIELDS.some((field) => fieldErrors[field] !== null)) {
    return { margins: null, fieldErrors };
  }
  return {
    margins: {
      marginTopMm: cmToMm(parsed.top ?? 0),
      marginRightMm: cmToMm(parsed.right ?? 0),
      marginBottomMm: cmToMm(parsed.bottom ?? 0),
      marginLeftMm: cmToMm(parsed.left ?? 0),
    },
    fieldErrors,
  };
}
