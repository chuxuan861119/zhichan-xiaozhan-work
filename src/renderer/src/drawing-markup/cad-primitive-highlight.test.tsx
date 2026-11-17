import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CadPrimitiveBatch } from "./cad-primitive-highlight";
import type { CadScene } from "./cadcraft-client";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const strokes = (count: number): CadScene["primitives"] =>
  Array.from({ length: count }, (_, i) => ({
    handle: String(i),
    kind: "polyline",
    points: [
      [i, 0],
      [i, 10],
    ],
    color: [0, 0, 0],
    aci7: true,
    lineweight: 0,
  }));

test("Mac retains unchanged selection paths and refreshes a changed coordinate mapping", () => {
  vi.stubGlobal("documentFontPlatform", "MacIntel");
  const primitives = strokes(130);
  const point = vi.fn(([x, y]: [number, number]) => ({ x, y }));
  const { container, rerender } = render(<svg><CadPrimitiveBatch primitives={primitives} point={point} pointKey="page:0" /></svg>);
  expect(point).toHaveBeenCalledTimes(260);
  point.mockClear();
  rerender(<svg><CadPrimitiveBatch primitives={[...primitives]} point={point} pointKey="page:0" /></svg>);
  expect(point).not.toHaveBeenCalled();
  rerender(<svg><CadPrimitiveBatch primitives={primitives} point={([x,y])=>({x:x+10,y})} pointKey="page:10" /></svg>);
  expect(container.querySelector("path")?.getAttribute("d")).toMatch(/^M10 0L10 10/);
  const edited = [{...primitives[0]!,points:[[5,5],[10,10]] as [number,number][]},...primitives.slice(1)];
  rerender(<svg><CadPrimitiveBatch primitives={edited} point={([x,y])=>({x:x+10,y})} pointKey="page:10" /></svg>);
  expect(container.querySelector("path")?.getAttribute("d")).toMatch(/^M15 5L20 10/);
});

test.each(["Win32", "MacIntel"])("large selection feedback batches independent strokes with bounded paths (%s)", platform => {
  vi.stubGlobal("documentFontPlatform", platform);
  const primitives = strokes(130);
  const original = JSON.stringify(primitives);
  const { container } = render(
    <svg role="presentation">
      <CadPrimitiveBatch primitives={primitives} />
    </svg>,
  );
  const paths = [...container.querySelectorAll("path")];
  expect(paths).toHaveLength(3);
  expect(paths.map((p) => (p.getAttribute("d")?.match(/M/g) ?? []).length)).toEqual([64, 64, 2]);
  expect(paths.every((p) => p.getAttribute("vector-effect") === "non-scaling-stroke")).toBe(true);
  expect(JSON.stringify(primitives)).toBe(original);
});

test.each(["Win32", "MacIntel"])("stroke width changes and solid geometry retain their order and treatment (%s)", platform => {
  vi.stubGlobal("documentFontPlatform", platform);
  const primitives = strokes(66);
  primitives[32] = {
    ...primitives[32]!,
    kind: "triangles",
    points: [
      [0, 0],
      [10, 0],
      [0, 10],
    ],
  };
  primitives[33] = { ...primitives[33]!, kind: "mask" };
  const { container } = render(
    <svg role="presentation">
      <CadPrimitiveBatch
        primitives={primitives}
        strokeWidth={(p) => (Number(p.handle) < 40 ? 1 : 3)}
        point={([x, y]) => ({ x: x + 100, y: -y })}
      />
    </svg>,
  );
  const children = [...container.querySelector("svg")!.children];
  expect(children.map((p) => p.tagName)).toEqual(["path", "g", "path", "path"]);
  expect(children[0]?.getAttribute("d")).toContain("M100 0L100 -10");
  expect(children[1]?.getAttribute("fill-opacity")).toBe("0.18");
  expect(children[3]?.getAttribute("stroke-width")).toBe("3");
  expect(children[1]?.querySelector("path")?.getAttribute("d")).toBe("M100,0L110,0L100,-10Z");
  expect(children[1]?.querySelector("path")?.getAttribute("stroke")).toBe("none");
});

test.each(["Win32", "MacIntel"])("dense filled selections keep every triangle in bounded compound paths (%s)", platform => {
  vi.stubGlobal("documentFontPlatform", platform);
  const triangles = Array.from({ length: 130 }, (_, i) => [[i, 0], [i + 1, 0], [i, 1]]).flat() as [number, number][];
  const original = JSON.stringify(triangles);
  const { container } = render(<svg><CadPrimitiveBatch primitives={[{ ...strokes(1)[0]!, kind: "triangles", points: triangles }]} /></svg>);
  const paths = [...container.querySelectorAll("path")];
  expect(paths).toHaveLength(3);
  expect(paths.map(p => p.getAttribute("d")!.match(/Z/g)!.length)).toEqual([64, 64, 2]);
  expect(paths.at(-1)?.getAttribute("d")).toContain("M129,0L130,0L129,1Z");
  expect(container.querySelectorAll("polygon")).toHaveLength(0);
  expect(JSON.stringify(triangles)).toBe(original);
});
