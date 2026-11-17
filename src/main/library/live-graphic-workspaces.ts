import type { DatabaseSync } from "node:sqlite";
import { AssetDescriptorSchema, type ImageRotation } from "../../shared/document/model.js";
import { DrawingProjectsSchema } from "../../shared/drawing-markup/model.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import {
  loadFlowchartFigureLink,
  loadFlowchartProjects,
} from "../flowcharts/flowchart-persistence.js";
import { decodeEnvelope } from "./edit-journal.js";
import { decodeJson } from "./plaintext-codec.js";

/** Independent workspaces are authoritative; document history never rolls them back. */
export function readLiveGraphicWorkspaces(
  database: DatabaseSync,
  patentId: string,
): Pick<CanonicalPatent, "drawingProjects" | "assets" | "flowchartProjects" | "figures"> {
  const row = database
    .prepare("SELECT value FROM library_state WHERE key = ?")
    .get(`patent:${patentId}:figure-state`) as { value: Uint8Array } | undefined;
  const state = row
    ? decodeJson<{
        drawingProjects?: unknown;
        assets: unknown;
        rotations?: Record<string, ImageRotation>;
      }>(decodeEnvelope(row.value))
    : { assets: [] };
  const figures = database
    .prepare(
      "SELECT figure_id, asset_id, width_mm, flowchart_link FROM patent_figures WHERE patent_id = ? ORDER BY position",
    )
    .all(patentId) as Array<{
    figure_id: string;
    asset_id: string;
    width_mm: number;
    flowchart_link: Uint8Array | null;
  }>;
  return {
    drawingProjects: DrawingProjectsSchema.parse(state.drawingProjects ?? []),
    assets: AssetDescriptorSchema.array().parse(state.assets),
    flowchartProjects: loadFlowchartProjects(database, patentId),
    figures: figures.map((figure) => ({
      figureId: figure.figure_id,
      assetId: figure.asset_id,
      widthMm: figure.width_mm,
      rotationDeg: state.rotations?.[figure.figure_id] ?? 0,
      ...(figure.flowchart_link === null
        ? {}
        : { flowchartLink: loadFlowchartFigureLink(figure.flowchart_link) }),
    })),
  };
}
