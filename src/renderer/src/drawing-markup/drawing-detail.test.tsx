import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import type { PatentApi } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { createPatentSession } from "../patents/patent-reducer";
import { DrawingWorkspace } from "./drawing-workspace";

const calls = vi.hoisted(() => ({
  update: vi.fn(),
  prepare: vi.fn(),
  image: vi.fn(),
  render: vi.fn(),
}));
vi.mock("../patents/patent-context", () => ({
  usePatents: () => ({
    updatePatentFigures: calls.update,
    preparePatentSnapshot: calls.prepare,
  }),
}));
vi.mock("../app/application-close-coordinator", () => ({
  useApplicationCloseParticipant: () => {},
}));
vi.mock("./render", () => ({
  imageUrl: () => "data:image/png;base64,",
  pdfPreview: vi.fn(),
  renderDrawing: calls.render,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function open(
  defaultRatio = DEFAULT_APP_SETTINGS.drawingDetailDefaultRatio,
  annotationCount = 1,
  plainSource = false,
) {
  vi.clearAllMocks();
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "DOMPoint",
    class {
      constructor(
        public x: number,
        public y: number,
      ) {}
      matrixTransform() {
        return this;
      }
    },
  );
  SVGSVGElement.prototype.getScreenCTM = vi.fn(() => ({ inverse: () => ({}) })) as never;
  SVGSVGElement.prototype.setPointerCapture = vi.fn();
  SVGSVGElement.prototype.releasePointerCapture = vi.fn();
  URL.revokeObjectURL = vi.fn();
  SVGSVGElement.prototype.hasPointerCapture = vi.fn(() => false);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  window.patentApi = {
    settings: {
      read: async () => ({
        ok: true,
        value: { ...DEFAULT_APP_SETTINGS, drawingDetailDefaultRatio: defaultRatio },
      }),
    },
    assets: {
      readDrawingSource: async () => ({ ok: true, value: new Uint8Array() }),
      importMany: calls.image,
    },
  } as unknown as PatentApi;
  vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 800),
  );
  const patent = createBlankPatent({ patentType: "invention", name: "保存" });
  const assetId = "00000000-0000-4000-8000-000000000901";
  patent.drawingProjects = [{ ...drawingProjectFixture(assetId), detailViews: undefined }];
  if (plainSource) patent.drawingProjects[0]!.baseFragments = undefined;
  if (annotationCount !== 1) {
    const project = patent.drawingProjects[0]!;
    project.annotations = Array.from({ length: annotationCount }, (_, i) => ({
      ...project.annotations[0]!,
      id: `a${i + 1}`,
    }));
  }
  patent.assets = [
    {
      assetId,
      kind: "image",
      mediaType: "image/png",
      extension: "png",
      originalName: "drawing.png",
      byteLength: 1,
      sha256: "a".repeat(64),
      widthPx: 1000,
      heightPx: 800,
      previewByteLength: 1,
      previewSha256: "a".repeat(64),
    },
  ];
  const session = createPatentSession({
    patent,
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    saveState: "saved",
  });

  const mounted = render(<DrawingWorkspace session={session} active />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "局部放大" }).hasAttribute("disabled")).toBe(false),
  );
  return { ...mounted, session, canvas: screen.getByLabelText("CAD标号画布") };
}
function clickAt(canvas: Element, x: number, y: number) {
  fireEvent.pointerDown(canvas, { clientX: x, clientY: y, button: 0 });
  fireEvent.pointerUp(canvas, { clientX: x, clientY: y, button: 0 });
}
async function selectedDragTarget(kind: "annotation" | "detail") {
  const workspace = await open();
  const { canvas, container } = workspace;
  if (kind === "detail") {
    fireEvent.click(screen.getByRole("button", { name: "局部放大" }));
    clickAt(canvas, 300, 300);
    clickAt(canvas, 350, 300);
    clickAt(canvas, 200, 200);
    clickAt(canvas, 700, 300);
    fireEvent.keyDown(canvas, { key: "Escape" });
  }
  const target = container.querySelector(
    kind === "detail" ? '[data-detail-part="content"]' : '[data-annotation="a1"] text',
  );
  if (!target) throw new Error("Missing drag target");
  const start = kind === "detail" ? { x: 700, y: 300 } : { x: 200, y: 100 };
  clickAt(target, start.x, start.y);
  calls.update.mockClear();
  return { ...workspace, target, start };
}

test.each(["annotation", "detail"] as const)(
  "keeps a %s drag in its starting coordinate system when the canvas layout changes",
  async (kind) => {
    const { canvas, target, start } = await selectedDragTarget(kind);
    let inverse = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    SVGSVGElement.prototype.getScreenCTM = vi.fn(() => ({ inverse: () => inverse })) as never;
    vi.spyOn(DOMPoint.prototype, "matrixTransform").mockImplementation(function (
      this: DOMPoint,
      matrix = {},
    ) {
      return new DOMPoint(
        this.x * (matrix.a ?? 1) + this.y * (matrix.c ?? 0) + (matrix.e ?? 0),
        this.x * (matrix.b ?? 0) + this.y * (matrix.d ?? 1) + (matrix.f ?? 0),
      );
    });
    fireEvent.pointerDown(target, { clientX: start.x, clientY: start.y, button: 0 });
    inverse = { ...inverse, e: -50, f: -30 };
    fireEvent.pointerMove(canvas, { clientX: start.x + 50, clientY: start.y + 30, buttons: 1 });
    fireEvent.pointerUp(canvas, { clientX: start.x + 50, clientY: start.y + 30, button: 0 });
    expect(calls.update).toHaveBeenCalledTimes(1);
    const saved = calls.update.mock.lastCall?.[5][0];
    if (kind === "detail") expect(saved.detailViews[0].center).toEqual({ x: 750, y: 330 });
    else expect(saved.annotations[0].x).toBe(250);
    fireEvent.click(screen.getByRole("button", { name: "撤销标号编辑" }));
    const undone = calls.update.mock.lastCall?.[5][0];
    if (kind === "detail") expect(undone.detailViews[0].center).toEqual(start);
    else expect(undone.annotations[0].x).toBe(start.x);
    fireEvent.click(screen.getByRole("button", { name: "重做标号编辑" }));
    const redone = calls.update.mock.lastCall?.[5][0];
    if (kind === "detail") expect(redone.detailViews[0].center).toEqual({ x: 750, y: 330 });
    else expect(redone.annotations[0].x).toBe(250);
  },
);

