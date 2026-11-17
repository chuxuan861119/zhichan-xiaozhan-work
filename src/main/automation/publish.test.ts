// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { AutomationExportContext } from "./export.js";
import type { AutomationLedger, OperationRecord } from "./ledger.js";
import { recoverPublication } from "./publication-recovery.js";
import { publishAutomationBytes, publishAutomationFile } from "./publish.js";

test.each(["svg", "zip", "zxwbackup"])(
  "%s publication preserves a recoverable receipt when the final ledger write fails",
  async (format) => {
    const root = await mkdtemp(join(tmpdir(), "zxw-asset-publication-"));
    try {
      const record = { operationId: randomUUID() } as OperationRecord;
      const update = vi.fn((_record, status, _result, evidence) => {
        if (status === "committed") throw new Error("receipt write failed");
        record.evidence = evidence;
      });
      const context: AutomationExportContext = {
        signal: new AbortController().signal,
        grant: {
          patents: {},
          createLimit: 0,
          workspace: { importDirectory: root, exportDirectory: root },
        },
        record,
        ledger: { update } as unknown as AutomationLedger,
        assertAuthorized: () => {},
      };
      const output = join(root, `drawing.${format}`);
      const source = join(root, "private-source.bin");
      await writeFile(source, "immutable");
      await expect(
        format === "zxwbackup"
          ? publishAutomationFile(source, output, format, 3, context)
          : publishAutomationBytes(Buffer.from("immutable"), output, format, 3, context),
      ).rejects.toThrow("receipt write failed");
      expect((record.evidence as { phase: string }).phase).toBe("publishing");
      expect(await readFile(output, "utf8")).toBe("immutable");
      update.mockImplementation(() => {});
      await recoverPublication(context.ledger, record, [root], context.assertAuthorized);
      expect(update).toHaveBeenLastCalledWith(
        record,
        "committed",
        expect.objectContaining({ path: output, revision: 3, format }),
        record.evidence,
      );
      await expect(
        publishAutomationBytes(Buffer.from("replacement"), output, format, 4, context),
      ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
      expect(await readFile(output, "utf8")).toBe("immutable");
      const revoked = join(root, format === "zxwbackup" ? "revoked.zxwbackup" : "revoked.png");
      let calls = 0;
      context.assertAuthorized = () => {
        if (++calls === 2) throw new Error("revoked");
      };
      await expect(
        format === "zxwbackup"
          ? publishAutomationFile(source, revoked, format, 3, context)
          : publishAutomationBytes(Buffer.from("pending"), revoked, "png", 3, context),
      ).rejects.toThrow("revoked");
      await expect(readFile(revoked)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
