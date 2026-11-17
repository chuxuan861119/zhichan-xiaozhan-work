import type { DatabaseSync } from "node:sqlite";
import {
  type FlowchartFigureLink,
  FlowchartFigureLinkSchema,
  type FlowchartProjectDescriptor,
  FlowchartProjectDescriptorSchema,
  FlowchartProjectMetadataSchema,
} from "../../shared/flowcharts/model.js";
import { decodeEnvelope, LibraryServiceError } from "../library/edit-journal.js";
import { decodeJson } from "../library/plaintext-codec.js";

type ProjectRow = {
  project_id: string;
  revision: number;
  metadata: Uint8Array;
  source_sha256: string;
  created_at: string;
  modified_at: string;
};

export function loadFlowchartProjects(
  database: DatabaseSync,
  patentId: string,
): FlowchartProjectDescriptor[] {
  const rows = database
    .prepare(
      `SELECT project_id, revision, metadata, source_sha256, created_at, modified_at
       FROM patent_flowcharts WHERE patent_id = ? ORDER BY modified_at DESC, project_id`,
    )
    .all(patentId) as ProjectRow[];
  try {
    return rows.map((row) => {
      const metadata = FlowchartProjectMetadataSchema.parse(
        decodeJson(decodeEnvelope(row.metadata)),
      );
      return FlowchartProjectDescriptorSchema.parse({
        projectId: row.project_id,
        name: metadata.name,
        revision: row.revision,
        pageCount: metadata.pageCount,
        lastPageId: metadata.lastPageId,
        sourceSha256: row.source_sha256,
        createdAt: row.created_at,
        modifiedAt: row.modified_at,
      });
    });
  } catch {
    throw new LibraryServiceError("CORRUPT_FILE", "流程图工程元数据已损坏。");
  }
}

export function loadFlowchartFigureLink(
  stored: Uint8Array | null,
): FlowchartFigureLink | undefined {
  if (stored === null) return undefined;
  try {
    return FlowchartFigureLinkSchema.parse(decodeJson(decodeEnvelope(stored)));
  } catch {
    throw new LibraryServiceError("CORRUPT_FILE", "附图中的流程图关联数据已损坏。");
  }
}
