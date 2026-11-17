import { basename } from "node:path";
import type { z } from "zod";
import type { AutomationDocxCommitSchema } from "../../shared/automation/docx.js";
import {
  AutomationError,
  MAX_AUTOMATION_FRAME,
  type ResolvedAutomationScope,
} from "../../shared/automation/protocol.js";
import type { DocxImportPreview } from "../../shared/ipc/contract.js";
import { DocxImportSessionService } from "../docx-import/docx-import-session-service.js";
import { readDocxPackageBuffer } from "../docx-import/docx-package-reader.js";
import type { LibraryRuntime } from "../library/library-runtime.js";
import type { AutomationLedger, OperationRecord } from "./ledger.js";
import { readAllowedFile } from "./paths.js";

type Context = {
  grantId: string;
  grant: ResolvedAutomationScope;
  taskId: string;
  clientId: string;
  assertAuthorized(): void;
};
type CommitContext = Context & { record: OperationRecord; ledger: AutomationLedger };
type Entry = {
  owner: Context;
  service: DocxImportSessionService;
  preview: DocxImportPreview & { expiresAt: number };
  phase: "prepared" | "committing" | "discarding";
  commitContext?: CommitContext | undefined;
  dispose(): Promise<void>;
};

/** Session handles never outlive their grant; images remain staged until atomic patent creation. */
export class AutomationDocxImports {
  #entries = new Map<string, Entry>();
  #preparing = 0;
  constructor(private readonly runtime: LibraryRuntime) {}
  get pending() {
    return this.#preparing > 0 || this.#entries.size > 0;
  }
  async prepare(paths: string[], owner: Context) {
    owner.assertAuthorized();
    await this.cleanup();
    if (this.#entries.size + this.#preparing >= 4)
      throw new AutomationError("IMPORT_LIMIT", "待处理的 DOCX 导入过多，请先提交或放弃。");
    if (new Set(paths.map((path) => basename(path).toLowerCase())).size !== paths.length)
      throw new AutomationError("INVALID_INPUT", "所选 DOCX 文件名不能重复，请先重命名。");
    this.#preparing++;
    const staged = new Map<string, string[]>();
    const dispose = async () => {
      for (const [sessionId, ids] of staged)
        await this.runtime.assetStore.discardStaged(sessionId, ids, sessionId);
    };
    let retained = false;
    let entry: Entry | undefined;
    let total = 0;
    const service = new DocxImportSessionService({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: paths }) },
      readPackage: async (path) => {
        owner.assertAuthorized();
        const bytes = await readAllowedFile(
          path,
          [owner.grant.workspace.importDirectory],
          256 * 1024 * 1024,
        );
        total += bytes.length;
        if (total > 256 * 1024 * 1024)
          throw new AutomationError("TOO_LARGE", "DOCX 输入合计超过 256 MiB。");
        return readDocxPackageBuffer(bytes, basename(path));
      },
      assetStore: {
        stageMany: async (sessionId, assets) => {
          owner.assertAuthorized();
          const saved = await this.runtime.assetStore.stageMany(sessionId, assets, sessionId);
          staged.set(sessionId, [
            ...(staged.get(sessionId) ?? []),
            ...saved.map((a) => a.descriptor.assetId),
          ]);
          return saved;
        },
        commitStaged: (sessionId, ids) => this.runtime.assetStore.commitStaged(sessionId, ids),
        discardStaged: (sessionId, ids) =>
          this.runtime.assetStore.discardStaged(sessionId, ids, sessionId),
        readPreview: async (assetId) => (await this.runtime.assetStore.readAsset(assetId)).preview,
      },
      patents: {
        createImported: async (input) => {
          const context = entry?.commitContext;
          if (!context) throw new AutomationError("IMPORT_EXPIRED", "导入提交已失效。");
          const opened = await this.runtime.patents.createImported(input, {
            beforeCommit: context.assertAuthorized,
            inTransaction: (database, patent) => {
              context.assertAuthorized();
              context.ledger.recordCreated(
                database,
                context.taskId,
                context.clientId,
                patent.patentId,
                context.grant.createLimit,
              );
              context.ledger.inTransaction(
                database,
                { ...context.record, target: { patentIds: [patent.patentId] } },
                "committed",
                { patentId: patent.patentId, revision: patent.revision },
              );
            },
          });
          await this.runtime.patents.release(opened.sessionId);
          return opened;
        },
      },
    });
    try {
      const preview = await service.prepare(owner.grantId);
      if (!preview) throw new AutomationError("INVALID_INPUT", "没有可导入的 DOCX。");
      owner.assertAuthorized();
      if (Buffer.byteLength(JSON.stringify(preview)) > MAX_AUTOMATION_FRAME * 0.7)
        throw new AutomationError("RESULT_TOO_LARGE", "DOCX 预览过大，请分批导入。");
      entry = {
        owner,
        service,
        dispose,
        preview: { ...preview, expiresAt: Date.now() + 30 * 60 * 1000 },
        phase: "prepared",
      };
      this.#entries.set(preview.sessionId, entry);
      retained = true;
      return structuredClone(entry.preview);
    } finally {
      this.#preparing--;
      if (!retained) await dispose();
    }
  }
  #require(sessionId: string, grantId: string) {
    const entry = this.#entries.get(sessionId);
    if (!entry || entry.owner.grantId !== grantId || entry.preview.expiresAt <= Date.now())
      throw new AutomationError("IMPORT_EXPIRED", "导入预览已失效，请重新准备。");
    entry.owner.assertAuthorized();
    if (entry.phase !== "prepared")
      throw new AutomationError("OPERATION_IN_PROGRESS", "DOCX 预览正在处理。");
    return entry;
  }
  preview(sessionId: string, grantId: string) {
    return structuredClone(this.#require(sessionId, grantId).preview);
  }
  async asset(sessionId: string, assetId: string, grantId: string) {
    const entry = this.#require(sessionId, grantId);
    const bytes = await entry.service.previewAsset(grantId, sessionId, assetId);
    entry.owner.assertAuthorized();
    if (bytes.length > MAX_AUTOMATION_FRAME * 0.7)
      throw new AutomationError("RESULT_TOO_LARGE", "预览图片过大。");
    return {
      encoding: "base64",
      mediaType: "image/png",
      data: Buffer.from(bytes).toString("base64"),
    };
  }
  async discard(sessionId: string, grantId: string) {
    const entry = this.#require(sessionId, grantId);
    entry.phase = "discarding";
    try {
      await entry.dispose();
      this.#entries.delete(sessionId);
      return { discarded: true };
    } finally {
      entry.phase = "prepared";
    }
  }
  async commit(input: z.infer<typeof AutomationDocxCommitSchema>, context: CommitContext) {
    const entry = this.#require(input.sessionId, context.grantId);
    entry.phase = "committing";
    entry.commitContext = context;
    try {
      const saved = await entry.service.commit(context.grantId, input);
      this.#entries.delete(input.sessionId);
      return { patentId: saved.patentId, revision: saved.revision };
    } finally {
      entry.commitContext = undefined;
      if (
        context.ledger.byId(context.clientId, context.record.operationId)?.status === "committed"
      ) {
        entry.preview.expiresAt = 0;
        try {
          await entry.dispose();
          this.#entries.delete(input.sessionId);
        } finally {
          entry.phase = "prepared";
        }
      } else {
        entry.phase = "prepared";
      }
    }
  }
  async cleanup() {
    for (const [sessionId, entry] of this.#entries) {
      if (entry.phase !== "prepared") continue;
      let valid = entry.preview.expiresAt > Date.now();
      try {
        entry.owner.assertAuthorized();
      } catch {
        valid = false;
      }
      if (!valid) {
        // Dispose the adapter-owned stages directly, without the GUI service's idle-expiry callback.
        entry.phase = "discarding";
        try {
          await entry.dispose();
          this.#entries.delete(sessionId);
        } finally {
          entry.phase = "prepared";
        }
      }
    }
  }
}
