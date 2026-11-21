// @vitest-environment node
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LibraryLocation } from "./library-location.js";

vi.mock("../platform/harmony-public-files.js", () => ({ usesHarmonyPublicFileCopy: () => true }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const denied = Object.assign(new Error("unsupported public storage operation"), {
    code: "EPERM",
  });
  return {
    ...actual,
    copyFile: vi.fn().mockRejectedValue(denied),
    link: vi.fn().mockRejectedValue(denied),
    utimes: vi.fn().mockRejectedValue(denied),
  };
});

test("public Harmony library migration verifies database and resources without unsupported copy or timestamp operations", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "library-location-harmony-"));
  try {
    const source = join(root, "source"),
      parent = join(root, "destination");
    await fs.mkdir(join(source, "assets"), { recursive: true });
    await fs.mkdir(parent);
    const db = new DatabaseSync(join(source, "library.sqlite3"));
    db.exec("CREATE TABLE example (text TEXT); INSERT INTO example VALUES ('专利正文');");
    db.close();
    await fs.writeFile(
      join(source, "last-run-state.json"),
      JSON.stringify({ cleanShutdown: true }),
    );
    await fs.writeFile(join(source, "assets", "drawing.bin"), "CAD and flow resources");
    const locationFile = join(root, "location.json");
    const service = new LibraryLocation(locationFile, source);
    const target = await service.schedule(parent);
    await service.approveAfterShutdown();
    expect((await service.resolveStartup()).root).toBe(target);
    expect(await fs.readFile(join(target, "library.sqlite3"))).toEqual(
      await fs.readFile(join(source, "library.sqlite3")),
    );
    expect(await fs.readFile(join(target, "assets", "drawing.bin"), "utf8")).toBe(
      "CAD and flow resources",
    );
    expect((await new LibraryLocation(locationFile, source).resolveStartup()).root).toBe(target);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
