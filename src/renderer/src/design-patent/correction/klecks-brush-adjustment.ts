type Brush = { size: number; hardness: number };
/** Parameter-only gesture. Sensitivity is a host setting, not a claim about Adobe's rate. */
export function bindKlecksBrushAdjustment(
  canvas: HTMLCanvasElement,
  driver: {
    platform: "windows" | "mac" | "harmony";
    enabled(): boolean;
    current(): Brush;
    changed(brush: Brush, event: PointerEvent | null): void;
    finished(): void;
  },
): () => void {
  const controller = new AbortController(),
    options = { signal: controller.signal, capture: true };
  const hud = document.createElement("div");
  hud.style.cssText =
    "position:fixed;pointer-events:none;z-index:12;display:none;padding:5px 8px;border-radius:4px;color:white;background:#222;font:12px sans-serif";
  hud.setAttribute("role", "status");
  canvas.parentElement?.append(hud);
  let active: { id: number; x: number; y: number; initial: Brush } | null = null;
  const finish = (cancel = false) => {
    const previous = active;
    if (!previous) return;
    active = null;
    if (canvas.hasPointerCapture(previous.id)) canvas.releasePointerCapture(previous.id);
    if (cancel) driver.changed(previous.initial, null);
    hud.style.display = "none";
    driver.finished();
  };
  const update = (event: PointerEvent) => {
    if (!active) return;
    const size = Math.max(
        1,
        Math.min(
          5000,
          Math.round(
            active.initial.size *
              2 ** Math.max(-20, Math.min(20, (event.clientX - active.x) / 100)),
          ),
        ),
      ),
      hardness = Math.max(
        0,
        Math.min(1, active.initial.hardness + (event.clientY - active.y) / 100),
      );
    driver.changed({ size, hardness }, event);
    hud.textContent = `直径 ${size} px · 硬度 ${Math.round(hardness * 100)}%`;
    hud.style.left = `${event.clientX + 18}px`;
    hud.style.top = `${event.clientY + 18}px`;
    hud.style.display = "block";
  };
  canvas.addEventListener(
    "pointerdown",
    (event) => {
      const chord =
        driver.platform === "mac"
          ? event.button === 0 && event.altKey && event.ctrlKey && !event.metaKey
          : event.button === 2 && event.altKey && !event.ctrlKey && !event.metaKey;
      if (!chord || active || !driver.enabled()) return;
      active = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        initial: { ...driver.current() },
      };
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      update(event);
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    options,
  );
  canvas.addEventListener(
    "pointermove",
    (event) => {
      if (!active || active.id !== event.pointerId) return;
      update(event);
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    options,
  );
  canvas.addEventListener(
    "pointerup",
    (event) => {
      if (!active || active.id !== event.pointerId) return;
      update(event);
      finish();
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    options,
  );
  canvas.addEventListener("pointercancel", () => finish(true), options);
  canvas.addEventListener("lostpointercapture", () => finish(true), options);
  canvas.addEventListener(
    "keydown",
    (event) => {
      if (!active) return;
      if (event.key === "Escape") {
        finish(true);
        event.preventDefault();
        event.stopImmediatePropagation();
      } else if (event.key === "Enter") {
        finish();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    options,
  );
  canvas.addEventListener(
    "contextmenu",
    (event) => {
      if (active || (event.altKey && driver.enabled())) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    options,
  );
  canvas.addEventListener("blur", () => finish(true), options);
  return () => {
    finish(true);
    controller.abort();
    hud.remove();
  };
}
