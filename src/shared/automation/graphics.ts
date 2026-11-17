import type { PageSettings } from "../document/model.js";
import type { DrawingProject, DrawingRegion } from "../drawing-markup/model.js";
import type { DrawingTileIndex } from "../drawing-markup/tiles.js";

export const AUTOMATION_DRAWING_TILE_CHANNEL = "automation:graphic-drawing-tile";
/** Main-process-only lease; functions are never serialized to the renderer. */
export type AutomationDrawingTileLease = {
  index: DrawingTileIndex;
  readTile(id: string): Promise<Uint8Array>;
};

export type AutomationGraphicRequest =
  | {
      kind: "flowchart";
      source: string;
      projectId: string;
      projectRevision: number;
      pageIndex: number;
      selectedCellIds: string[];
    }
  | { kind: "pdf-preview"; source: string; pageNumber: number }
  | {
      kind: "drawing";
      frozenCadSources?: Record<string, string>;
      source: string;
      mediaType: string;
      project: DrawingProject;
      region: DrawingRegion;
      widthMm: number;
      dpi: 300 | 600;
      autoAdjustLabelSize: boolean;
      autoLabelScale?: number;
      fitToPage?: PageSettings;
      tiledIndex?: DrawingTileIndex;
    };
export type AutomationGraphicResult = {
  data: string;
  width: number;
  height: number;
  mediaType: "image/png" | "image/jpeg" | "image/svg+xml";
  pageId?: string | undefined;
  totalPages?: number | undefined;
  outputWidthMm?: number | undefined;
};
/** Renderer-to-main failure only; the public service rejects with its normal operation error. */
export type AutomationGraphicFailure = { error: string };
