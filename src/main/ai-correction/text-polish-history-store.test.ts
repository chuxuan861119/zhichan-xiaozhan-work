import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import writeFileAtomic from "write-file-atomic";
import { TextPolishHistoryStore } from "./text-polish-history-store.js";

test("restores independent reference drafts and messages after reopening storage", () => {
  const root = mkdtempSync(join(tmpdir(), "polish-reference-history-"));
  const store = new TextPolishHistoryStore(root);
  const fixture = reasoningFixture();
  const referenceText = "参".repeat(20000);
  const snapshot = {
    ...fixture,
    messages: [
      {
        role: "user" as const,
        messageId: randomUUID(),
        turnId: randomUUID(),
        text: "分析",
        referenceText,
      },
    ],
  };
  store.save(snapshot);
  store.saveDraft(snapshot.patentId, snapshot.conversationId, {
    text: "草稿",
    presets: [],
    referenceText,
  });
  const restored = new TextPolishHistoryStore(root);
  expect(restored.snapshot(snapshot.patentId, snapshot.conversationId)?.messages).toEqual(
    snapshot.messages,
  );
  expect(restored.draft(snapshot.patentId, snapshot.conversationId).referenceText).toBe(
    referenceText,
  );
});

test("lists lightweight history, renames across saves and removes only the selected record", async () => {
  const root = mkdtempSync(join(tmpdir(), "polish-history-manage-"));
  const store = new TextPolishHistoryStore(root);
  const first = reasoningFixture();
  const second = { ...reasoningFixture(), patentId: first.patentId };
  store.save(first);
  store.save(second);
  store.saveDraft(first.patentId, first.conversationId, { text: "草稿", presets: [] });
  store.rename(first.patentId, first.conversationId, "冷却结构讨论");
  store.save(first);
  expect(
    (await store.list(first.patentId)).find((item) => item.conversationId === first.conversationId)
      ?.title,
  ).toBe("冷却结构讨论");
  store.remove(first.patentId, first.conversationId);
  expect(await store.list(first.patentId)).toHaveLength(1);
  expect(store.snapshot(first.patentId, first.conversationId)).toBeNull();
  expect(store.draft(first.patentId, first.conversationId).text).toBe("");
  expect(store.snapshot(second.patentId, second.conversationId)).not.toBeNull();
});

