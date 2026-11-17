import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  createEditorColorGamut,
  gamutColor,
  hexToHsv,
  locateGamutColor,
} from "../../../shared/settings/editor-color-gamut";
import {
  DEFAULT_EDITOR_COLORS,
  type EditorColorField,
} from "../../../shared/settings/editor-colors";

export function EditorColorGamut({
  color,
  field,
  contrastColor,
  onChange,
}: {
  color: string;
  field: EditorColorField;
  contrastColor: string;
  onChange(color: string): void;
}) {
  const [hue, setHue] = useState(() => hexToHsv(color).h);
  const [selection, setSelection] = useState<{
    color: string;
    hue: number;
    x: number;
    y: number;
  } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef<number | null>(null);
  const gamut = useMemo(
    () =>
      createEditorColorGamut(
        {
          ...DEFAULT_EDITOR_COLORS,
          ...(field === "page"
            ? { canvas: contrastColor }
            : field === "canvas"
              ? { page: contrastColor }
              : {}),
        },
        field,
        hue,
      ),
    [field, contrastColor, hue],
  );
  const position = useMemo(
    () =>
      selection?.color === color && selection.hue === hue
        ? selection
        : locateGamutColor(gamut, color),
    [gamut, color, hue, selection],
  );
  const choose = (x: number, y: number) => {
    const next = { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    const nextColor = gamutColor(gamut, next.x, next.y);
    setSelection({ ...next, hue, color: nextColor });
    onChange(nextColor);
  };
  useEffect(() => {
    if (typeof CanvasRenderingContext2D === "undefined") return;
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    const pixels = context.createImageData(128, 128);
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const hex = gamutColor(gamut, x / 127, y / 127);
        const index = (y * 128 + x) * 4;
        pixels.data[index] = Number.parseInt(hex.slice(1, 3), 16);
        pixels.data[index + 1] = Number.parseInt(hex.slice(3, 5), 16);
        pixels.data[index + 2] = Number.parseInt(hex.slice(5, 7), 16);
        pixels.data[index + 3] = 255;
      }
    context.putImageData(pixels, 0, 0);
  }, [gamut]);
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width && bounds.height)
      choose(
        (event.clientX - bounds.left) / bounds.width,
        (event.clientY - bounds.top) / bounds.height,
      );
  };
  return (
    <div className="editor-color-gamut">
      <div
        className="editor-color-gamut__plane"
        role="slider"
        tabIndex={0}
        aria-label="可用色域"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position.x * 100)}
        aria-valuetext={color}
        aria-description="左右键调整浓淡，上下键调整明暗，按住 Shift 加快调整"
        onPointerDown={(event) => {
          if (event.button !== 0 || dragging.current !== null) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          dragging.current = event.pointerId;
          pick(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current === event.pointerId) pick(event);
        }}
        onPointerUp={(event) => {
          if (dragging.current !== event.pointerId) return;
          pick(event);
          dragging.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragging.current = null;
        }}
        onLostPointerCapture={() => {
          dragging.current = null;
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.1 : 0.02;
          const delta = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
          }[event.key];
          if (!delta) return;
          event.preventDefault();
          choose(position.x + (delta[0] ?? 0), position.y + (delta[1] ?? 0));
        }}
      >
        <canvas ref={canvas} width={128} height={128} />
        <span
          className="editor-color-gamut__cursor"
          style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%`, background: color }}
        />
      </div>
      <label className="editor-color-gamut__hue">
        色相
        <input
          type="range"
          min={0}
          max={359}
          step={1}
          value={hue}
          aria-label="色相"
          onChange={(event) => {
            const nextHue = Number(event.target.value);
            const nextGamut = createEditorColorGamut(
              {
                ...DEFAULT_EDITOR_COLORS,
                ...(field === "page"
                  ? { canvas: contrastColor }
                  : field === "canvas"
                    ? { page: contrastColor }
                    : {}),
              },
              field,
              nextHue,
            );
            setHue(nextHue);
            const nextColor = gamutColor(nextGamut, position.x, position.y);
            setSelection({ x: position.x, y: position.y, hue: nextHue, color: nextColor });
            onChange(nextColor);
          }}
        />
      </label>
      <small>仅显示可用颜色 · 方向键可微调</small>
    </div>
  );
}
