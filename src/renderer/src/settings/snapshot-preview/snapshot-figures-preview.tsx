import { useEffect, useState } from "react";
import type { SnapshotPreviewFigure } from "../../../../shared/snapshot/model";

type SnapshotFiguresPreviewProps = Readonly<{
  title?: string;
  figures: SnapshotPreviewFigure[];
  baselineFigures: SnapshotPreviewFigure[];
  documentId: string;
  currentRevision: number;
  baselineRevision?: number | null;
}>;

type FigurePreviewState =
  | { status: "loading"; url: null }
  | { status: "loaded"; url: string }
  | { status: "failed"; url: null };

function FigurePreview({
  documentId,
  revision,
  assetId,
  label,
  rotationDeg = 0,
}: Readonly<{
  documentId: string;
  revision: number;
  assetId: string;
  label: string;
  rotationDeg?: SnapshotPreviewFigure["rotationDeg"];
}>) {
  const [preview, setPreview] = useState<FigurePreviewState>({ status: "loading", url: null });

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setPreview({ status: "loading", url: null });

    const loadPreview = async () => {
      try {
        const result = await window.patentApi.snapshot.previewAsset({
          documentType: "patent",
          documentId,
          revision,
          assetId,
        });
        if (!active) return;
        if (!result.ok) {
          setPreview({ status: "failed", url: null });
          return;
        }
        const bytes = Uint8Array.from(result.value);
        objectUrl = URL.createObjectURL(
          new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" }),
        );
        setPreview({ status: "loaded", url: objectUrl });
      } catch {
        if (active) setPreview({ status: "failed", url: null });
      }
    };

    void loadPreview();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, documentId, revision]);

  if (preview.status === "loaded") {
    return (
      <div
        className={`snapshot-figure-preview__image${rotationDeg === 90 || rotationDeg === 270 ? " snapshot-figure-preview__image--quarter-turn" : ""}`}
      >
        <img
          src={preview.url}
          alt={label}
          style={{ transform: `translate(-50%, -50%) rotate(${rotationDeg}deg)` }}
        />
      </div>
    );
  }
  return (
    <div className="snapshot-figure-preview__image">
      <p>{preview.status === "failed" ? "图片预览不可用" : "正在载入图片…"}</p>
    </div>
  );
}

export function SnapshotFiguresPreview({
  title = "说明书附图",
  figures,
  baselineFigures,
  documentId,
  currentRevision,
  baselineRevision,
}: SnapshotFiguresPreviewProps) {
  const figureLabel = (index: number) => (title === "摘要附图" ? title : `图${index + 1}`);
  if (figures.length === 0 && (baselineFigures.length === 0 || baselineRevision == null)) {
    return (
      <section className="snapshot-figures-preview" aria-label="快照附图">
        <header>
          <h3>{title}</h3>
        </header>
        <p className="snapshot-figures-preview__empty">
          {baselineFigures.length > 0
            ? "该版本没有附图（基线版本仍有附图，可能已被删除）。"
            : "该版本没有附图。"}
        </p>
      </section>
    );
  }
  const baselineIds = new Set(baselineFigures.map((figure) => figure.figureId));
  const currentIds = new Set(figures.map((figure) => figure.figureId));
  const addedCount = figures.filter((figure) => !baselineIds.has(figure.figureId)).length;
  const deleted = baselineFigures.flatMap((figure, index) =>
    currentIds.has(figure.figureId) ? [] : [{ figure, index }],
  );
  return (
    <section className="snapshot-figures-preview" aria-label="快照附图">
      <header>
        <h3>{title}</h3>
        {addedCount > 0 ? (
          <span className="snapshot-figures-preview__added">新增 {addedCount} 张</span>
        ) : null}
        {deleted.length > 0 ? (
          <span className="snapshot-figures-preview__deleted">删除 {deleted.length} 张</span>
        ) : null}
      </header>
      <div className="snapshot-figures-preview__grid">
        {figures.map((figure, index) => (
          <article
            className="snapshot-figure-preview"
            aria-label={figureLabel(index)}
            key={figure.figureId}
            data-snapshot-figure-id={figure.figureId}
          >
            <FigurePreview
              documentId={documentId}
              revision={currentRevision}
              assetId={figure.assetId}
              rotationDeg={figure.rotationDeg}
              label={figureLabel(index)}
            />
            <footer>{figureLabel(index)}</footer>
          </article>
        ))}
      </div>
      {deleted.length > 0 && baselineRevision != null ? (
        <section aria-label="已删除附图">
          <h4>已删除附图（原版本）</h4>
          <div className="snapshot-figures-preview__grid">
            {deleted.map(({ figure, index }) => (
              <article
                key={figure.figureId}
                className="snapshot-figure-preview snapshot-figure-preview--deleted"
                data-snapshot-figure-id={figure.figureId}
                aria-label={`原${figureLabel(index)}（已删除）`}
              >
                <FigurePreview
                  documentId={documentId}
                  revision={baselineRevision}
                  assetId={figure.assetId}
                  rotationDeg={figure.rotationDeg}
                  label={`原${figureLabel(index)}（已删除）`}
                />
                <footer>原{figureLabel(index)} · 已删除</footer>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}
