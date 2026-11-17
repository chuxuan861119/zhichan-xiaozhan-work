/** Rasterize native CAD in the requested world rectangle, including outside its saved frame. */
export function cadExportViewport(
  bytes: Uint8Array,
  frame: { width: number; height: number },
  box: { x: number; y: number; width: number; height: number },
) {
  const svg = new TextDecoder().decode(bytes);
  const opening = svg.match(/^<svg\b[^>]*>/u)?.[0];
  const view = opening
    ?.match(/\bviewBox="([^"]+)"/u)?.[1]
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (
    !opening ||
    !view ||
    view.length !== 4 ||
    !view.every(Number.isFinite) ||
    view[2]! <= 0 ||
    view[3]! <= 0 ||
    frame.width <= 0 ||
    frame.height <= 0
  )
    throw new Error("CAD 成图坐标无效，请重新保存图纸后重试。");
  const sx = view[2]! / frame.width;
  const sy = view[3]! / frame.height;
  const viewport = [view[0]! + box.x * sx, view[1]! + box.y * sy, box.width * sx, box.height * sy];
  const pixelScale = Math.min(1, 2000 / Math.max(box.width, box.height));
  const reframed = opening
    .replace(/\bviewBox="[^"]+"/u, `viewBox="${viewport.join(" ")}"`)
    .replace(/\bwidth="[^"]+"/u, `width="${Math.max(1, Math.ceil(box.width * pixelScale))}"`)
    .replace(/\bheight="[^"]+"/u, `height="${Math.max(1, Math.ceil(box.height * pixelScale))}"`);
  return new TextEncoder().encode(svg.replace(opening, reframed));
}
