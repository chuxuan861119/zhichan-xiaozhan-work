import { expect, test } from "vitest";
import { BackupConfigureRequestSchema, BackupConfigureResultSchema } from "../ipc/contract.js";
import { BackupSettingsSchema } from "./model.js";

test("backup configuration accepts legacy calls and migration reports across IPC", () => {
  const legacy = { enabled: true, folder: "C:/backup", intervalMinutes: 5 };
  expect(BackupConfigureRequestSchema.parse(legacy)).toEqual(legacy);
  const request = BackupConfigureRequestSchema.parse({
    ...legacy,
    migrateExisting: true,
    expectedSourceFolder: "C:/old",
  });
  expect(request.migrateExisting).toBe(true);
  expect(BackupSettingsSchema.safeParse(request).success).toBe(false);
  expect(BackupConfigureResultSchema.parse({ ok: true, value: undefined }).ok).toBe(true);
  expect(
    BackupConfigureResultSchema.parse({
      ok: true,
      value: { migratedCount: 2, skippedCount: 1, retainedSourceCount: 0 },
    }).ok,
  ).toBe(true);
});
