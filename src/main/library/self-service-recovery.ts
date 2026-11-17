import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createFactoryPatentTemplates } from "../../shared/patent/templates.js";
import type { PreparedRecovery } from "../../shared/recovery/self-service-recovery.js";
import type { PatentPatdocPayload } from "../documents/patdoc-format.js";
import { LibraryDatabase } from "./library-database.js";
import { createLibraryRuntime } from "./library-runtime.js";
import { importPatentPatdocPayload } from "./register-library-ipc.js";

function overlaps(a: string, b: string): boolean {
  const path = relative(a, b);
  return !path || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** Recovery writes exclusively to a new library; activation requires an issued receipt. */
export class SelfServiceRecovery {
  private busy = false;
  private receipts = new Map<string, PreparedRecovery>();
  constructor(
    private readonly options: {
      sourceRoot: string;
      activate(root: string): Promise<void>;
    },
  ) {}

  async prepare(payload: PatentPatdocPayload, parent: string): Promise<PreparedRecovery> {
    if (this.busy) throw new Error("正在恢复，请等待当前操作完成。");
    this.busy = true;
    try {
      const destination = await realpath(parent);
      const source = await realpath(this.options.sourceRoot);
      if (overlaps(source, destination)) throw new Error("请选择原文档库之外的恢复位置。");
      const token = randomUUID();
      const libraryPath = join(destination, `知产小栈恢复库-${token.slice(0, 8)}`);
      if (overlaps(libraryPath, source)) throw new Error("恢复库不能与原文档库重叠。");
      await mkdir(libraryPath); // Exclusive: never merge with or overwrite existing data.
      const runtime = await createLibraryRuntime({
        libraryRoot: libraryPath,
        readOnly: false,
        runRecovery: false,
        startBackgroundSchedulers: false,
      });
      let prepared: PreparedRecovery;
      try {
        const restored = await importPatentPatdocPayload(
          runtime.patents,
          runtime.assetStore,
          async () => createFactoryPatentTemplates(randomUUID),
          {
            ...payload,
            patent: {
              ...payload.patent,
              name: `${(payload.patent.name ?? "未命名专利").slice(0, 490)}（恢复副本）`,
            },
          },
          runtime.flowcharts,
        );
        await runtime.patents.release(restored.sessionId);
        const report = await runtime.recovery.open();
        if (report.mode !== "read-write" || report.quarantinedPatentIds.length > 0)
          throw new Error("恢复副本校验失败，原文档库未改动，请选择其他版本或备份。");
        prepared = {
          token,
          libraryPath,
          sourceLibraryPath: source,
          documentId: restored.patentId,
          displayName: restored.patent.name ?? "未命名专利",
        };
      } finally {
        await runtime.close();
      }
      this.receipts.set(token, prepared);
      return prepared;
    } finally {
      this.busy = false;
    }
  }

  async activate(token: string): Promise<void> {
    if (this.busy) throw new Error("正在恢复，请稍后重试。");
    const prepared = this.receipts.get(token);
    if (!prepared) throw new Error("恢复结果已失效，请重新选择恢复文件。");
    this.busy = true;
    try {
      if ((await realpath(prepared.libraryPath)) !== resolve(prepared.libraryPath))
        throw new Error("恢复库位置已变化，请重新恢复。");
      const db = LibraryDatabase.openReadOnly(join(prepared.libraryPath, "library.sqlite3"));
      try {
        if (!db.integrityCheck().ok) throw new Error("恢复库校验失败，不能启用。");
        const row = db.read((database) =>
          database
            .prepare("SELECT recovery_state FROM patents WHERE patent_id = ?")
            .get(prepared.documentId),
        );
        if (row?.recovery_state !== "healthy") throw new Error("恢复副本不可用，不能启用。");
      } finally {
        db.close();
      }
      const verified = await createLibraryRuntime({
        libraryRoot: prepared.libraryPath,
        readOnly: false,
        runRecovery: true,
        startBackgroundSchedulers: false,
      });
      try {
        if (verified.readOnly || verified.recoveryReport.quarantinedPatentIds.length > 0)
          throw new Error("恢复库中的正文或附件不可用，原库仍保留，请选择其他备份。");
      } finally {
        await verified.close();
      }
      await this.options.activate(prepared.libraryPath);
      this.receipts.delete(token);
    } finally {
      this.busy = false;
    }
  }
}
