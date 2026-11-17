// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { AutomationError } from "../../shared/automation/protocol.js";
import type { AutomationLedger, OperationRecord } from "./ledger.js";
import { recoverPublication } from "./publication-recovery.js";

test("publication recovery rechecks authority after reading and never republishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "zxw-recovery-audit-"));
  try {
    const target = join(root, "output.docx");
    const bytes = Buffer.from("isolated-published-output");
    await writeFile(target, bytes);
    const info = await stat(target, { bigint: true });
    const hash = createHash("sha256").update(bytes).digest("hex");
    const record = {
      evidence: {
        phase: "publishing",
        target,
        temp: join(root, "absent.tmp"),
        hash,
        size: bytes.length,
        device: info.dev.toString(),
        inode: info.ino.toString(),
        revision: 1,
        format: "docx",
        warnings: [],
      },
    } as OperationRecord;
    const update = vi.fn();
    const ledger = { update } as unknown as AutomationLedger;
    await expect(
      recoverPublication(ledger, record, [root], () => {
        throw new AutomationError("AUTH_REVOKED", "revoked");
      }),
    ).rejects.toMatchObject({ code: "AUTH_REVOKED" });
    expect(update).not.toHaveBeenCalled();
    await recoverPublication(ledger, record, [root], () => {});
    expect(update).toHaveBeenCalledWith(
      record,
      "committed",
      expect.objectContaining({ path: target, sha256: hash }),
      record.evidence,
    );
    update.mockClear();
    record.evidence = { ...(record.evidence as object), inode: (info.ino + 1n).toString() };
    await recoverPublication(ledger, record, [root], () => {});
    expect(update).not.toHaveBeenCalled();
    // Old receipts with unsafe numeric identities cannot prove which file was published.
    record.evidence = { ...(record.evidence as object), inode: Number.MAX_SAFE_INTEGER + 1 };
    await expect(recoverPublication(ledger, record, [root], () => {})).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