test("invalidates cached history metadata when a record changes externally", async () => {
  const root = mkdtempSync(join(tmpdir(), "polish-history-cache-"));
  const store = new TextPolishHistoryStore(root);
  const snapshot = reasoningFixture();
  store.save(snapshot);
  expect((await store.list(snapshot.patentId))[0]?.error).toBeUndefined();
  const parse = vi.spyOn(JSON, "parse");
  try {
    await store.list(snapshot.patentId);
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
  writeFileSync(
    join(root, snapshot.patentId, `conversation-${snapshot.conversationId}.json`),
    "损坏记录",
  );
  expect((await store.list(snapshot.patentId))[0]?.error).toContain("原文件已保留");
});

function reasoningFixture() {
  const id = randomUUID();
  return {
    conversationId: id,
    patentId: id,
    sessionId: id,
    bookKind: "description" as const,
    conversationRevision: 0,
    source: { kind: "generation" as const, requirement: "合成测试需求" },
    model: {
      profileId: id,
      providerId: "custom",
      displayName: "Synthetic",
      baseUrl: "https://example.com/v1",
      model: "synthetic",
    },
    messages: [],
    latestValidDraft: "最终文字保留",
    summary: null,
    activeTurn: null,
    lastTurnOutcome: null,
    reasoningByTurn: { [id]: { text: "仅限本次会话的思考", truncated: false } },
  };
}

test("async draft saves serialize the latest value and preserve corrupt files", async () => {
  const root = mkdtempSync(join(tmpdir(), "polish-async-draft-"));
  const patentId = randomUUID();
  const store = new TextPolishHistoryStore(root);
  const sync = vi.spyOn(writeFileAtomic, "sync");
  try {
    await Promise.all([
      store.saveDraftAsync(patentId, null, { text: "第一版", presets: [] }),
      store.saveDraftAsync(patentId, null, { text: "最终版", presets: [] }),
    ]);
    expect(sync).not.toHaveBeenCalled();
    expect(store.draft(patentId, null).text).toBe("最终版");
    const path = join(root, patentId, "draft-new.json");
    writeFileSync(path, "损坏的原文件");
    await expect(
      store.saveDraftAsync(patentId, null, { text: "禁止覆盖", presets: [] }),
    ).rejects.toThrow(/原文件已保留/);
    expect(readFileSync(path, "utf8")).toBe("损坏的原文件");
  } finally {
    sync.mockRestore();
  }
});

test("a legacy rewrite failure blocks only that history, not startup or other histories", () => {
  const root = mkdtempSync(join(tmpdir(), "polish-migration-error-"));
  const snapshot = reasoningFixture();
  const store = new TextPolishHistoryStore(root);
  store.save(snapshot);
  const path = join(root, snapshot.patentId, `conversation-${snapshot.conversationId}.json`);
  const original = JSON.stringify({ snapshot, updatedAt: "original" });
  writeFileSync(path, original);
  const write = vi.spyOn(writeFileAtomic, "sync").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  try {
    const fresh = new TextPolishHistoryStore(root);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(() => fresh.snapshot(snapshot.patentId, snapshot.conversationId)).toThrow(
      /思考过程清理失败/,
    );
    expect(fresh.history(snapshot.patentId)[0]?.error).toMatch(/思考过程清理失败/);
    const other = reasoningFixture();
    fresh.save(other);
    expect(fresh.snapshot(other.patentId, other.conversationId)).toEqual(other);
  } finally {
    write.mockRestore();
  }
});

test("keeps reasoning in this store session but never writes or restores it from disk", () => {
  const root = mkdtempSync(join(tmpdir(), "polish-reasoning-session-"));
  const snapshot = reasoningFixture();
  const store = new TextPolishHistoryStore(root);
  store.save(snapshot);
  expect(store.snapshot(snapshot.patentId, snapshot.conversationId)).toEqual(snapshot);
  const raw = readFileSync(
    join(root, snapshot.patentId, `conversation-${snapshot.conversationId}.json`),
    "utf8",
  );
  expect(raw).not.toContain("reasoningByTurn");
  expect(raw).not.toContain("仅限本次会话的思考");
  const fresh = new TextPolishHistoryStore(root);
  expect(
    fresh.snapshot(snapshot.patentId, snapshot.conversationId)?.reasoningByTurn,
  ).toBeUndefined();
  expect(fresh.snapshot(snapshot.patentId, snapshot.conversationId)?.latestValidDraft).toBe(
    "最终文字保留",
  );
});

test("startup removes legacy reasoning from unopened history without changing final text or dates", () => {
  const root = mkdtempSync(join(tmpdir(), "polish-legacy-reasoning-"));
  const snapshot = reasoningFixture();
  new TextPolishHistoryStore(root).save(snapshot);
  const path = join(root, snapshot.patentId, `conversation-${snapshot.conversationId}.json`);
  writeFileSync(path, JSON.stringify({ snapshot, updatedAt: "original-date" }));
  const fresh = new TextPolishHistoryStore(root);
  expect(readFileSync(path, "utf8")).not.toContain("reasoningByTurn");
  expect(
    fresh.snapshot(snapshot.patentId, snapshot.conversationId)?.reasoningByTurn,
  ).toBeUndefined();
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    updatedAt: "original-date",
    snapshot: { latestValidDraft: "最终文字保留" },
  });
});

test("drafts and active conversation survive a fresh store without crossing patents", () => {
  const root = mkdtempSync(join(tmpdir(), "polish-history-"));
  const patentId = randomUUID();
  const store = new TextPolishHistoryStore(root);
  store.saveDraft(patentId, null, {
    text: "未发送的需求\n第二行",
    presets: ["专业严谨"],
  });
  const fresh = new TextPolishHistoryStore(root);
  expect(fresh.draft(patentId, null)).toEqual({
    text: "未发送的需求\n第二行",
    presets: ["专业严谨"],
  });
  expect(fresh.draft(randomUUID(), null)).toEqual({ text: "", presets: [] });
  expect(() => fresh.draft("../escape", null)).toThrow();
});

