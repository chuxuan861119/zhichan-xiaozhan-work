export type DescriptionReferenceNumber = Readonly<{ text: string; number: number }>;

const PARENTHESIZED = /^[\t \u3000]*[（(][\t \u3000]*([0-9０-９]+)[\t \u3000]*[)）]/u;
const BARE = /^[\t \u3000]*([0-9０-９]+)/u;
// Bare numbers in quantities, measurements, decimals and ranges are not reference marks.
const QUANTITY_SUFFIX =
  /^[\t \u3000]*(?:[a-zA-ZµμΩ℃℉°%％‰²³]|[.．,，][0-9０-９]|[-－—~～至到×*/／:：][\t \u3000]*[0-9０-９]|毫米|厘米|分米|千米|微米|纳米|米|毫升|升|千克|公斤|毫克|克|吨|牛顿|帕|伏|安培|瓦|赫兹|欧姆|摄氏|度|秒|分钟|小时|天|年|倍|个|件|套|条|根|片|块|枚|台|组(?!成|装)|次(?!级))/u;

/** Shared by description keyword rendering and issue detection; never changes document text. */
export function descriptionReferenceNumberSuffix(text: string): DescriptionReferenceNumber | null {
  const parenthesized = text.match(PARENTHESIZED);
  const match = parenthesized ?? text.match(BARE);
  if (!match) return null;
  const complete = match[0];
  if (!parenthesized && QUANTITY_SUFFIX.test(text.slice(complete.length))) return null;
  const digits = (match[1] ?? "").replace(/[０-９]/gu, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - "０".charCodeAt(0) + "0".charCodeAt(0)),
  );
  return { text: complete, number: Number(digits) };
}

/** Find number evidence after a word, excluding figure/claim citations and ordinary quantities. */
export function descriptionReferenceNumberRanges(text: string): Array<{
  from: number;
  to: number;
  number: number;
}> {
  const ranges: Array<{ from: number; to: number; number: number }> = [];
  for (const match of text.matchAll(
    /[（(][\t \u3000]*[0-9０-９]+[\t \u3000]*[)）]|[0-9０-９]+/gu,
  )) {
    const from = match.index;
    const prefix = text.slice(0, from).trimEnd();
    if (!/\p{Script=Han}$/u.test(prefix)) continue;
    if (/[0-9０-９][\t \u3000]*[至到]$/u.test(prefix)) continue;
    if (
      /(?:图|表|实施例|实施方式|权利要求|步骤|第|共|约|为|等于|小于|大于|至少|最多|不超过)$/u.test(
        prefix,
      )
    )
      continue;
    const suffix = descriptionReferenceNumberSuffix(text.slice(from));
    if (suffix) ranges.push({ from, to: from + suffix.text.length, number: suffix.number });
  }
  return ranges;
}
