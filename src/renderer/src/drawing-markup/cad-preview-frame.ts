import type { CadCheckpoint } from "../../../shared/drawing-markup/cad-state";

type Frame = { width: number; height: number; cad: Pick<CadCheckpoint, "mapping"> };
const close = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(1e-6, Math.max(Math.abs(a), Math.abs(b)) * 1e-7);

/** Check the actual vector viewBox, not its rounded raster thumbnail dimensions. */
export function cadPreviewFrameMatches(bytes: Uint8Array, frame: Frame): boolean {
  const root = new DOMParser().parseFromString(
    new TextDecoder().decode(bytes),
    "image/svg+xml",
  ).documentElement;
  const box = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  return (
    root.localName === "svg" &&
    !!box &&
    box.length === 4 &&
    box.every(Number.isFinite) &&
    close(box[0]!, 0) &&
    close(box[1]!, 0) &&
    close(box[2]!, frame.width / frame.cad.mapping.scale) &&
    close(box[3]!, frame.height / frame.cad.mapping.scale)
  );
}

/** Never publish a new preview with a different frame under old page coordinates. */
export function assertCadPreviewFrame(expected: Frame, prepared: Frame): void {
  if (
    !close(expected.width, prepared.width) ||
    !close(expected.height, prepared.height) ||
    !close(expected.cad.mapping.originX, prepared.cad.mapping.originX) ||
    !close(expected.cad.mapping.originY, prepared.cad.mapping.originY) ||
    !close(expected.cad.mapping.scale, prepared.cad.mapping.scale)
  ) {
    throw new Error("CAD 底图坐标范围与工作稿不一致，未发布错位底图。请重试保存。");
  }
}
