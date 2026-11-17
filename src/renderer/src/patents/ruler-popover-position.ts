export type RulerPopoverAnchor = { left: number; right: number; top: number; bottom: number };

export function rulerPopoverPosition(
  anchor: RulerPopoverAnchor,
  viewportWidth: number,
  viewportHeight: number,
) {
  const width = Math.min(136, Math.max(0, viewportWidth - 16));
  const topLimit = Math.max(8, anchor.top + 8);
  const bottomLimit = Math.min(viewportHeight - 8, anchor.bottom - 8);
  const height = Math.max(0, bottomLimit - topLimit);
  const left = Math.max(0, Math.min(viewportWidth - width - 8, anchor.left));
  return { left, top: topLimit, width, height };
}
