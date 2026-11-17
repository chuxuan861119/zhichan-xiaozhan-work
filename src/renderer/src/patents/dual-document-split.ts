import { DUAL_PANE_DIVIDER_WIDTH, minimumDualPaneWidth } from "./dual-pane-layout-budget";

/** 同屏双文档默认等宽：左栏占比 50%。 */
export const DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT = 50;

/** 拖动分隔线时每侧完整显示 52% A4 页面所需的宽度（px）。 */
export const DUAL_DOCUMENT_MIN_PANE_WIDTH_PX = minimumDualPaneWidth();

/** 任一侧的硬下限占比：窗口再宽也不把某侧压到 20% 以下。 */
export const DUAL_DOCUMENT_MIN_SPLIT_PERCENT = 20;

/** 任一侧的硬上限占比，与下限对称，同时用于分隔线的 ARIA 取值范围。 */
export const DUAL_DOCUMENT_MAX_SPLIT_PERCENT = 100 - DUAL_DOCUMENT_MIN_SPLIT_PERCENT;

/**
 * 拖动中线时向等宽位置吸附的半径（px）：指针进入这个范围就贴回严格 50%。
 * 取 20px 是为了比 15px 的抓取区略宽一点，拖回中间时不会在边缘反复抖动。
 */
export const DUAL_DOCUMENT_CENTER_SNAP_RADIUS_PX = 20;

/**
 * 左栏占比的允许区间。下限按每侧页面的最低可读宽度计算，
 * 容器很窄时退化为等宽（区间收拢到 50%），避免把某一侧拖没。
 */
export function dualDocumentSplitRange(
  containerWidth: number,
  minimumWidths: readonly [number, number] = [
    DUAL_DOCUMENT_MIN_PANE_WIDTH_PX,
    DUAL_DOCUMENT_MIN_PANE_WIDTH_PX,
  ],
): Readonly<{ min: number; max: number }> {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return { min: DUAL_DOCUMENT_MIN_SPLIT_PERCENT, max: DUAL_DOCUMENT_MAX_SPLIT_PERCENT };
  }
  const width = Math.max(1, containerWidth - DUAL_PANE_DIVIDER_WIDTH);
  const min = Math.max(
    DUAL_DOCUMENT_MIN_SPLIT_PERCENT,
    Math.ceil((minimumWidths[0] / width) * 10000) / 100,
  );
  const max = Math.min(
    DUAL_DOCUMENT_MAX_SPLIT_PERCENT,
    Math.floor((1 - minimumWidths[1] / width) * 10000) / 100,
  );
  return min <= max ? { min, max } : { min: 50, max: 50 };
}

/** 把左栏占比夹进允许区间并保留两位小数，保证拖出的数值稳定可比较。 */
export function clampDualDocumentSplitPercent(
  percent: number,
  containerWidth: number,
  minimumWidths?: readonly [number, number],
): number {
  if (!Number.isFinite(percent)) return DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT;
  const { min, max } = dualDocumentSplitRange(containerWidth, minimumWidths);
  return Math.round(Math.min(max, Math.max(min, percent)) * 100) / 100;
}

/**
 * 拖动分隔线后的左栏占比：横向位移按容器宽度折算成占比，两侧此消彼长，
 * 因此一次拖动会同时改变两侧文档的宽度。
 *
 * 从非等宽位置拖回中间时，结果落在等宽附近就直接吸附到 50%，用户不用像素级对齐。
 * 从 50% 开始向外拖动时，调用方会在离开吸附区后重新启用吸附，避免起步产生死区，
 * 同时保证同一次手势拖出去再返回时仍能贴回中心。
 */
export function dualDocumentSplitPercentAfterDrag(
  startPercent: number,
  deltaX: number,
  containerWidth: number,
  minimumWidths?: readonly [number, number],
  centerSnapArmed = startPercent !== DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT,
): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return startPercent;
  const percent =
    startPercent + (deltaX / Math.max(1, containerWidth - DUAL_PANE_DIVIDER_WIDTH)) * 100;
  const distanceFromCenterPx =
    (Math.abs(percent - DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT) * containerWidth) / 100;
  return clampDualDocumentSplitPercent(
    centerSnapArmed && distanceFromCenterPx <= DUAL_DOCUMENT_CENTER_SNAP_RADIUS_PX
      ? DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT
      : percent,
    containerWidth,
    minimumWidths,
  );
}

/** 左栏占比是否正好停在等宽位置——拖动时吸附成功就是这个结果。 */
export function dualDocumentSplitIsCentered(percent: number): boolean {
  return percent === DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT;
}

function gridFraction(percent: number): number {
  return Math.round((percent / DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT) * 10000) / 10000;
}

/**
 * 分栏网格模板。等宽时保持原有 `1fr/1fr` 写法（未拖动过的布局字符串不变），
 * 否则按占比输出 fr 值；分隔线列仍是 auto，1fr 合计为 2 不会挤爆容器。
 */
export function dualDocumentSplitTemplate(percent: number): string {
  if (percent === DUAL_DOCUMENT_DEFAULT_SPLIT_PERCENT) {
    return "minmax(0, 1fr) auto minmax(0, 1fr)";
  }
  return `minmax(0, ${gridFraction(percent)}fr) auto minmax(0, ${gridFraction(100 - percent)}fr)`;
}
