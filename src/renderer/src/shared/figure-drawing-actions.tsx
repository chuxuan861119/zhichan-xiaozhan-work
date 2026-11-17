import { ImagePlus, Replace } from "lucide-react";

export function FigureDrawingActions({
  onInsert,
  onReplace,
  disabled = false,
}: {
  onInsert(): void;
  onReplace?: (() => void) | undefined;
  disabled?: boolean;
}) {
  return (
    <>
      {onReplace ? (
        <button
          type="button"
          className="figure-drawing-action"
          disabled={disabled}
          onClick={onReplace}
        >
          <Replace size={16} aria-hidden="true" />
          替换附图
        </button>
      ) : null}
      <button
        type="button"
        className="figure-drawing-action"
        disabled={disabled}
        onClick={onInsert}
      >
        <ImagePlus size={16} aria-hidden="true" />
        插入附图
      </button>
    </>
  );
}
