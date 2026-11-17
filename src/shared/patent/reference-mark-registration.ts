import { randomUuid } from "../id.js";
import type { CanonicalPatent } from "./model.js";
import type { ReferenceMarkPlanResult } from "./reference-mark-operations.js";
import { PatentReferenceMarkSchema, type ParsedReferenceMark } from "./reference-marks.js";

export function referenceMarkRegistrationProblem(
  entries: readonly ParsedReferenceMark[], entry: ParsedReferenceMark,
): string | null {
  if (!Number.isSafeInteger(entry.number) || entry.number <= 0) return "编号须为正整数。";
  if (!PatentReferenceMarkSchema.shape.keyword.safeParse(entry.keyword).success)
    return "请填写关键词，最多500字，不能含换行、分号或顿号。";
  if (entries.some(mark => mark.number === entry.number)) return "该编号已存在，请使用其他编号。";
  if (entries.some(mark => mark.keyword === entry.keyword.trim())) return "该关键词已存在，请使用已有登记。";
  if (entries.length >= 100_000) return "附图标记数量已达上限。";
  return null;
}

/** Register only: no document rewriting, CAD reconstruction, or asset changes. */
export function planRegisterReferenceMark(
  patent: CanonicalPatent, entry: ParsedReferenceMark,
): ReferenceMarkPlanResult {
  const problem = !patent.drawingBooksEnabled ? "说明书附图已删除，无法增加附图标记。"
    : patent.referenceMarkSettings.pendingReview ? "请先完成当前附图标记核对。"
    : referenceMarkRegistrationProblem(patent.referenceMarks, entry);
  if (problem) return { ok: false, code: "INVALID_REFERENCE_MARK", message: problem };
  return {
    ok: true,
    plan: {
      before: patent,
      after: {
        ...patent,
        referenceMarks: [...patent.referenceMarks, {
          referenceMarkId: randomUuid(), number: entry.number, keyword: entry.keyword.trim(),
        }],
      },
      counts: { claims: 0, description: 0, abstract: 0 },
      affectedBookKinds: [], recordHistory: true,
      message: "已增加附图标记，可使用增补编号补充正文编号。",
    },
  };
}