test.each(["annotation", "detail"] as const)(
  "does not cancel a new %s drag for an old capture-loss event while capture is held",
  async (kind) => {
    const { canvas, target, start } = await selectedDragTarget(kind);
    SVGSVGElement.prototype.hasPointerCapture = vi.fn(() => true);
    fireEvent.pointerDown(target, { clientX: start.x, clientY: start.y, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: start.x + 50, clientY: start.y + 30, buttons: 1 });
    fireEvent.lostPointerCapture(canvas);
    fireEvent.pointerUp(canvas, { clientX: start.x + 50, clientY: start.y + 30, button: 0 });
    expect(calls.update).toHaveBeenCalledTimes(1);
  },
);

test.each(["pan", "annotation", "detail"] as const)(
  "commits a fast %s release when capture is lost before pointerup, including its final sample",
  async (kind) => {
    const workspace =
      kind === "pan"
        ? await open().then((result) => ({
            ...result,
            target: result.canvas,
            start: { x: 400, y: 400 },
          }))
        : await selectedDragTarget(kind);
    const { canvas, container, target, start } = workspace;
    SVGSVGElement.prototype.getScreenCTM = vi.fn(() => ({
      inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    })) as never;
    const beforeView = canvas.getAttribute("viewBox")?.split(" ").map(Number) ?? [];
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    calls.update.mockClear();
    const button = kind === "pan" ? 1 : 0;
    fireEvent.pointerDown(target, { clientX: start.x, clientY: start.y, button });
    fireEvent.pointerMove(canvas, {
      clientX: start.x + 40,
      clientY: start.y + 20,
      buttons: kind === "pan" ? 4 : 1,
    });
    fireEvent.lostPointerCapture(canvas, {
      clientX: start.x + 50,
      clientY: start.y + 30,
      button: -1,
      buttons: 0,
    });
    const assertFinal = () => {
      if (kind === "pan") {
        const nextView = canvas.getAttribute("viewBox")?.split(" ").map(Number) ?? [];
        expect(nextView[0]).toBe((beforeView[0] ?? 0) - 50);
        expect(nextView[1]).toBe((beforeView[1] ?? 0) - 30);
        expect(nextView.slice(2)).toEqual(beforeView.slice(2));
        expect(calls.update).not.toHaveBeenCalled();
      } else {
        expect(calls.update).toHaveBeenCalledTimes(1);
        const saved = calls.update.mock.lastCall?.[5][0];
        if (kind === "detail") expect(saved.detailViews[0].center).toEqual({ x: 750, y: 330 });
        else expect(saved.annotations[0].x).toBe(250);
      }
    };
    assertFinal();
    fireEvent.pointerMove(canvas, { clientX: start.x + 50, clientY: start.y + 30, buttons: 0 });
    fireEvent.pointerUp(canvas, { clientX: start.x + 50, clientY: start.y + 30, button });
    for (const frame of frames.splice(0)) frame(0);
    assertFinal();
    expect(container.querySelector('[data-panning="true"]')).toBeNull();
    if (kind !== "pan") {
      fireEvent.click(screen.getByRole("button", { name: "撤销标号编辑" }));
      const undone = calls.update.mock.lastCall?.[5][0];
      if (kind === "detail") expect(undone.detailViews[0].center).toEqual(start);
      else expect(undone.annotations[0].x).toBe(start.x);
      fireEvent.click(screen.getByRole("button", { name: "重做标号编辑" }));
      const redone = calls.update.mock.lastCall?.[5][0];
      if (kind === "detail") expect(redone.detailViews[0].center).toEqual({ x: 750, y: 330 });
      else expect(redone.annotations[0].x).toBe(250);
    }
  },
);

test.each([
  ["annotation", "Escape"],
  ["annotation", "pointerCancel"],
  ["annotation", "lostPointerCapture"],
  ["detail", "Escape"],
  ["detail", "pointerCancel"],
  ["detail", "lostPointerCapture"],
] as const)("still restores a %s drag on genuine %s cancellation", async (kind, cancellation) => {
  const { canvas, container, target, start } = await selectedDragTarget(kind);
  const attribute = kind === "detail" ? "cx" : "x";
  const before = target.getAttribute(attribute);
  fireEvent.pointerDown(target, { clientX: start.x, clientY: start.y, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: start.x + 50, clientY: start.y + 30, buttons: 1 });
  await waitFor(() => {
    const liveTarget = kind === "detail" ? target : container.querySelector("[data-label-drag-preview] text");
    expect(liveTarget).not.toBeNull();
    expect(liveTarget?.getAttribute(attribute)).not.toBe(before);
  });
  if (cancellation === "Escape") fireEvent.keyDown(canvas, { key: "Escape" });
  else if (cancellation === "pointerCancel") fireEvent.pointerCancel(canvas);
  else fireEvent.lostPointerCapture(canvas, { buttons: 1 });
  const restored = kind === "detail" ? target : container.querySelector('[data-annotation="a1"] text');
  expect(restored).not.toBeNull();
  expect(restored?.getAttribute(attribute)).toBe(before);
  expect(container.querySelector("[data-label-drag-preview]")).toBeNull();
  fireEvent.pointerUp(canvas, { clientX: start.x + 50, clientY: start.y + 30, button: 0 });
  expect(calls.update).not.toHaveBeenCalled();
});
test("placing a label at the project limit reports failure without changing saved data or undo", async () => {
  const { canvas } = await open(2, 5000);
  calls.update.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "标号" }));
  clickAt(canvas, 600, 600);
  clickAt(canvas, 700, 700);
  expect(screen.getByText("标号数量已达上限，无法继续添加。")).toBeDefined();
  expect(calls.update).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "撤销标号编辑" }).hasAttribute("disabled")).toBe(true);
}, 20000);

