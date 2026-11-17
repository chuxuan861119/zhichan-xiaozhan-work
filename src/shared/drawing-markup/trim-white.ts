// Keep every nonwhite pixel, including antialiased hairlines. Call after compositing on white.
export function nonWhiteBounds(data: Uint8ClampedArray, width: number, height: number) {
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] && (data[i]! < 255 || data[i + 1]! < 255 || data[i + 2]! < 255)) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = y;
      }
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
