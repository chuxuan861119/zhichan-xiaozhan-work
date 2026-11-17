import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRetainedTransientVisibility } from "../../shared/transient-function-rail-slot";
import {
  clampImageWidth,
  type ResizeCorner,
  type ResizeSession,
  resizedImageWidth,
} from "./image-transform";

const RESIZE_CORNERS: readonly ResizeCorner[] = ["top-left", "bottom-left", "bottom-right"];

function resizeCornerLabel(corner: ResizeCorner, imageLabel: string): string {
  const name = corner === "top-left" ? "左上角" : corner === "bottom-left" ? "左下角" : "右下角";
  return `从${name}缩放${imageLabel}`;
}

type ImageSelectionFrameProps = Readonly<{
  children: ReactNode;
  selected: boolean;
  controls?: boolean;
  widthMm: number;
  aspectRatio?: number;
  readOnly?: boolean;
  className?: string;
  imageLabel?: string;
  as?: "div" | "span";
  onResizeCommit(widthMm: number): void;
  onDelete(): void;
}>;

export function ImageSelectionFrame({
  children,
  selected,
  controls = selected,
  widthMm,
  aspectRatio,
  readOnly = false,
  className = "",
  imageLabel = "图片",
  as = "div",
  onResizeCommit,
  onDelete,
}: ImageSelectionFrameProps) {
  const controlsOpen = controls && !readOnly;
  const controlsVisible = useRetainedTransientVisibility(controlsOpen);
  const [draftWidthMm, setDraftWidthMm] = useState<number | null>(null);
  const sessionRef = useRef<ResizeSession | null>(null);
  const captureRef = useRef<HTMLButtonElement | null>(null);
  const displayedWidthMm = draftWidthMm ?? widthMm;
  const Frame = as;

  const cancelResize = useCallback(() => {
    const session = sessionRef.current;
    const handle = captureRef.current;
    sessionRef.current = null;
    captureRef.current = null;
    if (session && handle?.hasPointerCapture?.(session.pointerId))
      handle.releasePointerCapture(session.pointerId);
    setDraftWidthMm(null);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && sessionRef.current) {
        event.preventDefault();
        cancelResize();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", cancelResize);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", cancelResize);
      cancelResize();
    };
  }, [cancelResize]);

  // Undo, geometry updates and read-only changes invalidate the in-progress gesture.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these values deliberately invalidate the resize session.
  useEffect(cancelResize, [widthMm, aspectRatio, readOnly, controls, cancelResize]);

  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    cancelResize();
    if (commit) onResizeCommit(resizedImageWidth(session, event.clientX));
  };

  return (
    <Frame
      className={`image-selection-frame${selected ? " is-selected" : ""}${className ? ` ${className}` : ""}`}
      style={{
        ...(as === "span" ? { display: "inline-block" } : {}),
        width: `${displayedWidthMm}mm`,
        ...(aspectRatio
          ? ({
              "--image-aspect-ratio": String(aspectRatio),
              aspectRatio: "var(--image-aspect-ratio)",
            } as CSSProperties)
          : {}),
      }}
      data-testid="image-selection-frame"
    >
      {children}
      {controlsVisible ? (
        <>
          <button
            type="button"
            className="image-selection-frame__delete"
            data-motion={controlsOpen ? "enter" : "exit"}
            inert={controlsOpen ? undefined : true}
            aria-hidden={controlsOpen ? undefined : true}
            aria-label={`删除${imageLabel}`}
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            ×
          </button>
          {RESIZE_CORNERS.map((corner) => (
            <button
              type="button"
              className={`image-selection-frame__resize is-${corner}`}
              data-motion={controlsOpen ? "enter" : "exit"}
              inert={controlsOpen ? undefined : true}
              aria-hidden={controlsOpen ? undefined : true}
              aria-label={resizeCornerLabel(corner, imageLabel)}
              key={corner}
              onPointerDown={(event) => {
                if (event.button !== 0 || sessionRef.current) return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setPointerCapture?.(event.pointerId);
                captureRef.current = event.currentTarget;
                const frame = event.currentTarget.parentElement;
                const scale =
                  frame && frame.offsetWidth > 0
                    ? frame.getBoundingClientRect().width / frame.offsetWidth
                    : 1;
                sessionRef.current = {
                  pointerId: event.pointerId,
                  corner,
                  startX: event.clientX,
                  startWidthMm: widthMm,
                  scale: scale > 0 ? scale : 1,
                };
              }}
              onPointerMove={(event) => {
                const session = sessionRef.current;
                if (!session || session.pointerId !== event.pointerId) return;
                setDraftWidthMm(resizedImageWidth(session, event.clientX));
              }}
              onPointerUp={(event) => finishResize(event, true)}
              onPointerCancel={(event) => finishResize(event, false)}
              onLostPointerCapture={(event) => finishResize(event, false)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                event.stopPropagation();
                const delta = event.shiftKey ? 5 : 1;
                onResizeCommit(
                  clampImageWidth(widthMm + (event.key === "ArrowRight" ? delta : -delta)),
                );
              }}
            />
          ))}
        </>
      ) : null}
    </Frame>
  );
}
