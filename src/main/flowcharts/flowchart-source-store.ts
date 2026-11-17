import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { FLOWCHART_MAX_SOURCE_XML_BYTES } from "../../shared/flowcharts/limits.js";
import {
  type FlowchartProjectMetadata,
  FlowchartProjectMetadataSchema,
} from "../../shared/flowcharts/model.js";
import { decodeEnvelope, encodeEnvelope, LibraryServiceError } from "../library/edit-journal.js";
import type { LibraryDatabase } from "../library/library-database.js";
import { decodeBytes, decodeJson, encodeBytes, encodeJson } from "../library/plaintext-codec.js";

const IdentitySchema = z.string().uuid();

export type SaveFlowchartSourceRequest = {
  patentId: string;
  projectId: string;
  expectedProjectRevision: number;
  source: Uint8Array;
  metadata: FlowchartProjectMetadata;
};

export type FlowchartSourceSnapshot = {
  patentId: string;
  projectId: string;
  sourceRevisionId: string;
  revision: number;
  sourceSha256: string;
  source: Uint8Array;
  metadata: FlowchartProjectMetadata;
  createdAt: string;
  modifiedAt: string;
};

type ProjectRow = {
  patent_id: string;
  project_id: string;
  revision: number;
  metadata: Uint8Array;
  current_source_revision_id: string;
  source_sha256: string;
  created_at: string;
  modified_at: string;
};

type SourceRow = {
  source_revision_id: string;
  project_revision: number;
  source: Uint8Array;
  source_sha256: string;
  byte_length: number;
};

export type FlowchartSourceStoreOptions = {
  database: LibraryDatabase;
  now?: () => Date;
  randomUUID?: () => string;
};

function hashSource(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex").toUpperCase();
}

function validateSource(source: Uint8Array): Uint8Array {
  if (
    Object.prototype.toString.call(source) !== "[object Uint8Array]" ||
    source.byteLength < 1 ||
    source.byteLength > FLOWCHART_MAX_SOURCE_XML_BYTES
  ) {
    throw new LibraryServiceError("INVALID_INPUT", "流程图源文件大小无效。");
  }
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new LibraryServiceError("INVALID_INPUT", "流程图源文件不是有效的 UTF-8 XML。");
  }
  if (!/^\s*<mxfile(?:\s|>)/u.test(xml) || !/<\/mxfile>\s*$/u.test(xml)) {
    throw new LibraryServiceError("INVALID_INPUT", "流程图源文件不是有效的 draw.io 文档。");
  }
  return Uint8Array.from(source);
}

export class FlowchartSourceStore {
  readonly #database: LibraryDatabase;
  readonly #now: () => Date;
  readonly #randomUUID: () => string;
  #disposed = false;

