import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { DrawingAnnotationView } from "./annotation-view";

const annotation = {
  id: "a",
  text: "12",
  x: 30,
  y: 20,
  fontSize: 10,
  lineWidth: 1,
  points: [
    { x: 10, y: 10 },
    { x: 30, y: 20 },
  ],
};
const props = {
  annotation,
  selected: false,
  handles: false,
  clipped: false,
  color: "black",
  viewWidth: 100,
  unitsPerPixel: 1,
  canvasWidth: 1000,
};

test("native label retains its hit target without drawing a second black label", () => {
  const { container, rerender } = render(
    <svg>
      <title>CAD 标号</title>
      <DrawingAnnotationView {...props} nativeVisual />
    </svg>,
  );
  expect(container.querySelectorAll("polyline")).toHaveLength(1);
  expect(container.querySelector("text")?.getAttribute("opacity")).toBe("0");
  expect(container.querySelector("text")?.getAttribute("pointer-events")).toBe("all");
  rerender(
    <svg>
      <title>CAD 标号</title>
      <DrawingAnnotationView {...props} nativeVisual color="#007AFF" handles />
    </svg>,
  );
  expect(container.querySelectorAll("polyline")).toHaveLength(1);
  expect(container.querySelector("text")?.getAttribute("opacity")).toBe("0");
  expect(container.querySelectorAll("circle")).toHaveLength(2);
});
