/** Export-only proportions, measured from the visible drawing, before adding labels. */
export function automaticAnnotationStyle(
  content: { width: number; height: number },
  labelScale = 1,
) {
  if (!Number.isFinite(content.width) || !Number.isFinite(content.height)) return null;
  if (content.width <= 0 || content.height <= 0) return null;

  // A roughly square drawing at 120 mm wide uses a 7 mm label and 0.25 mm leader.
  // Keep the same output proportions for whole drawings and differently shaped crops.
  const ratio = Number.isFinite(labelScale) ? Math.min(2, Math.max(0.5, labelScale)) : 1;
  const fontSize = content.width * (7 / 120) * ratio;
  const lineWidth = content.width * (0.25 / 120);
  return { fontSize, lineWidth };
}
