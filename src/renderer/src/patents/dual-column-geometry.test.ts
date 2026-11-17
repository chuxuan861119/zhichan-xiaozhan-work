import { columnGeometry } from "./dual-column-geometry";

test("keeps adjacent slices continuous at fractional zoom", () => {
  const geometry = columnGeometry(324.25, 631.5, 3500.75);
  expect(geometry.right - geometry.left).toBe(631.5);
  expect(geometry.leftTop).toBe(20 - 324.25);
  expect(geometry.rightBottom).toBe(631.5 + 955.75 - 3500.75 - 20);
});

test("outer paper edges return only at document boundaries", () => {
  expect(columnGeometry(-20, 600, 3000).leftTop).toBe(20);
  expect(columnGeometry(9999, 600, 3000).rightBottom).toBe(20);
  expect(columnGeometry(900, 600, 3000)).toMatchObject({ left: 900, right: 1500, max: 1840 });
});

test("short documents retain two readable column surfaces without negative scrolling", () => {
  expect(columnGeometry(40, 600, 400)).toMatchObject({
    left: 0,
    right: 600,
    max: 0,
    rightBottom: 20,
  });
});

test("page and content share the normal-mode outer gap without breaking slice continuity", () => {
  for (const position of [0, 10, 20, 400, 1840]) {
    const geometry = columnGeometry(position, 600, 3000);
    expect(geometry.contentRight - geometry.contentLeft).toBe(600);
    expect(geometry.contentLeft).toBe(geometry.left - 20);
    expect(geometry.leftTop).toBeCloseTo(-geometry.contentLeft);
  }
});
