import { createColumnFlow } from "./dual-column-flow";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

test("flow is a decorative sibling, stays outside paper and ruler, and supports live settings", () => {
  const layout = document.createElement("div");
  document.body.append(layout);
  const flow = createColumnFlow(layout);
  flow.paint({ columnWidth: 500, rulerSlot: 70, height: 600, position: 0 });
  const overlay = layout.querySelector<HTMLElement>(".dual-column-flow");
  if (!overlay) throw new Error("Missing flow overlay");
  expect(overlay.getAttribute("aria-hidden")).toBe("true");
  expect(overlay.style.width).toBe("1028px");
  expect(overlay.style.height).toBe("620px");
  const boxes = overlay.querySelectorAll<HTMLElement>(".flow-box");
  expect(boxes[0]?.style.left).toBe("62px");
  expect(boxes[0]?.style.top).toBe("600px");
  expect(boxes[1]?.style.left).toBe("582px");
  expect(boxes[1]?.style.top).toBe("0px");
  expect(overlay.querySelector("path")?.getAttribute("d")).toContain("L 510 608");
  for (const style of ["classic", "slim", "ceramic", "graphite"] as const) {
    flow.configure({ style, mode: "boxes" });
    expect(overlay.dataset.style).toBe(style);
    expect(overlay.dataset.mode).toBe("boxes");
    expect(layout.firstChild).toBe(overlay);
  }
  flow.configure({ style: "slim", mode: "off" });
  expect(layout.dataset.flowMode).toBe("off");
  expect(overlay.hidden).toBe(true);
  flow.configure({ style: "slim", mode: "cable" });
  expect(overlay.hidden).toBe(false);
  expect(overlay.dataset.margin).toBe("dust");
  expect(overlay.querySelectorAll(".margin-flow")).toHaveLength(2);
  for (const margin of ["dust", "threads", "ticks", "chevrons", "none"] as const) {
    flow.configure({ style: "graphite", mode: "cable", margin });
    expect(overlay.dataset.margin).toBe(margin);
  }
  flow.destroy();
  expect(layout.childElementCount).toBe(0);
});

test("current follows actual scrolling, idles, and does not flash on resizing", () => {
  vi.useFakeTimers();
  const layout = document.createElement("div");
  const flow = createColumnFlow(layout);
  const geometry = { columnWidth: 500, rulerSlot: 70, height: 600, position: 0 };
  const overlay = layout.firstElementChild as HTMLElement;
  flow.paint(geometry);
  expect(overlay.classList.contains("moving")).toBe(false);
  flow.paint({ ...geometry, position: 20 });
  const mark = overlay.querySelector<HTMLElement>(".margin-mark");
  const at20 = parseFloat(mark?.style.translate.split(" ")[1] ?? "NaN");
  expect(overlay.classList.contains("moving")).toBe(true);
  expect(overlay.classList.contains("backward")).toBe(false);
  flow.paint({ ...geometry, position: 10 });
  expect(parseFloat(mark?.style.translate.split(" ")[1] ?? "NaN") - at20).toBe(10);
  expect(overlay.classList.contains("backward")).toBe(true);
  vi.advanceTimersByTime(220);
  expect(overlay.classList.contains("moving")).toBe(false);
  flow.paint({ ...geometry, height: 620, position: 40 });
  expect(overlay.classList.contains("moving")).toBe(false);
  flow.destroy();
  expect(vi.getTimerCount()).toBe(0);
});
