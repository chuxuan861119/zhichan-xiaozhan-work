import { useState } from "react";
import type { PatentFigure } from "../../../../shared/patent/model";
import { extractClipboardDataImages } from "../../editor/paste-sanitizer";
import { AssetPreview } from "./asset-preview";

export type DrawingImageImport = {
  originalName: string;
  declaredMediaType: string | null;
  bytes: Uint8Array;
};

type DrawingsEditorProps = {
  sessionId: string;
  title: string;
  figures: PatentFigure[];
  onPasteImages?(images: DrawingImageImport[]): void;
  onReorderFigures(figures: PatentFigure[]): void;
  onResizeFigure(figureId: string, widthMm: number): void;
};

function moveFigureTo(
  figures: PatentFigure[],
  draggedFigureId: string,
  targetIndex: number,
): PatentFigure[] {
  const sourceIndex = figures.findIndex((figure) => figure.figureId === draggedFigureId);
  if (sourceIndex < 0 || sourceIndex === targetIndex) return figures;
  const next = figures.slice();
  const [moved] = next.splice(sourceIndex, 1);
  if (!moved) return figures;
  next.splice(targetIndex, 0, moved);
  return next;
}

function clampWidth(widthMm: number): number {
  return Math.max(10, Math.min(165, widthMm));
}

const SUPPORTED_CLIPBOARD_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/bmp",
  "image/tiff",
]);
const SUPPORTED_CLIPBOARD_IMAGE_EXTENSIONS = /\.(?:png|jpe?g|bmp|tiff?)$/iu;

function isSupportedClipboardImage(file: File): boolean {
  return (
    SUPPORTED_CLIPBOARD_IMAGE_TYPES.has(file.type.toLocaleLowerCase("en-US")) ||
    SUPPORTED_CLIPBOARD_IMAGE_EXTENSIONS.test(file.name)
  );
}

async function clipboardImages(data: DataTransfer): Promise<DrawingImageImport[]> {
  const files = Array.from(data.files ?? []).filter(isSupportedClipboardImage);
  if (files.length > 0) {
    return Promise.all(
      files.map(async (file) => ({
        originalName: file.name,
        declaredMediaType: file.type || null,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );
  }
  return extractClipboardDataImages(data.getData("text/html") ?? "").map((image) => ({
    originalName: image.originalName,
    declaredMediaType: image.mediaType,
    bytes: image.bytes,
  }));
}

export function DrawingsEditor({
  sessionId,
  title,
  figures,
  onPasteImages = () => undefined,
  onReorderFigures,
  onResizeFigure,
}: DrawingsEditorProps) {
  const [draggedFigureId, setDraggedFigureId] = useState<string | null>(null);
  const [resizeDrag, setResizeDrag] = useState<{
    figureId: string;
    pointerId: number;
    startX: number;
    startWidthMm: number;
  } | null>(null);

  return (
    <main
      className="drawings-editor"
      aria-label="附图编辑器"
      onPaste={(event) => {
        const data = event.clipboardData;
        const hasImageFile = Array.from(data.files ?? []).some(isSupportedClipboardImage);
        const hasDataImage = /<img\b[^>]*\bsrc\s*=\s*["']?data:image\//iu.test(
          data.getData("text/html") ?? "",
        );
        if (!hasImageFile && !hasDataImage) return;
        event.preventDefault();
        void clipboardImages(data).then((images) => {
          if (images.length > 0) onPasteImages(images);
        });
      }}
    >
      <header className="patent-book-page-header">{title}</header>
      <section className="drawing-figure-list" aria-label={`${title}列表`}>
        {figures.map((figure, index) => {
          const label = `图${index + 1}`;
          return (
            <article
              className="drawing-figure-row is-centered"
              aria-label={label}
              key={figure.figureId}
              draggable
              onDragStart={() => setDraggedFigureId(figure.figureId)}
              onDragEnd={() => setDraggedFigureId(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (!draggedFigureId) return;
                onReorderFigures(moveFigureTo(figures, draggedFigureId, index));
                setDraggedFigureId(null);
              }}
            >
              <h2>{label}</h2>
              <div className="drawing-figure-placeholder" style={{ width: `${figure.widthMm}mm` }}>
                <AssetPreview sessionId={sessionId} assetId={figure.assetId} alt={label} />
              </div>
              <div
                className="drawing-figure-resize-handle"
                role="slider"
                tabIndex={0}
                aria-label={`拖拽缩放${label}`}
                aria-valuemin={10}
                aria-valuemax={165}
                aria-valuenow={figure.widthMm}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  setResizeDrag({
                    figureId: figure.figureId,
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startWidthMm: figure.widthMm,
                  });
                }}
                onPointerMove={(event) => {
                  if (
                    resizeDrag?.figureId !== figure.figureId ||
                    resizeDrag.pointerId !== event.pointerId
                  )
                    return;
                  const deltaMm = Math.round((event.clientX - resizeDrag.startX) / 4);
                  onResizeFigure(figure.figureId, clampWidth(resizeDrag.startWidthMm + deltaMm));
                }}
                onPointerUp={(event) => {
                  if (resizeDrag?.pointerId !== event.pointerId) return;
                  event.currentTarget.releasePointerCapture?.(event.pointerId);
                  setResizeDrag(null);
                }}
                onPointerCancel={(event) => {
                  if (resizeDrag?.pointerId !== event.pointerId) return;
                  event.currentTarget.releasePointerCapture?.(event.pointerId);
                  setResizeDrag(null);
                }}
              />
            </article>
          );
        })}
      </section>
    </main>
  );
}
