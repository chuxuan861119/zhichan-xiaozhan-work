type NumberToken = { value: number; from: number; to: number };

export const CLAIM_REFERENCE_MARKER_SOURCE = String.raw`权\s*利\s*要\s*求`;
const numberSource = String.raw`(?:第\s*)?([0-9０-９]+)(?:\s*项)?`;
const firstNumber = new RegExp(String.raw`^\s*${numberSource}`, "u");
const connector = new RegExp(
  String.raw`^\s*((?:[,，、]\s*)?(?:或者|或|以及|和|及|与)|、|,|，|[-－—–~～至到])\s*(?:${CLAIM_REFERENCE_MARKER_SOURCE}\s*)?${numberSource}`,
  "u",
);
const choiceSuffix = /^\s*(?:中(?:的)?)?(任意一项|任意一|任意|任一项|任一|一项)/u;
const maxReferences = 1000;

export type ClaimReferenceExpression = {
  from: number;
  to: number;
  parts: Array<{ first: NumberToken; last?: NumberToken }>;
  numbers: number[];
  alternative: boolean;
  /** Inspection recognizes more notation than automatic editing may safely change. */
  editable: boolean;
};

export type ClaimReferenceParseResult = {
  expressions: ClaimReferenceExpression[];
  numbers: number[];
  alternative: boolean;
  error?: string;
};

/** Parse original text, retaining UTF-16 offsets. Never normalize the source string. */
export function parseClaimReferences(text: string): ClaimReferenceParseResult {
  const expressions: ClaimReferenceExpression[] = [];
  const allNumbers = new Set<number>();
  const result = (error?: string): ClaimReferenceParseResult => ({
    expressions,
    numbers: [...allNumbers],
    alternative:
      !error &&
      expressions.length > 0 &&
      expressions.every((e) => e.alternative || e.numbers.length <= 1) &&
      expressions.some((e) => e.alternative),
    ...(error ? { error } : {}),
  });
  const unreadable = () => result("引用编号无法完整识别，请人工核对引用写法。");
  let consumed = 0;
  for (const marker of text.matchAll(new RegExp(CLAIM_REFERENCE_MARKER_SOURCE, "gu"))) {
    if (marker.index < consumed) continue;
    let cursor = marker.index + marker[0].length;
    if (/^\s*书/u.test(text.slice(cursor))) continue;
    const firstMatch = firstNumber.exec(text.slice(cursor));
    if (!firstMatch?.[1]) return unreadable();
    let editable = true;
    const token = (match: string, digits: string, offset: number): NumberToken => {
      if (/第|项|[０-９]/u.test(match)) editable = false;
      const from = offset + match.lastIndexOf(digits);
      return { value: Number(digits.normalize("NFKC")), from, to: from + digits.length };
    };
    const parts: ClaimReferenceExpression["parts"] = [
      { first: token(firstMatch[0], firstMatch[1], cursor) },
    ];
    cursor += firstMatch[0].length;
    let hasOr = false;
    let hasAnd = false;
    for (;;) {
      const next = connector.exec(text.slice(cursor));
      if (!next?.[1] || !next[2]) break;
      const number = token(next[0], next[2], cursor);
      if (/^[-－—–~～至到]$/u.test(next[1])) {
        const part = parts.at(-1);
        if (!part || part.last) return unreadable();
        part.last = number;
      } else {
        hasOr ||= /或/u.test(next[1]);
        hasAnd ||= /以及|和|及|与/u.test(next[1]);
        parts.push({ first: number });
      }
      cursor += next[0].length;
    }
    const tail = text.slice(cursor);
    const incompleteTail =
      /^\s*(?:[,，、；;。：:]\s*)+(?:或者|或|以及|及|和|与|至|到|[-－—–~～]|[0-9０-９])/u.test(
        tail,
      ) ||
      !/^\s*(?:(?:中(?:的)?)?(?:任意一项|任意一|任意|任一项|任一|一项)?\s*(?:所述|所记载|限定|的|[，,；;。：:]|$))/u.test(
        tail,
      );
    const numbers = new Set<number>();
    for (const part of parts) {
      const start = part.first.value;
      const end = part.last?.value ?? start;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
        return result("引用范围无效，请检查起止编号。");
      if (end - start + 1 > maxReferences)
        return result("引用范围过大，未展开超过1000项的引用，请核对编号。");
      for (let n = start; n <= end; n++) {
        numbers.add(n);
        allNumbers.add(n);
        if (allNumbers.size > maxReferences) {
          allNumbers.delete(n);
          return result("引用范围过大，未展开超过1000项的引用，请核对编号。");
        }
      }
    }
    expressions.push({
      from: marker.index,
      to: cursor,
      parts,
      numbers: [...numbers],
      alternative: !hasAnd && (hasOr || choiceSuffix.test(tail)),
      editable: editable && !hasAnd,
    });
    consumed = cursor;
    // Inspection can still flag a definitely missing number; incomplete syntax is
    // explicitly reported and the editing adapter rejects the entire operation.
    if (incompleteTail) return unreadable();
    if (hasAnd && (hasOr || choiceSuffix.test(tail)))
      return result("引用同时包含并列和择一表述，含义不明确，请人工核对引用写法。");
  }
  return result();
}

/** Automatic renumbering is atomic and refuses ambiguous or inspection-only notation. */
export function claimReferenceExpressions(text: string): ClaimReferenceExpression[] | null {
  const parsed = parseClaimReferences(text);
  return parsed.error || parsed.expressions.some((expression) => !expression.editable)
    ? null
    : parsed.expressions;
}
