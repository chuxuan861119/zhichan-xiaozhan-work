export type DrawingReference = Readonly<{
  start: number;
  end: number;
  text: string;
  first: number;
  last: number;
}>;

function figureNumber(text: string): number {
  if (/^\d+$/u.test(text)) return Number(text);
  const digits = "零一二三四五六七八九";
  const tens = text.indexOf("十");
  if (tens >= 0)
    return (
      (tens === 0 ? 1 : digits.indexOf(text.charAt(0))) * 10 +
      (text[tens + 1] ? digits.indexOf(text.charAt(tens + 1)) : 0)
    );
  return Number([...text].map((character) => digits.indexOf(character)).join(""));
}

// Full-width digits are one UTF-16 unit too, so offsets remain in the source text.
export function drawingReferences(text: string): DrawingReference[] {
  const normalized = text.replace(/[０-９]/gu, (digit) => String(digit.charCodeAt(0) - 0xff10));
  const result: DrawingReference[] = [];
  for (const match of normalized.matchAll(
    /图\s*(?:\d+|[零一二三四五六七八九十]+)(?:(?:\s*(?:、|,|，|和|及|与|至|到|[-~～—])\s*)(?:图\s*)?(?:\d+|[零一二三四五六七八九十]+))*/gu,
  )) {
    const start = match.index;
    const after = normalized.slice(start + match[0].length);
    // Chinese numerals need a reference boundary, otherwise “示意图一般” becomes “图一”.
    if (
      /[零一二三四五六七八九十]$/u.test(match[0]) &&
      /^\p{Script=Han}/u.test(after) &&
      !/^(?:所示|示出|为|是|的|中|上|下|和|及|与|表示|显示)/u.test(after)
    )
      continue;
    const before =
      normalized
        .slice(0, start)
        .split(/[。！？；;\n]/u)
        .at(-1) ?? "";
    // Only explicit external attribution is excluded; a later local attribution wins.
    const external =
      [...before.matchAll(/现有技术|对比文件|文献|公开(?:号|文本)|CN\d+/gu)].at(-1)?.index ?? -1;
    const local = [...before.matchAll(/本发明|本实用新型|本申请|本实施例/gu)].at(-1)?.index ?? -1;
    if (external >= 0 && external > local) continue;
    const parts = [...match[0].matchAll(/\d+|[零一二三四五六七八九十]+/gu)];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part) continue;
      let last = figureNumber(part[0]);
      const next = parts[index + 1];
      if (next && /至|到|[-~～—]/u.test(match[0].slice(part.index + part[0].length, next.index))) {
        last = figureNumber(next[0]);
        index++;
      }
      result.push({
        start,
        end: start + match[0].length,
        text: text.slice(start, start + match[0].length),
        first: figureNumber(part[0]),
        last,
      });
    }
  }
  return result;
}
