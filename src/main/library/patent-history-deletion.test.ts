import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PatentHistoryDeletion } from "./patent-history-deletion.js";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "history-deletion-"));
  roots.push(root);
  for (const patentId of [id, other]) {
    mkdirSync(join(root, patentId));
    for (const name of [
      "active.json",
      "draft-new.json",
      `conversation-${other}.json`,
      "draft-new.json.unreadable-test",
    ]) {
      writeFileSync(join(root, patentId, name), name);
    }
  }
  return { root, deletion: new PatentHistoryDeletion(root) };
}
test("deletes the complete authorized patent history only after committing the record deletion", async () => {
  const { root, deletion } = await fixture();
  let committed = false;
  deletion.run(id, () => {
    committed = true;
  });
  expect(committed).toBe(true);
  expect(existsSync(join(root, id))).toBe(false);
  expect(readFileSync(join(root, other, "active.json"), "utf8")).toBe("active.json");
});
test("restores every staged history byte when the database deletion fails", async () => {
  const { root, deletion } = await fixture();
  expect(() =>
    deletion.run(id, () => {
      throw new Error("database locked");
    }),
  ).toThrow("database locked");
  expect(readFileSync(join(root, id, "draft-new.json.unreadable-test"), "utf8")).toBe(
    "draft-new.json.unreadable-test",
  );
});
test("leaves the record untouched on rename failure and can retry", async () => {
  const { root } = await fixture();
  const commit = vi.fn();
  const rename = vi.fn(fs.renameSync).mockImplementationOnce(() => {
    throw new Error("EPERM");
  });
  const deletion = new PatentHistoryDeletion(root, { renameSync: rename, rmSync: fs.rmSync });
  expect(() => deletion.run(id, commit)).toThrow("EPERM");
  expect(commit).not.toHaveBeenCalled();
  expect(existsSync(join(root, id, "active.json"))).toBe(true);
  deletion.run(id, commit);
  expect(commit).toHaveBeenCalledOnce();
});
test("preserves a durable retry marker after post-commit cleanup failure", async () => {
  const { root } = await fixture();
  const commit = vi.fn();
  const remove = vi.fn(fs.rmSync).mockImplementationOnce(() => {
    throw new Error("EPERM");
  });
  const deletion = new PatentHistoryDeletion(root, { renameSync: fs.renameSync, rmSync: remove });
  expect(() => deletion.run(id, commit)).toThrow("EPERM");
  expect(commit).toHaveBeenCalledOnce();
  expect(existsSync(join(root, `.pending-delete-${id}`, "active.json"))).toBe(true);
  new PatentHistoryDeletion(root).reconcile(() => false);
  expect(existsSync(join(root, `.pending-delete-${id}`))).toBe(false);
});
test("rejects linked patent scopes without following them or deleting the record", async () => {
  const { root, deletion } = await fixture();
  const linked = "33333333-3333-4333-8333-333333333333";
  fs.symlinkSync(join(root, other), join(root, linked), "junction");
  const commit = vi.fn();
  expect(() => deletion.run(linked, commit)).toThrow("不安全");
  expect(commit).not.toHaveBeenCalled();
  expect(existsSync(join(root, other, "active.json"))).toBe(true);
});

test("reports blocked cleanup while continuing to restore surviving patents", async () => {
  const { root } = await fixture();
  renameSync(join(root, id), join(root, `.pending-delete-${id}`));
  renameSync(join(root, other), join(root, `.pending-delete-${other}`));
  const deletion = new PatentHistoryDeletion(root, {
    renameSync: fs.renameSync,
    rmSync: () => {
      throw new Error("EPERM");
    },
  });
  expect(deletion.reconcile((patentId) => patentId === other)).toEqual([id]);
  expect(readFileSync(join(root, `.pending-delete-${id}`, "active.json"), "utf8")).toBe(
    "active.json",
  );
  expect(existsSync(join(root, other, "active.json"))).toBe(true);
  expect(new PatentHistoryDeletion(root).reconcile(() => false)).toEqual([]);
  expect(existsSync(join(root, `.pending-delete-${id}`))).toBe(false);
});
test("reconciles interrupted staging based on the surviving patent record without touching normal scopes", async () => {
  const { root, deletion } = await fixture();
  renameSync(join(root, id), join(root, `.pending-delete-${id}`));
  deletion.reconcile((patentId) => patentId === id);
  expect(existsSync(join(root, id, "active.json"))).toBe(true);
  renameSync(join(root, id), join(root, `.pending-delete-${id}`));
  deletion.reconcile(() => false);
  expect(existsSync(join(root, `.pending-delete-${id}`))).toBe(false);
  expect(existsSync(join(root, other, "active.json"))).toBe(true);
});
test("rejects traversal and staging conflicts before invoking database deletion", async () => {
  const { root, deletion } = await fixture();
  const commit = vi.fn();
  expect(() => deletion.run("../escape", commit)).toThrow();
  mkdirSync(join(root, `.pending-delete-${id}`));
  expect(() => deletion.run(id, commit)).toThrow();
  expect(commit).not.toHaveBeenCalled();
  expect(existsSync(join(root, id, "active.json"))).toBe(true);
});
