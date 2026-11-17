// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { LibraryLocation } from "./library-location.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "library-location-"));
  roots.push(root);
  const source = join(root, "old");
  await mkdir(source);
  const db = new DatabaseSync(join(source, "library.sqlite3"));
  db.exec("CREATE TABLE example (text TEXT); INSERT INTO example VALUES ('专利正文');");
  db.close();
  await writeFile(join(source, "last-run-state.json"), JSON.stringify({ cleanShutdown: true }));
  await mkdir(join(source, "assets"));
  await mkdir(join(source, "empty-folder"));
  await writeFile(join(source, "assets", "drawing.bin"), "drawing");
  const parent = join(root, "new");
  await mkdir(parent);
  const file = join(root, "location.json");
  const service = new LibraryLocation(file, source);
  return { root, source, parent, file, service };
}
test("moves complete library only on startup and persists the new location", async () => {
  const { source, parent, file, service } = await fixture();
  expect((await service.resolveStartup()).root).toBe(source);
  const target = await service.schedule(parent);
  await service.approveAfterShutdown();
  expect(await readFile(join(source, "assets/drawing.bin"), "utf8")).toBe("drawing");
  expect((await service.resolveStartup()).root).toBe(target);
  expect(await readFile(join(target, "assets/drawing.bin"), "utf8")).toBe("drawing");
  expect((await new LibraryLocation(file, source).resolveStartup()).root).toBe(target);
  expect(await readFile(join(target, "library.sqlite3"))).toEqual(
    await readFile(join(source, "library.sqlite3")),
  );
  expect(await readFile(join(source, "assets/drawing.bin"), "utf8")).toBe("drawing");
});
test("cancel leaves original library active", async () => {
  const { source, parent, service } = await fixture();
  await service.schedule(parent);
  await service.cancel();
  expect((await service.resolveStartup()).root).toBe(source);
});
test("unclean shutdown aborts migration and leaves the old library for recovery", async () => {
  const { source, parent, service } = await fixture();
  await service.schedule(parent);
  await service.approveAfterShutdown();
  await writeFile(join(source, "last-run-state.json"), JSON.stringify({ cleanShutdown: false }));
  const result = await service.resolveStartup();
  expect(result.root).toBe(source);
  expect(result.notice).toContain("未正常退出");
});
test("an unapproved request cannot move a library even with an old clean marker", async () => {
  const { source, parent, service } = await fixture();
  await service.schedule(parent);
  const result = await service.resolveStartup();
  expect(result.root).toBe(source);
  expect(result.notice).toContain("未正常退出");
});
test("invalid database leaves source and location unchanged", async () => {
  const { source, parent, service } = await fixture();
  await writeFile(join(source, "library.sqlite3"), "not sqlite");
  await service.schedule(parent);
  await service.approveAfterShutdown();
  const result = await service.resolveStartup();
  expect(result.root).toBe(source);
  expect(result.notice).toContain("迁移未完成");
  expect(await readFile(join(source, "library.sqlite3"), "utf8")).toBe("not sqlite");
});
test("missing destination aborts safely and another migration can succeed", async () => {
  const { source, parent, service } = await fixture();
  await service.schedule(parent);
  await service.approveAfterShutdown();
  await rm(parent, { recursive: true });
  expect((await service.resolveStartup()).root).toBe(source);
  await mkdir(parent);
  const target = await service.schedule(parent);
  await service.approveAfterShutdown();
  expect((await service.resolveStartup()).root).toBe(target);
  const nextParent = join(parent, "again");
  await mkdir(nextParent);
  const next = await service.schedule(nextParent);
  await service.approveAfterShutdown();
  expect((await service.resolveStartup()).root).toBe(next);
});
test("missing relocated library never silently falls back to an empty default", async () => {
  const { parent, service } = await fixture();
  const target = await service.schedule(parent);
  await service.approveAfterShutdown();
  await service.resolveStartup();
  await rm(target, { recursive: true });
  await expect(service.resolveStartup()).rejects.toThrow("不可用");
});
test("a supported library directory replacement preserves location identity", async () => {
  const { source, parent, service } = await fixture();
  const target = await service.schedule(parent);
  await service.approveAfterShutdown();
  await service.resolveStartup();
  await rm(target, { recursive: true });
  await mkdir(target);
  await writeFile(join(target, "library.sqlite3"), await readFile(join(source, "library.sqlite3")));
  expect((await service.resolveStartup()).root).toBe(target);
});
test("nested targets and corrupt position records are rejected", async () => {
  const { source, file, service } = await fixture();
  await expect(service.schedule(source)).rejects.toThrow();
  await writeFile(file, "broken");
  await expect(service.resolveStartup()).rejects.toThrow("位置记录");
});
