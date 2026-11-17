import { type PageRangeSelection, resolvePageRanges } from "./page-range.js";

function expectResolved(
  selection: PageRangeSelection,
  expected: { from: number; to: number }[] | undefined,
  currentPage = 1,
  totalPages = 12,
): void {
  const result = resolvePageRanges(selection, currentPage, totalPages);

  expect(result).toEqual({ ok: true, pageRanges: expected });
}

function expectRangeError(source: string, expectedMessage: string): void {
  const result = resolvePageRanges({ mode: "custom", source }, 1, 5);

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(expectedMessage);
}

describe("print page range resolution", () => {
  test("converts comma-separated one-based custom ranges to zero-based closed ranges", () => {
    expectResolved({ mode: "custom", source: "1-3, 5, 8-10" }, [
      { from: 0, to: 2 },
      { from: 4, to: 4 },
      { from: 7, to: 9 },
    ]);
  });

  test("ignores whitespace around numbers, ranges, and separators", () => {
    expectResolved({ mode: "custom", source: " 1 - 2 ,  4 " }, [
      { from: 0, to: 1 },
      { from: 3, to: 3 },
    ]);
  });

  test("sorts and merges duplicate, overlapping, and adjacent ranges", () => {
    expectResolved({ mode: "custom", source: "3, 1-2, 2-4, 6, 5" }, [{ from: 0, to: 5 }]);
  });

  test("resolves current page mode to the current visible page", () => {
    expectResolved({ mode: "current" }, [{ from: 4, to: 4 }], 5, 12);
  });

  test("returns undefined for all pages instead of a fake huge range", () => {
    expectResolved({ mode: "all" }, undefined);
  });

  test.each([
    ["0", "页码必须从 1 开始"],
    ["-1", "页码范围只能包含数字"],
    ["3-2", "结束页不能小于起始页"],
    ["abc", "页码范围只能包含数字"],
    ["1,,3", "页码范围包含空片段"],
    ["6", "页码不能超过总页数"],
  ])("rejects invalid custom range %s", (source, expectedMessage) => {
    expectRangeError(source, expectedMessage);
  });

  test("returns classified Chinese errors instead of throwing for malformed input", () => {
    expect(() => resolvePageRanges({ mode: "custom", source: "1-a" }, 1, 5)).not.toThrow();

    const result = resolvePageRanges({ mode: "custom", source: "1-a" }, 1, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("页码范围只能包含数字");
  });
});
