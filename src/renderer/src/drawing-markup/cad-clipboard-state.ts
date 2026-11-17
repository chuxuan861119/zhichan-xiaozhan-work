import type { DrawingPoint, DrawingProject } from "../../../shared/drawing-markup/model";
import type { CadCheckpoint, CadScene } from "./cadcraft-client";

/** One explicit copy per patent workspace; independent of disposable drawing workers. */
export type CadClipboard = {
  sessionId: string;
  project: DrawingProject;
  handles: string[];
  scene: CadScene;
  bytes: Uint8Array | CadCheckpoint;
  materialized?: Promise<Uint8Array>;
  base: DrawingPoint;
};
export type CadClipboardRef = { current: CadClipboard | null };
