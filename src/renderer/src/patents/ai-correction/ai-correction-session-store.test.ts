import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  type AiCorrectionSessionEntry,
  appendReasoning,
  localEntryKey,
  removeSessionEntries,
  selectVisibleEntry,
} from "./ai-correction-session-store";

function entry(
  patentId: string,
  sessionId: string,
  scope: AiCorrectionSessionEntry["scope"],
): AiCorrectionSessionEntry {
  return {
    patentId,
    sessionId,
    scope,
    originBookKind: scope.bookKind,
    status: "completed",
    jobId: randomUUID(),
    issues: [],
    progress: null,
    error: null,
    thinkingEnabled: false,
    phase: null,
    reasoning: "",
    reasoningTruncated: false,
    resultLimitReached: false,
    discardedIssueCount: 0,
  };
}

describe("AI correction session store", () => {
  test("uses one result key for each patent document", () => {
    expect(localEntryKey("patent-a", "description")).toBe("patent-a:description");
  });

  test("selects results only for the active patent and document", () => {
    const sessionId = randomUUID();
    const entries = {
      [localEntryKey("patent-a", "claims")]: entry("patent-a", sessionId, {
        kind: "current-book",
        bookKind: "claims",
      }),
      [localEntryKey("patent-a", "description")]: entry("patent-a", sessionId, {
        kind: "current-book",
        bookKind: "description",
      }),
    };

    expect(selectVisibleEntry(entries, "patent-a", "claims")?.scope).toEqual({
      kind: "current-book",
      bookKind: "claims",
    });
    expect(selectVisibleEntry(entries, "patent-a", "abstract")).toBeNull();
    expect(selectVisibleEntry(entries, "patent-b", "claims")).toBeNull();
  });

  test("removes only entries owned by a closed patent session", () => {
    const closedSessionId = randomUUID();
    const openSessionId = randomUUID();
    const entries = {
      [localEntryKey("patent-a", "claims")]: entry("patent-a", closedSessionId, {
        kind: "current-book",
        bookKind: "claims",
      }),
      [localEntryKey("patent-b", "abstract")]: entry("patent-b", openSessionId, {
        kind: "current-book",
        bookKind: "abstract",
      }),
    };

    expect(Object.values(removeSessionEntries(entries, closedSessionId))).toEqual([
      expect.objectContaining({ sessionId: openSessionId }),
    ]);
  });

  test("retains reasoning beyond the old 20,000 character display limit", () => {
    const current = entry("patent-a", randomUUID(), {
      kind: "current-book",
      bookKind: "description",
    });

    const next = appendReasoning(current, `开头${"x".repeat(20_000)}结尾`);

    expect(next.reasoning).toHaveLength(20_004);
    expect(next.reasoning).toContain("开头");
    expect(next.reasoning.endsWith("结尾")).toBe(true);
    expect(next.reasoningTruncated).toBe(false);
  });
});
