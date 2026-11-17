/** Screen-pixel slices of one document; never round each column independently. */
export function columnGeometry(position: number, height: number, documentHeight: number) {
  // Match the normal page's workspace gap. It travels with the document,
  // rather than reserving a permanent strip at the viewport edges.
  const outerGap = 20;
  const total = Math.max(documentHeight + outerGap * 2, height * 2);
  const max = Math.max(0, total - height * 2);
  const left = Math.max(0, Math.min(max, position));
  const right = left + height;
  return {
    left,
    right,
    max,
    contentLeft: left - outerGap,
    contentRight: right - outerGap,
    leftTop: outerGap - left,
    rightBottom: height + right - total + outerGap,
  };
}