test("a plain image viewport does not render a stray zero from an empty detail list", async () => {
  const { container } = await open(2, 1, true);
  const viewport = container.querySelector(".drawing-viewport")!;
  expect(
    [...viewport.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(""),
  ).toBe("");
});

test.each(["darwin", "openharmony", "ohos"])("%s right-click cancel keeps undo routed to the canvas after the placement input unmounts", async (platform) => {
  const { canvas, container } = await open();
  vi.stubGlobal("documentFontPlatform", platform);
  (canvas as unknown as SVGSVGElement).getScreenCTM = vi.fn(() => ({
    inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  })) as never;
  fireEvent.click(screen.getByRole("button", { name: "标号" }));
  clickAt(canvas, 100, 200);
  clickAt(canvas, 500, 300);
  expect(container.querySelectorAll("[data-annotation]")).toHaveLength(2);
  clickAt(canvas, 300, 400);
  fireEvent.pointerMove(canvas, { clientX: 600, clientY: 400 });
  fireEvent.pointerDown(canvas, { clientX: 600, clientY: 400, button: 2 });
  fireEvent.contextMenu(canvas);
  fireEvent.pointerUp(canvas, { clientX: 600, clientY: 400, button: 2 });
  expect(container.querySelector('[data-drawing-preview="label"]')).toBeNull();
  expect(document.activeElement).toBe(canvas);
  fireEvent.keyDown(document.activeElement!, { key: "z", ctrlKey: true });
  expect(container.querySelectorAll("[data-annotation]")).toHaveLength(1);
});

test("starting a crop preserves the label draft committed by canvas focus", async () => {
  const { canvas, container } = await open();
  clickAt(container.querySelector('[data-annotation="a1"] text')!, 200, 100);
  const input = screen.getByLabelText("标号内容");
  (input as HTMLInputElement).focus();
  fireEvent.change(input, { target: { value: "42" } });
  fireEvent.pointerDown(canvas, { clientX: 500, clientY: 400, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 800, clientY: 600, buttons: 1 });
  fireEvent.pointerUp(canvas, { clientX: 800, clientY: 600, button: 0 });
  expect(calls.update.mock.lastCall![5][0].annotations[0].text).toBe("42");
  expect(container.querySelector('[data-annotation="a1"] text')?.textContent).toBe("42");
});

test("failed preview keeps Escape available for cancelling the crop", async () => {
  const { canvas, container } = await open();
  rectangle(canvas, 50, 50, 450, 350);
  calls.render.mockRejectedValueOnce(new Error("成图失败"));
  const preview = screen.getByRole("button", { name: "预览成图" });
  preview.focus();
  fireEvent.click(preview);
  await screen.findByText("成图失败");
  expect(document.activeElement).toBe(canvas);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(container.querySelector("[data-region-outline]")).toBeNull();
});

test("crop handles all have generous invisible hit targets and the interior stays uncovered", async () => {
  const { canvas, container } = await open();
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 500, clientY: 500, buttons: 1 });
  fireEvent.pointerUp(canvas, { clientX: 500, clientY: 500, button: 0 });
  const targets = container.querySelectorAll('[data-region-handle][fill="transparent"]');
  expect(targets).toHaveLength(8);
  const edge = container.querySelector("[data-region-move]");
  expect(edge?.getAttribute("fill")).toBe("none");
  expect(edge?.getAttribute("pointer-events")).toBe("stroke");
  const edgeWidth = Number(edge?.getAttribute("stroke-width"));
  for (const target of targets) {
    expect(Number(target.getAttribute("r"))).toBeCloseTo(edgeWidth / 2);
  }
});
test.each(["Escape", "pointerCancel"])(
  "canceling crop content resize restores geometry: %s",
  async (cancel) => {
    const { canvas, container } = await open();
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: 500, clientY: 500, buttons: 1 });
    fireEvent.pointerUp(canvas, { clientX: 500, clientY: 500, button: 0 });
    const outline = () => container.querySelector("[data-region-outline]")?.getAttribute("points");
    const before = outline();
    const saved = structuredClone(calls.update.mock.lastCall![5][0]);
    calls.update.mockClear();
    fireEvent.pointerDown(container.querySelector('[data-region-handle="ne"]')!, {
      clientX: 500,
      clientY: 100,
      button: 0,
    });
    fireEvent.pointerMove(canvas, { clientX: 700, clientY: 50, buttons: 1 });
    await waitFor(() => expect(outline()).not.toBe(before));
    if (cancel === "Escape") fireEvent.keyDown(canvas, { key: "Escape" });
    else fireEvent.pointerCancel(canvas);
    if (cancel === "pointerCancel") expect(outline()).toBe(before);
    expect(calls.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "标号" }));
    clickAt(canvas, 600, 600);
    clickAt(canvas, 700, 700);
    const after = calls.update.mock.lastCall![5][0];
    expect(after.baseFragments).toEqual(saved.baseFragments);
    expect(after.annotations.slice(0, -1)).toEqual(saved.annotations);
  },
);

test("repeated annotation drags respect the 100-entry undo limit", async () => {
  const { canvas, container } = await open();
  clickAt(container.querySelector('[data-annotation="a1"] text')!, 200, 100);
  for (let i = 0; i < 101; i++) {
    const x = 200 + i * 10;
    fireEvent.pointerDown(container.querySelector('[data-annotation="a1"] text')!, {
      clientX: x,
      clientY: 100,
      button: 0,
    });
    fireEvent.pointerMove(canvas, { clientX: x + 10, clientY: 100, buttons: 1 });
    fireEvent.pointerUp(canvas, { clientX: x + 10, clientY: 100, button: 0 });
  }
  const undo = screen.getByRole("button", { name: "撤销标号编辑" });
  for (let i = 0; i < 100; i++) fireEvent.click(undo);
  expect(undo.hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "重做标号编辑" }).hasAttribute("disabled")).toBe(false);
}, 20000);

