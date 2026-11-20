import type { DesignPatentIssue } from "../../../../shared/patent/design-patent";

type ReviewGroupId = "images" | "correction" | "brief" | "export";
export type DesignReviewItem = DesignPatentIssue & {
  id: string;
  group: ReviewGroupId;
  target: { step: "images" | "correction" | "brief" | "review"; headingId: string };
  excludedFromExport: boolean;
};

const GROUP_FOR_CODE: Partial<Record<DesignPatentIssue["code"], ReviewGroupId>> = {
  "missing-images": "images",
  "invalid-view-omission": "images",
  "unassigned-images": "images",
  "missing-representative-view": "brief",
  "missing-view-explanation": "images",
  "subject-bounds-unavailable": "correction",
  "subject-bounds-unconfirmed": "correction",
  "view-width-mismatch": "correction",
  "view-height-mismatch": "correction",
  "view-depth-mismatch": "correction",
  "missing-product-use": "brief",
  "missing-design-point": "brief",
  "missing-partial-design-description": "brief",
  "missing-omission-reason": "brief",
  "invalid-design-color": "brief",
  "invalid-design-brief-text": "brief",
  "invalid-design-group": "brief",
  "incomplete-gui-brief": "brief",
  "invalid-brief-combination": "brief",
};
const TARGET_FOR_GROUP: Record<ReviewGroupId, DesignReviewItem["target"]> = {
  images: { step: "images", headingId: "images-heading" },
  correction: { step: "correction", headingId: "correction-heading" },
  brief: { step: "brief", headingId: "brief-heading" },
  export: { step: "review", headingId: "review-heading" },
};
export function buildDesignReviewModel(issues: readonly DesignPatentIssue[]) {
  const items = issues.map((issue) => {
    const group = GROUP_FOR_CODE[issue.code] ?? "export";
    return {
      ...issue,
      id: `${issue.code}:${issue.viewIds?.join(",") ?? ""}`,
      group,
      target: TARGET_FOR_GROUP[group],
      excludedFromExport: issue.code === "unassigned-images",
    };
  });
  const groups = (["images", "correction", "brief", "export"] as const)
    .map((id) => ({ id, items: items.filter((item) => item.group === id) }))
    .filter((group) => group.items.length > 0);
  return { items, groups };
}
export function designReviewWarningSignature(revision: number, items: readonly DesignReviewItem[]) {
  return `${revision}:${items
    .map((item) => item.id)
    .sort()
    .join("|")}`;
}
