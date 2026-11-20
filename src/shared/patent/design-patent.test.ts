import { describe, expect, it } from "vitest";
import {
  createBlankDesignPatent,
  DesignPatentImageOperationSchema,
  inspectDesignPatent,
  inspectDesignViewDimensions,
} from "./design-patent.js";

describe("design patent aggregate", () => {
  it("starts with its own image and brief-description state", () => {
    expect(createBlankDesignPatent()).toEqual({
      subject: "whole-product",
      primaryExpression: null,
      representativeViewId: null,
      dimensionReferenceViewId: null,
      views: [],
      brief: {
        productUse: "",
        designPoints: [],
        colorProtectionRequested: false,
        omissions: [],
        continuousSurface: null,
        elongatedObjectLengthOmitted: false,
        materialDescription: "",
        partialDesignDescription: "",
        excludedInteriorDescription: "",
        guiDescription: "",
        setDescription: "",
        otherDescription: "",
      },
      exports: [],
    });
  });

  it("reports incomplete brief fields as warnings that do not prevent export", () => {
    const issues = inspectDesignPatent(createBlankDesignPatent());

    expect(issues).toEqual([
      expect.objectContaining({ code: "missing-product-use", severity: "warning" }),
      expect.objectContaining({ code: "missing-design-point", severity: "warning" }),
      expect.objectContaining({ code: "missing-representative-view", severity: "warning" }),
      expect.objectContaining({ code: "missing-view-explanation", severity: "warning" }),
    ]);
  });

  it("distinguishes an unexplained missing standard view from an omitted view", () => {
    const design = createBlankDesignPatent();
    design.brief.omissions = [{ viewKind: "rear", reason: "same-or-symmetric", otherReason: null }];

    const issue = inspectDesignPatent(design).find(
      (candidate) => candidate.code === "missing-view-explanation",
    );
    expect(issue?.message).not.toContain("后视图");
    expect(issue?.message).toContain("主视图");
  });

  it("reports conditional omission text and unavailable six-view subject measurements", () => {
    const design = createBlankDesignPatent();
    design.brief.omissions = [{ viewKind: "rear", reason: "other", otherReason: "" }];
    design.views = [
      {
        viewId: crypto.randomUUID(),
        kind: "front",
        label: "主视图",
        assetId: crypto.randomUUID(),
        expression: "line-drawing",
        subjectBounds: null,
        operations: [],
        note: null,
      },
    ];

    expect(inspectDesignPatent(design).map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["missing-omission-reason", "subject-bounds-unavailable"]),
    );
  });

  it("requires a protected-part description only for a partial design", () => {
    const design = createBlankDesignPatent();
    expect(inspectDesignPatent(design).map((issue) => issue.code)).not.toContain(
      "missing-partial-design-description",
    );

    design.subject = "partial-design";
    expect(inspectDesignPatent(design).map((issue) => issue.code)).toContain(
      "missing-partial-design-description",
    );
  });

  it("compares six-view product dimensions rather than canvas dimensions", () => {
    const issues = inspectDesignViewDimensions([
      { viewId: "front", kind: "front", subjectWidthPx: 100, subjectHeightPx: 200 },
      { viewId: "rear", kind: "rear", subjectWidthPx: 120, subjectHeightPx: 200 },
      { viewId: "left", kind: "left", subjectWidthPx: 80, subjectHeightPx: 200 },
      { viewId: "right", kind: "right", subjectWidthPx: 80, subjectHeightPx: 200 },
      { viewId: "top", kind: "top", subjectWidthPx: 100, subjectHeightPx: 80 },
      { viewId: "bottom", kind: "bottom", subjectWidthPx: 100, subjectHeightPx: 80 },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        code: "view-width-mismatch",
        severity: "warning",
        viewIds: ["front", "rear"],
      }),
    ]);
  });

  it("checks the corresponding width, height and depth axes across all six views", () => {
    const issues = inspectDesignViewDimensions([
      { viewId: "front", kind: "front", subjectWidthPx: 100, subjectHeightPx: 200 },
      { viewId: "rear", kind: "rear", subjectWidthPx: 100, subjectHeightPx: 200 },
      { viewId: "left", kind: "left", subjectWidthPx: 80, subjectHeightPx: 180 },
      { viewId: "right", kind: "right", subjectWidthPx: 80, subjectHeightPx: 200 },
      { viewId: "top", kind: "top", subjectWidthPx: 110, subjectHeightPx: 70 },
      { viewId: "bottom", kind: "bottom", subjectWidthPx: 100, subjectHeightPx: 80 },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual([
      "view-width-mismatch",
      "view-height-mismatch",
      "view-depth-mismatch",
    ]);
  });

  it("uses the selected standard view as the dimension comparison baseline", () => {
    const views = [
      { viewId: "front", kind: "front" as const, subjectWidthPx: 100, subjectHeightPx: 200 },
      { viewId: "rear", kind: "rear" as const, subjectWidthPx: 120, subjectHeightPx: 200 },
      { viewId: "top", kind: "top" as const, subjectWidthPx: 80, subjectHeightPx: 80 },
    ];

    const frontIssue = inspectDesignViewDimensions(views, 0.05, "front").find(
      (issue) => issue.code === "view-width-mismatch",
    );
    const rearIssue = inspectDesignViewDimensions(views, 0.05, "rear").find(
      (issue) => issue.code === "view-width-mismatch",
    );

    expect(frontIssue).toMatchObject({ viewIds: ["front", "rear"] });
    expect(frontIssue?.message).toContain("20%");
    expect(rearIssue).toMatchObject({ viewIds: ["rear", "top"] });
    expect(rearIssue?.message).toContain("33%");
  });

  it("rejects image operations that exceed safe edge or pixel limits", () => {
    expect(
      DesignPatentImageOperationSchema.safeParse({
        kind: "canvas",
        width: 6_000,
        height: 6_000,
        fit: "contain",
      }).success,
    ).toBe(false);
    expect(
      DesignPatentImageOperationSchema.safeParse({
        kind: "canvas",
        width: 6_001,
        height: 1_000,
        fit: "contain",
      }).success,
    ).toBe(false);
  });
});
