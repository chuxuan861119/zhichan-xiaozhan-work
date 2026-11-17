import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { remapAssetIds } from "../../shared/document/asset-references.js";
import type { AssetOwner } from "../assets/asset-store.js";
import type { AssetStore } from "./asset-store.js";
import { hashJson, LibraryServiceError } from "./edit-journal.js";
import type { LibraryDatabase } from "./library-database.js";
import { LibrarySafetyBackupService } from "./library-safety-backup.js";
import { decodeJson, encodeJson } from "./plaintext-codec.js";

type OwnerReference = { kind: AssetOwner["kind"]; id: string; asset_id: string };
type Plan = { owner: OwnerReference; replacements: Map<string, string> };

function referenceOwners(database: LibraryDatabase): OwnerReference[] {
  return database.read((db) =>
    db
      .prepare(`
    SELECT 'patent' AS kind, patent_id AS id, asset_id FROM patent_assets
    UNION SELECT 'patent', patent_id, asset_id FROM snapshot_assets
    UNION SELECT 'library-document', library_document_id, asset_id FROM document_assets
    UNION SELECT 'patent-template', template_id, asset_id FROM template_assets
    ORDER BY asset_id, kind, id
  `)
      .all(),
  ) as OwnerReference[];
}

function remapRows(
  db: DatabaseSync,
  table: string,
  ownerColumn: string,
  ownerId: string,
  columns: readonly string[],
  replacements: ReadonlyMap<string, string>,
  hashed = false,
) {
  const rows = db
    .prepare(`SELECT rowid AS isolation_rowid, * FROM ${table} WHERE ${ownerColumn} = ?`)
    .all(ownerId) as Array<Record<string, unknown>>;
  for (const row of rows) {
    for (const column of columns) {
      if (row[column] === null) continue;
      const original = decodeJson(row[column] as Uint8Array);
      if (hashed && row.content_hash !== hashJson(original)) {
        throw new LibraryServiceError(
          "CORRUPT_FILE",
          "资源独立保存前发现历史数据校验失败，原数据未更改。",
        );
      }
      const value = remapAssetIds(original, replacements);
      if (JSON.stringify(value) === JSON.stringify(original)) continue;
      db.prepare(
        `UPDATE ${table} SET ${column} = ?${hashed ? ", content_hash = ?" : ""} WHERE rowid = ?`,
      ).run(
        Buffer.from(encodeJson(value)),
        ...(hashed ? [hashJson(value)] : []),
        row.isolation_rowid as number,
      );
    }
  }
}

function applyPlan(db: DatabaseSync, { owner, replacements }: Plan) {
  if (owner.kind === "patent") {
    remapRows(
      db,
      "patent_books",
      "patent_id",
      owner.id,
      ["document_json", "editor_state_json"],
      replacements,
    );
    remapRows(
      db,
      "patent_auxiliary_documents",
      "patent_id",
      owner.id,
      ["document_json", "editor_state_json"],
      replacements,
    );
    remapRows(db, "snapshots", "patent_id", owner.id, ["payload"], replacements, true);
    remapRows(db, "edit_log", "patent_id", owner.id, ["payload"], replacements, true);
    remapRows(
      db,
      "library_state",
      "key",
      `patent:${owner.id}:figure-state`,
      ["value"],
      replacements,
    );
    for (const [before, after] of replacements) {
      db.prepare("UPDATE patent_figures SET asset_id = ? WHERE patent_id = ? AND asset_id = ?").run(
        after,
        owner.id,
        before,
      );
      db.prepare("UPDATE patent_assets SET asset_id = ? WHERE patent_id = ? AND asset_id = ?").run(
        after,
        owner.id,
        before,
      );
      db.prepare(
        "UPDATE snapshot_assets SET asset_id = ? WHERE patent_id = ? AND asset_id = ?",
      ).run(after, owner.id, before);
    }
  } else if (owner.kind === "library-document") {
    remapRows(
      db,
      "document_snapshots",
      "library_document_id",
      owner.id,
      ["payload"],
      replacements,
      true,
    );
    remapRows(
      db,
      "document_edit_log",
      "library_document_id",
      owner.id,
      ["payload"],
      replacements,
      true,
    );
    remapRows(
      db,
      "library_state",
      "key",
      `document-editor-state:${owner.id}`,
      ["value"],
      replacements,
    );
    for (const [before, after] of replacements)
      db.prepare(
        "UPDATE document_assets SET asset_id = ? WHERE library_document_id = ? AND asset_id = ?",
      ).run(after, owner.id, before);
  } else {
    remapRows(
      db,
      "patent_template_slots",
      "template_id",
      owner.id,
      ["claims_json", "description_json", "abstract_json"],
      replacements,
    );
    for (const [before, after] of replacements)
      db.prepare(
        "UPDATE template_assets SET asset_id = ? WHERE template_id = ? AND asset_id = ?",
      ).run(after, owner.id, before);
  }
}

/** Startup only, before editors/schedulers: files first, then one atomic reference swap. */
export async function isolateLibraryAssets(options: {
  root: string;
  database: LibraryDatabase;
  assets: AssetStore;
}): Promise<void> {
  const owners = referenceOwners(options.database);
  const seen = new Set<string>();
  const plans = new Map<string, Plan>();
  for (const owner of owners) {
    if (!seen.has(owner.asset_id)) {
      seen.add(owner.asset_id);
      continue;
    }
    const key = `${owner.kind}:${owner.id}`;
    const plan = plans.get(key) ?? { owner, replacements: new Map<string, string>() };
    plan.replacements.set(owner.asset_id, "");
    plans.set(key, plan);
  }
  if (!plans.size) return;
  await new LibrarySafetyBackupService(options.root).create();
  const sessionId = randomUUID();
  const stagedIds: string[] = [];
  try {
    for (const plan of plans.values()) {
      for (const assetId of plan.replacements.keys()) {
        const original = await options.assets.readAsset(assetId);
        const [copied] = await options.assets.stageMany(sessionId, [
          { ...original, descriptor: { ...original.descriptor, assetId: randomUUID() } },
        ]);
        if (!copied) throw new Error("资源副本不存在。");
        plan.replacements.set(assetId, copied.descriptor.assetId);
        stagedIds.push(copied.descriptor.assetId);
      }
    }
    options.database.transaction((db) => {
      if (JSON.stringify(referenceOwners(options.database)) !== JSON.stringify(owners))
        throw new LibraryServiceError("REVISION_CONFLICT", "资源引用已变化，取消本次拆分。");
      for (const plan of plans.values()) applyPlan(db, plan);
    });
    await options.assets.commitStaged(sessionId, stagedIds);
  } catch (error) {
    try {
      await options.assets.discardStaged(sessionId, stagedIds);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "资源拆分失败，原引用保留，副本清理待重试。");
    }
    throw error;
  }
}
