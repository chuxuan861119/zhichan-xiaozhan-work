import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { createSingleWorkspace } from "./patent-workspace-layout";
import { usePatentWorkspaceTabDrag } from "./use-patent-workspace-tab-drag";

const claims = { patentId: "patent-a", bookKind: "claims" } as const;
const description = { patentId: "patent-a", bookKind: "description" } as const;
const drawingMarkup = { patentId: "patent-a", kind: "tool", tool: "drawing-markup" } as const;
const flowchart = { patentId: "patent-a", kind: "tool", tool: "flowchart" } as const;
const workspaceRect = {
  left: 0,
  top: 160,
  right: 1200,
  bottom: 800,
  width: 1200,
  height: 640,
};

function startRequest(target = description) {
  const sourceElement = document.createElement("button");
  sourceElement.getBoundingClientRect = () =>
    ({
      x: 120,
      y: 10,
      left: 120,
      top: 10,
      right: 340,
      bottom: 44,
      width: 220,
      height: 34,
      toJSON: () => ({}),
    }) as DOMRect;
  return {
    source: {
      key: `book:patent-a:${target.bookKind}`,
      label: "说明书",
      target,
    },
    sourceElement,
    pointerId: 9,
    button: 0,
    clientX: 150,
    clientY: 25,
  };
}

describe("usePatentWorkspaceTabDrag", () => {
  test("commits a valid left-side drop after crossing the threshold", async () => {
    const onDrop = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePatentWorkspaceTabDrag({
        enabled: true,
        layout: createSingleWorkspace(claims),
        getWorkspaceRect: () => workspaceRect,
        onDrop,
      }),
    );

    act(() => result.current.bindings.start(startRequest()));
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 300, clientY: 400 });
    expect(result.current.session?.pane).toBe("left");
    expect(result.current.session?.effect).toBe("split-other");

    fireEvent.pointerUp(window, { pointerId: 9, clientX: 300, clientY: 400 });

    expect(result.current.bindings.consumeClick("book:patent-a:description")).toBe(true);
    await waitFor(() =>
      expect(onDrop).toHaveBeenCalledWith(
        description,
        "left",
        "split-other",
        startRequest().source,
      ),
    );
  });

  test("keeps an ordinary click when movement never crosses the threshold", () => {
    const onDrop = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePatentWorkspaceTabDrag({
        enabled: true,
        layout: createSingleWorkspace(claims),
        getWorkspaceRect: () => workspaceRect,
        onDrop,
      }),
    );

    act(() => result.current.bindings.start(startRequest()));
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 153, clientY: 28 });
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 153, clientY: 28 });

    expect(result.current.session).toBeNull();
    expect(result.current.bindings.consumeClick("book:patent-a:description")).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });

  test("returns the ghost and does not commit when released above the workspace", () => {
    const onDrop = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePatentWorkspaceTabDrag({
        enabled: true,
        layout: createSingleWorkspace(claims),
        getWorkspaceRect: () => workspaceRect,
        onDrop,
      }),
    );

    act(() => result.current.bindings.start(startRequest()));
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 300, clientY: 120 });
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 300, clientY: 120 });

    expect(onDrop).not.toHaveBeenCalled();
    expect(result.current.session?.status).toBe("cancelling");
  });

  test.each([
    ["Escape", () => fireEvent.keyDown(window, { key: "Escape" })],
    ["pointercancel", () => fireEvent.pointerCancel(window, { pointerId: 9 })],
    ["blur", () => fireEvent(window, new Event("blur"))],
  ] as const)("cancels an active drag on %s", (_label, cancel) => {
    const onDrop = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePatentWorkspaceTabDrag({
        enabled: true,
        layout: createSingleWorkspace(claims),
        getWorkspaceRect: () => workspaceRect,
        onDrop,
      }),
    );

    act(() => result.current.bindings.start(startRequest()));
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 900, clientY: 400 });
    cancel();

    expect(onDrop).not.toHaveBeenCalled();
    expect(result.current.session?.status).toBe("cancelling");
  });

  test("suppresses the source-tab click when the pointer is released after Escape", async () => {
    const onDrop = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePatentWorkspaceTabDrag({
        enabled: true,
        layout: createSingleWorkspace(claims),
        getWorkspaceRect: () => workspaceRect,
        onDrop,
      }),
    );

    act(() => result.current.bindings.start(startRequest()));
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 900, clientY: 400 });
    fireEvent.keyDown(window, { key: "Escape" });
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 900, clientY: 400 });

    expect(onDrop).not.toHaveBeenCalled();
    expect(result.current.bindings.consumeClick("book:patent-a:description")).toBe(true);
  });

  test("cancels a stale drag when pointer movement reports that the primary button is released", () => {
    const onDrop = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePatentWorkspaceTabDrag({
        enabled: true,
        layout: createSingleWorkspace(claims),
        getWorkspaceRect: () => workspaceRect,
        onDrop,
      }),
    );

    act(() => result.current.bindings.start(startRequest()));
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 900, clientY: 400 });
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 0, clientX: 600, clientY: 500 });

    expect(onDrop).not.toHaveBeenCalled();
    expect(result.current.session?.status).toBe("cancelling");
    expect(result.current.session?.point).toEqual({ x: 900, y: 400 });
  });

  test("drops a CAD标号 tab as a tool target while the tool owns the single screen", async () => {
    const onDrop = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePatentWorkspaceTabDrag({
        enabled: true,
        layout: createSingleWorkspace(claims),
        singleCurrentTarget: drawingMarkup,
        getWorkspaceRect: () => workspaceRect,
        onDrop,
      }),
    );
    const request = startRequest();

    act(() =>
      result.current.bindings.start({
        ...request,
        source: {
          key: "tool:patent-a:flowchart",
          label: "流程图",
          target: flowchart,
        },
      }),
    );
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 300, clientY: 400 });
    // 屏幕上显示的是 CAD标号，因此拖入流程图属于"另一个文档"。
    expect(result.current.session?.effect).toBe("split-other");

    fireEvent.pointerUp(window, { pointerId: 9, clientX: 300, clientY: 400 });

    expect(result.current.bindings.consumeClick("tool:patent-a:flowchart")).toBe(true);
    await waitFor(() =>
      expect(onDrop).toHaveBeenCalledWith(
        flowchart,
        "left",
        "split-other",
        expect.objectContaining({ target: flowchart }),
      ),
    );
  });

  test("treats the tool already on screen as the current document", () => {
    const onDrop = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePatentWorkspaceTabDrag({
        enabled: true,
        layout: createSingleWorkspace(claims),
        singleCurrentTarget: drawingMarkup,
        getWorkspaceRect: () => workspaceRect,
        onDrop,
      }),
    );
    const request = startRequest();

    act(() =>
      result.current.bindings.start({
        ...request,
        source: {
          key: "tool:patent-a:drawing-markup",
          label: "CAD标号",
          target: drawingMarkup,
        },
      }),
    );
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 900, clientY: 400 });

    expect(result.current.session?.effect).toBe("split-current");
  });

  test("cancels a drag and suppresses its delayed click when pointer capture is lost", async () => {
    const onDrop = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePatentWorkspaceTabDrag({
        enabled: true,
        layout: createSingleWorkspace(claims),
        getWorkspaceRect: () => workspaceRect,
        onDrop,
      }),
    );

    act(() => result.current.bindings.start(startRequest()));
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 900, clientY: 400 });
    fireEvent.lostPointerCapture(window, { pointerId: 9 });
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 900, clientY: 400 });

    expect(onDrop).not.toHaveBeenCalled();
    expect(result.current.session?.status).toBe("cancelling");
    expect(result.current.bindings.consumeClick("book:patent-a:description")).toBe(true);
  });
});

