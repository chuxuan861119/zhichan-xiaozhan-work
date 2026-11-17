import type { CanonicalPatent } from "../patent/model.js";
import { buildPatentFactIndex, type PatentFactIndex } from "./facts.js";
import {
  type InspectionIssue,
  type InspectionIssueDraft,
  type InspectionMode,
  InspectionUnavailableError,
  PATENT_INSPECTION_ENGINE_VERSION,
  type PatentInspectionReport,
  type PatentInspectionRule,
  type PatentLocation,
} from "./types.js";

export type RunPatentInspectionOptions = Readonly<{
  mode?: InspectionMode;
  now?: () => Date;
  buildFacts?: (patent: CanonicalPatent, mode: InspectionMode) => PatentFactIndex;
}>;

const severityOrder = {
  error: 0,
  warning: 1,
  suggestion: 2,
} as const;

export function runPatentInspection(
  patent: CanonicalPatent,
  rules: readonly PatentInspectionRule[],
  options: RunPatentInspectionOptions = {},
): PatentInspectionReport {
  const mode = options.mode ?? "full";
  const context = { patent, mode } as const;
  const issues: InspectionIssue[] = [];
  const degradedRules: Array<{ ruleId: string; message: string }> = [];
  const applicableRules: PatentInspectionRule[] = [];

  for (const rule of rules) {
    if (mode === "instant" && rule.cost !== "instant") continue;
    try {
      if (rule.appliesTo(context)) applicableRules.push(rule);
    } catch {
      degradedRules.push({ ruleId: rule.id, message: "该项检查未完成。" });
    }
  }

  let facts: PatentFactIndex;
  try {
    facts = (options.buildFacts ?? buildPatentFactIndex)(patent, mode);
  } catch {
    return {
      engineVersion: PATENT_INSPECTION_ENGINE_VERSION,
      patentId: patent.patentId,
      patentRevision: patent.revision,
      mode,
      checkedAt: (options.now?.() ?? new Date()).toISOString(),
      issues: [],
      degradedRules: [{ ruleId: "engine.facts", message: "检查所需数据未能完成整理。" }],
    };
  }
  for (const rule of applicableRules) {
    try {
      for (const draft of rule.inspect(context, facts)) {
        if (issues.length >= 1000) {
          degradedRules.push({
            ruleId: rule.id,
            message: "检查结果达到1000项上限，请先修正已列出的问题，再重新检查。",
          });
          break;
        }
        issues.push(toInspectionIssue(rule, draft));
      }
    } catch (error) {
      degradedRules.push({
        ruleId: rule.id,
        message: error instanceof InspectionUnavailableError ? error.message : "该项检查未完成。",
      });
    }
  }

  const uniqueIssues = [...new Map(issues.map((issue) => [issue.fingerprint, issue])).values()];
  uniqueIssues.sort(compareIssues);
  degradedRules.sort((left, right) => left.ruleId.localeCompare(right.ruleId));

  return {
    engineVersion: PATENT_INSPECTION_ENGINE_VERSION,
    patentId: patent.patentId,
    patentRevision: patent.revision,
    mode,
    checkedAt: (options.now?.() ?? new Date()).toISOString(),
    issues: uniqueIssues,
    degradedRules,
  };
}

function toInspectionIssue(
  rule: PatentInspectionRule,
  draft: InspectionIssueDraft,
): InspectionIssue {
  return {
    ...draft,
    fingerprint: createIssueFingerprint(rule, draft),
    ruleId: rule.id,
    ruleVersion: rule.version,
    source: "deterministic",
    category: rule.category,
    provenance: rule.provenance,
  };
}

function createIssueFingerprint(rule: PatentInspectionRule, draft: InspectionIssueDraft): string {
  const canonicalValue = JSON.stringify({
    ruleId: rule.id,
    ruleVersion: rule.version,
    legacyCode: draft.legacyCode,
    identityKey: draft.identityKey ?? null,
    locations: [...draft.locations].sort(compareLocations).map(normalizeLocation),
    evidence: [...draft.evidence]
      .map((evidence) => evidence.location)
      .sort(compareLocations)
      .map(normalizeLocation),
  });
  return `${rule.id}@${rule.version}:${fnv1a(canonicalValue)}`;
}

function normalizeLocation(location: PatentLocation) {
  return {
    kind: location.kind ?? "book",
    bookKind: location.bookKind,
    targetId: location.targetId ?? null,
    startOffset: location.startOffset ?? null,
    endOffset: location.endOffset ?? null,
  };
}

function compareLocations(left: PatentLocation, right: PatentLocation): number {
  return (
    (left.kind ?? "book").localeCompare(right.kind ?? "book") ||
    (left.bookKind ?? "").localeCompare(right.bookKind ?? "") ||
    (left.targetId ?? "").localeCompare(right.targetId ?? "") ||
    (left.startOffset ?? -1) - (right.startOffset ?? -1) ||
    (left.endOffset ?? -1) - (right.endOffset ?? -1)
  );
}

function compareIssues(left: InspectionIssue, right: InspectionIssue): number {
  return (
    severityOrder[left.severity] - severityOrder[right.severity] ||
    (left.locations[0]?.bookKind ?? "").localeCompare(right.locations[0]?.bookKind ?? "") ||
    left.ruleId.localeCompare(right.ruleId) ||
    (left.identityKey ?? "").localeCompare(right.identityKey ?? "") ||
    left.fingerprint.localeCompare(right.fingerprint)
  );
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
