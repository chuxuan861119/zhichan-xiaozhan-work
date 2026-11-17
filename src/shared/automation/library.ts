import { z } from "zod";
import { BackupConfigureRequestSchema } from "../backup/model.js";
import type { AppSettings } from "../settings/model.js";
import { SnapshotSettingsSchema } from "../snapshot/model.js";

const expectedHash = z.string().regex(/^[a-f0-9]{64}$/);
const fileName = z.string().min(1).max(1024);
export const AutomationBackupReadSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z
    .object({
      action: z.literal("list"),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  z.object({ action: z.literal("inspect"), fileName }).strict(),
]);
export const AutomationBackupRunSchema = z.object({ expectedHash }).strict();
export const AutomationBackupDeleteSchema = z
  .object({ fileName, expectedState: expectedHash })
  .strict();
export const AutomationBackupConfigureSchema = z
  .object({ expectedHash, settings: BackupConfigureRequestSchema })
  .strict();
export const AutomationSnapshotConfigureSchema = z
  .object({ expectedHash, settings: SnapshotSettingsSchema })
  .strict();
export function librarySettings(settings: AppSettings) {
  return { backup: settings.backup, snapshot: settings.snapshot };
}
