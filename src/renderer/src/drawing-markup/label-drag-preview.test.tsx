import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { expect, test } from "vitest";
import { LabelDragPreview, type LabelDragPreviewHandle } from "./label-drag-preview";

test("dragging one label repaints only its own native glyph and alignment guide", () => {
  const ref = createRef<LabelDragPreviewHandle>();
  const original = {
    id: "a",
    text: "1",
    x: 10,
    y: 20,
    fontSize: 12,
    lineWidth: 0.3,
    points: [
      { x: 5, y: 40 },
      { x: 10, y: 20 },
    ],
  };
  const { container } = render(
    <svg aria-label="标号拖动测试">
      <g data-other-label="b">
        <path d="M1 2L3 4" />
      </g>
      <LabelDragPreview
        ref={ref}
        annotation={original}
        glyphPaths={[
          { d: "M9 18L11 18L10 22Z", fill: "black", stroke: "none", width: 1, point: false },
        ]}
        mapping={{ originX: 0, originY: 100, scale: 1 }}
        unitsPerPixel={1}
      />
    </svg>,
  );
  const other = container.querySelector('[data-other-label="b"]');
  expect(other).not.toBeNull();
  act(() =>
    ref.current?.update(
      {
        ...original,
        x: 20,
        points: [
          { x: 5, y: 40 },
          { x: 20, y: 20 },
        ],
      },
      [{ axis: "vertical", from: { x: 20, y: 50 }, to: { x: 20, y: 20 } }],
    ),
  );
  expect(
    container
      .querySelector("[data-label-drag-preview] [data-label-glyph-shift]")
      ?.getAttribute("transform"),
  ).toBe("translate(10 0)");
  expect(container.querySelector('[data-label-align-guide="vertical"]')).not.toBeNull();
  expect(container.querySelector('[data-other-label="b"]')).toBe(other);
});
