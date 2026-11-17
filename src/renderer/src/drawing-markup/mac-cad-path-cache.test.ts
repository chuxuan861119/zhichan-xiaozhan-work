import { expect, test, vi } from "vitest";
import { macCadPath } from "./mac-cad-path-cache";
import type { CadScene } from "./cadcraft-client";

test("reuses immutable paths but invalidates changes in mapping, points and scene", () => {
  const p: CadScene["primitives"][number] = {
    handle: "1",
    kind: "polyline",
    points: [
      [1, 2],
      [3, 4],
    ],
    color: [0, 0, 0],
    aci7: true,
    lineweight: 0,
  };
  const point = vi.fn(([x, y]: [number, number]) => ({ x, y }));
  expect(macCadPath(p, "cad", point)).toBe("M1 2L3 4");
  expect(macCadPath(p, "cad", point)).toBe("M1 2L3 4");
  expect(point).toHaveBeenCalledTimes(2);
  expect(macCadPath(p, "translated", ([x, y]) => ({ x: x + 10, y: -y }))).toBe("M11 -2L13 -4");
  p.points = [
    [5, 6],
    [7, 8],
  ];
  expect(macCadPath(p, "translated", point)).toBe("M5 6L7 8");
  expect(
    macCadPath(
      {
        ...p,
        points: [
          [9, 10],
          [11, 12],
        ],
      },
      "translated",
      point,
    ),
  ).toBe("M9 10L11 12");
});
