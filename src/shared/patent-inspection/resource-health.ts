import type { CanonicalPatent } from "../patent/model.js";
import { nestedBlocks } from "./blocks.js";
import { PRODUCT_POLICY } from "./rule-provenance.js";
import {
  InspectionUnavailableError,
  type PatentInspectionReport,
  type PatentInspectionRule,
  type PatentLocation,
} from "./types.js";
export const RESOURCE_HEALTH_RULE_ID = "core.assets.resource-health";
export type AssetHealth = { assetId: string; status: "ok" | "missing" | "damaged" | "unreadable" };
export type ResourceHealthResult = {
  patentId: string;
  patentRevision: number;
  assets: AssetHealth[];
};
export function resourceLocations(patent: CanonicalPatent): Map<string, PatentLocation[]> {
  const result = new Map<string, PatentLocation[]>();
  const add = (assetId: string, location: PatentLocation) => {
    const items = result.get(assetId) ?? [];
    if (!items.some((i) => i.bookKind === location.bookKind && i.targetId === location.targetId))
      items.push(location);
    result.set(assetId, items);
  };
  for (const book of patent.books)
    for (const node of nestedBlocks(book.document.content)) {
      if (node.type === "figure") add(node.assetId, { bookKind: book.kind, targetId: node.id });
      if (node.type === "chemical-structure")
        add(node.previewAssetId, { bookKind: book.kind, targetId: node.id });
      if (node.type === "paragraph" || node.type === "heading")
        for (const inline of node.content)
          if (inline.type === "inline-figure")
            add(inline.assetId, { bookKind: book.kind, targetId: inline.id });
    }
  if (patent.drawingBooksEnabled)
    for (const figure of patent.figures) {
      add(figure.assetId, { bookKind: "description-drawings", targetId: figure.figureId });
      if (figure.figureId === patent.abstractDrawingFigureId)
        add(figure.assetId, { bookKind: "abstract-drawing", targetId: figure.figureId });
    }
  return result;
}
export const resourceHealthRule: PatentInspectionRule = {
  id: RESOURCE_HEALTH_RULE_ID,
  version: 1,
  category: "export",
  cost: "full",
  defaultSeverity: "warning",
  dependencies: [
    "assets",
    "figures",
    "claims",
    "description",
    "abstract",
    "description-drawings",
    "abstract-drawing",
  ],
  provenance: PRODUCT_POLICY.exportSafety,
  appliesTo: () => true,
  inspect: ({ patent }) => {
    if (resourceLocations(patent).size)
      throw new InspectionUnavailableError("图片资源文件尚未核验。请重新进行全文检查。");
    return [];
  },
};
export function mergeResourceHealth(
  report: PatentInspectionReport,
  patent: CanonicalPatent,
  result: ResourceHealthResult,
): PatentInspectionReport {
  if (
    report.mode !== "full" ||
    result.patentId !== report.patentId ||
    result.patentRevision !== report.patentRevision
  )
    return report;
  const locations = resourceLocations(patent);
  const assets = new Map(result.assets.map((a) => [a.assetId, a]));
  if ([...locations.keys()].some((id) => !assets.has(id))) return report;
  const issues = [...report.issues.filter((i) => i.ruleId !== RESOURCE_HEALTH_RULE_ID)];
  const descriptors = new Map(patent.assets.map((asset) => [asset.assetId, asset]));
  for (const [assetId, targets] of locations) {
    const health = assets.get(assetId)!;
    if (health.status === "ok") continue;
    const name = descriptors.get(assetId)?.originalName ?? "图片";
    const reason =
      health.status === "missing"
        ? "文件缺失"
        : health.status === "damaged"
          ? "文件缺失或损坏"
          : "文件无法读取";
    issues.push({
      fingerprint: `${RESOURCE_HEALTH_RULE_ID}@1:${assetId}`,
      ruleId: RESOURCE_HEALTH_RULE_ID,
      ruleVersion: 1,
      source: "deterministic",
      category: "export",
      legacyCode: "asset-unreadable",
      identityKey: assetId,
      severity: "error",
      confidence: "certain",
      summary: `“${name}”${reason}。`,
      locations: targets,
      evidence: targets.map((location) => ({ location, excerpt: name })),
      recommendation: "重新导入或替换该图片；文件被占用时请稍后重试。",
      provenance: resourceHealthRule.provenance,
    });
  }
  return {
    ...report,
    issues,
    degradedRules: report.degradedRules.filter((r) => r.ruleId !== RESOURCE_HEALTH_RULE_ID),
  };
}