test("label clicks tolerate five pixel jitter and Escape cancels pending placement", async () => {
  const { canvas, session } = await open();
  fireEvent.click(screen.getByRole("button", { name: "标号" }));
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 105, clientY: 100, buttons: 1 });
  fireEvent.pointerUp(canvas, { clientX: 105, clientY: 100, button: 0 });
  expect(calls.update).not.toHaveBeenCalled();
  fireEvent.pointerDown(canvas, { clientX: 200, clientY: 200, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 205, clientY: 200, buttons: 1 });
  fireEvent.pointerUp(canvas, { clientX: 205, clientY: 200, button: 0 });
  expect(calls.update.mock.lastCall![5][0].annotations).toHaveLength(
    session.patent.drawingProjects![0]!.annotations.length + 1,
  );
  calls.update.mockClear();
  clickAt(canvas, 300, 300);
  fireEvent.keyDown(canvas, { key: "Escape" });
  clickAt(canvas, 400, 400);
  expect(calls.update).not.toHaveBeenCalled();
});

test.each(["pointerup", "lostpointercapture"] as const)(
  "%s hover cannot resurrect a completed two-click label placement",
  async (release) => {
    const { canvas, container } = await open(2, 0);
    fireEvent.click(screen.getByRole("button", { name: "标号" }));
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const ghost = () => container.querySelector('[data-drawing-preview="label"]');
    for (let i = 0; i < 3; i++) {
      clickAt(canvas, 100, 100);
      expect(ghost()).not.toBeNull();
      expect(calls.update).toHaveBeenCalledTimes(i);
      fireEvent.pointerDown(canvas, { clientX: 200, clientY: 200, button: 0 });
      // Native capture loss and the release-time move can arrive before React
      // publishes the cleared preview; the queued hover must respect that clear.
      act(() => {
        fireEvent.pointerMove(canvas, { clientX: 205, clientY: 205, buttons: 1 });
        fireEvent[release === "pointerup" ? "pointerUp" : "lostPointerCapture"](canvas, {
          clientX: 205,
          clientY: 205,
          button: release === "pointerup" ? 0 : -1,
          buttons: 0,
        });
        fireEvent.pointerMove(canvas, { clientX: 206, clientY: 206, buttons: 0 });
        for (const frame of frames.splice(0)) frame(0);
        fireEvent.pointerUp(canvas, { clientX: 206, clientY: 206, button: 0 });
      });
      expect(calls.update).toHaveBeenCalledTimes(i + 1);
      expect(calls.update.mock.lastCall?.[5][0].annotations).toHaveLength(i + 1);
      expect(calls.update.mock.lastCall?.[5][0].annotations.at(-1).text).toBe(String(i + 1));
      expect(ghost()).toBeNull();
    }
  },
);

test.each([
  [14, 300, true, false],
  [15, 199, true, false],
  [100, 199, true, false],
  [15, 200, true, true],
  [15, 200, false, true],
] as const)(
  "label drag distance %s duration %s move %s commits %s",
  async (distance, duration, move, commits) => {
    const { canvas } = await open();
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    fireEvent.click(screen.getByRole("button", { name: "标号" }));
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
    now.mockReturnValue(1000 + duration);
    if (move) fireEvent.pointerMove(canvas, { clientX: 100 + distance, clientY: 100, buttons: 1 });
    fireEvent.pointerUp(canvas, { clientX: 100 + distance, clientY: 100, button: 0 });
    expect(calls.update).toHaveBeenCalledTimes(commits ? 1 : 0);
    if (!commits) {
      clickAt(canvas, 300, 300);
      expect(calls.update).toHaveBeenCalledTimes(1);
    }
  },
);
test("four clicks create one undoable detail, preserve title independence, and cancel unfinished views", async () => {
  const { canvas, container } = await open();
  fireEvent.click(screen.getByRole("button", { name: "局部放大" }));
  clickAt(canvas, 300, 300);
  fireEvent.pointerMove(canvas, { clientX: 350, clientY: 300 });
  await waitFor(() =>
    expect(container.querySelector("[data-detail-radius-ghost]")?.getAttribute("r")).toBe("50"),
  );
  expect(calls.update).not.toHaveBeenCalled();
  clickAt(canvas, 350, 300);
  fireEvent.pointerMove(canvas, { clientX: 200, clientY: 200 });
  expect(
    container.querySelector('[data-detail="pending-detail"] [data-detail-part="marker"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('[data-detail="pending-detail"] [data-detail-part="content"]'),
  ).toBeNull();
  expect(container.querySelector('[data-detail-image="pending-detail"]')).toBeNull();
  expect(calls.update).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      Number(
        container
          .querySelector('[data-detail="pending-detail"] [data-detail-part="marker"] text')!
          .getAttribute("y"),
      ),
    ).toBeLessThan(200),
  );
  const markerY = Number(
    container
      .querySelector('[data-detail="pending-detail"] [data-detail-part="marker"] text')!
      .getAttribute("y"),
  );
  expect(markerY).toBeLessThan(200);
  clickAt(canvas, 200, 200);
  fireEvent.pointerMove(canvas, { clientX: 700, clientY: 300 });
  expect(container.querySelector('[data-detail="pending-detail"]')).not.toBeNull();
  expect(calls.update).not.toHaveBeenCalled();
  clickAt(canvas, 700, 300);
  fireEvent.keyDown(canvas, { key: "Escape" });
  clickAt(container.querySelector('[data-detail-part="content"]')!, 700, 300);
  const saved = calls.update.mock.lastCall![5][0];
  expect(saved.detailViews).toHaveLength(1);
  expect(saved.detailViews[0]).toMatchObject({
    label: "A",
    ratio: 2,
    radius: 50,
    center: { x: 700, y: 300 },
    marker: { x: 200, y: markerY },
  });
  const circle = container.querySelector('[data-detail-part="content"]')!;
  fireEvent.pointerDown(circle, { clientX: 700, clientY: 300, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 750, clientY: 330, buttons: 1 });
  fireEvent.pointerUp(canvas, { clientX: 750, clientY: 330, button: 0 });
  expect(calls.update.mock.lastCall![5][0].detailViews[0].center).toEqual({ x: 750, y: 330 });
  expect(calls.update.mock.lastCall![5][0].detailViews[0].title).toEqual(
    saved.detailViews[0].title,
  );
  fireEvent.click(screen.getByRole("button", { name: "放大局部图" }));
  expect(calls.update.mock.lastCall![5][0].detailViews[0].ratio).toBe(2.5);
  fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
  expect(calls.update.mock.lastCall![5][0].detailViews[0].ratio).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "局部放大" }));
  expect((screen.getByLabelText("局部放大字母") as HTMLInputElement).value).toBe("B");
  clickAt(canvas, 100, 100);
  fireEvent.keyDown(canvas, { key: "Escape" });
  expect(container.querySelector("[data-detail-radius-ghost]")).toBeNull();
  expect(canvas.getAttribute("data-tool")).toBe("select");
});
test("detail label and ratio persist on flush and copied view waits for placement", async () => {
  const { canvas, container } = await open();
  fireEvent.click(screen.getByRole("button", { name: "局部放大" }));
  clickAt(canvas, 300, 300);
  clickAt(canvas, 350, 300);
  clickAt(canvas, 200, 200);
  clickAt(canvas, 700, 300);
  fireEvent.keyDown(canvas, { key: "Escape" });
  clickAt(container.querySelector('[data-detail-part="content"]')!, 700, 300);
  fireEvent.change(screen.getByLabelText("局部放大字母"), { target: { value: "X" } });
  fireEvent.blur(screen.getByLabelText("局部放大字母"));
  expect(calls.update.mock.lastCall![5][0].detailViews[0].label).toBe("X");
  fireEvent.keyDown(canvas, { key: "c", ctrlKey: true });
  fireEvent.keyDown(canvas, { key: "v", ctrlKey: true });
  expect(calls.update.mock.lastCall![5][0].detailViews).toHaveLength(1);
  fireEvent.pointerMove(canvas, { clientX: 800, clientY: 600 });
  clickAt(canvas, 800, 600);
  expect(calls.update.mock.lastCall![5][0].detailViews).toHaveLength(2);
  expect(calls.update.mock.lastCall![5][0].detailViews[1]).toMatchObject({
    label: "Y",
    center: { x: 800, y: 600 },
  });
  fireEvent.keyDown(canvas, { key: "Delete" });
  expect(calls.update.mock.lastCall![5][0].detailViews).toHaveLength(1);
  expect(container.querySelectorAll("[data-detail-part=content]")).toHaveLength(1);
});

