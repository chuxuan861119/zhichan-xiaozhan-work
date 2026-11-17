import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AutomationError } from "../../shared/automation/protocol.js";
import type { LibraryDatabase } from "../library/library-database.js";
import { decodeJson, encodeJson } from "../library/plaintext-codec.js";

export type OperationStatus =
  | "accepted"
  | "running"
  | "committed"
  | "failed"
  | "cancelled"
  | "recovery_required";
export type OperationRecord = {
  clientId: string;
  command: string;
  requestId: string;
  operationId: string;
  payloadHash: string;
  status: OperationStatus;
  target: { patentIds: string[] };
  result: unknown;
  evidence: unknown;
};
type Row = {
  client_id: string;
  command: string;
  request_id: string;
  operation_id: string;
  payload_hash: string;
  status: OperationStatus;
  target_json: string;
  result_json: string | null;
  evidence_json: string | null;
};
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v)]),
    );
  return value;
}
export function payloadHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
}
function fromRow(row: Row): OperationRecord {
  return {
    clientId: row.client_id,
    command: row.command,
    requestId: row.request_id,
    operationId: row.operation_id,
    payloadHash: row.payload_hash,
    status: row.status,
    target: JSON.parse(row.target_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
  };
}
export class AutomationLedger {
  constructor(readonly database: LibraryDatabase) {}
  read(clientId: string, command: string, requestId: string): OperationRecord | null {
    return this.database.read((d) => {
      const row = d
        .prepare(
          "SELECT * FROM automation_operations WHERE client_id=? AND command=? AND request_id=?",
        )
        .get(clientId, command, requestId) as Row | undefined;
      return row ? fromRow(row) : null;
    });
  }
  byId(clientId: string, operationId: string): OperationRecord | null {
    return this.database.read((d) => {
      const row = d
        .prepare("SELECT * FROM automation_operations WHERE client_id=? AND operation_id=?")
        .get(clientId, operationId) as Row | undefined;
      return row ? fromRow(row) : null;
    });
  }
  reserve(
    clientId: string,
    command: string,
    requestId: string,
    hash: string,
    patentIds: string[],
  ): OperationRecord {
    this.database.transaction((d) => {
      d.prepare(
        "INSERT OR IGNORE INTO automation_operations(client_id,command,request_id,operation_id,payload_hash,status,target_json,result_json,evidence_json,updated_at) VALUES(?,?,?,?,?,'accepted',?,NULL,NULL,?)",
      ).run(
        clientId,
        command,
        requestId,
        randomUUID(),
        hash,
        JSON.stringify({ patentIds }),
        new Date().toISOString(),
      );
    });
    const record = this.read(clientId, command, requestId);
    if (!record) throw new AutomationError("INTERNAL", "操作登记失败。");
    if (record.payloadHash !== hash)
      throw new AutomationError("IDEMPOTENCY_CONFLICT", "同一请求 ID 的内容不一致。");
    return record;
  }
  update(
    record: OperationRecord,
    status: OperationStatus,
    result: unknown = null,
    evidence?: unknown,
  ): void {
    this.database.transaction((d) => this.inTransaction(d, record, status, result, evidence));
    record.status = status;
    record.result = result;
    if (evidence !== undefined) record.evidence = evidence;
  }
  inTransaction(
    d: DatabaseSync,
    record: OperationRecord,
    status: OperationStatus,
    result: unknown,
    evidence?: unknown,
  ): void {
    const previous = d
      .prepare("SELECT status FROM automation_operations WHERE operation_id=?")
      .get(record.operationId) as { status: OperationStatus } | undefined;
    if (!previous) throw new AutomationError("INTERNAL", "操作记录丢失。");
    if (previous.status === "committed" && status !== "committed")
      throw new AutomationError("ALREADY_COMMITTED", "操作已提交。");
    d.prepare(
      "UPDATE automation_operations SET status=?,target_json=?,result_json=?,evidence_json=COALESCE(?,evidence_json),updated_at=? WHERE operation_id=?",
    ).run(
      status,
      JSON.stringify(record.target),
      JSON.stringify(result),
      evidence === undefined ? null : JSON.stringify(evidence),
      new Date().toISOString(),
      record.operationId,
    );
  }
  getState<T>(key: string): T | undefined {
    return this.database.read((d) => {
      const row = d.prepare("SELECT value FROM library_state WHERE key=?").get(key) as
        | { value: Uint8Array }
        | undefined;
      return row ? decodeJson<T>(row.value) : undefined;
    });
  }
  putState(d: DatabaseSync, key: string, value: unknown): void {
    d.prepare(
      "INSERT INTO library_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    ).run(key, encodeJson(value), new Date().toISOString());
  }
  createdForTask(taskId: string, clientId: string): string[] {
    const state = this.getState<{ version: number; clientId: string; patentIds: string[] }>(
      `automation:task:${taskId}`,
    );
    if (!state) return [];
    if (
      !z
        .object({
          version: z.literal(1),
          clientId: z.literal(clientId),
          patentIds: z.array(z.string().uuid()).max(100),
        })
        .strict()
        .safeParse(state).success
    )
      throw new AutomationError("RECOVERY_REQUIRED", "任务创建记录无效。");
    return state.patentIds;
  }
  recordCreated(
    d: DatabaseSync,
    taskId: string,
    clientId: string,
    patentId: string,
    limit: number,
  ): void {
    const patentIds = this.createdForTask(taskId, clientId);
    if (patentIds.length >= limit)
      throw new AutomationError(
        "SCOPE_DENIED",
        "本次新建额度已用完，请执行 pair renew-create 请求用户再次授权，每次最多 5 件。",
      );
    this.putState(d, `automation:task:${taskId}`, {
      version: 1,
      clientId,
      patentIds: [...patentIds, patentId],
    });
  }
  restoredForTask(taskId: string, clientId: string): string[] {
    const state = this.getState<unknown>(`automation:restored:${taskId}`);
    if (state === undefined) return [];
    const parsed = z
      .object({ clientId: z.literal(clientId), patentIds: z.array(z.string().uuid()) })
      .strict()
      .safeParse(state);
    if (!parsed.success) throw new AutomationError("RECOVERY_REQUIRED", "任务恢复归属记录无效。");
    return parsed.data.patentIds;
  }
  recordRestored(d: DatabaseSync, taskId: string, clientId: string, patentId: string): void {
    this.putState(d, `automation:restored:${taskId}`, {
      clientId,
      patentIds: [...this.restoredForTask(taskId, clientId), patentId],
    });
  }
  initializeLibraryId(readOnly: boolean): string {
    const existing = this.getState<string>("automation:library-id");
    if (existing) return existing;
    if (readOnly) return randomUUID();
    const id = randomUUID();
    this.database.transaction((d) => this.putState(d, "automation:library-id", id));
    return id;
  }
  unfinished(): OperationRecord[] {
    return this.database.read((d) =>
      (
        d
          .prepare(
            "SELECT * FROM automation_operations WHERE status IN ('accepted','running','recovery_required')",
          )
          .all() as Row[]
      ).map(fromRow),
    );
  }
}
