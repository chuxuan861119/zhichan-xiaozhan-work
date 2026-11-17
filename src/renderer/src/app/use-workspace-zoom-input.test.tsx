import { act, fireEvent, renderHook } from "@testing-library/react";
import { useWorkspaceZoomInput } from "./use-workspace-zoom-input";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function setup() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++id, fn);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  const zoom = vi.fn(),
    reset = vi.fn();
  const hook = renderHook(() => useWorkspaceZoomInput(zoom, reset));
  const editor = document.createElement("div");
  editor.className = "editor-workspace";
  document.body.append(editor);
  const step = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const fn of pending) fn(0);
    });
  return { ...hook, zoom, reset, editor, frames, step };
}

test("wheel zoom follows its pane without clicking or focusing that pane", () => {
  const { editor, zoom, step } = setup();
  const pane = document.createElement("section");
  pane.className = "dual-document-pane";
  pane.dataset.pane = "left";
  editor.replaceWith(pane);
  pane.append(editor);
  const activate = vi.fn();
  pane.addEventListener("pointerdown", activate);
  fireEvent.wheel(pane, { deltaY: -12, ctrlKey: true });
  step();
  expect(zoom).toHaveBeenCalledWith(expect.any(Number), true, "left");
  expect(activate).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(document.body);
});

test("crossing panes within one wheel frame keeps each pane's input independent", () => {
  const { editor, zoom, step } = setup();
  const left = document.createElement("section");
  left.className = "dual-document-pane";
  left.dataset.pane = "left";
  editor.replaceWith(left);
  left.append(editor);
  const right = left.cloneNode(true) as HTMLElement;
  right.dataset.pane = "right";
  document.body.append(right);
  fireEvent.wheel(editor, { deltaY: -10, ctrlKey: true });
  fireEvent.wheel(right.firstElementChild!, { deltaY: 10, ctrlKey: true });
  step();
  expect(zoom.mock.calls).toEqual([
    [expect.closeTo(Math.exp(0.014)), true, "left"],
    [expect.closeTo(Math.exp(-0.014)), true, "right"],
  ]);
  fireEvent.keyDown(editor, { key: "=", ctrlKey: true });
  expect(zoom).toHaveBeenLastCalledWith(10);
});
test("format shortcuts, composition and previously handled keys never zoom", () => {
  const { editor, zoom, reset } = setup();
  fireEvent.keyDown(editor, { key: "0", ctrlKey: true, altKey: true });
  fireEvent.keyDown(editor, { key: "0", metaKey: true, shiftKey: true });
  fireEvent.keyDown(editor, { key: "0", ctrlKey: true, isComposing: true });
  const event = new KeyboardEvent("keydown", {
    key: "0",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  event.preventDefault();
  editor.dispatchEvent(event);
  expect(zoom).not.toHaveBeenCalled();
  expect(reset).not.toHaveBeenCalled();
  fireEvent.keyDown(editor, { key: "0", metaKey: true });
  expect(reset).toHaveBeenCalledOnce();
  fireEvent.keyDown(editor, { key: "+", metaKey: true, shiftKey: true });
  expect(zoom).toHaveBeenCalledWith(10);
});
test("fine pinch events accumulate once per frame instead of jumping five percent each", () => {
  const { editor, zoom, frames, step } = setup();
  for (let i = 0; i < 4; i++) fireEvent.wheel(editor, { deltaY: -0.1, ctrlKey: true });
  expect(frames.size).toBe(1);
  expect(zoom).not.toHaveBeenCalled();
  step();
  expect(zoom.mock.calls[0]?.[0]).toBeCloseTo(Math.exp(0.4 * 0.0014));
  expect(zoom.mock.calls[0]?.[1]).toBe(true);
});

test.each([
  [120, 0],
  [3, 1],
  [1, 2],
])(
  "coarse wheel input (%s, mode %s) stays below five percent and reverses symmetrically",
  (deltaY, deltaMode) => {
    const { editor, zoom, step } = setup();
    fireEvent.wheel(editor, { deltaY: -deltaY, deltaMode, ctrlKey: true });
    step();
    const increase = zoom.mock.calls[0]![0];
    expect(increase).toBeGreaterThan(1);
    expect(increase).toBeLessThan(1.05);
    fireEvent.wheel(editor, { deltaY, deltaMode, ctrlKey: true });
    step();
    expect(increase * zoom.mock.calls[1]![0]).toBeCloseTo(1);
  },
);

test("a burst of wheel events cannot multiply into a large jump in one frame", () => {
  const { editor, zoom, step } = setup();
  for (let i = 0; i < 8; i++) fireEvent.wheel(editor, { deltaY: -120, ctrlKey: true });
  step();
  expect(zoom).toHaveBeenCalledOnce();
  expect(zoom.mock.calls[0]![0]).toBeLessThan(1.05);
});

test("Harmony system modifiers and unfinished IME events do not zoom", () => {
  vi.stubGlobal("documentFontPlatform", "openharmony");
  const { editor, zoom, reset, step } = setup();
  fireEvent.keyDown(editor, { key: "0", metaKey: true });
  fireEvent.keyDown(editor, { key: "=", ctrlKey: true, keyCode: 229 });
  fireEvent.wheel(editor, { deltaY: -40, metaKey: true });
  step();
  expect(zoom).not.toHaveBeenCalled();
  expect(reset).not.toHaveBeenCalled();
  fireEvent.keyDown(editor, { key: "=", ctrlKey: true });
  expect(zoom).toHaveBeenCalledWith(10);
});
test("canvas/modal gestures stay isolated and pending input is cancelled on unmount", () => {
  const { editor, zoom, frames, step, unmount } = setup();
  const canvas = document.createElement("div");
  canvas.className = "drawing-workspace";
  editor.append(canvas);
  fireEvent.wheel(canvas, { deltaY: -40, ctrlKey: true });
  step();
  expect(zoom).not.toHaveBeenCalled();
  fireEvent.wheel(editor, { deltaY: -2, ctrlKey: true });
  const modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  document.body.append(modal);
  step();
  expect(zoom).not.toHaveBeenCalled();
  modal.remove();
  fireEvent.wheel(editor, { deltaY: -2, ctrlKey: true });
  unmount();
  expect(frames.size).toBe(0);
});
