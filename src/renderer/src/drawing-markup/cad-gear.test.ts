import { expect, test } from "vitest";
import { compileDrawMethod, DRAW_METHODS } from "./cad-draw-methods";

test.each(["gear.external", "gear.internal", "gear.rack"])(
  "%s uses the native diagram generator with two-point placement",
  (id) => {
    expect(DRAW_METHODS.gear?.map((m) => m.id)).toContain(id);
    expect(compileDrawMethod(id, [{ x: 1, y: 2 }], 20)).toBeNull();
    const result = compileDrawMethod(
      id,
      [
        { x: 1, y: 2 },
        { x: 4, y: 6 },
      ],
      20,
    );
    expect(result?.command).toBe("bridge.gear");
    expect(result?.params).toMatchObject({
      kind: id.slice(5),
      teeth: 20,
      at: [1, 2],
      size: id === "gear.rack" ? 5 : 10,
      hole: true,
    });
  },
);
test("gear placement rejects fractional teeth and zero-size without producing a command", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ];
  expect(() => compileDrawMethod("gear.external", points, 8.5)).toThrow();
  expect(() => compileDrawMethod("gear.external", points, 121)).toThrow();
  expect(() =>
    compileDrawMethod(
      "gear.external",
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      20,
    ),
  ).toThrow();
});