test("corrupt drafts are reported and never silently overwritten", () => {
  const root = mkdtempSync(join(tmpdir(), "polish-history-"));
  const patentId = randomUUID();
  const store = new TextPolishHistoryStore(root);
  store.saveDraft(patentId, null, { text: "草稿", presets: [] });
  const path = join(root, patentId, "draft-new.json");
  writeFileSync(path, "broken", "utf8");
  expect(() => store.draft(patentId, null)).toThrow(/读取/);
  expect(() => store.saveDraft(patentId, null, { text: "新字", presets: [] })).toThrow();
  expect(readFileSync(path, "utf8")).toBe("broken");
});

test("explicit state recovery preserves corrupt bytes and unblocks a fresh draft", () => {
  const root = mkdtempSync(join(tmpdir(), "polish-recover-"));
  const id = randomUUID();
  const store = new TextPolishHistoryStore(root);
  store.saveDraft(id, null, { text: "原文", presets: [] });
  writeFileSync(join(root, id, "active.json"), "broken-active");
  writeFileSync(join(root, id, "draft-new.json"), "broken-draft");
  store.recoverState(id);
  expect(store.active(id)).toBeNull();
  expect(store.draft(id, null).text).toBe("");
  const backups = readdirSync(join(root, id)).filter((name) => name.includes(".unreadable-"));
  expect(backups.map((name) => readFileSync(join(root, id, name), "utf8")).sort()).toEqual([
    "broken-active",
    "broken-draft",
  ]);
  store.saveDraft(id, null, { text: "新文", presets: [] });
  expect(store.draft(id, null).text).toBe("新文");
});

test("lists a damaged conversation separately without modifying its file", () => {
  const root = mkdtempSync(join(tmpdir(), "polish-history-"));
  const patentId = randomUUID();
  const id = randomUUID();
  const store = new TextPolishHistoryStore(root);
  store.saveDraft(patentId, null, { text: "", presets: [] });
  const path = join(root, patentId, `conversation-${id}.json`);
  writeFileSync(path, "broken", "utf8");
  expect(store.history(patentId)).toEqual([
    expect.objectContaining({ conversationId: id, error: expect.any(String) }),
  ]);
  expect(readFileSync(path, "utf8")).toBe("broken");
});

test("explicit recovery quarantines only the selected corrupt conversation and preserves its bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "polish-recover-conversation-"));
  const patentId = randomUUID();
  const id = randomUUID();
  const other = randomUUID();
  const store = new TextPolishHistoryStore(root);
  store.saveDraft(patentId, id, { text: "继续保留", presets: [] });
  store.activate(patentId, id);
  const name = `conversation-${id}.json`;
  writeFileSync(join(root, patentId, name), "broken-conversation");
  writeFileSync(join(root, patentId, `conversation-${other}.json`), "other-broken");
  store.recoverState(patentId, id);
  expect(store.snapshot(patentId, id)).toBeNull();
  expect(store.draft(patentId, id).text).toBe("继续保留");
  expect(store.history(patentId)).toEqual([expect.objectContaining({ conversationId: other })]);
  const preserved = readdirSync(join(root, patentId)).find((file) =>
    file.startsWith(`${name}.unreadable-`),
  );
  expect(preserved).toBeDefined();
  if (!preserved) throw new Error("missing quarantine");
  expect(readFileSync(join(root, patentId, preserved), "utf8")).toBe("broken-conversation");
});

