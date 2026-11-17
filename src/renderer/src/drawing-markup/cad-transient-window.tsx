import { X } from "lucide-react";
import {
  Children,
  Fragment,
  isValidElement,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { MotionPresence } from "../app/motion-presence";
import "./cad-transient-window.css";

/** A non-modal palette: canvas picking continues while parameter drafts stay mounted. */
export function CadTransientWindow({
  target,
  open,
  title,
  children,
  onClose,
  focusCanvas,
}: {
  target?: HTMLElement | null | undefined;
  open?: boolean;
  title: string;
  children: ReactNode;
  onClose(): void;
  focusCanvas?(): void;
}) {
  const titleId = useId();
  const visible = open ?? hasSettings(children);
  const palette = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!target || !visible) return;
    const rail = target
      .closest(".drawing-workspace")
      ?.querySelector<HTMLElement>(".patent-global-function-rail");
    const slot = rail?.closest(".patent-global-function-rail-slot");
    let frame = 0;
    const measure = () => {
      const host = target.getBoundingClientRect(),
        side = rail?.getBoundingClientRect();
      // Keep both palettes usable even when the pinned rail floats over a narrow canvas.
      const room =
        slot?.getAttribute("data-expanded") === "true" &&
        side &&
        side.width > 0 &&
        side.left > host.left &&
        side.left < host.right &&
        side.bottom > host.top
          ? Math.max(120, side.left - host.left - 28)
          : host.width - 32;
      palette.current?.style.setProperty("--cad-settings-room", `${Math.max(0, room)}px`);
      if (palette.current) palette.current.dataset.compact = String(room < 680);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(target);
    if (rail) resize?.observe(rail);
    const changes = new MutationObserver(schedule);
    if (slot)
      changes.observe(slot, {
        attributes: true,
        subtree: true,
        attributeFilter: ["style", "data-expanded", "data-layout"],
      });
    window.addEventListener("resize", schedule);
    return () => {
      resize?.disconnect();
      changes.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
    };
  }, [target, visible]);
  // Standalone editors can render without a workspace. A workspace awaiting its
  // host must not briefly paint settings in the function rail.
  if (target === undefined) return children;
  if (!target) return null;
  return createPortal(
    <MotionPresence kind="panel">
      {visible && (
        <section
          ref={palette}
          className="cad-transient-window"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
          onClick={(event) => {
            const control = (event.target as Element).closest(
              "button,summary,input[type='checkbox'],input[type='radio']",
            );
            if (control && !control.closest("[aria-haspopup]")) focusCanvas?.();
          }}
        >
          <div className="cad-transient-window__body">
            <header className="cad-transient-window__header">
              <h3 id={titleId} title={`${title}设置`}>
                {title}设置
              </h3>
              <button type="button" aria-label="关闭设置" title="关闭设置（Esc）" onClick={onClose}>
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            {children}
          </div>
        </section>
      )}
    </MotionPresence>,
    target,
  );
}

function hasSettings(children: ReactNode): boolean {
  return Children.toArray(children).some((child) =>
    isValidElement<{ children?: ReactNode }>(child)
      ? child.type === Fragment
        ? hasSettings(child.props.children)
        : true
      : typeof child === "string" || typeof child === "number",
  );
}
