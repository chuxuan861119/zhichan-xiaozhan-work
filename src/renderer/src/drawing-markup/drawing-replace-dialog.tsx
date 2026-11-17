import type { PatentFigure } from "../../../shared/patent/model";
import { FigureReplacementDialog } from "../shared/figure-replacement-dialog";
import { imageUrl } from "./render";

export type DrawingReplacementPreview = {
  bytes: Uint8Array;
  width: number;
  height: number;
  widthMm: number;
};

export function DrawingReplaceDialog({
  open,
  sessionId,
  figures,
  onPreview,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  sessionId: string;
  figures: readonly PatentFigure[];
  onPreview(widthMm: number): Promise<DrawingReplacementPreview>;
  onConfirm(target: PatentFigure, preview: DrawingReplacementPreview): Promise<void>;
  onCancel(): void;
}) {
  return (
    <FigureReplacementDialog
      open={open}
      sessionId={sessionId}
      figures={figures}
      sourceLabel="当前选区"
      previewAlt="当前选区成图预览"
      onPreview={async (target) => {
        const value = await onPreview(target.widthMm);
        const url = imageUrl(value.bytes, "image/jpeg");
        return {
          url,
          value,
          note: `${value.width} × ${value.height} 像素`,
          dispose: () => URL.revokeObjectURL(url),
        };
      }}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
