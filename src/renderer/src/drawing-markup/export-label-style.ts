export function exportLabelFont(kind: string, size: number) {
  return kind === "dwg" || kind === "dxf"
    ? `300 ${size}px "Segoe UI", Arial, sans-serif`
    : `400 ${size}px Arial, sans-serif`;
}

export function exportLeaderWidth(kind: string, width: number) {
  return kind === "dwg" || kind === "dxf" ? width * (0.18 / 0.25) : width;
}