test.each(["circle", "polyline", "text"])(
  "dragging source %s moves the letter, keeping source and enlarged circle fixed",
  async (element) => {
    const { canvas, container } = await open();
    fireEvent.click(screen.getByRole("button", { name: "局部放大" }));
    clickAt(canvas, 300, 300);
    clickAt(canvas, 350, 300);
    clickAt(canvas, 200, 200);
    clickAt(canvas, 700, 300);
    fireEvent.keyDown(canvas, { key: "Escape" });
    clickAt(container.querySelector('[data-detail-part="content"]')!, 700, 300);
    const before = structuredClone(calls.update.mock.lastCall![5][0].detailViews[0]);
    const target = container.querySelector(`[data-detail-part="marker"] ${element}`)!;
    clickAt(target, 200, 200);
    fireEvent.pointerDown(target, { clientX: 280, clientY: 270, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: 240, clientY: 220, buttons: 1 });
    fireEvent.pointerUp(canvas, { clientX: 240, clientY: 220, button: 0 });
    const after = calls.update.mock.lastCall![5][0].detailViews[0];
    expect(after.marker.x).toBe(240);
    expect(after.marker.y + after.fontSize * 0.55).toBeLessThan(220);
    expect(after.source).toEqual(before.source);
    expect(after.radius).toBe(before.radius);
    expect(after.center).toEqual(before.center);
    expect(after.ratio).toBe(before.ratio);
    fireEvent.change(screen.getByLabelText("局部放大字母"), { target: { value: "B" } });
    fireEvent.blur(screen.getByLabelText("局部放大字母"));
    expect(container.querySelector('[data-detail-part="marker"] text')?.textContent).toBe("B");
    expect(container.querySelector('[data-detail-part="title"] text')?.textContent).toBe("B");
  },
);
test.each(["Escape", "right-click"])(
  "cancels the leader ghost without saving (%s)",
  async (cancel) => {
    const { canvas, container } = await open();
    fireEvent.click(screen.getByRole("button", { name: "局部放大" }));
    clickAt(canvas, 300, 300);
    clickAt(canvas, 350, 300);
    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 200 });
    if (cancel === "Escape") fireEvent.keyDown(canvas, { key: "Escape" });
    else fireEvent.contextMenu(canvas);
    expect(container.querySelector('[data-detail="pending-detail"]')).toBeNull();
    expect(calls.update).not.toHaveBeenCalled();
  },
);

test("dragging a selected numeric leader carries its anchor and keeps text above pointer", async () => {
  const { canvas, container } = await open();
  const line = container.querySelector('[data-annotation="a1"] polyline')!;
  clickAt(line, 130, 160);
  fireEvent.pointerDown(line, { clientX: 130, clientY: 160, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 300, clientY: 300, buttons: 1 });
  fireEvent.pointerUp(canvas, { clientX: 300, clientY: 300, button: 0 });
  const a = calls.update.mock.lastCall![5][0].annotations[0];
  expect(a.x).toBe(300);
  expect(a.y + a.fontSize * 0.55).toBeLessThan(300);
  expect(a.points[0]).toEqual({ x: 200, y: 200 + a.y - 100 });
});

