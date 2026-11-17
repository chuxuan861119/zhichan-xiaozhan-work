/** Deterministic safeguards complement, but cannot replace, human technical review. */
export function replacementSafetyReason(original: string, replacement: string): string | null {
  if (original === replacement) return "建议与原文相同。";
  if (/[\uFFFC\r\n]/u.test(original + replacement)) return "涉及换行或行内对象，请人工修改。";
  const protectedTokens = (text: string) =>
    text.match(
      /\d+(?:[.,]\d+)*|[a-zA-ZμΩ℃°%]+|毫米|厘米|千米|微米|纳米|毫升|公斤|千克|摄氏度|不|无|非|未|仅|至少|至多|以上|以下|大于|小于|至|[~～±≤≥<>]/gu,
    ) ?? [];
  if (JSON.stringify(protectedTokens(original)) !== JSON.stringify(protectedTokens(replacement))) {
    return "涉及数值、单位、范围或否定含义变化，请人工核对。";
  }
  const a = Array.from(original),
    b = Array.from(replacement);
  let start = 0,
    endA = a.length,
    endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if ((endA - start) * (endB - start) > 2_000_000)
    return "修改范围过大，无法安全保留原文格式，请人工修改。";
  return null;
}
