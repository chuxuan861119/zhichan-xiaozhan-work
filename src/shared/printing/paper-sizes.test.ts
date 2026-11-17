import {
  createDefaultPrintSettings,
  DEFAULT_PRINT_PREFERENCES,
  type PrintPreferences,
  PrintPreferencesSchema,
  PrintSettingsSchema,
  StandardPaperSizeSchema,
} from "./model.js";
import {
  getDefaultPaperSize,
  getPaperSizeMillimetres,
  STANDARD_PAPER_SIZE_NAMES,
} from "./paper-sizes.js";

const ELECTRON_PRINT_PAPER_SIZE_NAMES = [
  "A0",
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "Legal",
  "Letter",
  "Tabloid",
] as const;

const DOCUMENT_PAGE_SETTINGS = {
  widthMm: 148,
  heightMm: 210,
  marginTopMm: 25,
  marginRightMm: 15,
  marginBottomMm: 15,
  marginLeftMm: 25,
};

describe("standard print paper sizes", () => {
  test("accepts only Electron print named paper sizes", () => {
    expect(STANDARD_PAPER_SIZE_NAMES).toEqual(ELECTRON_PRINT_PAPER_SIZE_NAMES);

    for (const paperSize of ELECTRON_PRINT_PAPER_SIZE_NAMES) {
      expect(StandardPaperSizeSchema.safeParse(paperSize).success).toBe(true);
    }

    for (const paperSize of ["Ledger", "A7", "Executive", "a4", ""] as const) {
      expect(StandardPaperSizeSchema.safeParse(paperSize).success).toBe(false);
    }
  });

  test("maps A4 portrait dimensions and swaps them for landscape", () => {
    expect(getPaperSizeMillimetres("A4", "portrait")).toEqual({ widthMm: 210, heightMm: 297 });
    expect(getPaperSizeMillimetres("A4", "landscape")).toEqual({ widthMm: 297, heightMm: 210 });
  });

  test("falls back to A4 when document paper is not provided", () => {
    expect(getDefaultPaperSize()).toBe("A4");
  });
});

describe("print settings defaults and preferences", () => {
  test("defaults to monochrome while honoring an explicitly saved color preference", () => {
    expect(DEFAULT_PRINT_PREFERENCES.color).toBe(false);
    expect(createDefaultPrintSettings().output.color).toBe(false);
    expect(
      createDefaultPrintSettings(undefined, { ...DEFAULT_PRINT_PREFERENCES, color: true }).output
        .color,
    ).toBe(true);
  });
  test("creates schema-valid session defaults without persisting per-job settings", () => {
    const settings = createDefaultPrintSettings(DOCUMENT_PAGE_SETTINGS);

    expect(settings).toEqual({
      layout: {
        orientation: "portrait",
        paperSize: "A5",
        scalePercent: 100,
        margins: { mode: "document" },
      },
      output: {
        printerDeviceName: null,
        copies: 1,
        pageRanges: undefined,
        duplexMode: "simplex",
        color: false,
        pagesPerSheet: 1,
        collate: true,
      },
    });
    expect(PrintSettingsSchema.parse(settings)).toEqual(settings);
  });

  test("applies only persistent preferences while resetting volatile settings", () => {
    const preferences: PrintPreferences = {
      printerDeviceName: "printer-1",
      duplexMode: "longEdge",
      color: false,
      orientation: "landscape",
      paperSize: "Letter",
    };

    const settings = createDefaultPrintSettings(undefined, preferences);

    expect(settings.layout).toEqual({
      orientation: "landscape",
      paperSize: "Letter",
      scalePercent: 100,
      margins: { mode: "document" },
    });
    expect(settings.output).toEqual({
      printerDeviceName: "printer-1",
      copies: 1,
      pageRanges: undefined,
      duplexMode: "longEdge",
      color: false,
      pagesPerSheet: 1,
      collate: true,
    });
  });

  test("persists only printer, duplex, color, orientation, and paper", () => {
    const preferences: PrintPreferences = {
      printerDeviceName: null,
      duplexMode: "shortEdge",
      color: true,
      orientation: "portrait",
      paperSize: "Legal",
    };

    expect(PrintPreferencesSchema.safeParse(preferences).success).toBe(true);
    expect(
      PrintPreferencesSchema.safeParse({
        ...preferences,
        copies: 2,
        pageRanges: [{ from: 0, to: 0 }],
        scalePercent: 90,
        pagesPerSheet: 2,
        collate: false,
        margins: { mode: "none" },
      }).success,
    ).toBe(false);
  });
});
