import { describe, expect, test } from "vitest";
import { capabilitiesForPatentBook } from "./patent-toolbar-capabilities";

describe("patent toolbar capabilities", () => {
  test("allows only book-appropriate rich text structures", () => {
    expect(capabilitiesForPatentBook("claims")).toMatchObject({
      tables: false,
      formulas: true,
      chemistry: true,
      chemicalStructures: true,
      images: true,
    });
    expect(capabilitiesForPatentBook("description")).toMatchObject({
      tables: true,
      formulas: true,
      chemistry: true,
      chemicalStructures: true,
      images: true,
    });
    expect(capabilitiesForPatentBook("abstract")).toMatchObject({
      tables: false,
      formulas: true,
      chemistry: true,
      chemicalStructures: true,
      images: false,
    });
  });

  test("disables ordinary text commands on drawing-only books", () => {
    expect(capabilitiesForPatentBook("description-drawings")).toEqual({
      headings: false,
      lists: false,
      tables: false,
      formulas: false,
      chemistry: false,
      chemicalStructures: false,
      images: false,
      pageBreaks: false,
    });
    expect(capabilitiesForPatentBook("abstract-drawing")).toEqual(
      capabilitiesForPatentBook("description-drawings"),
    );
  });

  test("returns stable capability objects for editor registration", () => {
    expect(capabilitiesForPatentBook("claims")).toBe(capabilitiesForPatentBook("claims"));
    expect(capabilitiesForPatentBook("description")).toBe(capabilitiesForPatentBook("description"));
    expect(capabilitiesForPatentBook("abstract")).toBe(capabilitiesForPatentBook("abstract"));
  });
});