  constructor(options: FlowchartSourceStoreOptions) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#randomUUID = options.randomUUID ?? (() => randomUUID());
  }

  loadCurrent(patentId: string, projectId: string): FlowchartSourceSnapshot {
    this.#assertActive();
    IdentitySchema.parse(patentId);
    IdentitySchema.parse(projectId);
    return this.#database.read((database) => {
      const project = database
        .prepare("SELECT * FROM patent_flowcharts WHERE patent_id = ? AND project_id = ?")
        .get(patentId, projectId) as ProjectRow | undefined;
      if (project === undefined) throw new LibraryServiceError("NOT_FOUND", "流程图工程不存在。");
      const source = database
        .prepare("SELECT * FROM patent_flowchart_source_revisions WHERE source_revision_id = ?")
        .get(project.current_source_revision_id) as SourceRow | undefined;
      if (source === undefined || source.project_revision !== project.revision) {
        throw new LibraryServiceError("CORRUPT_FILE", "流程图当前源修订已损坏。");
      }
      return this.#decodeSnapshot(project, source);
    });
  }

  appendRevision(request: SaveFlowchartSourceRequest): FlowchartSourceSnapshot {
    this.#assertActive();
    const patentId = IdentitySchema.parse(request.patentId);
    const projectId = IdentitySchema.parse(request.projectId);
    if (
      !Number.isSafeInteger(request.expectedProjectRevision) ||
      request.expectedProjectRevision < 0
    ) {
      throw new LibraryServiceError("INVALID_INPUT", "流程图工程版本无效。");
    }
    const source = validateSource(request.source);
    const metadata = FlowchartProjectMetadataSchema.parse(request.metadata);
    const sourceSha256 = hashSource(source);

    return this.#database.transaction((database) =>
      this.#appendValidated(
        database,
        patentId,
        projectId,
        request.expectedProjectRevision,
        source,
        metadata,
        sourceSha256,
      ),
    );
  }

  appendRevisionInTransaction(
    database: DatabaseSync,
    request: SaveFlowchartSourceRequest,
  ): FlowchartSourceSnapshot {
    this.#assertActive();
    const patentId = IdentitySchema.parse(request.patentId);
    const projectId = IdentitySchema.parse(request.projectId);
    if (
      !Number.isSafeInteger(request.expectedProjectRevision) ||
      request.expectedProjectRevision < 0
    ) {
      throw new LibraryServiceError("INVALID_INPUT", "流程图工程版本无效。");
    }
    const source = validateSource(request.source);
    const metadata = FlowchartProjectMetadataSchema.parse(request.metadata);
    return this.#appendValidated(
      database,
      patentId,
      projectId,
      request.expectedProjectRevision,
      source,
      metadata,
      hashSource(source),
    );
  }

  #appendValidated(
    database: DatabaseSync,
    patentId: string,
    projectId: string,
    expectedProjectRevision: number,
    source: Uint8Array,
    metadata: FlowchartProjectMetadata,
    sourceSha256: string,
  ): FlowchartSourceSnapshot {
    const current = database
      .prepare("SELECT * FROM patent_flowcharts WHERE patent_id = ? AND project_id = ?")
      .get(patentId, projectId) as ProjectRow | undefined;
    if (current !== undefined && current.revision !== expectedProjectRevision) {
      throw new LibraryServiceError("REVISION_CONFLICT", "流程图工程版本冲突。");
    }
    if (current === undefined && expectedProjectRevision !== 0) {
      throw new LibraryServiceError("REVISION_CONFLICT", "流程图工程版本冲突。");
    }
    if (current?.source_sha256 === sourceSha256) {
      const row = database
        .prepare("SELECT * FROM patent_flowchart_source_revisions WHERE source_revision_id = ?")
        .get(current.current_source_revision_id) as SourceRow;
      return this.#decodeSnapshot(current, row);
    }

    // Restoring a snapshot may point to an older source; retained history stays monotonic.
    const latest = database
      .prepare(
        "SELECT MAX(project_revision) AS revision FROM patent_flowchart_source_revisions WHERE patent_id = ? AND project_id = ?",
      )
      .get(patentId, projectId) as { revision: number | null };
    const revision = latest.revision === null ? 0 : latest.revision + 1;
    const sourceRevisionId = IdentitySchema.parse(this.#randomUUID());
    const timestamp = this.#now().toISOString();
    const storedSource = encodeEnvelope(encodeBytes(source));
    const storedMetadata = encodeEnvelope(encodeJson(metadata));
    database
      .prepare(
        `INSERT INTO patent_flowchart_source_revisions(
             source_revision_id, patent_id, project_id, project_revision, source,
             source_sha256, byte_length, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceRevisionId,
        patentId,
        projectId,
        revision,
        storedSource,
        sourceSha256,
        source.byteLength,
        timestamp,
      );
    if (current === undefined) {
      database
        .prepare(
          `INSERT INTO patent_flowcharts(
               patent_id, project_id, revision, metadata, current_source_revision_id,
               source_sha256, created_at, modified_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          patentId,
          projectId,
          revision,
          storedMetadata,
          sourceRevisionId,
          sourceSha256,
          timestamp,
          timestamp,
        );
    } else {
      database
        .prepare(
          `UPDATE patent_flowcharts
             SET revision = ?, metadata = ?, current_source_revision_id = ?,
                 source_sha256 = ?, modified_at = ?
             WHERE patent_id = ? AND project_id = ?`,
        )
        .run(
          revision,
          storedMetadata,
          sourceRevisionId,
          sourceSha256,
          timestamp,
          patentId,
          projectId,
        );
    }
    return {
      patentId,
      projectId,
      sourceRevisionId,
      revision,
      sourceSha256,
      source: Uint8Array.from(source),
      metadata: { ...metadata },
      createdAt: current?.created_at ?? timestamp,
      modifiedAt: timestamp,
    };
  }

  list(patentId: string): FlowchartSourceSnapshot[] {
    this.#assertActive();
    IdentitySchema.parse(patentId);
    return this.#database.read((database) =>
      (
        database
          .prepare(
            "SELECT * FROM patent_flowcharts WHERE patent_id = ? ORDER BY modified_at DESC, project_id",
          )
          .all(patentId) as ProjectRow[]
      ).map((project) => {
        const source = database
          .prepare("SELECT * FROM patent_flowchart_source_revisions WHERE source_revision_id = ?")
          .get(project.current_source_revision_id) as SourceRow | undefined;
        if (source === undefined)
          throw new LibraryServiceError("CORRUPT_FILE", "流程图当前源修订已损坏。");
        return this.#decodeSnapshot(project, source);
      }),
    );
  }

  renameInTransaction(
    database: DatabaseSync,
    patentId: string,
    projectId: string,
    expectedProjectRevision: number,
    name: string,
  ): FlowchartSourceSnapshot {
    this.#assertActive();
    const project = database
      .prepare("SELECT * FROM patent_flowcharts WHERE patent_id = ? AND project_id = ?")
      .get(IdentitySchema.parse(patentId), IdentitySchema.parse(projectId)) as
      | ProjectRow
      | undefined;
    if (project === undefined) throw new LibraryServiceError("NOT_FOUND", "流程图工程不存在。");
    if (project.revision !== expectedProjectRevision) {
      throw new LibraryServiceError("REVISION_CONFLICT", "流程图工程版本冲突。");
    }
    const source = database
      .prepare("SELECT * FROM patent_flowchart_source_revisions WHERE source_revision_id = ?")
      .get(project.current_source_revision_id) as SourceRow;
    const current = this.#decodeSnapshot(project, source);
    const metadata = FlowchartProjectMetadataSchema.parse({ ...current.metadata, name });
    const modifiedAt = this.#now().toISOString();
    database
      .prepare(
        "UPDATE patent_flowcharts SET metadata = ?, modified_at = ? WHERE patent_id = ? AND project_id = ?",
      )
      .run(encodeEnvelope(encodeJson(metadata)), modifiedAt, patentId, projectId);
    return { ...current, metadata, modifiedAt };
  }

  collectUnreferenced(patentId: string): number {
    this.#assertActive();
    IdentitySchema.parse(patentId);
    return this.#database.transaction((database) => {
      const result = database
        .prepare(
          `DELETE FROM patent_flowchart_source_revisions AS source
           WHERE source.patent_id = ?
             AND NOT EXISTS (SELECT 1 FROM patent_flowcharts AS project WHERE project.current_source_revision_id = source.source_revision_id)
             AND NOT EXISTS (SELECT 1 FROM snapshot_flowchart_revisions AS snapshot WHERE snapshot.source_revision_id = source.source_revision_id)
             AND NOT EXISTS (SELECT 1 FROM edit_log_flowchart_revisions AS edit WHERE edit.source_revision_id = source.source_revision_id)`,
        )
        .run(patentId);
      return Number(result.changes);
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Flowchart source store is disposed");
  }

  #decodeSnapshot(project: ProjectRow, source: SourceRow): FlowchartSourceSnapshot {
    let plain: Uint8Array;
    let metadata: FlowchartProjectMetadata;
    try {
      plain = decodeBytes(decodeEnvelope(source.source));
      metadata = FlowchartProjectMetadataSchema.parse(decodeJson(decodeEnvelope(project.metadata)));
    } catch {
      throw new LibraryServiceError("CORRUPT_FILE", "流程图数据已损坏。");
    }
    if (
      plain.byteLength !== source.byte_length ||
      hashSource(plain) !== source.source_sha256 ||
      source.source_sha256 !== project.source_sha256
    ) {
      throw new LibraryServiceError("CORRUPT_FILE", "流程图源文件摘要不匹配。");
    }
    validateSource(plain);
    return {
      patentId: project.patent_id,
      projectId: project.project_id,
      sourceRevisionId: source.source_revision_id,
      revision: project.revision,
      sourceSha256: project.source_sha256,
      source: Uint8Array.from(plain),
      metadata: { ...metadata },
      createdAt: project.created_at,
      modifiedAt: project.modified_at,
    };
  }
}