test("detail caption and completed input use one decimal while saved geometry retains full precision", async () => {
  const { canvas, container } = await open();
  fireEvent.click(screen.getByRole("button", { name: "局部放大" }));
  clickAt(canvas, 300, 300);
  clickAt(canvas, 350, 300);
  clickAt(canvas, 200, 200);
  clickAt(canvas, 700, 300);
  fireEvent.keyDown(canvas, { key: "Escape" });
  clickAt(container.querySelector('[data-detail-part="content"]')!, 700, 300);
  const input = screen.getByLabelText("局部放大比例");
  fireEvent.change(input, { target: { value: "2.34567:1" } });
  fireEvent.blur(input);
  expect(calls.update.mock.lastCall![5][0].detailViews[0].ratio).toBe(2.34567);
  expect((input as HTMLInputElement).value).toBe("2.3:1");
  expect(container.querySelector('[data-detail-part="title"]')?.textContent).toContain("2.3:1");
  fireEvent.blur(input);
  expect(calls.update.mock.lastCall![5][0].detailViews[0].ratio).toBe(2.34567);
});

test("opens detail settings with the 2:1 default and saves a custom ratio", async () => {
  await open();
  const updateSettings = vi.fn(async () => ({ ok: true as const, value: DEFAULT_APP_SETTINGS }));
  window.patentApi.settings.update = updateSettings;
  fireEvent.click(screen.getByRole("button", { name: "局部放大" }));
  expect((screen.getByLabelText("局部放大比例") as HTMLInputElement).value).toBe("2:1");
  const settings = screen.getByLabelText("局部放大设置");
  fireEvent.click(settings);
  expect(settings.closest("details")?.open).toBe(true);
  const defaultRatio = screen.getByLabelText("默认放大比例");
  expect((defaultRatio as HTMLInputElement).value).toBe("2:1");
  fireEvent.change(defaultRatio, { target: { value: "3:1" } });
  fireEvent.click(screen.getByRole("button", { name: "保存为默认" }));
  await waitFor(() =>
    expect(updateSettings).toHaveBeenCalledWith({ drawingDetailDefaultRatio: 3 }),
  );
  expect((screen.getByLabelText("局部放大比例") as HTMLInputElement).value).toBe("3:1");
});

test("continues creating details with the configured default rather than the last ratio", async () => {
  const { canvas, container } = await open(1);
  fireEvent.click(screen.getByRole("button", { name: "局部放大" }));
  expect((screen.getByLabelText("局部放大比例") as HTMLInputElement).value).toBe("1:1");
  fireEvent.change(screen.getByLabelText("局部放大比例"), { target: { value: "3:1" } });
  clickAt(canvas, 300, 300);
  clickAt(canvas, 350, 300);
  clickAt(canvas, 200, 200);
  clickAt(canvas, 700, 300);
  expect(canvas.getAttribute("data-tool")).toBe("detail");
  expect((screen.getByLabelText("局部放大字母") as HTMLInputElement).value).toBe("B");
  expect((screen.getByLabelText("局部放大比例") as HTMLInputElement).value).toBe("1:1");
  clickAt(canvas, 100, 100);
  clickAt(canvas, 120, 100);
  clickAt(canvas, 70, 70);
  clickAt(canvas, 500, 500);
  expect(
    calls.update.mock.lastCall![5][0].detailViews.map((d: { ratio: number }) => d.ratio),
  ).toEqual([3, 1]);
  fireEvent.keyDown(canvas, { key: "Escape" });
  clickAt(container.querySelector('[data-detail-part="content"]')!, 700, 300);
  expect(screen.queryByRole("button", { name: "删除局部放大图" })).toBeNull();
  expect(screen.getByRole("button", { name: "放大局部图" }).textContent).toBe("");
});

test("detail source marks reuse crop warnings and crossing selection expands only on release", async () => {
  const { canvas, container } = await open(1);
  fireEvent.click(screen.getByRole("button", { name: "局部放大" }));
  clickAt(canvas, 300, 300);
  clickAt(canvas, 350, 300);
  clickAt(canvas, 200, 200);
  clickAt(canvas, 700, 300);
  fireEvent.keyDown(canvas, { key: "Escape" });
  fireEvent.pointerDown(canvas, { clientX: 185, clientY: 175, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 215, clientY: 205, buttons: 1 });
  fireEvent.pointerUp(canvas, { clientX: 215, clientY: 205, button: 0 });
  const marker = container.querySelector('[data-detail-part="marker"]')!;
  expect(marker.querySelector("text")?.getAttribute("fill")).toBe("#e00000");
  expect(
    marker.querySelector("polyline:not([data-detail-leader-hit])")?.getAttribute("stroke"),
  ).toBe("#e00000");
  fireEvent.keyDown(canvas, { key: "Escape" });
  fireEvent.pointerDown(canvas, { clientX: 245, clientY: 245, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 185, clientY: 175, buttons: 1 });
  await waitFor(() => expect(marker.querySelector("text")?.getAttribute("fill")).toBe("#007AFF"));
  expect(
    marker.querySelector("polyline:not([data-detail-leader-hit])")?.getAttribute("stroke"),
  ).toBe("#007AFF");
  const preview = container
    .querySelector('[data-drawing-preview="range"]')!
    .getAttribute("points")!;
  expect(
    Math.max(
      ...preview
        .trim()
        .split(/\s+/)
        .map((p) => Number(p.split(",")[0])),
    ),
  ).toBe(245);
  fireEvent.pointerUp(canvas, { clientX: 185, clientY: 175, button: 0 });
  const outline = container.querySelector("[data-region-outline]")!.getAttribute("points")!;
  expect(
    Math.max(
      ...outline
        .trim()
        .split(/\s+/)
        .map((p) => Number(p.split(",")[0])),
    ),
  ).toBeGreaterThan(245);
  expect(marker.querySelector("text")?.getAttribute("fill")).toBe("#007AFF");
});

