import { calculateContentColumnWidths } from "./table-autofit";

describe("table content autofit", () => {
  test("uses the measured content width for ordinary cells", () => {
    expect(
      calculateContentColumnWidths(
        [
          { left: 0, right: 1, requiredWidthMm: 45 },
          { left: 1, right: 2, requiredWidthMm: 60 },
        ],
        [30, 30],
        165,
      ),
    ).toEqual([45, 60]);
  });

  test("shrinks page-width columns when every cell contains only short content", () => {
    expect(
      calculateContentColumnWidths(
        [
          { left: 0, right: 1, requiredWidthMm: 4 },
          { left: 1, right: 2, requiredWidthMm: 4 },
          { left: 2, right: 3, requiredWidthMm: 4 },
        ],
        [55, 55, 55],
        165,
      ),
    ).toEqual([10, 10, 10]);
  });

  test("distributes a merged cell width deficit across its covered columns", () => {
    expect(
      calculateContentColumnWidths([{ left: 0, right: 2, requiredWidthMm: 120 }], [30, 30], 165),
    ).toEqual([60, 60]);
  });

  test("keeps each column usable and clamps the total to the available page width", () => {
    expect(
      calculateContentColumnWidths(
        [
          { left: 0, right: 1, requiredWidthMm: 120 },
          { left: 1, right: 2, requiredWidthMm: 120 },
        ],
        [30, 30],
        165,
      ),
    ).toEqual([82.5, 82.5]);
  });
});
