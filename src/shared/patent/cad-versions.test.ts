import type { CadCheckpoint } from "../drawing-markup/cad-state.js";
import { drawingProjectFixture } from "../drawing-markup/test-fixture.js";
import { createBlankPatent } from "./defaults.js";
import { migrateCanonicalPatent } from "./migrations.js";
import { CanonicalPatentSchema, parsePatentWithVerifiedBooks } from "./model.js";

function cadPatentInput(location: "project" | "detail", checkpointFields: Partial<CadCheckpoint>) {
  const assetId = "00000000-0000-4000-8000-000000000811";
  const project = drawingProjectFixture(assetId);
  const checkpoint: CadCheckpoint = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "00c7613f1af3c73f7157fa91d9fe2635c6f23c06",
    assetId,
    mapping: { originX: -50, originY: 300, scale: 2 },
    ...checkpointFields,
  };
  if (location === "project") project.cad = checkpoint;
  else {
    const detail = project.detailViews?.[0];
    if (!detail) throw new Error("Missing detail fixture");
    detail.cadSource = { ...checkpoint, baseAssetId: assetId };
  }
  return {
    ...createBlankPatent({ patentType: "invention", name: null }),
    assets: [
      {
        assetId,
        kind: "image" as const,
        originalName: "draft.png",
        extension: "png" as const,
        mediaType: "image/png" as const,
        widthPx: 100,
        heightPx: 100,
        byteLength: 1,
        sha256: "A".repeat(64),
        previewByteLength: 1,
        previewSha256: "B".repeat(64),
      },
    ],
    drawingProjects: [project],
  };
}

const unifiedObjectFields: Partial<CadCheckpoint> = {
  unified: 1,
  objects: [{ id: "detail-1", kind: "detail", body: ["B1"], frame: ["B2"] }],
};
const unifiedFields: Partial<CadCheckpoint>[] = [
  { overlayAssetId: "00000000-0000-4000-8000-000000000811", backgroundSize: [100, 100] },
  { unified: 1 },
  { objects: [] },
  { objects: [{ id: "label-1", kind: "label", label: ["A1", "A2"] }] },
  unifiedObjectFields,
];

describe("CAD patent format compatibility", () => {
  test.each([12, 13, 14])("ordinary CAD at version %i retains version 14", (formatVersion) => {
    for (const location of ["project", "detail"] as const) {
      const input = { ...cadPatentInput(location, {}), formatVersion };
      const parsed = CanonicalPatentSchema.parse(input);
      expect(parsed.formatVersion).toBe(14);
      expect(parsed.drawingProjects).toEqual(input.drawingProjects);
    }
  });

  test.each([12, 13, 14])(
    "unified checkpoints upgrade version %i without losing objects",
    (formatVersion) => {
      for (const location of ["project", "detail"] as const) {
        for (const fields of unifiedFields) {
          const input = { ...cadPatentInput(location, fields), formatVersion };
          const before = structuredClone(input);
          const parsed = CanonicalPatentSchema.parse(input);
          expect(parsed.formatVersion).toBe(15);
          expect(parsed.drawingProjects).toEqual(input.drawingProjects);
          expect(input).toEqual(before);
        }
      }
    },
  );

  test.each([12, 13, 14, 15])(
    "migration accepts unified version %i without mutating checkpoint data",
    (formatVersion) => {
      const input = { ...cadPatentInput("detail", unifiedObjectFields), formatVersion };
      const before = structuredClone(input);
      const migrated = migrateCanonicalPatent(input);
      expect(migrated.ok).toBe(true);
      if (!migrated.ok) throw new Error(migrated.error.message);
      expect(migrated.value.formatVersion).toBe(15);
      expect(migrated.value.drawingProjects).toEqual(input.drawingProjects);
      expect(input).toEqual(before);
    },
  );

  test("incremental parsing normalizes a newly unified CAD checkpoint", () => {
    const verified = CanonicalPatentSchema.parse(cadPatentInput("project", {}));
    const input = {
      ...verified,
      drawingProjects: cadPatentInput("project", unifiedObjectFields).drawingProjects,
    };
    expect(parsePatentWithVerifiedBooks(input, verified).formatVersion).toBe(15);
  });

  test("plain patents keep their ordinary format and future unified formats remain protected", () => {
    const plain = createBlankPatent({ patentType: "invention", name: null });
    expect(CanonicalPatentSchema.parse(plain).formatVersion).toBe(12);
    expect(migrateCanonicalPatent({ ...plain, formatVersion: 16 })).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_VERSION" },
    });
  });
});
