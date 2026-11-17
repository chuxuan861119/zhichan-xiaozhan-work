import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test } from "vitest";
import { createDetailView } from "../../../shared/drawing-markup/detail-view";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import {
  DetailPointerPreview,
  detailAtPointer,
  type DetailPointerHandle,
} from "./detail-pointer-preview";
afterEach(cleanup);
test("pointer frames update only the detail draft, keeping source, marker and saved data intact", () => {
  const original = createDetailView(
    drawingProjectFixture("asset"),
    { x: 10, y: 20 },
    5,
    { x: 50, y: 60 },
    "A",
    2,
    10,
    1,
    "draft",
  );
  const before = JSON.stringify(original),
    ref = createRef<DetailPointerHandle>();
  let renders = 0;
  function Parent() {
    renders++;
    return (
      <DetailPointerPreview ref={ref} initial={original.center}>
        {(p) => {
          const d = detailAtPointer(original, p);
          return <span data-testid="position">{JSON.stringify(d)}</span>;
        }}
      </DetailPointerPreview>
    );
  }
  const view = render(<Parent />);
  act(() => ref.current!.update({ x: 80, y: 100 }));
  const result = JSON.parse(view.getByTestId("position").textContent!);
  expect(renders).toBe(1);
  expect(result.center).toEqual({ x: 80, y: 100 });
  expect(result.title).toEqual({ x: original.title.x + 30, y: original.title.y + 40 });
  expect(result.source).toEqual(original.source);
  expect(result.marker).toEqual(original.marker);
  expect(JSON.stringify(original)).toBe(before);
});
