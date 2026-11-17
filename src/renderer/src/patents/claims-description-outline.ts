/** One closed outline, in CSS pixels, with tangent rounded corners. */
export function claimsDescriptionOutline(
  width: number,
  height: number,
  header: number,
  left: number,
): string {
  const r = 8;
  const x = Math.max(0, left) + 0.5;
  const right = width - 0.5;
  const bottom = height - 0.5;
  const seam = header + 0.5;
  const inner = Math.min(12, Math.max(0, x - r - 0.5));
  const top = left < 1 ? 0.5 : seam;
  return `M ${x + r} 0.5 H ${right - r} Q ${right} 0.5 ${right} ${r + 0.5} V ${bottom - r} Q ${right} ${bottom} ${right - r} ${bottom} H ${r + 0.5} Q 0.5 ${bottom} 0.5 ${bottom - r} V ${top + r} Q 0.5 ${top} ${r + 0.5} ${top} ${left < 1 ? "" : `H ${x - inner} Q ${x} ${seam} ${x} ${seam - inner} V ${r + 0.5} Q ${x} 0.5 ${x + r} 0.5`} Z`;
}
