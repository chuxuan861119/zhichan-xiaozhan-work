import { act, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, type RefObject, useRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PatentFunctionRailScope, usePatentFunctionRail } from "./function-rail-context";
import {
  measureFunctionRailSpace,
  useFunctionRailMeasurement,
} from "./use-function-rail-measurement";

type Rect = Pick<DOMRect, "left" | "right" | "width">;

function rect(left: number, right: number, width = right - left): Rect {
  return { left, right, width };
}

class ControlledResizeObserver implements ResizeObserver {
  static instances: ControlledResizeObserver[] = [];

  readonly observe = vi.fn((element: Element) => {
    this.elements.add(element);
  });
  readonly unobserve = vi.fn((element: Element) => {
    this.elements.delete(element);
  });
  readonly disconnect = vi.fn(() => {
    this.elements.clear();
  });
  readonly elements = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }

  trigger() {
    this.callback([], this);
  }
}

let nextFrameId = 1;
let frames = new Map<number, FrameRequestCallback>();
const requestFrame = vi.fn((callback: FrameRequestCallback) => {
  const id = nextFrameId++;
  frames.set(id, callback);
  return id;
});
const cancelFrame = vi.fn((id: number) => {
  frames.delete(id);
});

function flushFrames() {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [id, callback] of pending) callback(id);
}

function MeasurementProbe({
  pageClass = "patent-page-zoom-frame",
  pages,
  measurementKey = 100,
  withStructureRuler = false,
}: {
  pageClass?: string;
  pages?: ReactNode;
  measurementKey?: number;
  withStructureRuler?: boolean;
}) {
  const slotRef = useRef<HTMLElement | null>(null);
  const rail = usePatentFunctionRail();
  useFunctionRailMeasurement(slotRef as RefObject<HTMLElement | null>, measurementKey);

  return (
    <div className="patent-page-with-rail">
      {withStructureRuler ? <aside className="document-structure-ruler" /> : null}
      {pages ?? <main className={pageClass} data-testid="page" />}
      <aside ref={slotRef}>功能栏</aside>
      <output aria-label="空间状态">{rail.space}</output>
      <output aria-label="用户意图">{rail.userIntent}</output>
      <output aria-label="功能栏呈现">
        {String(rail.presentation.expanded)}:{rail.presentation.layout}
      </output>
      <button type="button" onClick={rail.collapse}>
        手动收起
      </button>
    </div>
  );
}

function renderProbe(
  initialSpace: "fits" | "constrained" = "fits",
  pages?: ReactNode,
  withStructureRuler = false,
) {
  return render(
    <PatentFunctionRailScope scopeKey="test" initialSpace={initialSpace}>
      <MeasurementProbe pages={pages} withStructureRuler={withStructureRuler} />
    </PatentFunctionRailScope>,
  );
}

function setMeasuredRect(element: Element, value: Rect) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(value as DOMRect);
  if (element.classList.contains("patent-function-rail-scope")) {
    const layout = element.querySelector(".patent-page-with-rail");
    if (layout) setMeasuredRect(layout, value);
  }
}

describe("measureFunctionRailSpace", () => {
  test("uses the whole pane when a centered page and full rail fit side by side", () => {
    expect(measureFunctionRailSpace("fits", rect(0, 1287), rect(233, 1053, 820))).toBe("fits");
    expect(measureFunctionRailSpace("constrained", rect(0, 1287), rect(233, 1053, 820))).toBe(
      "fits",
    );
  });

  test("ignores hidden zero-width measurements", () => {
    expect(measureFunctionRailSpace("fits", rect(0, 900, 900), rect(40, 40, 0))).toBeNull();
  });

  test("restores constrained space after the rail and page fit with a recovery margin", () => {
    expect(measureFunctionRailSpace("fits", rect(0, 1112), rect(0, 820))).toBe("fits");
    expect(measureFunctionRailSpace("constrained", rect(0, 1111), rect(0, 820))).toBe(
      "constrained",
    );
    expect(measureFunctionRailSpace("constrained", rect(0, 1112), rect(0, 820))).toBe(
      "constrained",
    );
    expect(measureFunctionRailSpace("constrained", rect(0, 1124), rect(0, 820))).toBe("fits");
  });
});

