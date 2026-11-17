import type { LibraryPatentSummary } from "../../../shared/library/model";

export function formatPatentCounts(
  patents: readonly Pick<LibraryPatentSummary, "patentType">[],
): string {
  const inventions = patents.filter((patent) => patent.patentType === "invention").length;
  const utilityModels = patents.filter((patent) => patent.patentType === "utility-model").length;
  return `总计 ${patents.length} 项 · 发明 ${inventions} 项 · 新型 ${utilityModels} 项`;
}
