import { claimReferenceExpressions, parseClaimReferences } from "./claim-reference-expression.js";

test.each(["-", "－", "—", "–", "~", "～", "至", "到"])(
  "expands %s identically and retains source offsets",
  (separator) => {
    const source = `🧪 根据权利\n要求 2${separator}4中的任一项所述的装置`;
    const parsed = parseClaimReferences(source);
    expect(parsed.error).toBeUndefined();
    expect(parsed.numbers).toEqual([2, 3, 4]);
    expect(parsed.alternative).toBe(true);
    const part = parsed.expressions[0]?.parts[0];
    expect(source.slice(part?.first.from, part?.first.to)).toBe("2");
    expect(source.slice(part?.last?.from, part?.last?.to)).toBe("4");
    expect(claimReferenceExpressions(source)).toEqual(parsed.expressions);
  },
);

test("inspection-only numeral forms keep their original positions and never become edit instructions", () => {
  const source = "🧪 权利要求第 ２ 项或者第 9 项所述的装置";
  const parsed = parseClaimReferences(source);
  expect(parsed.numbers).toEqual([2, 9]);
  expect(parsed.error).toBeUndefined();
  expect(parsed.alternative).toBe(true);
  expect(
    parsed.expressions.flatMap((e) => e.parts.map((p) => source.slice(p.first.from, p.first.to))),
  ).toEqual(["２", "9"]);
  expect(claimReferenceExpressions(source)).toBeNull();
});

test.each(["1和2", "1及2", "1，以及2", "1与2"])(
  "conjunctions remain conjunctions: %s",
  (reference) => {
    const text = `根据权利要求${reference}所述的装置`;
    expect(parseClaimReferences(text)).toMatchObject({ numbers: [1, 2], alternative: false });
    expect(claimReferenceExpressions(text)).toBeNull();
  },
);

test("a bad suffix cannot make a known missing target disappear or become an editable prefix", () => {
  const text = "根据权利要求9设置的控制器";
  expect(parseClaimReferences(text)).toMatchObject({ numbers: [9], error: expect.any(String) });
  expect(claimReferenceExpressions(text)).toBeNull();
});

test("reference limits apply across markers as well as individual ranges", () => {
  const text = "权利要求1至600所述的装置，以及权利要求601至1200所述的装置";
  const parsed = parseClaimReferences(text);
  expect(parsed.error).toContain("引用范围过大");
  expect(parsed.numbers.length).toBeLessThanOrEqual(1000);
  expect(claimReferenceExpressions(text)).toBeNull();
});

test("a later conjunction is not overridden by an earlier alternative", () => {
  const parsed = parseClaimReferences("权利要求1或2所述的装置与权利要求3和4所述的组件");
  expect(parsed.numbers).toEqual([1, 2, 3, 4]);
  expect(parsed.alternative).toBe(false);
});
