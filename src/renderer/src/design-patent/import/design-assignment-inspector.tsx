import type { AssignmentSuggestion } from "./design-assignment";

export function DesignAssignmentInspector({
  suggestion,
}: {
  suggestion: AssignmentSuggestion | undefined;
}) {
  if (!suggestion) return null;
  return (
    <p className="design-import-step__suggestion">
      {suggestion.status === "suggested"
        ? suggestion.evidence
        : suggestion.reason === "ambiguous"
          ? "文件名包含多个视图标记，请手动分配。"
          : suggestion.reason === "occupied"
            ? "目标视图已占用，已保留在暂存区。"
            : suggestion.reason === "duplicate"
              ? "同批图片重复指向该视图，已保留在暂存区。"
              : "未识别到视图标记，请手动分配。"}
    </p>
  );
}
