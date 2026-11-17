import { FlowchartFigureLinkSchema, FlowchartProjectDescriptorSchema } from "./model.js";

const projectId = "00000000-0000-4000-8000-000000000901";

function projectFixture() {
  return {
    projectId,
    name: "方法流程图",
    revision: 3,
    pageCount: 2,
    lastPageId: "page-2",
    sourceSha256: "A".repeat(64),
    createdAt: "2026-08-11T00:00:00.000Z",
    modifiedAt: "2026-08-11T00:01:00.000Z",
  };
}

function linkFixture() {
  return {
    projectId,
    pageId: "page-2",
    exportScope: "selection" as const,
    selectedCellIds: ["cell-1", "cell-2"],
    borderMm: 2,
    exportedProjectRevision: 3,
    exportedSourceSha256: "A".repeat(64),
    renderProfileVersion: 1 as const,
  };
}

describe("flowchart canonical model", () => {
  test("accepts a bounded project descriptor", () => {
    expect(FlowchartProjectDescriptorSchema.parse(projectFixture())).toEqual(projectFixture());
  });

  test("rejects invalid project bounds and lowercase source hashes", () => {
    expect(
      FlowchartProjectDescriptorSchema.safeParse({ ...projectFixture(), pageCount: 101 }).success,
    ).toBe(false);
    expect(
      FlowchartProjectDescriptorSchema.safeParse({
        ...projectFixture(),
        sourceSha256: "a".repeat(64),
      }).success,
    ).toBe(false);
  });

  test("accepts page and selection links with a 0 to 20 mm border", () => {
    expect(FlowchartFigureLinkSchema.parse(linkFixture())).toEqual(linkFixture());
    expect(FlowchartFigureLinkSchema.safeParse({ ...linkFixture(), borderMm: 0 }).success).toBe(
      true,
    );
    expect(FlowchartFigureLinkSchema.safeParse({ ...linkFixture(), borderMm: 20 }).success).toBe(
      true,
    );
    expect(FlowchartFigureLinkSchema.safeParse({ ...linkFixture(), borderMm: 20.01 }).success).toBe(
      false,
    );
  });

  test("rejects duplicate selected cells and selection data on a page export", () => {
    expect(
      FlowchartFigureLinkSchema.safeParse({
        ...linkFixture(),
        selectedCellIds: ["cell-1", "cell-1"],
      }).success,
    ).toBe(false);
    expect(
      FlowchartFigureLinkSchema.safeParse({
        ...linkFixture(),
        exportScope: "page",
        selectedCellIds: ["cell-1"],
      }).success,
    ).toBe(false);
  });
});
