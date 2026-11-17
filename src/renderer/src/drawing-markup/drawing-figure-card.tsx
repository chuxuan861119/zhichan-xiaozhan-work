import { useEditorSessionVisible } from "../shared/editor-session-scope";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AssetPreview } from "../patents/editors/asset-preview";
import { SpatialPresence } from "../shared/spatial-presence";

type Props = {
  sessionId: string;
  assetId: string;
  figureId: string;
  name: string;
  aspectRatio?: number;
  selected: boolean;
  disabled: boolean;
  onLocate(): void;
};

export function DrawingFigureCard({
  sessionId,
  assetId,
  figureId,
  name,
  aspectRatio = 1,
  selected,
  disabled,
  onLocate,
}: Props) {
  const sessionVisible = useEditorSessionVisible();
  const card = useRef<HTMLDivElement>(null);
  const id = useId();
  const [ratio, setRatio] = useState(aspectRatio);
  const [hovered, setHovered] = useState(false);
  const [preview, setPreview] = useState<{
    src: string;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  useEffect(() => {
    if (!hovered || disabled) {
      setPreview(null);
      return;
    }
    const dismiss = () => setHovered(false);
    const timer = setTimeout(() => {
      const element = card.current;
      const img = element?.querySelector("img");
      if (!element || !img) return;
      const rect = element.getBoundingClientRect();
      const sidebar = element.closest(".drawing-sources")?.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 16);
      const height = Math.min(width / ratio + 48, 440, window.innerHeight - 16);
      setPreview({
        src: img.src,
        width,
        height,
        left: Math.max(
          8,
          Math.min((sidebar?.right ?? rect.right) + 12, window.innerWidth - width - 8),
        ),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - height - 8)),
      });
    }, 350);
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      clearTimeout(timer);
      setPreview(null);
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [hovered, disabled, ratio]);
  return (
    <>
      {/* The image's retry button remains independent of the keyboard-accessible card. */}
      {/* biome-ignore lint/a11y/useSemanticElements: AssetPreview may contain its own retry button. */}
      <div
        ref={card}
        className="drawing-region-item"
        data-published-figure={figureId}
        data-wide={ratio > 1.6}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={`定位${name}`}
        aria-pressed={selected}
        aria-disabled={disabled}
        aria-describedby={preview ? id : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onClick={(event) => {
          if (!disabled && !(event.target as Element).closest("button")) onLocate();
        }}
        onKeyDown={(event) => {
          if (
            !disabled &&
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            event.stopPropagation();
            setHovered(false);
            onLocate();
          }
        }}
      >
        <div className="drawing-region-thumbnail" style={{ aspectRatio: ratio }}>
          <AssetPreview sessionId={sessionId} assetId={assetId} alt={name} onLoad={setRatio} />
        </div>
        <span>{name}</span>
      </div>
      {createPortal(
        <SpatialPresence>
          {preview && !disabled ? (
            <div
              hidden={!sessionVisible}
              id={id}
              role="tooltip"
              aria-label={`${name}完整预览`}
              className="drawing-figure-hover-preview"
              style={{
                left: preview.left,
                top: preview.top,
                width: preview.width,
                height: preview.height,
              }}
            >
              <img src={preview.src} alt={name} />
              <span>{name}</span>
            </div>
          ) : null}
        </SpatialPresence>,
        document.body,
      )}
    </>
  );
}
