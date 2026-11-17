import type { DatabaseSync } from "node:sqlite";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import { patentDocumentSnapshot } from "../../shared/patent/snapshot-scope.js";
import type { PatdocSnapshot } from "../documents/patdoc-format.js";
import type { LibraryDatabase } from "./library-database.js";
import { createSnapshotPayload } from "./snapshot-worker.js";

/** Called only for an unpublished new import, inside its write transaction. */
export function installPatdocHistory(
  _database: LibraryDatabase,
  db: DatabaseSync,
  current: CanonicalPatent,
  snapshots: PatdocSnapshot[],
) {
  const insert = (patent: CanonicalPatent, createdAt: string, source: PatdocSnapshot["source"]) => {
    const document = patentDocumentSnapshot(patent);
    const result = createSnapshotPayload({
      patentId: patent.patentId,
      revision: patent.revision,
      modelVersion: 3,
      scope: "documents",
      patent: document,
    });
    db.prepare(
      "INSERT INTO snapshots(patent_id, revision, model_version, payload, content_hash, created_at, source) VALUES (?, ?, 3, ?, ?, ?, ?)",
    ).run(patent.patentId, patent.revision, result.payload, result.contentHash, createdAt, source);
    for (const asset of document.assets)
      db.prepare("INSERT INTO snapshot_assets(patent_id, revision, asset_id) VALUES (?, ?, ?)").run(
        patent.patentId,
        patent.revision,
        asset.assetId,
      );
  };
  db.prepare("DELETE FROM snapshots WHERE patent_id = ?").run(current.patentId);
  // The fresh imported recovery anchor replaces the synthetic import journal.
  db.prepare("DELETE FROM edit_log WHERE patent_id = ?").run(current.patentId);
  const ordered = [...snapshots].sort((a, b) => a.patent.revision - b.patent.revision);
  ordered.forEach((item, revision) => {
    const patent = structuredClone(item.patent);
    patent.patentId = current.patentId;
    patent.revision = revision;
    for (const book of patent.books) {
      book.bookId = current.books.find((candidate) => candidate.kind === book.kind)!.bookId;
      book.localRevision = revision;
      book.persistedRevision = revision;
    }
    insert(patent, item.createdAt, item.source);
  });
  const next = structuredClone(current);
  next.revision = Math.max(current.revision, ordered.length) + 1;
  insert(next, current.modifiedAt, "historical");
  db.prepare("UPDATE patents SET revision = ? WHERE patent_id = ?").run(
    next.revision,
    current.patentId,
  );
  // The imported patent's live graphic workspaces and source pointers are untouched.
  return next;
}