test("a long cancellation keeps its picture until the shared return motion ends", () => {
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() =>
      usePatentWorkspaceTabDrag({
        enabled: true,
        layout: createSingleWorkspace(claims),
        getWorkspaceRect: () => workspaceRect,
        onDrop: vi.fn(async () => true),
      }),
    );
    act(() => result.current.bindings.start(startRequest()));
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 900, clientY: 400 });
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.session?.status).toBe("cancelling");
    act(() => vi.advanceTimersByTime(20));
    expect(result.current.session).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("an older drop response cannot cancel the removal timer for a newer drag", async () => {
  vi.useFakeTimers();
  try {
    let finish!: (accepted: boolean) => void;
    const onDrop = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() =>
      usePatentWorkspaceTabDrag({
        enabled: true,
        layout: createSingleWorkspace(claims),
        getWorkspaceRect: () => workspaceRect,
        onDrop,
      }),
    );
    act(() => result.current.bindings.start(startRequest()));
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 300, clientY: 400 });
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 300, clientY: 400 });
    act(() => result.current.bindings.start(startRequest()));
    fireEvent.pointerMove(window, { pointerId: 9, buttons: 1, clientX: 900, clientY: 400 });
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => finish(true));
    act(() => vi.advanceTimersByTime(220));
    expect(result.current.session).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
