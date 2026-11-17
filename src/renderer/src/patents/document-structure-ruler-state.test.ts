import {
  clampDocumentStructureRulerOffset,
  DOCUMENT_STRUCTURE_RULER_COMPACT_WIDTH,
  DOCUMENT_STRUCTURE_RULER_NAVIGATION_GAP,
  DOCUMENT_STRUCTURE_RULER_NAVIGATION_ROW_HEIGHT,
  DOCUMENT_STRUCTURE_RULER_NAVIGATION_STEP,
  DOCUMENT_STRUCTURE_RULER_RESUME_WINDOW_MS,
  DOCUMENT_STRUCTURE_RULER_TARGET_FLASH_MS,
  documentStructureRulerCenterIndex,
  documentStructureRulerNavigationTop,
  nearestDocumentStructureRulerMarkerIndex,
  nextDocumentStructureRulerMode,
} from "./document-structure-ruler-state";

describe("document structure ruler presentation", () => {
  test("uses actual left space even when the right rail makes the full row overflow", () => {
    expect(nextDocumentStructureRulerMode(84)).toBe("wide");
    expect(nextDocumentStructureRulerMode(76)).toBe("wide");
    expect(nextDocumentStructureRulerMode(75)).toBe("compact");
    expect(nextDocumentStructureRulerMode(20)).toBe("compact");
    expect(DOCUMENT_STRUCTURE_RULER_COMPACT_WIDTH).toBe(20);
  });

  test("restores immediately when the permanently reserved wide slot is visible", () => {
    expect(nextDocumentStructureRulerMode(60)).toBe("compact");
    expect(nextDocumentStructureRulerMode(80)).toBe("wide");
    expect(nextDocumentStructureRulerMode(75.6)).toBe("wide");
  });

  test("uses the navigation geometry constants", () => {
    expect(DOCUMENT_STRUCTURE_RULER_NAVIGATION_ROW_HEIGHT).toBe(24);
    expect(DOCUMENT_STRUCTURE_RULER_NAVIGATION_GAP).toBe(2);
    expect(DOCUMENT_STRUCTURE_RULER_NAVIGATION_STEP).toBe(
      DOCUMENT_STRUCTURE_RULER_NAVIGATION_ROW_HEIGHT + DOCUMENT_STRUCTURE_RULER_NAVIGATION_GAP,
    );
    expect(DOCUMENT_STRUCTURE_RULER_RESUME_WINDOW_MS).toBe(1000);
    expect(DOCUMENT_STRUCTURE_RULER_TARGET_FLASH_MS).toBe(1000);
  });

  test("finds the nearest marker center and keeps the earlier index on ties", () => {
    expect(nearestDocumentStructureRulerMarkerIndex([80, 120, 170], 145)).toBe(1);
    expect(nearestDocumentStructureRulerMarkerIndex([], 145)).toBeNull();
  });

  test("places a navigation row around the viewport center", () => {
    expect(documentStructureRulerNavigationTop(3, 1, 300, 10)).toBe(330);
  });

  test("clamps navigation offsets so both endpoints can reach the center", () => {
    expect(clampDocumentStructureRulerOffset(-100, 2, 5)).toBe(-52);
    expect(clampDocumentStructureRulerOffset(0, 2, 5)).toBe(0);
    expect(clampDocumentStructureRulerOffset(100, 2, 5)).toBe(52);
    expect(clampDocumentStructureRulerOffset(100, 0, 0)).toBe(0);
  });

  test("derives the center marker index from the wheel offset", () => {
    expect(documentStructureRulerCenterIndex(2, 0, 5)).toBe(2);
    expect(documentStructureRulerCenterIndex(2, -13, 5)).toBe(1);
    expect(documentStructureRulerCenterIndex(2, 13, 5)).toBe(2);
    expect(documentStructureRulerCenterIndex(2, -26, 5)).toBe(1);
    expect(documentStructureRulerCenterIndex(2, 27, 5)).toBe(3);
    expect(documentStructureRulerCenterIndex(2, -100, 5)).toBe(0);
    expect(documentStructureRulerCenterIndex(2, 100, 5)).toBe(4);
    expect(documentStructureRulerCenterIndex(2, 0, 0)).toBeNull();
  });
});
