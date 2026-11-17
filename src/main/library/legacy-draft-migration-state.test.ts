import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LegacyDraftMigrationStateFile } from "./legacy-draft-migration-state.js";

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

describe("legacy draft migration state", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "patent-legacy-migration-state-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("persists imported draft ids across service instances", async () => {
    const path = join(root, "legacy-draft-migration.json");
    const draftId = testUuid(1);
    const libraryDocumentId = testUuid(2);
    const first = new LegacyDraftMigrationStateFile(path, () => new Date("2026-08-01T02:07:04Z"));

    expect(await first.isImported(draftId)).toBe(false);
    await first.markImported(draftId, libraryDocumentId);

    const second = new LegacyDraftMigrationStateFile(path);
    expect(await second.isImported(draftId)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      formatVersion: 1,
      importedDrafts: [
        {
          draftId,
          libraryDocumentId,
          importedAt: "2026-08-01T02:07:04.000Z",
        },
      ],
    });
  });
});
