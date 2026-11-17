import { DEFAULT_DUAL_COLUMN_FLOW, type DualColumnFlow } from "../../../shared/settings/model";

type FlowGeometry = { columnWidth: number; rulerSlot: number; height: number; position: number };

/** Decorative sibling of the editor: never cloned into the document or used for hit testing. */
export function createColumnFlow(layout: HTMLElement) {
  const overlay = document.createElement("div");
  overlay.className = "dual-column-flow";
  overlay.setAttribute("aria-hidden", "true");
  overlay.inert = true;
  overlay.innerHTML = `<div class="flow-box bottom"><i class="flow-opening"></i><i class="flow-face"><i class="flow-grip"></i><i class="flow-led"></i></i></div>
    <div class="flow-box top"><i class="flow-opening"></i><i class="flow-face"><i class="flow-grip"></i><i class="flow-led"></i></i></div>
    <svg class="flow-cable" focusable="false"><path class="flow-shadow"/><path class="flow-body"/><path class="flow-edge"/><path class="flow-current flow-glow"/><path class="flow-current"/></svg>`;
  layout.append(overlay);
  const margins = [0, 1].map((side) => {
    const layer = document.createElement("div");
    layer.className = `margin-flow ${side === 0 ? "bottom" : "top"}`;
    for (const edge of ["left", "right"]) {
      const strip = document.createElement("div");
      strip.className = `margin-strip ${edge}`;
      for (let index = -5; index <= 5; index++) {
        const mark = document.createElement("i");
        mark.className = "margin-mark";
        mark.dataset.index = String(index);
        mark.style.setProperty("--lane", String(Math.abs(index) % 3));
        strip.append(mark);
      }
      layer.append(strip);
    }
    overlay.append(layer);
    return layer;
  });
  const boxes = overlay.querySelectorAll<HTMLElement>(".flow-box");
  const cable = overlay.querySelector<SVGSVGElement>("svg");
  if (!cable) throw new Error("Missing column flow cable");
  let last: FlowGeometry | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    overlay.classList.remove("moving");
  };
  const configure = (
    settings: Omit<DualColumnFlow, "margin"> & Partial<Pick<DualColumnFlow, "margin">>,
  ) => {
    overlay.dataset.style = settings.style;
    overlay.dataset.mode = settings.mode;
    layout.dataset.flowMode = settings.mode;
    overlay.dataset.margin = settings.margin ?? "dust";
    overlay.hidden = settings.mode === "off";
    stop();
  };
  configure(DEFAULT_DUAL_COLUMN_FLOW);
  return {
    configure,
    paint(geometry: FlowGeometry) {
      const { columnWidth: width, rulerSlot, height, position } = geometry;
      const bandHeight = Math.min(144, height);
      const phase = (((position + height) % 38) + 38) % 38;
      margins.forEach((layer, side) => {
        layer.style.left = `${side * (width + 20) + rulerSlot}px`;
        layer.style.top = `${side === 0 ? height - bandHeight : 20}px`;
        layer.style.width = `${width - rulerSlot}px`;
        layer.style.height = `${bandHeight}px`;
        layer.querySelectorAll<HTMLElement>(".margin-mark").forEach((mark) => {
          mark.style.translate = `0 ${(side === 0 ? bandHeight : 0) + Number(mark.dataset.index) * 38 - phase}px`;
        });
      });
      const resized =
        !last ||
        last.columnWidth !== width ||
        last.rulerSlot !== rulerSlot ||
        last.height !== height;
      if (resized) {
        stop();
        overlay.style.width = `${2 * width + 28}px`;
        overlay.style.height = `${height + 20}px`;
        boxes.forEach((box, side) => {
          box.style.left = `${side * (width + 20) + rulerSlot - 8}px`;
          box.style.top = `${side === 0 ? height : 0}px`;
          box.style.width = `${width - rulerSlot + 16}px`;
        });
        // Use the existing 20px outer gaps. The cable crosses ABOVE the right
        // ruler, then descends in the genuine inter-column gutter, not over labels.
        const start = width + 20 + rulerSlot - 8;
        const mid = width + 10;
        const end = width + 8;
        const d = `M ${start} 10 L ${mid + 8} 10 Q ${mid} 10 ${mid} 18 L ${mid} ${height + 8} Q ${mid} ${height + 10} ${end} ${height + 10}`;
        cable.setAttribute("viewBox", `0 0 ${2 * width + 28} ${height + 20}`);
        cable.querySelectorAll("path").forEach((path) => {
          path.setAttribute("d", d);
        });
      } else if (last && Math.abs(position - last.position) > 0.01 && !overlay.hidden) {
        overlay.classList.add("moving");
        overlay.classList.toggle("backward", position < last.position);
        clearTimeout(timer);
        timer = setTimeout(stop, 200);
      }
      last = geometry;
    },
    destroy() {
      stop();
      overlay.remove();
      delete layout.dataset.flowMode;
    },
  };
}
