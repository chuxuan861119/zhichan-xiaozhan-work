import type { Page } from "@playwright/test";

type Probe = {
  running: boolean;
  previous: number;
  frames: number[];
  longTasks: number[];
  changes: number;
  gpuDraws: number;
  originalDraw: WebGLRenderingContext["drawArrays"];
  observer: MutationObserver;
  tasks: PerformanceObserver;
};
type ProbeWindow = Window & { toolProbe: Probe };

export async function begin(page: Page, selector: string) {
  await page.evaluate((selector) => {
    const canvas = document.querySelector('[aria-label="CAD标号画布"]');
    if (!canvas) throw Error("Canvas missing");
    const state = {
      running: true,
      previous: 0,
      frames: [],
      longTasks: [],
      changes: 0,
      gpuDraws: 0,
    } as unknown as Probe;
    state.originalDraw = WebGLRenderingContext.prototype.drawArrays;
    WebGLRenderingContext.prototype.drawArrays = function (...args) {
      if (this.canvas instanceof HTMLCanvasElement && this.canvas.dataset.cadGpuPreview)
        state.gpuDraws++;
      return state.originalDraw.apply(this, args);
    };
    state.observer = new MutationObserver((records) => {
      if (
        records.some((r) =>
          (r.target instanceof Element ? r.target : r.target.parentElement)?.closest(selector),
        )
      )
        state.changes++;
    });
    state.observer.observe(canvas.parentElement ?? canvas, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    state.tasks = new PerformanceObserver((list) =>
      state.longTasks.push(...list.getEntries().map((e) => e.duration)),
    );
    state.tasks.observe({ type: "longtask" });
    (window as unknown as ProbeWindow).toolProbe = state;
    const frame = (t: number) => {
      if (!state.running) return;
      if (state.previous) state.frames.push(t - state.previous);
      state.previous = t;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, selector);
}

export async function end(page: Page, name: string) {
  return page.evaluate((name) => {
    const s = (window as unknown as ProbeWindow).toolProbe;
    s.running = false;
    s.observer.disconnect();
    s.tasks.disconnect();
    WebGLRenderingContext.prototype.drawArrays = s.originalDraw;
    const a = s.frames.sort((a, b) => a - b);
    return {
      name,
      samples: a.length,
      p50: a[Math.floor(a.length * 0.5)] ?? 0,
      p95: a[Math.floor(a.length * 0.95)] ?? 0,
      max: a.at(-1) ?? 0,
      visualUpdates: s.changes,
      gpuDraws: s.gpuDraws,
      longTasks: s.longTasks,
    };
  }, name);
}
