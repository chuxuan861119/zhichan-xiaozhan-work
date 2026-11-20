import { describe, expect, it } from "vitest";
import {
  createBlankDesignPatent,
  DesignPatentImageOperationSchema,
  DesignPatentSchema,
  inferDesignPatentViewKindFromFilename,
  inspectDesignPatent,
  inspectDesignViewDimensions,
  normalizeDesignPatentMeasurementStatus,
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

  it("requires a source and confirmation state for every persisted subject bound", () => {
    const design = createBlankDesignPatent() as unknown as {
      views: unknown[];
    };
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

    expect(DesignPatentSchema.safeParse(design).success).toBe(false);
  });

  it("normalizes only missing measurement status fields while preserving explicit manual confirmation", () => {
    const normalized = normalizeDesignPatentMeasurementStatus({
      views: [
        { subjectBounds: { leftPx: 0, topPx: 0, widthPx: 10, heightPx: 20 } },
        { subjectBounds: null },
        {
          subjectBounds: { leftPx: 0, topPx: 0, widthPx: 10, heightPx: 20 },
          subjectBoundsSource: "manual",
          subjectBoundsConfirmed: true,
        },
      ],
    }) as { views: Array<Record<string, unknown>> };

    expect(normalized.views).toEqual([
      expect.objectContaining({ subjectBoundsSource: "automatic", subjectBoundsConfirmed: false }),
      expect.objectContaining({ subjectBoundsSource: null, subjectBoundsConfirmed: false }),
      expect.objectContaining({ subjectBoundsSource: "manual", subjectBoundsConfirmed: true }),
    ]);
  });

  it("rejects subject-bound statuses that cannot describe the stored bounds", () => {
    const base = {
      viewId: crypto.randomUUID(),
      kind: "front",
      label: "主视图",
      assetId: crypto.randomUUID(),
      expression: "line-drawing",
      operations: [],
      note: null,
    };
    const design = createBlankDesignPatent() as unknown as { views: unknown[] };

    design.views = [
      {
        ...base,
        subjectBounds: null,
        subjectBoundsSource: "automatic",
        subjectBoundsConfirmed: false,
      },
    ];
    expect(DesignPatentSchema.safeParse(design).success).toBe(false);

    design.views = [
      { ...base, subjectBounds: null, subjectBoundsSource: null, subjectBoundsConfirmed: true },
    ];
    expect(DesignPatentSchema.safeParse(design).success).toBe(false);

    design.views = [
      {
        ...base,
        subjectBounds: { leftPx: 0, topPx: 0, widthPx: 10, heightPx: 20 },
        subjectBoundsSource: "automatic",
        subjectBoundsConfirmed: true,
      },
    ];
    expect(DesignPatentSchema.safeParse(design).success).toBe(false);
  });

  it("reports unconfirmed orthographic measurements but clears the warning after manual confirmation", () => {
    const design = createBlankDesignPatent();
    const viewId = crypto.randomUUID();
    design.views = [
      {
        viewId,
        kind: "front",
        label: "主视图",
        assetId: crypto.randomUUID(),
        expression: "line-drawing",
        subjectBounds: { leftPx: 0, topPx: 0, widthPx: 10, heightPx: 20 },
        subjectBoundsSource: "automatic",
        subjectBoundsConfirmed: false,
        operations: [],
        note: null,
      },
    ];

    expect(inspectDesignPatent(design)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "subject-bounds-unconfirmed", viewIds: [viewId] }),
      ]),
    );

    design.views[0]!.subjectBoundsSource = "manual";
    design.views[0]!.subjectBoundsConfirmed = true;
    expect(inspectDesignPatent(design).map((issue) => issue.code)).not.toContain(
      "subject-bounds-unconfirmed",
    );
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

  it("does not warn about legacy image expression metadata", () => {
    const design = createBlankDesignPatent();
    design.primaryExpression = "photo";
    design.views = [
      {
        viewId: crypto.randomUUID(),
        kind: "perspective",
        label: "立体图1",
        assetId: crypto.randomUUID(),
        expression: "line-drawing",
        subjectBounds: null,
        subjectBoundsSource: null,
        subjectBoundsConfirmed: false,
        operations: [],
        note: null,
      },
    ];

    expect(inspectDesignPatent(design).map((issue) => issue.code)).not.toContain(
      "mixed-primary-expression",
    );
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
        subjectBoundsSource: null,
        subjectBoundsConfirmed: false,
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

  it("rejects duplicate primary view kinds before they can be hidden or exported", () => {
    const design = createBlankDesignPatent();
    design.views = [
      {
        viewId: crypto.randomUUID(),
        kind: "front",
        label: "主视图一",
        assetId: crypto.randomUUID(),
        expression: "line-drawing",
        subjectBounds: null,
        subjectBoundsSource: null,
        subjectBoundsConfirmed: false,
        operations: [],
        note: null,
      },
      {
        viewId: crypto.randomUUID(),
        kind: "front",
        label: "主视图二",
        assetId: crypto.randomUUID(),
        expression: "line-drawing",
        subjectBounds: null,
        subjectBoundsSource: null,
        subjectBoundsConfirmed: false,
        operations: [],
        note: null,
      },
    ];

    const result = DesignPatentSchema.safeParse(design);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("fixture");
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "立体图和六个标准视图的类型不能重复。",
          path: ["views", 1, "kind"],
        }),
      ]),
    );
  });

  it("accepts three distinct perspective slots and persisted unassigned images", () => {
    const design = createBlankDesignPatent();
    const placements = [
      ["perspective", "立体图1"],
      ["perspective-2", "立体图2"],
      ["perspective-3", "立体图3"],
      ["unassigned", "待分配图片"],
    ] as const;
    design.views = placements.map(([kind, label]) => ({
      viewId: crypto.randomUUID(),
      kind,
      label,
      assetId: crypto.randomUUID(),
      expression: "line-drawing" as const,
      subjectBounds: null,
      subjectBoundsSource: null,
      subjectBoundsConfirmed: false,
      operations: [],
      note: null,
    }));

    expect(
      DesignPatentSchema.safeParse(normalizeDesignPatentMeasurementStatus(design)).success,
    ).toBe(true);
    expect(inspectDesignPatent(design)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unassigned-images" })]),
    );
  });

  it("recognizes explicit Chinese and English view names without guessing ambiguous files", () => {
    expect(inferDesignPatentViewKindFromFilename("产品A_主视图.png")).toBe("front");
    expect(inferDesignPatentViewKindFromFilename("chair-left-view.jpg")).toBe("left");
    expect(inferDesignPatentViewKindFromFilename("折叠椅立体图2.PNG")).toBe("perspective-2");
    expect(inferDesignPatentViewKindFromFilename("chair perspective 3.png")).toBe("perspective-3");
    expect(inferDesignPatentViewKindFromFilename("产品A.png")).toBeNull();
    expect(inferDesignPatentViewKindFromFilename("主视图_左视图.png")).toBeNull();
  });

  it("does not treat an unassigned image as the representative export view", () => {
    const design = createBlankDesignPatent();
    const viewId = crypto.randomUUID();
    design.views = [
      {
        viewId,
        kind: "unassigned",
        label: "暂存图片.png",
        assetId: crypto.randomUUID(),
        expression: "line-drawing",
        subjectBounds: null,
        subjectBoundsSource: null,
        subjectBoundsConfirmed: false,
        operations: [],
        note: null,
      },
    ];
    design.representativeViewId = viewId;

    expect(inspectDesignPatent(design)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing-representative-view" })]),
    );
  });
});
