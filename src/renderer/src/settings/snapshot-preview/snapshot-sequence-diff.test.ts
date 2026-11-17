import { describe, expect, test } from "vitest";
import { diffSequence, segmentGraphemes } from "./snapshot-sequence-diff";

describe("segmentGraphemes", () => {
  test("keeps supplementary, ZWJ, and combining graphemes intact", () => {
    expect(segmentGraphemes("甲𠀀👩‍🔬e\u0301乙")).toEqual(["甲", "𠀀", "👩‍🔬", "e\u0301", "乙"]);
  });

  test("handles empty text", () => {
    expect(segmentGraphemes("")).toEqual([]);
  });
});

describe("diffSequence", () => {
  const keyOf = (value: { id: string; label: string }) => value.id;

  test("returns stable items and coalesces adjacent runs", () => {
    const retainedBefore = { id: "a", label: "旧 A" };
    const deleted = { id: "b", label: "旧 B" };
    const retainedAfter = { id: "a", label: "新 A" };
    const inserted = { id: "c", label: "新 C" };

    expect(diffSequence([retainedBefore, deleted], [retainedAfter, inserted], keyOf)).toEqual([
      { kind: "equal", before: [retainedBefore], after: [retainedAfter] },
      { kind: "delete", before: [deleted], after: [] },
      { kind: "insert", before: [], after: [inserted] },
    ]);
  });

  test("keeps source order across multiple edits", () => {
    expect(diffSequence(["a", "b", "c", "d", "e"], ["a", "x", "c", "e", "y"], String)).toEqual([
      { kind: "equal", before: ["a"], after: ["a"] },
      { kind: "delete", before: ["b"], after: [] },
      { kind: "insert", before: [], after: ["x"] },
      { kind: "equal", before: ["c"], after: ["c"] },
      { kind: "delete", before: ["d"], after: [] },
      { kind: "equal", before: ["e"], after: ["e"] },
      { kind: "insert", before: [], after: ["y"] },
    ]);
  });

  test("chooses a deterministic shortest path for repeated keys", () => {
    expect(diffSequence(["a", "b", "a"], ["a", "a", "b"], String)).toEqual([
      { kind: "equal", before: ["a"], after: ["a"] },
      { kind: "delete", before: ["b"], after: [] },
      { kind: "equal", before: ["a"], after: ["a"] },
      { kind: "insert", before: [], after: ["b"] },
    ]);
  });

  test("handles empty inputs", () => {
    expect(diffSequence([], [], String)).toEqual([]);
    expect(diffSequence(["a", "b"], [], String)).toEqual([
      { kind: "delete", before: ["a", "b"], after: [] },
    ]);
    expect(diffSequence([], ["a", "b"], String)).toEqual([
      { kind: "insert", before: [], after: ["a", "b"] },
    ]);
  });

  test("handles a small tail edit in a 20,000-item sequence", () => {
    const before = Array.from({ length: 20_000 }, (_, index) => `item-${index}`);
    const after = [...before.slice(0, -2), "replacement", before.at(-1)!];
    const runs = diffSequence(before, after, String);

    expect(runs).toHaveLength(4);
    expect(runs[0]).toMatchObject({ kind: "equal" });
    expect(runs[0]?.before).toHaveLength(19_998);
    expect(runs.slice(1)).toEqual([
      { kind: "delete", before: ["item-19998"], after: [] },
      { kind: "insert", before: [], after: ["replacement"] },
      { kind: "equal", before: ["item-19999"], after: ["item-19999"] },
    ]);
  });

  test("reconstructs 4,000 entirely different items without a quadratic trace", () => {
    const before = Array.from({ length: 4_000 }, (_, index) => `before-${index}`);
    const after = Array.from({ length: 4_000 }, (_, index) => `after-${index}`);
    const runs = diffSequence(before, after, String);

    expect(runs.filter(({ kind }) => kind !== "insert").flatMap(({ before }) => before)).toEqual(
      before,
    );
    expect(runs.filter(({ kind }) => kind !== "delete").flatMap(({ after }) => after)).toEqual(
      after,
    );
    expect(runs).toEqual([
      { kind: "delete", before, after: [] },
      { kind: "insert", before: [], after },
    ]);
  }, 20_000);

  test("matches the shortest edit length across deterministic random repeated keys", () => {
    let state = 0x5eed1234;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let sample = 0; sample < 100; sample += 1) {
      const before = Array.from({ length: random() % 11 }, () => String(random() % 4));
      const after = Array.from({ length: random() % 11 }, () => String(random() % 4));
      const runs = diffSequence(before, after, String);
      const reconstructedBefore = runs
        .filter(({ kind }) => kind !== "insert")
        .flatMap(({ before: values }) => values);
      const reconstructedAfter = runs
        .filter(({ kind }) => kind !== "delete")
        .flatMap(({ after: values }) => values);
      const editLength = runs.reduce(
        (total, run) => total + (run.kind === "equal" ? 0 : run.before.length + run.after.length),
        0,
      );

      expect(reconstructedBefore).toEqual(before);
      expect(reconstructedAfter).toEqual(after);
      expect(editLength).toBe(shortestInsertDeleteLength(before, after));
    }
  });
});

function shortestInsertDeleteLength(before: readonly string[], after: readonly string[]): number {
  let previous = Array.from({ length: after.length + 1 }, (_, index) => index);
  for (let beforeIndex = 0; beforeIndex < before.length; beforeIndex += 1) {
    const current = [beforeIndex + 1];
    for (let afterIndex = 0; afterIndex < after.length; afterIndex += 1) {
      current.push(
        before[beforeIndex] === after[afterIndex]
          ? previous[afterIndex]!
          : Math.min(previous[afterIndex + 1]!, current[afterIndex]!) + 1,
      );
    }
    previous = current;
  }
  return previous[after.length]!;
}