test("recovery preserves valid conversations and quarantines identity-mismatched records", () => {
  const root = mkdtempSync(join(tmpdir(), "polish-recover-identity-"));
  const patentId = randomUUID();
  const id = randomUUID();
  const store = new TextPolishHistoryStore(root);
  const snapshot = {
    conversationId: id,
    patentId,
    sessionId: id,
    bookKind: "description" as const,
    conversationRevision: 0,
    source: { kind: "generation" as const, requirement: "synthetic" },
    model: {
      profileId: id,
      providerId: "custom" as const,
      displayName: "Synthetic",
      baseUrl: "https://example.com/v1",
      model: "synthetic",
    },
    messages: [],
    latestValidDraft: null,
    summary: null,
    activeTurn: null,
    lastTurnOutcome: null,
  };
  store.save(snapshot);
  store.recoverState(patentId, id);
  expect(store.snapshot(patentId, id)).toEqual(snapshot);
  const path = join(root, patentId, `conversation-${id}.json`);
  const invalid = JSON.stringify({
    updatedAt: "synthetic",
    snapshot: { ...snapshot, patentId: randomUUID() },
  });
  writeFileSync(path, invalid);
  expect(() => store.snapshot(patentId, id)).toThrow("所属专利不一致");
  store.recoverState(patentId, id);
  expect(store.snapshot(patentId, id)).toBeNull();
  const preserved = readdirSync(join(root, patentId)).find((name) => name.includes(".unreadable-"));
  if (!preserved) throw new Error("missing identity quarantine");
  expect(readFileSync(join(root, patentId, preserved), "utf8")).toBe(invalid);
});

test("history exposes an inactive conversation's corrupt draft for targeted recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "polish-recover-inactive-draft-"));
  const patentId = randomUUID();
  const activeId = randomUUID();
  const inactiveId = randomUUID();
  const store = new TextPolishHistoryStore(root);
  const snapshots = [activeId, inactiveId].map((id) => ({
    conversationId: id,
    patentId,
    sessionId: id,
    bookKind: "description" as const,
    conversationRevision: 0,
    source: { kind: "generation" as const, requirement: "synthetic" },
    model: {
      profileId: id,
      providerId: "custom" as const,
      displayName: "Synthetic",
      baseUrl: "https://example.com/v1",
      model: "synthetic",
    },
    messages: [],
    latestValidDraft: null,
    summary: null,
    activeTurn: null,
    lastTurnOutcome: null,
  }));
  for (const snapshot of snapshots) {
    store.save(snapshot);
    store.saveDraft(patentId, snapshot.conversationId, {
      text: "保留草稿",
      presets: [],
    });
  }
  store.activate(patentId, activeId);
  const directory = join(root, patentId);
  const draftName = `draft-${inactiveId}.json`;
  writeFileSync(join(directory, draftName), "broken-inactive-draft", "utf8");
  const before = new Map(
    readdirSync(directory).map((name) => [name, readFileSync(join(directory, name), "utf8")]),
  );

  const fresh = new TextPolishHistoryStore(root);
  const history = fresh.history(patentId);
  expect(
    (await fresh.list(patentId)).find((item) => item.conversationId === inactiveId)?.error,
  ).toEqual(expect.any(String));
  expect(history.find((item) => item.conversationId === activeId)?.error).toBeUndefined();
  expect(history.find((item) => item.conversationId === inactiveId)?.error).toEqual(
    expect.any(String),
  );
  for (const [name, bytes] of before)
    expect(readFileSync(join(directory, name), "utf8")).toBe(bytes);

  fresh.recoverState(patentId, inactiveId);
  expect(fresh.active(patentId)).toBe(activeId);
  for (const snapshot of snapshots)
    expect(fresh.snapshot(patentId, snapshot.conversationId)).toEqual(snapshot);
  expect(fresh.draft(patentId, activeId)).toEqual({
    text: "保留草稿",
    presets: [],
  });
  expect(fresh.draft(patentId, inactiveId)).toEqual({ text: "", presets: [] });
  const quarantined = readdirSync(directory).filter((name) => name.includes(".unreadable-"));
  expect(quarantined).toHaveLength(1);
  const preserved = quarantined[0];
  if (!preserved) throw new Error("missing draft quarantine");
  expect(preserved).toMatch(new RegExp(`^${draftName}\\.unreadable-`));
  expect(readFileSync(join(directory, preserved), "utf8")).toBe("broken-inactive-draft");
  expect(fresh.history(patentId).every((item) => !item.error)).toBe(true);
  expect((await fresh.list(patentId)).every((item) => !item.error)).toBe(true);
  fresh.saveDraft(patentId, inactiveId, { text: "恢复后草稿", presets: [] });
  expect(new TextPolishHistoryStore(root).draft(patentId, inactiveId).text).toBe("恢复后草稿");
});
