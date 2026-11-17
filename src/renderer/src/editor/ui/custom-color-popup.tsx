import { Pipette } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { SpatialPresence } from "../../shared/spatial-presence";
import "./custom-color-popup.css";

type Channels = [number, number, number];
function rgb(hex: string): Channels {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}
function hex(channels: number[]): string {
  return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}
function hsv(color: string): Channels {
  const source = rgb(color);
  const r = source[0] / 255;
  const g = source[1] / 255;
  const b = source[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const hue =
    delta === 0
      ? 0
      : max === r
        ? ((g - b) / delta) % 6
        : max === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4;
  return [(hue * 60 + 360) % 360, max === 0 ? 0 : delta / max, max];
}
function fromHsv(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const channels =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return hex(channels.map((channel) => (channel + v - c) * 255));
}
type EyeDropperConstructor = new () => { open(): Promise<{ sRGBHex: string }> };

export function CustomColorPopup({
  open,
  value,
  title,
  onSelect,
  onClose,
  anchor,
  surface,
  footer,
  onConfirm,
  className,
}: {
  open: boolean;
  value: string;
  title: string;
  onSelect(color: string): void;
  onClose(): void;
  anchor: HTMLElement | null;
  surface: RefObject<HTMLElement | null>;
  footer?: ReactNode | ((valid: boolean) => ReactNode);
  onConfirm?(color: string): void;
  className?: string;
}) {
  const [color, setColor] = useState(value.toUpperCase());
  const [coordinates, setCoordinates] = useState(() => hsv(value));
  const [hexInput, setHexInput] = useState(value.toUpperCase());
  const [sampling, setSampling] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const session = useRef(0);
  const currentValue = useRef(value);
  currentValue.current = value;
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useEffect(() => {
    mounted.current = open;
    session.current += 1;
    if (open) {
      setColor(currentValue.current.toUpperCase());
      setCoordinates(hsv(currentValue.current));
      setHexInput(currentValue.current.toUpperCase());
      setSampling(false);
      setError("");
    }
    return () => {
      mounted.current = false;
      session.current += 1;
    };
  }, [open]);
  const update = (next: string) => {
    setColor(next);
    setHexInput(next);
    setCoordinates(hsv(next));
    setError("");
    onSelect(next);
  };
  const [h, s, v] = coordinates;
  const updateHsv = (next: Channels) => {
    setCoordinates(next);
    const nextColor = fromHsv(next[0], next[1], next[2]);
    setColor(nextColor);
    setHexInput(nextColor);
    setError("");
    onSelect(nextColor);
  };
  const EyeDropper = (window as Window & { EyeDropper?: EyeDropperConstructor }).EyeDropper;
  const sample = async () => {
    if (!EyeDropper) return;
    const sessionId = session.current;
    setSampling(true);
    if (surface.current) surface.current.dataset.colorSampling = "true";
    try {
      const result = await new EyeDropper().open();
      if (mounted.current && sessionId === session.current) {
        update(result.sRGBHex.toUpperCase());
      }
    } catch (reason) {
      if (
        mounted.current &&
        sessionId === session.current &&
        !(reason instanceof DOMException && reason.name === "AbortError")
      )
        setError("取色失败，请重试或手动输入颜色。");
    } finally {
      if (mounted.current && sessionId === session.current) {
        setSampling(false);
        if (surface.current) surface.current.dataset.colorSampling = "false";
      }
    }
  };
  useLayoutEffect(() => {
    if (!open || !anchor || !surface.current) return;
    const bounds = anchor.getBoundingClientRect();
    const popup = surface.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(bounds.left, window.innerWidth - popup.width - 8)),
      top:
        bounds.bottom + popup.height + 8 <= window.innerHeight
          ? bounds.bottom
          : Math.max(8, bounds.top - popup.height),
    });
  }, [open, anchor, surface]);
  return createPortal(
    <SpatialPresence>
      {open ? (
        <section
          ref={surface}
          className={className ? `custom-color-popup ${className}` : "custom-color-popup"}
          data-color-sampling={sampling}
          role="dialog"
          aria-label={title}
          style={position}
          onKeyDown={(event) => {
            if (event.key === "Enter" && /^#[0-9a-f]{6}$/i.test(hexInput)) {
              event.preventDefault();
              onSelect(hexInput.toUpperCase());
              if (onConfirm) {
                event.stopPropagation();
                onConfirm(hexInput.toUpperCase());
              }
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
              anchor?.closest<HTMLElement>("button")?.focus({ preventScroll: true });
            }
          }}
        >
          <div
            className="custom-color-popup__saturation"
            role="slider"
            tabIndex={0}
            aria-label="饱和度与亮度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(s * 100)}
            aria-valuetext={`饱和度 ${Math.round(s * 100)}%，亮度 ${Math.round(v * 100)}%`}
            style={{ backgroundColor: fromHsv(h, 1, 1) }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const bounds = event.currentTarget.getBoundingClientRect();
              updateHsv([
                h,
                Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
                1 - Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
              ]);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              updateHsv([
                h,
                Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
                1 - Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
              ]);
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.1 : 0.01;
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
              event.preventDefault();
              updateHsv([
                h,
                Math.max(
                  0,
                  Math.min(
                    1,
                    s + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
                  ),
                ),
                Math.max(
                  0,
                  Math.min(
                    1,
                    v + (event.key === "ArrowDown" ? -step : event.key === "ArrowUp" ? step : 0),
                  ),
                ),
              ]);
            }}
          >
            <span style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }} />
          </div>
          <div className="custom-color-popup__preview-row">
            <span className="custom-color-popup__preview" style={{ backgroundColor: color }} />
            {EyeDropper ? (
              <button type="button" aria-label="屏幕取色" disabled={sampling} onClick={sample}>
                <Pipette size={18} />
              </button>
            ) : null}
            <label>
              色相
              <input
                type="range"
                style={{ color: fromHsv(h, 1, 1) }}
                min={0}
                max={359}
                value={Math.round(h)}
                onChange={(event) => updateHsv([Number(event.target.value), s, v])}
              />
            </label>
          </div>
          <div className="custom-color-popup__channels">
            {rgb(color).map((channel, index) => (
              <label key={["R", "G", "B"][index]}>
                {["R", "G", "B"][index]}
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={channel}
                  onChange={(event) => {
                    const next = event.target.valueAsNumber;
                    if (!Number.isFinite(next)) return;
                    const channels = rgb(color);
                    channels[index] = Math.max(0, Math.min(255, next));
                    update(hex(channels));
                  }}
                />
              </label>
            ))}
          </div>
          <label className="custom-color-popup__hex">
            HEX
            <input
              value={hexInput}
              aria-invalid={!/^#[0-9a-f]{6}$/i.test(hexInput)}
              maxLength={7}
              onChange={(event) => {
                const next = event.target.value;
                setHexInput(next);
                if (/^#[0-9a-f]{6}$/i.test(next)) {
                  setColor(next.toUpperCase());
                  setCoordinates(hsv(next));
                  onSelect(next.toUpperCase());
                }
              }}
            />
          </label>
          {error ? <p role="alert">{error}</p> : null}
          {typeof footer === "function" ? footer(/^#[0-9a-f]{6}$/i.test(hexInput)) : footer}
        </section>
      ) : null}
    </SpatialPresence>,
    anchor?.closest(".editor-mini-format") ?? document.body,
  );
}
