type Quote = {
  originalText: string;
  contextBefore?: string | undefined;
  contextAfter?: string | undefined;
};

function splitsSurrogatePair(text: string, position: number): boolean {
  const before = text.charCodeAt(position - 1);
  const after = text.charCodeAt(position);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Exact, segment-local matching only. Never guess an occurrence or normalize user text. */
export function locateExactQuote(
  text: string,
  quote: Quote,
): { startOffset: number; endOffset: number } | null {
  if (!quote.originalText) return null;
  let match: { startOffset: number; endOffset: number } | null = null;
  let start = text.indexOf(quote.originalText);
  while (start !== -1) {
    const end = start + quote.originalText.length;
    const before = quote.contextBefore ?? "";
    const after = quote.contextAfter ?? "";
    if (
      !splitsSurrogatePair(text, start) &&
      !splitsSurrogatePair(text, end) &&
      text.slice(Math.max(0, start - before.length), start) === before &&
      text.slice(end, end + after.length) === after
    ) {
      if (match) return null;
      match = { startOffset: start, endOffset: end };
    }
    start = text.indexOf(quote.originalText, start + 1);
  }
  return match;
}
