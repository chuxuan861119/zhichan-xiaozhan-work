import { DEFAULT_PAGE_MARGINS } from "../settings/page-margins.js";
import { DEFAULT_PAGE_SETTINGS } from "./defaults.js";

describe("default page settings", () => {
  test("keeps A4 geometry", () => {
    expect(DEFAULT_PAGE_SETTINGS.widthMm).toBe(210);
    expect(DEFAULT_PAGE_SETTINGS.heightMm).toBe(297);
  });

  test("uses Word A4 normal template margins from the single source of truth", () => {
    expect(DEFAULT_PAGE_SETTINGS.marginTopMm).toBe(DEFAULT_PAGE_MARGINS.marginTopMm);
    expect(DEFAULT_PAGE_SETTINGS.marginRightMm).toBe(DEFAULT_PAGE_MARGINS.marginRightMm);
    expect(DEFAULT_PAGE_SETTINGS.marginBottomMm).toBe(DEFAULT_PAGE_MARGINS.marginBottomMm);
    expect(DEFAULT_PAGE_SETTINGS.marginLeftMm).toBe(DEFAULT_PAGE_MARGINS.marginLeftMm);
    expect(DEFAULT_PAGE_SETTINGS.marginTopMm).toBe(25.4);
    expect(DEFAULT_PAGE_SETTINGS.marginRightMm).toBe(31.7);
    expect(DEFAULT_PAGE_SETTINGS.marginBottomMm).toBe(25.4);
    expect(DEFAULT_PAGE_SETTINGS.marginLeftMm).toBe(31.7);
  });
});
