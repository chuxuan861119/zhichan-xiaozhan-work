import { createContext, useContext } from "react";
import type { DesignPatentView } from "../../../shared/patent/design-patent";
import type { buildSixViewModel, SixViewRotation } from "./six-view-model";

export type DesignPixelSize = { widthPx: number; heightPx: number };
export const ProcessedDesignSizesContext = createContext<Readonly<Record<string, DesignPixelSize>>>(
  {},
);
export const useProcessedDesignSizes = () => useContext(ProcessedDesignSizesContext);
export function resolveDesignViewPixelSize(
  view: DesignPatentView,
  original: DesignPixelSize | undefined,
  processed: Readonly<Record<string, DesignPixelSize>>,
): DesignPixelSize | undefined {
  return view.editor?.applied ?? (view.operations.length ? processed[view.viewId] : original);
}

// Keep context identity independent of the hot-reloaded model view component.
export const PreviewContext = createContext<{
  model: ReturnType<typeof buildSixViewModel>;
  selectedViewId: string | null;
  select(viewId: string | null): void;
  collapsed?: boolean;
  setCollapsed?(value: boolean): void;
} | null>(null);
export const RotationContext = createContext<{
  rotation: SixViewRotation;
  rotate(value: SixViewRotation): void;
} | null>(null);
export const useSixViewPreview = () => useContext(PreviewContext);
