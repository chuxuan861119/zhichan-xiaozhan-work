import { randomUUID } from "node:crypto";
import {
  type EditorOperationPool,
  EditorResourceAdmissionError,
  editorOperationPool,
} from "./editor-operation-pool.js";

export class EditorWorkspaceConflictError extends Error {
  constructor() {
    super("此案件的图片编辑器仍在使用，请先关闭原编辑会话。");
  }
}
type Lease = { sessionId: string; frameId: string; leaseId: string; limitBytes: number };
export class EditorWorkspaceLeases {
  private readonly leases = new Map<
    string,
    { value: Lease; application: boolean; release(): void }
  >();
  constructor(
    private readonly pool: EditorOperationPool = editorOperationPool,
    private readonly policy = { workspaceBytes: 2 * 1024 ** 3, headroomBytes: 512 * 1024 ** 2 },
  ) {
    this.policy = { ...policy };
    if (
      !Number.isSafeInteger(policy.workspaceBytes) ||
      policy.workspaceBytes <= 0 ||
      !Number.isSafeInteger(policy.headroomBytes) ||
      policy.headroomBytes < 0
    )
      throw new Error("Invalid workspace resource policy");
  }
  acquire(sessionId: string, frameId: string, application = false): Lease {
    const existing = this.leases.get(sessionId);
    if (existing) {
      if (existing.value.frameId !== frameId || existing.application !== application)
        throw new EditorWorkspaceConflictError();
      return { ...existing.value };
    }
    // Leave space for a case save/read even when the workspace reservation is full.
    const releaseHeadroom = this.pool.reserve(this.policy.headroomBytes);
    let release: () => void;
    let limitBytes: number;
    try {
      limitBytes = Math.min(this.policy.workspaceBytes, this.pool.availableBytes);
      if (limitBytes < Math.min(this.policy.workspaceBytes, 512 * 1024 ** 2))
        throw new EditorResourceAdmissionError();
      release = this.pool.reserve(limitBytes);
    } finally {
      releaseHeadroom();
    }
    const value = {
      sessionId,
      frameId,
      leaseId: randomUUID(),
      limitBytes,
    };
    this.leases.set(sessionId, { value, application, release });
    return { ...value };
  }
  release(sessionId: string, leaseId: string): boolean {
    const existing = this.leases.get(sessionId);
    if (!existing || existing.value.leaseId !== leaseId) return false;
    existing.release();
    this.leases.delete(sessionId);
    return true;
  }
  releaseSession(sessionId: string): void {
    const existing = this.leases.get(sessionId);
    if (existing && !existing.application) this.release(sessionId, existing.value.leaseId);
  }
  dispose(): void {
    for (const [session, lease] of this.leases) this.release(session, lease.value.leaseId);
  }
}
