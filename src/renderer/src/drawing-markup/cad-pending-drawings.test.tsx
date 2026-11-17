import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { CadPendingDrawings, type PendingCadDrawingsHandle } from "./cad-pending-drawings";

afterEach(cleanup);
test("pending strokes hand off by sequence and remain aligned after a mapping rebase", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "a".repeat(40),
    assetId: "00000000-0000-4000-8000-000000000002",
    mapping: { originX: 0, originY: 100, scale: 2 },
  };
  const ref = createRef<PendingCadDrawingsHandle>();
  const { container, rerender } = render(
    <svg role="img" aria-label="CAD测试画布">
      <CadPendingDrawings ref={ref} project={project} />
    </svg>,
  );
  act(() => {
    for (const sequence of [1, 2])
      ref.current?.append({
        sequence,
        primitives: [
          {
            handle: String(sequence),
            kind: "polyline",
            points: [
              [10, 20],
              [30, 40],
            ],
            color: [255, 255, 255],
            aci7: true,
            lineweight: 0,
          },
        ],
      });
  });
  expect(container.querySelectorAll("polyline")).toHaveLength(2);
  expect(container.querySelector("polyline")?.getAttribute("points")).toBe("20,160 60,120");
  act(() => ref.current?.painted(1));
  expect(container.querySelectorAll("polyline")).toHaveLength(1);
  expect(
    container
      .querySelector("[data-cad-drawing-sequence]")
      ?.getAttribute("data-cad-drawing-sequence"),
  ).toBe("2");
  rerender(
    <svg role="img" aria-label="CAD测试画布">
      <CadPendingDrawings
        ref={ref}
        project={{
          ...project,
          cad: { ...project.cad, mapping: { originX: -10, originY: 110, scale: 2 } },
        }}
      />
    </svg>,
  );
  expect(container.querySelector("polyline")?.getAttribute("points")).toBe("40,180 80,140");
  act(() => ref.current?.painted(2));
  expect(container.querySelector("[data-cad-pending-drawings]")).toBeNull();
});
