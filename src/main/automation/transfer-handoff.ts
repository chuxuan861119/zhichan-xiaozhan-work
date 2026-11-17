import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DataImportRecoveryResult } from "../data-transfer/data-import-recovery-service.js";
import { privateDirectory } from "./paths.js";

export const TransferHandoffReceiptSchema = z
  .object({
    importId: z.string().uuid(),
    libraryRoot: z.string(),
    phase: z.enum([
      "scheduled",
      "restart-validation-pending",
      "failed",
      "recovery-required",
      "committed",
      "rolled-back",
    ]),
    updatedAt: z.string(),
  })
  .strict();
export type TransferHandoffReceipt = z.infer<typeof TransferHandoffReceiptSchema>;

/** Outside the database and replaced user-data tree, so the restart can settle the handoff. */
export class TransferHandoffStore {
  constructor(
    private readonly applicationDataRoot: string,
    private readonly libraryRoot: string,
  ) {}
  async read(): Promise<TransferHandoffReceipt | null> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        join(this.applicationDataRoot, "automation-transfer", "handoff.json"),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4096) throw new Error("Invalid transfer handoff receipt");
      const receipt = TransferHandoffReceiptSchema.parse(JSON.parse(await handle.readFile("utf8")));
      return receipt.libraryRoot === this.libraryRoot ? receipt : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }
  async write(importId: string, phase: TransferHandoffReceipt["phase"]) {
    const root = await privateDirectory(join(this.applicationDataRoot, "automation-transfer"));
    const receipt = TransferHandoffReceiptSchema.parse({
      importId,
      libraryRoot: this.libraryRoot,
      phase,
      updatedAt: new Date().toISOString(),
    });
    const temporary = join(root, `${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(receipt));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, join(root, "handoff.json"));
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    // Directory fsync is unsupported on Windows; the package recovery journal remains authoritative.
    if (process.platform !== "win32") {
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return receipt;
  }
  async settle(journalImportId: string | undefined, recovery: DataImportRecoveryResult) {
    const receipt = await this.read();
    if (!receipt || ["committed", "rolled-back", "failed"].includes(receipt.phase)) return;
    const matching = journalImportId === receipt.importId;
    await this.write(
      receipt.importId,
      matching && recovery.status === "recovered"
        ? "committed"
        : matching && ["rolled-back", "abandoned"].includes(recovery.status)
          ? "rolled-back"
          : "recovery-required",
    );
  }
}
