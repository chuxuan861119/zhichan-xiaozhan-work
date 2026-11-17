import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedAutomationScope } from "../../shared/automation/protocol.js";
import type { PatdocPayload, PatentPatdocPayload } from "../documents/patdoc-format.js";
import { readPatdoc } from "../documents/patdoc-reader.js";
import type { LibraryRuntime } from "../library/library-runtime.js";
import { importAutomationDocument } from "./documents.js";
import { importAutomationPatents } from "./imports.js";
import type { AutomationLedger, OperationRecord } from "./ledger.js";

export async function restoreAutomationBackup(
  runtime: LibraryRuntime,
  home: string,
  bytes: Uint8Array,
  context: {
    grant: ResolvedAutomationScope;
    taskId: string;
    record: OperationRecord;
    ledger: AutomationLedger;
    assertAuthorized(): void;
  },
) {
  context.assertAuthorized();
  const directory = await mkdtemp(join(home, "backup-restore-"));
  try {
    const path = join(directory, "restore.patdoc");
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    const payload = await readPatdoc<PatentPatdocPayload | PatdocPayload>(path);
    context.assertAuthorized();
    if ("patent" in payload)
      return await importAutomationPatents(
        runtime,
        home,
        { path, format: "patdoc", allowDuplicate: true },
        { ...context, restoreBytes: bytes },
      );
    return await importAutomationDocument(runtime, payload, context);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
