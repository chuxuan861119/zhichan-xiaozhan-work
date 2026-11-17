import { afterEach, describe, expect, test, vi } from "vitest";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { AdaptiveRulerScheduler, isComplexRulerDocument } from "./adaptive-ruler-scheduler";

afterEach(() => vi.useRealTimers());

describe("adaptive ruler scheduling", () => {
  function fixture() {
    vi.useFakeTimers();
    let clock = 0;
    let cost = 20;
    const calculate = vi.fn((value: number) => {
      clock += cost;
      return value;
    });
    const publish = vi.fn();
    const scheduler = new AdaptiveRulerScheduler(calculate, publish, () => clock);
    return {
      scheduler,
      calculate,
      publish,
      cost: (value: number) => {
        cost = value;
      },
      clock: (value: number) => {
        clock = value;
      },
    };
  }

  test("small documents and fast complex documents publish every edit immediately", () => {
    const f = fixture();
    for (let i = 0; i < 10; i += 1) f.scheduler.update(i, false);
    expect(f.publish).toHaveBeenCalledTimes(10);
    f.cost(7);
    for (let i = 10; i < 20; i += 1) f.scheduler.update(i, true);
    expect(f.publish).toHaveBeenCalledTimes(20);
  });

  test("three slow samples out of five merge work, not just display, and flush the latest edit", () => {
    const f = fixture();
    for (let i = 0; i < 5; i += 1) {
      f.cost(i % 2 === 0 ? 20 : 7);
      f.scheduler.update(i, true);
    }
    f.clock(80);
    f.scheduler.update(5, true);
    f.scheduler.update(6, true);
    expect(f.calculate).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(73);
    expect(f.calculate).toHaveBeenCalledTimes(5);
    f.clock(154);
    vi.advanceTimersByTime(1);
    expect(f.calculate).toHaveBeenCalledTimes(6);
    expect(f.publish).toHaveBeenLastCalledWith(6);
  });

  test("cancellation prevents publishing an unmounted or switched document", () => {
    const f = fixture();
    for (let i = 0; i < 3; i += 1) f.scheduler.update(i, true);
    f.scheduler.update(3, true);
    f.scheduler.cancel();
    vi.runAllTimers();
    expect(f.publish).toHaveBeenCalledTimes(3);
  });

  test("five fast samples restore realtime and shrinking to a small document also resets", () => {
    const f = fixture();
    for (let i = 0; i < 3; i += 1) f.scheduler.update(i, true);
    f.cost(7);
    for (let i = 3; i < 8; i += 1) {
      f.clock(i * 100);
      f.scheduler.update(i, true);
    }
    f.scheduler.update(8, true);
    expect(f.publish).toHaveBeenLastCalledWith(8);
    f.cost(20);
    for (let i = 9; i < 12; i += 1) f.scheduler.update(i, true);
    f.scheduler.update(12, true);
    f.scheduler.update(13, false);
    expect(f.publish).toHaveBeenLastCalledWith(13);
    vi.runAllTimers();
    expect(f.publish).toHaveBeenLastCalledWith(13);
  });
});

test("complexity includes text, block count, and nested table/list nodes", () => {
  const document = createBlankPatent({ patentType: "invention", name: null }).books[0]?.document;
  if (!document) throw new Error("Missing fixture document");
  const paragraph = document.content[0];
  if (!paragraph) throw new Error("Missing fixture paragraph");
  expect(isComplexRulerDocument(document)).toBe(false);
  const withText = (text: string) => ({
    ...document,
    content: [{ ...paragraph, content: [{ type: "text" as const, text, marks: [] }] }],
  });
  expect(isComplexRulerDocument(withText("字".repeat(30_000)))).toBe(false);
  expect(isComplexRulerDocument(withText("字".repeat(30_001)))).toBe(true);
  expect(isComplexRulerDocument(withText("😀".repeat(30_000)))).toBe(false);
  expect(isComplexRulerDocument({ ...document, content: Array(801).fill(paragraph) })).toBe(true);
  const nested = {
    ...document,
    content: [
      {
        type: "table",
        rows: [
          {
            cells: [
              {
                content: Array(2501).fill({
                  type: "paragraph",
                  content: [{ type: "text", text: "A" }],
                }),
              },
            ],
          },
        ],
      },
    ],
  };
  expect(isComplexRulerDocument(nested)).toBe(true);
});
