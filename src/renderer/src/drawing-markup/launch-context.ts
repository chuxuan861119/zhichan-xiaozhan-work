import { createContext, useContext } from "react";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
export type DrawingLaunchRequest = {
  sessionId?: string;
  figureId?: string;
  bodyNodeId?: string;
  editorId?: string;
};
export const DrawingLaunchContext = createContext<{
  projects: readonly DrawingProject[];
  open(request: DrawingLaunchRequest): void;
} | null>(null);
export const useDrawingLauncher = () => useContext(DrawingLaunchContext);