async function detail() {
  const opened = await open(1);
  const { canvas } = opened;
  fireEvent.click(screen.getByRole("button", { name: "局部放大" }));
  clickAt(canvas, 300, 300);
  clickAt(canvas, 350, 300);
  clickAt(canvas, 200, 200);
  clickAt(canvas, 700, 300);
  fireEvent.keyDown(canvas, { key: "Escape" });
  return opened;
}
function rectangle(canvas: Element, x1: number, y1: number, x2: number, y2: number, ctrl = false) {
  fireEvent.pointerDown(canvas, { clientX: x1, clientY: y1, button: 0, ctrlKey: ctrl });
  fireEvent.pointerMove(canvas, { clientX: x2, clientY: y2, buttons: 1, ctrlKey: ctrl });
  fireEvent.pointerUp(canvas, { clientX: x2, clientY: y2, button: 0, ctrlKey: ctrl });
}
test("crop selection keeps its actions without the legacy rotation controls", async () => {
  const { canvas } = await open();
  rectangle(canvas, 50, 50, 450, 350);
  expect(screen.getByLabelText("选区标号字号")).toBeTruthy();
  expect(screen.getByRole("button", { name: "复制选区" })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "选区旋转" })).toBeNull();
  expect(screen.queryByLabelText("旋转角度")).toBeNull();
});

test("copying a range containing an enlarged view includes that view", async () => {
  const { canvas, container } = await detail();
  rectangle(canvas, 620, 200, 780, 380);
  fireEvent.keyDown(canvas, { key: "c", ctrlKey: true });
  fireEvent.keyDown(canvas, { key: "v", ctrlKey: true });
  fireEvent.pointerMove(canvas, { clientX: 500, clientY: 600 });
  clickAt(canvas, 500, 600);
  expect(calls.update.mock.lastCall![5][0].detailViews).toHaveLength(2);
});
test("moving a range containing an enlarged view moves that view", async () => {
  const { canvas } = await detail();
  rectangle(canvas, 620, 200, 780, 380);
  const previous = calls.update.mock.lastCall![5][0];
  const previousCenter = { ...previous.detailViews[0].center };
  const clone = vi.spyOn(globalThis, "structuredClone");
  fireEvent.pointerDown(canvas, { clientX: 650, clientY: 230, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 750, clientY: 330, buttons: 1 });
  fireEvent.pointerUp(canvas, { clientX: 750, clientY: 330, button: 0 });
  expect(calls.update.mock.lastCall![5][0].detailViews[0].center).toEqual({ x: 800, y: 400 });
  expect(previous.detailViews[0].center).toEqual(previousCenter);
  // Immutable gesture/history references preserve the previous drawing without a full clone.
  expect(clone.mock.calls.filter(([value]) => !Array.isArray(value))).toHaveLength(0);
});
test("ctrl box can select the letter and leader for batch operations", async () => {
  const { canvas, container } = await detail();
  rectangle(canvas, 170, 170, 350, 320, true);
  expect(container.querySelector('[data-detail-part="marker"] text')?.getAttribute("fill")).toBe(
    "#007AFF",
  );
});
test("crop cutting the enlarged caption raises a warning", async () => {
  const { canvas, container } = await detail();
  rectangle(canvas, 690, 210, 705, 219);
  expect(screen.queryByText(/标号或引出线可能被裁切/)).not.toBeNull();
  expect(container.querySelector('[data-detail-part="title"]')?.getAttribute("fill")).toBe(
    "#e00000",
  );
});
test.each(["release", "cancel"])(
  "live pan moves the complete detail clip without translating its children twice: %s",
  async (finish) => {
    const { canvas, container } = await detail();
    SVGSVGElement.prototype.getScreenCTM = vi.fn(() => ({
      inverse: () => ({ a: 1, b: 0, c: 0, d: 1 }),
    })) as never;
    const image = container.querySelector<HTMLElement>("[data-detail-image]")!;
    const surface = image.closest<HTMLElement>("[data-pan-preview-surface]")!;
    calls.update.mockClear();
    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 400, button: 1 });
    fireEvent.pointerMove(canvas, { clientX: 480, clientY: 440, buttons: 4 });
    expect(surface.style.transform).toBe("translate3d(80px, 40px, 0)");
    expect(image.style.transform).toBe("");
    for (const child of image.querySelectorAll<HTMLElement>("[data-base-fragments] > *")) {
      expect(child.style.transform).not.toContain("translate3d");
    }
    if (finish === "release")
      fireEvent.pointerUp(canvas, { clientX: 480, clientY: 440, button: 1 });
    else fireEvent.pointerCancel(canvas);
    expect(image.style.transform).toBe("");
    expect(surface.style.transform).toBe("");
    expect(calls.update).not.toHaveBeenCalled();
  },
);

test("one font slider gesture is one undo step", async () => {
  const { canvas, container } = await detail();
  clickAt(container.querySelector('[data-detail-part="content"]')!, 700, 300);
  const slider = screen.getByRole("slider", { name: "标号字号" });
  fireEvent.pointerDown(slider, { button: 0 });
  fireEvent.change(slider, { target: { value: "18" } });
  fireEvent.change(slider, { target: { value: "24" } });
  fireEvent.pointerUp(slider, { button: 0 });
  fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
  expect(calls.update.mock.lastCall![5][0].detailViews[0].fontSize).toBe(12);
  fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
  expect(calls.update.mock.lastCall![5][0].detailViews ?? []).toHaveLength(0);
});

test("undoing from a selected label slider keeps keyboard redo inside the drawing", async () => {
  const { canvas, container } = await open();
  const originalSize = container
    .querySelector('[data-annotation="a1"] text')
    ?.getAttribute("font-size");
  clickAt(container.querySelector('[data-annotation="a1"] text')!, 200, 100);
  const slider = screen.getByRole("slider", { name: "标号字号" });
  slider.focus();
  fireEvent.pointerDown(slider, { button: 0 });
  fireEvent.change(slider, { target: { value: "24" } });
  fireEvent.pointerUp(slider, { button: 0 });
  fireEvent.keyDown(slider, { key: "z", ctrlKey: true });
  expect(container.querySelector('[data-annotation="a1"] text')?.getAttribute("font-size")).toBe(
    originalSize,
  );
  expect(document.activeElement).toBe(canvas);
  fireEvent.keyDown(document.activeElement!, { key: "y", ctrlKey: true });
  expect(container.querySelector('[data-annotation="a1"] text')?.getAttribute("font-size")).toBe(
    "24",
  );
});

