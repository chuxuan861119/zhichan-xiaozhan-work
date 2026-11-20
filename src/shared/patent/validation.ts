import { DEFAULT_PATENT_INSPECTION_RULES } from "../patent-inspection/default-rules.js";
import { runPatentInspection } from "../patent-inspection/engine.js";
import type {
  InspectionMode,
  PatentInspectionReport,
  PatentIssueCode,
} from "../patent-inspection/types.js";
import { type DesignPatentIssueCode, inspectDesignPatent } from "./design-patent.js";
import type { CanonicalPatent, PatentBookKind } from "./model.js";

export type { PatentIssueCode } from "../patent-inspection/types.js";

export type PatentIssue = Readonly<{
  severity: "warning" | "error";
  code: PatentIssueCode | DesignPatentIssueCode;
  bookKind: PatentBookKind;
  targetId: string | null;
  message: string;
}>;

export function inspectPatent(
  patent: CanonicalPatent,
  mode: InspectionMode = "full",
): PatentInspectionReport {
  return runPatentInspection(patent, DEFAULT_PATENT_INSPECTION_RULES, { mode });
}

export function validatePatentWithEngine(patent: CanonicalPatent): PatentIssue[] {
  return inspectPatent(patent).issues.map((issue) => ({
    severity: issue.severity === "error" ? "error" : "warning",
    code: issue.legacyCode,
    bookKind: issue.locations[0]?.bookKind ?? "description",
    targetId: issue.locations[0]?.targetId ?? null,
    message: issue.summary,
  }));
}

export function validatePatent(patent: CanonicalPatent): PatentIssue[] {
  if (patent.patentType === "design" && patent.designPatent) {
    return inspectDesignPatent(patent.designPatent, patent.name).map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      bookKind: "description",
      targetId: issue.viewIds?.[0] ?? null,
      message: issue.message,
    }));
  }
  return validatePatentWithEngine(patent);
}
