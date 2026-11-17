import type {
  AiCorrectionBookKind,
  AiCorrectionIssue,
  AiCorrectionPhase,
  AiCorrectionScope,
} from "../../../../shared/ai-correction/contract";
import type { AiCorrectionPanelStatus } from "./ai-correction-panel";

const MAX_REASONING_CHARACTERS = 32 * 1024 * 1024;

export type AiCorrectionSessionEntry = {
  patentId: string;
  sessionId: string;
  scope: AiCorrectionScope;
  originBookKind: AiCorrectionBookKind;
  status: AiCorrectionPanelStatus;
  jobId: string | null;
  issues: AiCorrectionIssue[];
  reportedIssueCount?: number;
  progress: { completed: number; total: number } | null;
  error: string | null;
  thinkingEnabled: boolean;
  phase: AiCorrectionPhase | null;
  reasoning: string;
  reasoningTruncated: boolean;
  resultLimitReached: boolean;
  discardedIssueCount: number;
  checkedAt?: string;
  checkedRevision?: number;
  contentChanged?: boolean;
  modelName?: string | undefined;
};

export type AiCorrectionSessionEntries = Record<string, AiCorrectionSessionEntry>;

export function localEntryKey(patentId: string, bookKind: AiCorrectionBookKind): string {
  return `${patentId}:${bookKind}`;
}

export function entryKey(patentId: string, bookKind: AiCorrectionBookKind): string {
  return localEntryKey(patentId, bookKind);
}

export function upsertEntry(
  entries: AiCorrectionSessionEntries,
  key: string,
  entry: AiCorrectionSessionEntry,
): AiCorrectionSessionEntries {
  return { ...entries, [key]: entry };
}

export function appendReasoning(
  entry: AiCorrectionSessionEntry,
  delta: string,
): AiCorrectionSessionEntry {
  const combined = entry.reasoning + delta;
  if (combined.length <= MAX_REASONING_CHARACTERS) {
    return { ...entry, reasoning: combined };
  }
  return {
    ...entry,
    reasoning: combined.slice(-MAX_REASONING_CHARACTERS),
    reasoningTruncated: true,
  };
}

export function removeSessionEntries(
  entries: AiCorrectionSessionEntries,
  sessionId: string,
): AiCorrectionSessionEntries {
  return Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => entry.sessionId !== sessionId),
  );
}

export function selectVisibleEntry(
  entries: AiCorrectionSessionEntries,
  patentId: string | null,
  bookKind: AiCorrectionBookKind,
): AiCorrectionSessionEntry | null {
  if (!patentId) return null;
  return entries[localEntryKey(patentId, bookKind)] ?? null;
}
