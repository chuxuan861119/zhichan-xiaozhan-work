import type { LibrarySaveState } from "../../../shared/library/model";

type SaveStateBadgeProps = {
  state: LibrarySaveState;
  lastSavedAt?: string | null;
  compact?: boolean;
};

const SAVE_STATE_LABELS: Record<LibrarySaveState, string> = {
  saving: "保存中…",
  saved: "已保存",
  failed: "保存失败",
};

function savedTitle(lastSavedAt: string | null | undefined): string | undefined {
  if (!lastSavedAt) return "已保存";
  return `已保存于 ${new Date(lastSavedAt).toLocaleString("zh-CN")}`;
}

export function SaveStateBadge({
  state,
  lastSavedAt = null,
  compact = false,
}: SaveStateBadgeProps) {
  const label = SAVE_STATE_LABELS[state];
  return (
    <span
      className={`save-indicator is-${state}${compact ? " is-compact" : ""}`}
      role="status"
      aria-label={label}
      aria-live="polite"
      title={state === "saved" ? savedTitle(lastSavedAt) : label}
    >
      {state !== "saved" && <span aria-hidden="true">{state === "failed" ? "!" : "•"}</span>}
      <span>{compact && state === "saved" ? "✓" : label}</span>
    </span>
  );
}
