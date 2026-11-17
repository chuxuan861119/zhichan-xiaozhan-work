import { formatPatentCounts } from "./patent-counts";

test("counts invention and utility-model patents including empty lists", () => {
  expect(formatPatentCounts([])).toBe("总计 0 项 · 发明 0 项 · 新型 0 项");
  expect(
    formatPatentCounts([
      { patentType: "invention" },
      { patentType: "utility-model" },
      { patentType: "invention" },
    ]),
  ).toBe("总计 3 项 · 发明 2 项 · 新型 1 项");
});
