import { useEffect, useState } from "react";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { drawingPreviewSource } from "./drawing-preview-source";
import type { DrawingView } from "./fixed-line-preview";
import { VectorDrawingPreview } from "./vector-drawing-preview";
export function CadOverlayPreview({
  project,
  sessionId,
  view,
  onPainted,
  onError,
}: {
  project: DrawingProject;
  sessionId: string;
  view: DrawingView;
  onPainted(id: string): void;
  onError(message: string): void;
}) {
  const id = project.cad?.overlayAssetId;
  const [source, setSource] = useState<{ id: string; bytes: Uint8Array } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!id) return;
    void window.patentApi.assets
      .readDrawingSource(sessionId, id)
      .then((r) => {
        if (!r.ok) throw new Error(r.error.message);
        if (!cancelled) setSource({ id, bytes: r.value });
      })
      .catch((e) => {
        if (!cancelled) onError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id, sessionId, onError]);
  if (!source) return null;
  return (
    <div data-cad-overlay-preview style={{ position: "absolute", inset: 0 }}>
      <VectorDrawingPreview
        source={drawingPreviewSource(source.bytes)}
        width={project.width}
        height={project.height}
        sourceKind="dxf"
        pageNumber={1}
        view={view}
        transparent
        infinite={!!project.cad?.unified}
        onPending={() => {}}
        onPainted={() => {
          if (source.id === id && project.cad) onPainted(project.cad.assetId);
        }}
        onError={onError}
      />
    </div>
  );
}
