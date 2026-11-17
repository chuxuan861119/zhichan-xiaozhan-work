import { lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const PREFIX = ".pending-delete-";
function directoryExists(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("小栈AI助手历史清理目录不安全。");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// The pending directory is a durable intent marker. Only this module's UUID scopes
// are reconciled; ordinary history directories are never swept as orphans.
export class PatentHistoryDeletion {
  constructor(
    private readonly root: string,
    private readonly files = { renameSync, rmSync },
  ) {}
  run(patentId: string, commit: () => void): void {
    z.uuid().parse(patentId);
    if (!directoryExists(this.root)) {
      commit();
      return;
    }
    const source = join(this.root, patentId);
    const pending = join(this.root, `${PREFIX}${patentId}`);
    if (directoryExists(pending))
      throw new Error("小栈AI助手历史存在待恢复清理，请重新打开应用后重试。");
    if (!directoryExists(source)) {
      commit();
      return;
    }
    this.files.renameSync(source, pending);
    try {
      commit();
    } catch (error) {
      // If rollback itself fails, keep the durable marker for startup recovery.
      this.files.renameSync(pending, source);
      throw error;
    }
    // A failure remains visible and leaves the marker for the next reconciliation.
    this.files.rmSync(pending, { recursive: true, force: true });
  }
  reconcile(exists: (patentId: string) => boolean): string[] {
    const pendingCleanupPatentIds: string[] = [];
    if (!directoryExists(this.root)) return pendingCleanupPatentIds;
    for (const name of readdirSync(this.root)) {
      if (!name.startsWith(PREFIX)) continue;
      const parsed = z.uuid().safeParse(name.slice(PREFIX.length));
      if (!parsed.success) continue;
      const pending = join(this.root, name);
      if (!directoryExists(pending)) continue;
      if (exists(parsed.data)) {
        const source = join(this.root, parsed.data);
        if (directoryExists(source)) throw new Error("小栈AI助手历史恢复目录冲突，原文件已保留。");
        this.files.renameSync(pending, source);
      } else {
        try {
          this.files.rmSync(pending, { recursive: true, force: true });
        } catch {
          // The patent is already deleted. Retain the retry marker and report it
          // without blocking access to unrelated documents or their recovery.
          pendingCleanupPatentIds.push(parsed.data);
        }
      }
    }
    return pendingCleanupPatentIds;
  }
}
