import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const root = new URL("../../../resources/cadcraft/wasm/", import.meta.url);
const source = await readFile(new URL("cadcraft.js", root), "utf8");
const bridge = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
bridge.initSync({ module: await readFile(new URL("cadcraft_bg.wasm", root)) });
const cases = [
  ["circle", { center: [0, 0], diameter: 10 }],
  ["circle", { p1: [0, 0], p2: [10, 0] }],
  ["circle", { p1: [0, 0], p2: [10, 0], p3: [5, 5] }],
  ["arc.sce", { start: [10, 0], center: [0, 0], end: [0, 10] }],
  ["arc.ser", { start: [0, 0], end: [10, 0], radius: 10 }],
  ["arc.sea", { start: [0, 0], end: [10, 0], angle: -90 }],
  ["arc.continue", { end: [20, 10] }],
  ["ellipse.axis", { p1: [0, 0], p2: [10, 0], p3: [5, 20] }],
  ["ellipse.arc", { p1: [0, 0], p2: [10, 0], distance: 20, start: -90, end: 0 }],
  ["polygon", { center: [0, 0], radius: 10, sides: 6, inscribed: false }],
  [
    "polygon",
    {
      edge: [
        [0, 0],
        [10, 0],
      ],
      sides: 5,
    },
  ],
  ["circle.ttr", null],
  ["circle.ttt", null],
];
for (const [command, input] of cases)
  test(`${command} previews without writes, commits, undoes and reloads`, () => {
    const s = new bridge.CadcraftSession();
    const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
    try {
      const h1 = run("line", {
        points: [
          [0, 0],
          [10, 0],
        ],
      }).handles[0];
      const h2 = run("line", {
        points: [
          [0, 0],
          [0, 10],
        ],
      }).handles[0];
      const h3 = run("line", {
        points: [
          [0, 10],
          [10, 0],
        ],
      }).handles[0];
      const params = input ?? { h1, h2, h3, p1: [3, 0], p2: [0, 3], p3: [5, 5], radius: 2 };
      const before = s.export_dxf();
      const preview = run("bridge.preview_draw", { command, params });
      assert.equal(preview.entities.length, 1);
      assert.ok(preview.primitives.length > 0);
      assert.deepEqual(s.export_dxf(), before);
      const handle = run(command, params).handle;
      const saved = JSON.parse(s.scene());
      assert.equal(saved.entities.length, 4);
      assert.deepEqual(
        saved.entities.find((e) => e.handle === handle).geometry,
        preview.entities[0].geometry,
      );
      run("undo", {});
      assert.equal(JSON.parse(s.scene()).entities.length, 3);
      run("redo", {});
      assert.equal(JSON.parse(s.scene()).entities.length, 4);
      const restored = new bridge.CadcraftSession();
      try {
        restored.load_dxf(s.export_dxf());
        assert.equal(JSON.parse(restored.scene()).entities.length, 4);
      } finally {
        restored.free();
      }
    } finally {
      s.free();
    }
  });
test("path arrays preserve source and undo in one step", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const path = run("line", {
      points: [
        [0, 0],
        [100, 0],
      ],
    }).handles[0];
    const handle = run("circle", { center: [0, 0], radius: 2 }).handle;
    const params = { handles: [handle], path, count: 5, align: true };
    const before = s.export_dxf();
    run("bridge.preview_modify", { command: "arraypath", params });
    assert.deepEqual(s.export_dxf(), before);
    run("arraypath", params);
    assert.equal(JSON.parse(s.scene()).entities.length, 6);
    run("undo", {});
    assert.equal(JSON.parse(s.scene()).entities.length, 2);
  } finally {
    s.free();
  }
});
