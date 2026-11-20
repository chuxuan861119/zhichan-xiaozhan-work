import {
  type DesignPatentIssue,
  type DesignPatentView,
  type DesignPatentViewKind,
  inspectDesignViewDimensions,
} from "./design-patent.js";

export type DesignDimensionAxis = "width" | "height" | "depth";
export type DesignDimensionMeasurementState =
  | "missing"
  | "unmeasured"
  | "automatic-unconfirmed"
  | "manual-unconfirmed"
  | "confirmed";

type DimensionGroupDefinition = {
  axis: DesignDimensionAxis;
  label: string;
  entries: ReadonlyArray<{
    kind: Extract<DesignPatentViewKind, "front" | "rear" | "left" | "right" | "top" | "bottom">;
    dimension: "width" | "height";
  }>;
};

export const DESIGN_DIMENSION_GROUPS: readonly DimensionGroupDefinition[] = [
  {
    axis: "width",
    label: "宽度",
    entries: [
      { kind: "front", dimension: "width" },
      { kind: "rear", dimension: "width" },
      { kind: "top", dimension: "width" },
      { kind: "bottom", dimension: "width" },
    ],
  },
  {
    axis: "height",
    label: "高度",
    entries: [
      { kind: "front", dimension: "height" },
      { kind: "rear", dimension: "height" },
      { kind: "left", dimension: "height" },
      { kind: "right", dimension: "height" },
    ],
  },
  {
    axis: "depth",
    label: "深度",
    entries: [
      { kind: "left", dimension: "width" },
      { kind: "right", dimension: "width" },
      { kind: "top", dimension: "height" },
      { kind: "bottom", dimension: "height" },
    ],
  },
];

export type DesignDimensionCell = {
  viewId: string | null;
  kind: DimensionGroupDefinition["entries"][number]["kind"];
  dimension: "width" | "height";
  valuePx: number | null;
  state: DesignDimensionMeasurementState;
  baseline: boolean;
  difference: number | null;
  direction: "larger" | "smaller" | "equal" | null;
};

export type DesignDimensionMatrix = {
  groups: Array<{
    axis: DesignDimensionAxis;
    label: string;
    cells: DesignDimensionCell[];
    softwarePrompt: DesignPatentIssue | null;
  }>;
  issues: DesignPatentIssue[];
};

function stateFor(view: DesignPatentView | undefined): DesignDimensionMeasurementState {
  if (!view) return "missing";
  if (!view.subjectBounds) return "unmeasured";
  if (view.subjectBoundsSource === "automatic") return "automatic-unconfirmed";
  return view.subjectBoundsConfirmed ? "confirmed" : "manual-unconfirmed";
}

export function buildDesignDimensionMatrix(
  views: readonly DesignPatentView[],
  referenceViewId: string | null,
): DesignDimensionMatrix {
  const byKind = new Map(views.map((view) => [view.kind, view]));
  const issues = inspectDesignViewDimensions(views, 0.05, referenceViewId ?? undefined);
  return {
    issues,
    groups: DESIGN_DIMENSION_GROUPS.map((group) => {
      const candidates = group.entries.map(({ kind, dimension }) => {
        const view = byKind.get(kind);
        const value =
          dimension === "width" ? view?.subjectBounds?.widthPx : view?.subjectBounds?.heightPx;
        return { view, value: value ?? null };
      });
      const preferred =
        group.axis === "depth"
          ? [
              ...candidates.filter(
                (candidate) => candidate.view?.kind === "left" || candidate.view?.kind === "right",
              ),
              ...candidates.filter(
                (candidate) => candidate.view?.kind !== "left" && candidate.view?.kind !== "right",
              ),
            ]
          : candidates;
      const referenceCandidate =
        candidates.find(
          (candidate) => candidate.view?.viewId === referenceViewId && candidate.value !== null,
        ) ??
        preferred.find(
          (candidate) =>
            candidate.value !== null &&
            candidate.view?.subjectBoundsSource === "manual" &&
            candidate.view.subjectBoundsConfirmed,
        ) ??
        preferred.find((candidate) => candidate.value !== null) ??
        null;
      const reference = referenceCandidate?.value ?? null;
      const referenceId = referenceCandidate?.view?.viewId ?? null;
      const cells = group.entries.map(({ kind, dimension }) => {
        const view = byKind.get(kind);
        const valuePx =
          dimension === "width" ? view?.subjectBounds?.widthPx : view?.subjectBounds?.heightPx;
        const value = valuePx ?? null;
        const difference =
          reference !== null && value !== null && reference !== 0
            ? Math.abs(value - reference) / reference
            : null;
        const direction: DesignDimensionCell["direction"] =
          difference === null || value === null || reference === null
            ? null
            : value === reference
              ? "equal"
              : value > reference
                ? "larger"
                : "smaller";
        return {
          viewId: view?.viewId ?? null,
          kind,
          dimension,
          valuePx: value,
          state: stateFor(view),
          baseline: view?.viewId === referenceId,
          difference,
          direction,
        };
      });
      const code = {
        width: "view-width-mismatch",
        height: "view-height-mismatch",
        depth: "view-depth-mismatch",
      }[group.axis];
      return {
        axis: group.axis,
        label: group.label,
        cells,
        softwarePrompt: issues.find((issue) => issue.code === code) ?? null,
      };
    }),
  };
}
