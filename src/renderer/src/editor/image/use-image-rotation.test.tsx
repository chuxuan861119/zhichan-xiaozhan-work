import { renderHook } from "@testing-library/react";
import { useImageRotation } from "./use-image-rotation";

test("keeps quarter turns continuous through zero and supports undo", () => {
  const { result, rerender } = renderHook(({ angle, asset }) => useImageRotation(angle, asset), {
    initialProps: { angle: 270, asset: "first" },
  });
  expect(result.current).toBe(270);
  rerender({ angle: 0, asset: "first" });
  expect(result.current).toBe(360);
  rerender({ angle: 90, asset: "first" });
  expect(result.current).toBe(450);
  rerender({ angle: 0, asset: "first" });
  expect(result.current).toBe(360);
  rerender({ angle: 270, asset: "first" });
  expect(result.current).toBe(270);
  rerender({ angle: 0, asset: "second" });
  expect(result.current).toBe(0);
  rerender({ angle: 270, asset: "second" });
  expect(result.current).toBe(-90);
});
