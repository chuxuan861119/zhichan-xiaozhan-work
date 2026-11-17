import { mkdirSync } from "node:fs";
import { dirname, toNamespacedPath } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_INTEGRITY_MESSAGES = 100;
const MAX_INTEGRITY_MESSAGE_LENGTH = 1_024;

export type ForeignKeyViolation = Readonly<{
  childTable: string;
  parentTable: string;
  foreignKeyIndex: number;
}>;

export type ForeignKeyCheckResult =
  | Readonly<{ ok: true; violations: readonly [] }>
  | Readonly<{ ok: false; violations: readonly ForeignKeyViolation[] }>;

export class LibraryDatabase implements Disposable {
  static open(path: string): LibraryDatabase {
    mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path === ":memory:" ? path : toNamespacedPath(path));
    try {
      database.exec("PRAGMA busy_timeout=5000");
      database.exec("PRAGMA journal_mode=WAL");
      database.exec("PRAGMA synchronous=FULL");
      database.exec("PRAGMA foreign_keys=ON");
      return new LibraryDatabase(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  static openReadOnly(path: string): LibraryDatabase {
    const database = new DatabaseSync(toNamespacedPath(path), { readOnly: true, timeout: 5_000 });
    try {
      database.exec("PRAGMA query_only=ON");
      database.exec("PRAGMA foreign_keys=ON");
      return new LibraryDatabase(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  #closed = false;

  private constructor(private readonly database: DatabaseSync) {}

  schemaVersion(): number | null {
    return this.read((database) => {
      const table = database
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("schema_migrations");
      if (table === undefined) return null;

      const rows = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      if (rows.length === 0) return null;
      if (rows.length !== 1) throw new Error("Ambiguous database schema version");
      const version = (rows[0] as { version?: unknown }).version;
      if (!Number.isSafeInteger(version) || (version as number) < 1) {
        throw new Error("Invalid database schema version");
      }
      return version as number;
    });
  }

  read<T>(operation: (database: DatabaseSync) => T): T {
    this.#assertOpen();
    return operation(this.database);
  }

  /** Includes writes on this connection, external commits, and local schema changes. */
  changeToken(): string {
    return this.read((database) => {
      const changes = database.prepare("SELECT total_changes() AS changes").get();
      const external = database.prepare("PRAGMA data_version").get();
      const schema = database.prepare("PRAGMA schema_version").get();
      return JSON.stringify([changes, external, schema]);
    });
  }

  transaction<T>(operation: (database: DatabaseSync) => T): T {
    this.#assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(this.database);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Database transaction and rollback both failed",
        );
      }
      throw error;
    }
  }

  integrityCheck(): { ok: true } | { ok: false; messages: string[] } {
    return this.read((database) => {
      try {
        const rows = database.prepare(`PRAGMA integrity_check(${MAX_INTEGRITY_MESSAGES})`).all();
        const messages = rows.slice(0, MAX_INTEGRITY_MESSAGES).map((row) => {
          const message = (row as Record<string, unknown>).integrity_check;
          return typeof message === "string"
            ? message.slice(0, MAX_INTEGRITY_MESSAGE_LENGTH)
            : "unknown integrity error";
        });
        if (messages.length === 1 && messages[0] === "ok") return { ok: true };
        return { ok: false, messages };
      } catch (error) {
        const message = error instanceof Error ? error.message : "database integrity check failed";
        return { ok: false, messages: [message.slice(0, MAX_INTEGRITY_MESSAGE_LENGTH)] };
      }
    });
  }

  foreignKeyCheck(): ForeignKeyCheckResult {
    return this.read((database) => {
      const violations = database
        .prepare("PRAGMA foreign_key_check")
        .all()
        .map((row): ForeignKeyViolation => {
          const value = row as Record<string, unknown>;
          if (
            typeof value.table !== "string" ||
            typeof value.parent !== "string" ||
            !Number.isSafeInteger(value.fkid) ||
            (value.fkid as number) < 0
          ) {
            throw new Error("Database foreign key check returned an invalid result");
          }
          return Object.freeze({
            childTable: value.table,
            parentTable: value.parent,
            foreignKeyIndex: value.fkid as number,
          });
        })
        .sort(
          (left, right) =>
            (left.childTable < right.childTable
              ? -1
              : left.childTable > right.childTable
                ? 1
                : 0) ||
            (left.parentTable < right.parentTable
              ? -1
              : left.parentTable > right.parentTable
                ? 1
                : 0) ||
            left.foreignKeyIndex - right.foreignKeyIndex,
        );
      const hasPatentFigureTable = database
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("patent_figures");
      const hasAssetTable = database
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("assets");
      if (hasPatentFigureTable !== undefined && hasAssetTable !== undefined) {
        const orphanedFigures = database
          .prepare(
            `SELECT 1
             FROM patent_figures AS figure
             LEFT JOIN assets AS asset ON asset.asset_id = figure.asset_id
             WHERE asset.asset_id IS NULL`,
          )
          .all();
        for (const _figure of orphanedFigures) {
          violations.push({
            childTable: "patent_figures",
            parentTable: "assets",
            foreignKeyIndex: 0,
          });
        }
      }
      violations.sort(
        (left, right) =>
          (left.childTable < right.childTable ? -1 : left.childTable > right.childTable ? 1 : 0) ||
          (left.parentTable < right.parentTable
            ? -1
            : left.parentTable > right.parentTable
              ? 1
              : 0) ||
          left.foreignKeyIndex - right.foreignKeyIndex,
      );
      if (violations.length === 0) {
        return Object.freeze({ ok: true as const, violations: Object.freeze([] as const) });
      }
      return Object.freeze({ ok: false as const, violations: Object.freeze(violations) });
    });
  }

  checkpoint(): void {
    this.read((database) => {
      const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
        | { busy: number; checkpointed: number; log: number }
        | undefined;
      if (result === undefined || result.busy !== 0 || result.log !== result.checkpointed) {
        throw new Error("Library database checkpoint could not complete");
      }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Library database is closed");
  }
}