test("batch letters move, copy as independent markers, delete and undo without losing the view", async () => {
  const { canvas, container } = await detail();
  clickAt(container.querySelector('[data-detail-part="content"]')!, 700, 300);
  rectangle(canvas, 170, 170, 350, 320, true);
  const marker = container.querySelector('[data-detail-part="marker"] text')!;
  fireEvent.pointerDown(marker, { clientX: 200, clientY: 185, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 240, clientY: 205, buttons: 1 });
  fireEvent.pointerUp(canvas, { clientX: 240, clientY: 205, button: 0 });
  let saved = calls.update.mock.lastCall![5][0];
  expect(saved.detailViews[0].marker.x).toBe(240);
  expect(saved.detailViews[0].center).toEqual({ x: 700, y: 300 });
  fireEvent.keyDown(canvas, { key: "c", ctrlKey: true });
  fireEvent.keyDown(canvas, { key: "v", ctrlKey: true });
  expect(container.querySelector('[data-detail="pending-detail"]')).toBeNull();
  clickAt(canvas, 500, 600);
  saved = calls.update.mock.lastCall![5][0];
  expect(saved.detailViews).toHaveLength(1);
  expect(saved.annotations.some((a: { text: string }) => a.text === "A")).toBe(true);
  fireEvent.keyDown(canvas, { key: "Escape" });
  rectangle(canvas, 170, 170, 350, 320, true);
  fireEvent.keyDown(canvas, { key: "Delete" });
  saved = calls.update.mock.lastCall![5][0];
  expect(saved.detailViews).toHaveLength(1);
  expect(saved.detailViews[0].markerHidden).toBe(true);
  expect(container.querySelector('[data-detail-part="marker"]')).toBeNull();
  fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
  expect(container.querySelector('[data-detail-part="marker"]')).not.toBeNull();
});

test("copying the complete detail keeps one linked letter and its snapshot geometry", async () => {
  const { canvas, container } = await detail();
  rectangle(canvas, 140, 140, 780, 380);
  fireEvent.keyDown(canvas, { key: "c", ctrlKey: true });
  fireEvent.keyDown(canvas, { key: "v", ctrlKey: true });
  fireEvent.pointerMove(canvas, { clientX: 500, clientY: 600 });
  expect(container.querySelectorAll("[data-detail-image]")).toHaveLength(2);
  clickAt(canvas, 500, 600);
  const saved = calls.update.mock.lastCall![5][0];
  const [a, b] = saved.detailViews;
  expect(b.markerHidden).toBe(false);
  expect(b.label).not.toBe(a.label);
  expect(saved.annotations.filter((a: { text: string }) => a.text === "A")).toHaveLength(0);
  expect(b.source.x - b.fragments[0].offset.x).toBeCloseTo(a.source.x - a.fragments[0].offset.x);
  fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
  expect(calls.update.mock.lastCall![5][0].detailViews).toHaveLength(1);
  fireEvent.keyDown(canvas, { key: "y", ctrlKey: true });
  expect(calls.update.mock.lastCall![5][0].detailViews).toHaveLength(2);
});

test("switching from a crop to detail clears the crop and keeps its letter ready to type", async () => {
  const { canvas, container } = await open();
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 500, clientY: 500, buttons: 1 });
  fireEvent.pointerUp(canvas, { clientX: 500, clientY: 500, button: 0 });
  expect(container.querySelector("[data-region-outline]")).not.toBeNull();
  const handle = container.querySelector('[data-region-handle="ne"]');
  expect(handle?.getAttribute("fill")).toBe("transparent");
  fireEvent.click(screen.getByRole("button", { name: "局部放大" }));
  expect(container.querySelector("[data-region-outline]")).toBeNull();
  const input = screen.getByRole("textbox", { name: "局部放大字母" }) as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  expect(input.selectionEnd).toBe(input.value.length);
  fireEvent.change(input, { target: { value: "XY" } });
  clickAt(canvas, 300, 300);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("XY");
});

test("deleting a selected detail title preserves the image and marker and can be undone", async () => {
  const { canvas, container } = await detail();
  const title = container.querySelector('[data-detail-part="title"]')!;
  clickAt(title, 700, 210);
  fireEvent.keyDown(canvas, { key: "Delete" });
  expect(container.querySelector('[data-detail-part="title"]')).toBeNull();
  expect(container.querySelector('[data-detail-part="content"]')).not.toBeNull();
  expect(container.querySelector('[data-detail-part="marker"]')).not.toBeNull();
  expect(calls.update.mock.lastCall![5][0].detailViews[0].titleHidden).toBe(true);
  fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
  expect(container.querySelector('[data-detail-part="title"]')).not.toBeNull();
});


test.each([
  ["win32", 1], ["darwin", 1], ["openharmony", 1], ["ohos", 1],
  ["darwin", 2], ["openharmony", 2], ["ohos", 2],
])("%s button %s drag pans without editing the drawing", async (platform, button) => {
  vi.stubGlobal("documentFontPlatform", platform);
  const { canvas } = await open();
  SVGSVGElement.prototype.getScreenCTM = vi.fn(() => ({
    inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  })) as never;
  const before = canvas.getAttribute("viewBox")!.split(" ").map(Number);
  calls.update.mockClear();
  fireEvent.pointerDown(canvas, { clientX: 400, clientY: 400, button });
  fireEvent.pointerMove(canvas, { clientX: 480, clientY: 440, buttons: button === 1 ? 4 : 2 });
  fireEvent.pointerUp(canvas, { clientX: 480, clientY: 440, button });
  await waitFor(() => {
    const after = canvas.getAttribute("viewBox")!.split(" ").map(Number);
    expect(after[0]).toBe((before[0] ?? 0) - 80);
    expect(after[1]).toBe((before[1] ?? 0) - 40);
    expect(after.slice(2)).toEqual(before.slice(2));
  });
  expect(calls.update).not.toHaveBeenCalled();
});
