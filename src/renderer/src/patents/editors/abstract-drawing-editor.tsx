import type { PatentFigure } from "../../../../shared/patent/model";
import { useObjectContextMenu } from "../../editor/ui/object-context-menu";
import { showAppAlert } from "../../shared/app-dialog";
import { useOptionalPatentFunctionRail } from "../function-rail/function-rail-context";
import { AssetPreview } from "./asset-preview";

type AbstractDrawingEditorProps = {
  sessionId: string;
  figures: PatentFigure[];
  selectedFigureId: string | null;
};

export function AbstractDrawingEditor({
  sessionId,
  figures,
  selectedFigureId,
}: AbstractDrawingEditorProps) {
  const selectedIndex = figures.findIndex((figure) => figure.figureId === selectedFigureId);
  const selectedFigure = selectedIndex >= 0 ? figures[selectedIndex] : undefined;
  const rail = useOptionalPatentFunctionRail();
  const context = useObjectContextMenu(`${sessionId}:abstract-drawing`, [
    { label: "选择摘要附图", run: () => rail?.pin() },
    {
      label: "复制图片",
      disabled: !selectedFigure,
      run: async () => {
        if (!selectedFigure) return;
        const result = await window.patentApi.assets.copyImages({
          sessionId,
          images: [
            {
              assetId: selectedFigure.assetId,
              rotationDeg: selectedFigure.rotationDeg ?? 0,
              label: "摘要附图",
            },
          ],
        });
        if (!result.ok) await showAppAlert(result.error.message);
      },
    },
  ]);

  return (
    <main
      className="drawings-editor patent-page-zoom-frame"
      aria-label="摘要附图编辑器"
      // The grid already reserves the scaled page width; auto margins would shift it twice.
      style={{ marginInline: 0 }}
    >
      <header className="patent-book-page-header">摘要附图</header>
      {figures.length === 0 ? (
        <p className="drawing-empty drawing-empty-centered">暂无可选的说明书附图</p>
      ) : selectedFigure ? (
        <article
          className="drawing-figure-row is-centered"
          aria-label={`摘要附图 图${selectedIndex + 1}`}
          onContextMenu={context.open}
        >
          <div
            className="drawing-figure-placeholder"
            style={{ width: `${selectedFigure.widthMm}mm` }}
          >
            <AssetPreview
              sessionId={sessionId}
              assetId={selectedFigure.assetId}
              alt={`摘要附图 图${selectedIndex + 1}`}
            />
          </div>
        </article>
      ) : (
        <p className="drawing-empty drawing-empty-centered">尚未选择摘要附图</p>
      )}
      {context.menu}
    </main>
  );
}
