import type { PatentBookKind } from "./model.js";

export type PatentWorkspaceTool = "flowchart" | "drawing-markup";
export const PATENT_WORKSPACE_TOOL_LABELS = {
  flowchart: "流程图 / 电路图",
  "drawing-markup": "CAD标号",
} as const;

export type PatentDocumentTarget =
  | Readonly<{ patentId: string; kind: "tool"; tool: PatentWorkspaceTool }>
  | Readonly<{ patentId: string; kind: "book"; bookKind: PatentBookKind }>
  | Readonly<{ patentId: string; kind: "auxiliary"; auxiliaryDocumentId: string }>;

export type PatentDocumentAvailability = Readonly<{
  patentId: string;
  availableBookKinds: readonly PatentBookKind[];
  auxiliaryDocumentIds: readonly string[];
}>;

export function patentDocumentTargetKey(target: PatentDocumentTarget): string {
  if (target.kind === "tool") return `${target.patentId}:tool:${target.tool}`;
  return target.kind === "book"
    ? `${target.patentId}:book:${target.bookKind}`
    : `${target.patentId}:auxiliary:${target.auxiliaryDocumentId}`;
}

export function patentDocumentTargetsEqual(
  left: PatentDocumentTarget,
  right: PatentDocumentTarget,
): boolean {
  return patentDocumentTargetKey(left) === patentDocumentTargetKey(right);
}

export function isPatentDocumentTargetAvailable(
  target: PatentDocumentTarget,
  availability: PatentDocumentAvailability | null | undefined,
): boolean {
  if (!availability || availability.patentId !== target.patentId) return false;
  if (target.kind === "tool") return true;
  return target.kind === "book"
    ? availability.availableBookKinds.includes(target.bookKind)
    : availability.auxiliaryDocumentIds.includes(target.auxiliaryDocumentId);
}
