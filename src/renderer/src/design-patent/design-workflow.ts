import {
  type DesignPatent,
  type DesignPatentIssue,
  inspectDesignPatent,
  isAssignedDesignView,
} from "../../../shared/patent/design-patent";
import { isHeldForOmittedView, resolvedOrthographicOmissions } from "./design-omission-status";

export const DESIGN_WORKFLOW_STEPS = ["images", "correction", "brief", "review"] as const;
export type DesignWorkflowStep = (typeof DESIGN_WORKFLOW_STEPS)[number];
export type DesignWorkflowStatus = "not-started" | "in-progress" | "needs-attention" | "complete";
export type DesignWorkflowStatuses = Record<DesignWorkflowStep, DesignWorkflowStatus>;
export type DesignWorkflowTarget = { step: DesignWorkflowStep; headingId: string };

const IMAGE_ISSUE_CODES = new Set<DesignPatentIssue["code"]>([
  "missing-images",
  "invalid-view-omission",
  "missing-view-explanation",
  "unassigned-images",
]);
const CORRECTION_ISSUE_CODES = new Set<DesignPatentIssue["code"]>([
  "subject-bounds-unavailable",
  "subject-bounds-unconfirmed",
  "view-width-mismatch",
  "view-height-mismatch",
  "view-depth-mismatch",
]);
const BRIEF_ISSUE_CODES = new Set<DesignPatentIssue["code"]>([
  "missing-representative-view",
  "missing-product-use",
  "missing-design-point",
  "missing-partial-design-description",
  "missing-omission-reason",
  "invalid-design-color",
  "invalid-design-brief-text",
  "invalid-design-group",
  "incomplete-gui-brief",
  "invalid-brief-combination",
]);

function statusForIssues(
  issues: readonly DesignPatentIssue[],
  issueCodes: ReadonlySet<DesignPatentIssue["code"]>,
  started: boolean,
): DesignWorkflowStatus {
  if (issues.some((issue) => issueCodes.has(issue.code))) return "needs-attention";
  return started ? "complete" : "not-started";
}

export function getDesignWorkflowStatuses(
  designPatent: DesignPatent,
  productName?: string | null,
): DesignWorkflowStatuses {
  const issues = inspectDesignPatent(designPatent, productName);
  const omitted = resolvedOrthographicOmissions(designPatent);
  const assignmentIssues = issues.filter(
    (issue) =>
      issue.code !== "unassigned-images" ||
      designPatent.views.some(
        (view) => issue.viewIds?.includes(view.viewId) && !isHeldForOmittedView(view, omitted),
      ),
  );
  const hasAssignedImage = designPatent.views.some(isAssignedDesignView);
  const hasOrthographicImage = designPatent.views.some((view) =>
    (["front", "rear", "left", "right", "top", "bottom"] as const).includes(
      view.kind as "front" | "rear" | "left" | "right" | "top" | "bottom",
    ),
  );
  const hasBriefContent = Boolean(
    designPatent.brief.productUse || designPatent.brief.designPoints.length > 0,
  );

  return {
    images: statusForIssues(assignmentIssues, IMAGE_ISSUE_CODES, hasAssignedImage),
    correction: issues.some((issue) => CORRECTION_ISSUE_CODES.has(issue.code))
      ? "needs-attention"
      : hasOrthographicImage || (designPatent.imageMode === "multi-image" && hasAssignedImage)
        ? "complete"
        : hasAssignedImage
          ? "in-progress"
          : "not-started",
    brief: statusForIssues(issues, BRIEF_ISSUE_CODES, hasBriefContent),
    review: issues.length === 0 ? "complete" : "needs-attention",
  };
}
