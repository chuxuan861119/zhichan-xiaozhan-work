import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ImageSelectionFrame } from "./image-selection-frame";

describe("ImageSelectionFrame", () => {
  test("closing controls retain inert paint without changing resize parentage", () => {
    vi.useFakeTimers();
    try {
      const onResizeCommit = vi.fn();
      const props = { selected: true, widthMm: 80, onResizeCommit, onDelete: vi.fn() };
      const view = render(
        <ImageSelectionFrame {...props} controls>
          <img alt="测试图片" />
        </ImageSelectionFrame>,
      );
      const handle = screen.getByRole("button", { name: "从右下角缩放图片" });
      expect(handle.parentElement).toBe(screen.getByTestId("image-selection-frame"));
      view.rerender(
        <ImageSelectionFrame {...props} controls={false}>
          <img alt="测试图片" />
        </ImageSelectionFrame>,
      );
      expect(handle.getAttribute("data-motion")).toBe("exit");
      expect(handle.hasAttribute("inert")).toBe(true);
      expect(screen.queryByRole("button", { name: "从右下角缩放图片" })).toBeNull();
      act(() => vi.advanceTimersByTime(420));
      expect(handle.isConnected).toBe(false);
      expect(onResizeCommit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  test.each(["Escape", "blur", "capture-lost", "right-button", "width-change", "read-only"])(
    "does not commit a resize interrupted by %s",
    (reason) => {
      const onResizeCommit = vi.fn();
      const props = { selected: true, widthMm: 80, onResizeCommit, onDelete: vi.fn() };
      const view = render(
        <ImageSelectionFrame {...props}>
          <img alt="测试图片" />
        </ImageSelectionFrame>,
      );
      const handle = screen.getByRole("button", { name: "从右下角缩放图片" });
      fireEvent.pointerDown(handle, {
        pointerId: 1,
        clientX: 100,
        button: reason === "right-button" ? 2 : 0,
      });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 138 });
      if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      if (reason === "blur") fireEvent.blur(window);
      if (reason === "capture-lost") fireEvent.lostPointerCapture(handle, { pointerId: 1 });
      if (reason === "width-change" || reason === "read-only") {
        view.rerender(
          <ImageSelectionFrame
            {...props}
            widthMm={reason === "width-change" ? 60 : 80}
            readOnly={reason === "read-only"}
          >
            <img alt="测试图片" />
          </ImageSelectionFrame>,
        );
      }
      expect(screen.getByTestId("image-selection-frame").style.width).toBe(
        reason === "width-change" ? "60mm" : "80mm",
      );
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 138 });
      expect(onResizeCommit).not.toHaveBeenCalled();
    },
  );

  test.each([0.5, 0.8, 1.5, 2])("converts screen drag distance at page scale %s", (scale) => {
    const onResizeCommit = vi.fn();
    const { unmount } = render(
      <ImageSelectionFrame selected widthMm={80} onResizeCommit={onResizeCommit} onDelete={vi.fn()}>
        <img alt="测试图片" />
      </ImageSelectionFrame>,
    );
    const frame = screen.getByTestId("image-selection-frame");
    Object.defineProperty(frame, "offsetWidth", { value: 300 });
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 300 * scale, height: 150 * scale }),
    );
    const handle = screen.getByRole("button", { name: "从右下角缩放图片" });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 + 38 * scale });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100 + 38 * scale });
    try {
      expect(onResizeCommit).toHaveBeenCalledWith(90.05);
    } finally {
      unmount();
    }
  });

  test("uses three resize handles and the top-right delete control", () => {
    render(
      <ImageSelectionFrame selected widthMm={80} onResizeCommit={vi.fn()} onDelete={vi.fn()}>
        <img alt="测试图片" />
      </ImageSelectionFrame>,
    );

    expect(screen.queryByRole("button", { name: "从右上角缩放图片" })).toBeNull();
    expect(screen.getByRole("button", { name: "从左上角缩放图片" })).toBeDefined();
    expect(screen.getByRole("button", { name: "从左下角缩放图片" })).toBeDefined();
    expect(screen.getByRole("button", { name: "从右下角缩放图片" })).toBeDefined();
    expect(screen.getByRole("button", { name: "删除图片" })).toBeDefined();
  });

  test("previews pointer resize and commits on pointer up", () => {
    const onResizeCommit = vi.fn();
    render(
      <ImageSelectionFrame selected widthMm={80} onResizeCommit={onResizeCommit} onDelete={vi.fn()}>
        <img alt="测试图片" />
      </ImageSelectionFrame>,
    );
    const handle = screen.getByRole("button", { name: "从右下角缩放图片" });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 138 });
    expect(screen.getByTestId("image-selection-frame").getAttribute("style")).toContain("90.05mm");
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 138 });
    expect(onResizeCommit).toHaveBeenCalledWith(90.05);
  });

  test("supports keyboard width adjustment from every visible resize handle", () => {
    const onResizeCommit = vi.fn();
    render(
      <ImageSelectionFrame selected widthMm={80} onResizeCommit={onResizeCommit} onDelete={vi.fn()}>
        <img alt="测试图片" />
      </ImageSelectionFrame>,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "从左上角缩放图片" }), {
      key: "ArrowRight",
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "从左下角缩放图片" }), {
      key: "ArrowLeft",
      shiftKey: true,
    });

    expect(onResizeCommit).toHaveBeenNthCalledWith(1, 81);
    expect(onResizeCommit).toHaveBeenNthCalledWith(2, 75);
  });

  test("gives an inline image frame its own measurable inline box", () => {
    render(
      <ImageSelectionFrame
        as="span"
        selected={false}
        widthMm={80}
        onResizeCommit={vi.fn()}
        onDelete={vi.fn()}
      >
        <img alt="嵌入式测试图片" />
      </ImageSelectionFrame>,
    );

    const frame = screen.getByTestId("image-selection-frame");
    expect(frame.tagName).toBe("SPAN");
    expect(frame.style.display).toBe("inline-block");
    expect(frame.style.width).toBe("80mm");
  });
});
