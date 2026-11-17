import { randomUUID } from "node:crypto";
import { AutomationError } from "../../shared/automation/protocol.js";
import type { FullDataImportService } from "../data-transfer/full-data-import-service.js";
import { allowedPath } from "./paths.js";

export function supportsAutomationImportCommit(platform: string): boolean {
  return platform === "win32" || platform === "darwin";
}

type Owner = { grantId: string; importDirectory: string; assertAuthorized(): void };
export type AutomationTransferImportServices = {
  supportsCommit?: boolean;
  prepare(
    path: string,
    password: string,
    importId: string,
    signal: AbortSignal,
    assertSource: () => void,
  ): ReturnType<FullDataImportService["prepareImport"]>;
  discard(importId: string): Promise<readonly string[] | void>;
  schedule(importId: string): Promise<void>;
  commit(importId: string, detach: () => Promise<void>): Promise<void>;
  fail(importId: string): Promise<void>;
};
type Entry = {
  owner: Owner;
  expiresAt: number;
  preview: Awaited<ReturnType<FullDataImportService["prepareImport"]>>;
  phase: "prepared" | "scheduling" | "scheduled" | "executing" | "discarding";
};

export class AutomationTransferImports {
  #entries = new Map<string, Entry>();
  constructor(private readonly services: AutomationTransferImportServices) {}
  async prepare(path: string, password: string, owner: Owner, signal: AbortSignal) {
    owner.assertAuthorized();
    const absolute = allowedPath(path, [owner.importDirectory], false);
    const importId = randomUUID();
    const preview = await this.services.prepare(absolute, password, importId, signal, () => {
      owner.assertAuthorized();
      allowedPath(absolute, [owner.importDirectory], false);
    });
    try {
      owner.assertAuthorized();
      signal.throwIfAborted();
      const expiresAt = Date.now() + 30 * 60_000;
      this.#entries.set(importId, {
        owner,
        preview,
        expiresAt,
        phase: "prepared",
      });
      return { importId, preview, expiresAt };
    } catch (error) {
      await this.services.discard(importId);
      throw error;
    }
  }
  #entry(importId: string, owner: Owner) {
    owner.assertAuthorized();
    const entry = this.#entries.get(importId);
    if (!entry || entry.owner.grantId !== owner.grantId || entry.expiresAt <= Date.now())
      throw new AutomationError("NOT_FOUND", "导入预览不存在或已过期，请重新准备。");
    entry.owner.assertAuthorized();
    if (entry.phase !== "prepared")
      throw new AutomationError("OPERATION_IN_PROGRESS", "导入预览正在处理，请等待当前操作完成。");
    return entry;
  }
  read(importId: string, owner: Owner) {
    const entry = this.#entry(importId, owner);
    return { importId, preview: entry.preview, expiresAt: entry.expiresAt };
  }
  async discard(importId: string, owner: Owner) {
    const entry = this.#entry(importId, owner);
    entry.phase = "discarding";
    try {
      const retainedDirectories = (await this.services.discard(importId)) ?? [];
      this.#entries.delete(importId);
      return { discarded: true, retainedDirectories };
    } finally {
      entry.phase = "prepared";
    }
  }
  async schedule(importId: string, owner: Owner) {
    if (this.services.supportsCommit === false)
      throw new AutomationError(
        "UNSUPPORTED_PLATFORM",
        "当前平台不支持安全的整库原子切换，请在 Windows 或 Mac 版本导入；当前库未改动。",
      );
    const entry = this.#entry(importId, owner);
    entry.phase = "scheduling";
    try {
      await this.services.schedule(importId);
      owner.assertAuthorized();
      entry.phase = "scheduled";
    } catch (error) {
      try {
        await this.services.fail(importId);
      } finally {
        entry.phase = "prepared";
      }
      throw error;
    }
    return { importId, phase: "scheduled", restartPending: true };
  }
  async commit(importId: string, owner: Owner, detach: () => Promise<void>) {
    const entry = this.#entries.get(importId);
    if (
      !entry ||
      entry.owner.grantId !== owner.grantId ||
      entry.expiresAt <= Date.now() ||
      entry.phase !== "scheduled"
    )
      throw new AutomationError("NOT_FOUND", "导入计划不存在。");
    owner.assertAuthorized();
    entry.owner.assertAuthorized();
    entry.phase = "executing";
    await this.services.commit(importId, detach);
    this.#entries.delete(importId);
  }
  async fail(importId: string) {
    await this.services.fail(importId);
    const entry = this.#entries.get(importId);
    if (entry) {
      entry.phase = "prepared";
    }
  }
  async cleanup() {
    for (const [id, entry] of this.#entries) {
      if (["scheduling", "executing", "discarding"].includes(entry.phase)) continue;
      let valid = entry.expiresAt > Date.now();
      try {
        entry.owner.assertAuthorized();
      } catch {
        valid = false;
      }
      if (!valid) {
        if (entry.phase === "scheduled") await this.services.fail(id);
        entry.phase = "discarding";
        try {
          await this.services.discard(id);
          this.#entries.delete(id);
        } finally {
          entry.phase = "prepared";
        }
      }
    }
  }
}