describe("useFunctionRailMeasurement", () => {
  beforeEach(() => {
    ControlledResizeObserver.instances = [];
    frames = new Map();
    nextFrameId = 1;
    requestFrame.mockClear();
    cancelFrame.mockClear();
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("measures the scope and first visible direct page after a resize", () => {
    const { container } = renderProbe();
    const scope = container.querySelector(".patent-function-rail-scope");
    const page = screen.getByTestId("page");
    if (!scope) throw new Error("missing scope");
    setMeasuredRect(scope, rect(0, 900, 900));
    setMeasuredRect(page, rect(40, 860, 820));

    act(() => {
      ControlledResizeObserver.instances.at(-1)?.trigger();
      flushFrames();
    });

    expect(screen.getByLabelText("空间状态").textContent).toBe("constrained");
    expect(ControlledResizeObserver.instances.at(-1)?.elements).toEqual(
      new Set([scope, page, container.querySelector(".patent-page-with-rail")]),
    );
  });

  test("keeps the rail expanded in a wide half-screen even when the page starts centered", () => {
    const { container } = renderProbe("fits");
    const scope = container.querySelector(".patent-function-rail-scope");
    const page = screen.getByTestId("page");
    if (!scope) throw new Error("missing scope");
    setMeasuredRect(scope, rect(0, 1287));
    setMeasuredRect(page, rect(233, 1053, 820));

    act(() => {
      ControlledResizeObserver.instances.at(-1)?.trigger();
      flushFrames();
    });

    expect(screen.getByLabelText("空间状态").textContent).toBe("fits");
  });

  test("single-page budget collapses the rail before the ruler and keeps compact state stable", () => {
    const { container } = renderProbe("fits", undefined, true);
    const layout = container.querySelector<HTMLElement>(".patent-page-with-rail")!;
    const page = screen.getByTestId("page");
    const ruler = container.querySelector(".document-structure-ruler")!;
    layout.dataset.pageZoomTarget = "1";
    Object.defineProperty(page, "offsetWidth", { value: 794 });
    setMeasuredRect(page, rect(84, 878, 794));
    setMeasuredRect(ruler, rect(0, 76, 76));
    const measure = (width: number) => {
      setMeasuredRect(layout, rect(0, width));
      act(() => {
        ControlledResizeObserver.instances.at(-1)?.trigger();
        flushFrames();
      });
    };
    measure(1000);
    expect(screen.getByLabelText("空间状态").textContent).toBe("constrained");
    expect(layout.dataset.paneRulerCompact).toBe("false");
    measure(900);
    expect(layout.dataset.paneRulerCompact).toBe("true");
    layout.style.gridTemplateColumns = "28px 794px 48px";
    measure(900);
    expect(screen.getByLabelText("空间状态").textContent).toBe("constrained");
    expect(layout.dataset.paneRulerCompact).toBe("true");
    measure(1170);
    expect(screen.getByLabelText("空间状态").textContent).toBe("constrained");
    measure(1182);
    expect(screen.getByLabelText("空间状态").textContent).toBe("fits");
    expect(layout.dataset.paneRulerCompact).toBe("false");
  });

  test("single page reserves the zoom target before the enlargement animation paints", () => {
    const { container } = renderProbe("fits", undefined, true);
    const layout = container.querySelector<HTMLElement>(".patent-page-with-rail")!;
    const page = screen.getByTestId("page");
    layout.dataset.pageZoomTarget = "1.2";
    Object.defineProperty(page, "offsetWidth", { value: 794 });
    setMeasuredRect(layout, rect(0, 1200));
    setMeasuredRect(page, rect(84, 878, 794));
    act(() => flushFrames());
    expect(screen.getByLabelText("空间状态").textContent).toBe("constrained");
  });

  test("uses the inner grid width and reservation, including compact ruler space", () => {
    const { container } = renderProbe("fits", undefined, true);
    const scope = container.querySelector(".patent-function-rail-scope")!;
    const layout = container.querySelector<HTMLElement>(".patent-page-with-rail")!;
    const ruler = container.querySelector(".document-structure-ruler")!;
    setMeasuredRect(scope, rect(0, 1403));
    setMeasuredRect(layout, rect(28, 1360));
    setMeasuredRect(screen.getByTestId("page"), rect(112, 1104, 992));
    setMeasuredRect(ruler, rect(84, 104, 20));
    layout.style.gridTemplateColumns = "84px 992px 292px";
    act(() => flushFrames());
    expect(screen.getByLabelText("空间状态").textContent).toBe("constrained");
    expect(ControlledResizeObserver.instances.at(-1)?.elements.has(layout)).toBe(true);
    setMeasuredRect(layout, rect(28, 1450));
    act(() => {
      ControlledResizeObserver.instances.at(-1)?.trigger();
      flushFrames();
    });
    expect(screen.getByLabelText("空间状态").textContent).toBe("fits");
  });

  test("collapses before a compact structure ruler would cause horizontal overflow", () => {
    const { container } = renderProbe("fits", undefined, true);
    const scope = container.querySelector(".patent-function-rail-scope");
    const page = screen.getByTestId("page");
    const ruler = container.querySelector(".document-structure-ruler");
    if (!scope || !ruler) throw new Error("missing measurement elements");
    setMeasuredRect(scope, rect(0, 1112));
    setMeasuredRect(page, rect(40, 860, 820));
    setMeasuredRect(ruler, rect(0, 20, 20));

    act(() => {
      ControlledResizeObserver.instances.at(-1)?.trigger();
      flushFrames();
    });

    expect(screen.getByLabelText("空间状态").textContent).toBe("constrained");
  });

  test("remeasures when page zoom changes without a resize observer callback", () => {
    let pageWidth = 820;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches(".patent-function-rail-scope, .patent-page-with-rail")) {
        return rect(0, 1287) as DOMRect;
      }
      if (this.classList.contains("patent-page-zoom-frame")) {
        return rect(0, pageWidth) as DOMRect;
      }
      return rect(0, 0, 0) as DOMRect;
    });

    const view = render(
      <PatentFunctionRailScope scopeKey="test" initialSpace="fits">
        <MeasurementProbe measurementKey={100} />
      </PatentFunctionRailScope>,
    );
    act(() => flushFrames());
    expect(screen.getByLabelText("空间状态").textContent).toBe("fits");

    pageWidth = 1066;
    view.rerender(
      <PatentFunctionRailScope scopeKey="test" initialSpace="fits">
        <MeasurementProbe measurementKey={130} />
      </PatentFunctionRailScope>,
    );
    act(() => flushFrames());
    expect(screen.getByLabelText("空间状态").textContent).toBe("constrained");

    pageWidth = 820;
    view.rerender(
      <PatentFunctionRailScope scopeKey="test" initialSpace="fits">
        <MeasurementProbe measurementKey={100} />
      </PatentFunctionRailScope>,
    );
    act(() => flushFrames());
    expect(screen.getByLabelText("空间状态").textContent).toBe("fits");
  });

  test("recovers a manually collapsed rail when page zoom releases sufficient width", () => {
    let pageWidth = 1066;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches(".patent-function-rail-scope, .patent-page-with-rail")) {
        return rect(0, 1287) as DOMRect;
      }
      if (this.classList.contains("patent-page-zoom-frame")) {
        return rect(0, pageWidth) as DOMRect;
      }
      return rect(0, 0, 0) as DOMRect;
    });

    const view = render(
      <PatentFunctionRailScope scopeKey="test" initialSpace="constrained">
        <MeasurementProbe measurementKey={130} />
      </PatentFunctionRailScope>,
    );
    act(() => flushFrames());
    fireEvent.click(screen.getByRole("button", { name: "手动收起" }));
    expect(screen.getByLabelText("用户意图").textContent).toBe("collapsed");

    pageWidth = 902;
    view.rerender(
      <PatentFunctionRailScope scopeKey="test" initialSpace="constrained">
        <MeasurementProbe measurementKey={110} />
      </PatentFunctionRailScope>,
    );
    act(() => flushFrames());

    expect(screen.getByLabelText("用户意图").textContent).toBe("auto");
    expect(screen.getByLabelText("空间状态").textContent).toBe("fits");
    expect(screen.getByLabelText("功能栏呈现").textContent).toBe("true:docked");
  });

  test("a laptop dual pane follows rendered width and hysteresis even while dragging its splitter", () => {
    let width = 900;
    let pageWidth = 397;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches(".patent-function-rail-scope, .patent-page-with-rail"))
        return rect(0, width) as DOMRect;
      if (this.matches(".patent-page-zoom-frame")) return rect(0, pageWidth) as DOMRect;
      return rect(0, 0) as DOMRect;
    });
    const { container } = render(
      <div className="dual-document-workspace" data-split-resizing="true">
        <PatentFunctionRailScope scopeKey="left" initialSpace="constrained">
          <div className="patent-editor-workspace" data-display-width-mm="345">
            <MeasurementProbe withStructureRuler />
          </div>
        </PatentFunctionRailScope>
      </div>,
    );
    Object.defineProperty(screen.getByTestId("page"), "offsetWidth", { value: 794 });
    const layout = container.querySelector<HTMLElement>(".patent-page-with-rail")!;
    layout.style.gridTemplateColumns = "28px 397px 48px";
    const remeasure = () =>
      act(() => {
        ControlledResizeObserver.instances.at(-1)?.trigger();
        flushFrames();
      });
    remeasure();
    expect(screen.getByLabelText("功能栏呈现").textContent).toBe("true:docked");
    pageWidth = 600;
    remeasure();
    expect(screen.getByLabelText("空间状态").textContent).toBe("constrained");
    width = 976;
    remeasure();
    expect(screen.getByLabelText("空间状态").textContent).toBe("constrained");
    width = 988;
    remeasure();
    expect(screen.getByLabelText("功能栏呈现").textContent).toBe("true:docked");
  });

  test("keeps an explicitly collapsed dual-pane rail collapsed during automatic zoom", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches(".patent-function-rail-scope, .patent-page-with-rail"))
        return rect(0, 900) as DOMRect;
      if (this.matches(".patent-page-zoom-frame")) return rect(0, 750) as DOMRect;
      return rect(0, 0, 0) as DOMRect;
    });
    const view = render(
      <PatentFunctionRailScope scopeKey="left" initialSpace="constrained">
        <MeasurementProbe measurementKey={54} />
      </PatentFunctionRailScope>,
    );
    act(() => flushFrames());
    fireEvent.click(screen.getByRole("button", { name: "手动收起" }));
    view.rerender(
      <PatentFunctionRailScope scopeKey="left" initialSpace="constrained">
        <MeasurementProbe measurementKey={87} />
      </PatentFunctionRailScope>,
    );
    act(() => flushFrames());
    expect(screen.getByLabelText("用户意图").textContent).toBe("collapsed");
    expect(screen.getByLabelText("功能栏呈现").textContent).toBe("false:overlay");
  });

  test("selects the first visible direct page in DOM order across supported page types", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches(".patent-function-rail-scope, .patent-page-with-rail"))
        return rect(0, 900, 900) as DOMRect;
      if (this.dataset.measurement === "hidden") return rect(0, 0, 0) as DOMRect;
      if (this.dataset.measurement === "drawing") return rect(40, 860, 820) as DOMRect;
      if (this.dataset.measurement === "zoom") return rect(0, 500, 500) as DOMRect;
      return rect(0, 0, 0) as DOMRect;
    });
    const { container } = renderProbe(
      "fits",
      <>
        <main className="drawings-editor" data-measurement="hidden" />
        <main className="drawing-page" data-measurement="drawing" data-testid="drawing-page" />
        <main className="patent-page-zoom-frame" data-measurement="zoom" />
      </>,
    );
    const scope = container.querySelector(".patent-function-rail-scope");
    const drawingPage = screen.getByTestId("drawing-page");
    if (!scope) throw new Error("missing scope");
    act(() => flushFrames());

    expect(ControlledResizeObserver.instances.at(-1)?.elements).toEqual(
      new Set([scope, drawingPage, container.querySelector(".patent-page-with-rail")]),
    );
    act(() => flushFrames());
    expect(screen.getByLabelText("空间状态").textContent).toBe("constrained");
  });

  test("reconnects observation and measures from a replacement page node", () => {
    const { container } = renderProbe("fits");
    const scope = container.querySelector(".patent-function-rail-scope");
    const oldPage = screen.getByTestId("page");
    if (!scope) throw new Error("missing scope");
    setMeasuredRect(scope, rect(0, 1136, 1136));
    setMeasuredRect(oldPage, rect(0, 820, 820));
    act(() => flushFrames());
    const observer = ControlledResizeObserver.instances.at(-1);

    const newPage = document.createElement("main");
    newPage.className = "drawing-page";
    setMeasuredRect(newPage, rect(118, 1018, 900));
    oldPage.replaceWith(newPage);
    act(() => {
      observer?.trigger();
      flushFrames();
    });

    expect(observer?.unobserve).toHaveBeenCalledWith(oldPage);
    expect(observer?.observe).toHaveBeenCalledWith(newPage);
    expect(screen.getByLabelText("空间状态").textContent).toBe("constrained");
  });

  test("does not overwrite the last space when the page becomes hidden", () => {
    const { container } = renderProbe("fits");
    const scope = container.querySelector(".patent-function-rail-scope");
    const page = screen.getByTestId("page");
    if (!scope) throw new Error("missing scope");
    setMeasuredRect(scope, rect(0, 900, 900));
    setMeasuredRect(page, rect(40, 40, 0));

    act(() => {
      ControlledResizeObserver.instances.at(-1)?.trigger();
      flushFrames();
    });

    expect(screen.getByLabelText("空间状态").textContent).toBe("fits");
  });

  test("ignores a retained invisible book even when its page still has width", () => {
    const { container } = renderProbe("fits");
    const layout = container.querySelector<HTMLElement>(".patent-page-with-rail")!;
    layout.style.visibility = "hidden";
    setMeasuredRect(layout, rect(0, 1060));
    setMeasuredRect(screen.getByTestId("page"), rect(84, 878, 794));
    act(() => flushFrames());
    expect(screen.getByLabelText("空间状态").textContent).toBe("fits");

    layout.style.visibility = "visible";
    act(() => {
      ControlledResizeObserver.instances.at(-1)?.trigger();
      flushFrames();
    });
    expect(screen.getByLabelText("空间状态").textContent).toBe("constrained");
  });

  test("coalesces repeated resize callbacks into one animation frame", () => {
    renderProbe();
    act(() => flushFrames());
    requestFrame.mockClear();
    const observer = ControlledResizeObserver.instances.at(-1);

    act(() => {
      observer?.trigger();
      observer?.trigger();
      observer?.trigger();
    });

    expect(requestFrame).toHaveBeenCalledOnce();
  });

  test("disconnects the observer and cancels a pending frame on unmount", () => {
    const { unmount } = renderProbe();
    const observer = ControlledResizeObserver.instances.at(-1);
    expect(frames.size).toBe(1);

    unmount();

    expect(observer?.disconnect).toHaveBeenCalledOnce();
    expect(cancelFrame).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
});
