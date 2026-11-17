import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const generated = new URL("../../../resources/cadcraft/wasm/", import.meta.url);
const source = await readFile(new URL("cadcraft.js", generated), "utf8");
const bridge = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
bridge.initSync({ module: await readFile(new URL("cadcraft_bg.wasm", generated)) });
function drawing(fn) {
  const s = new bridge.CadcraftSession();
  const run = (c, p = {}) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    fn(s, run, () => JSON.parse(s.scene()));
  } finally {
    s.free();
  }
}
test("a simple circle does not explode or create an undo record", () =>
  drawing((s, run, scene) => {
    const circle = run("circle", { center: [0, 0], radius: 5 }).handle;
    const before = s.export_dxf(),
      revision = scene().revision;
    const result = run("explode", { handles: [circle] });
    assert.equal(result.changed, false);
    assert.equal(result.skipped.length, 1);
    assert.deepEqual(s.export_dxf(), before);
    assert.equal(scene().revision, revision);
    run("undo");
    assert.equal(scene().entities.length, 0);
  }));
test("mixed selection explodes a rectangle once and retains a circle", () =>
  drawing((s, run, scene) => {
    const rectangle = run("rectang", { p1: [0, 0], p2: [10, 8] }).handle;
    const circle = run("circle", { center: [20, 0], radius: 3 }).handle;
    const result = run("explode", { handles: [rectangle, circle] });
    assert.equal(result.exploded, 1);
    assert.equal(result.handles.length, 4);
    assert.equal(result.skipped.length, 1);
    assert.equal(scene().entities.filter((e) => e.type === "Line").length, 4);
    assert.equal(scene().selection.length, 0);
    run("undo");
    assert.equal(scene().entities.length, 2);
    run("redo");
    assert.equal(scene().entities.length, 5);
    const saved = s.export_dxf();
    s.load_dxf(saved);
    assert.equal(scene().entities.length, 5);
  }));
test("block explode removes one level rather than recursively exploding its contents", () =>
  drawing((s, run, scene) => {
    const rectangle = run("rectang", { p1: [0, 0], p2: [10, 8] }).handle;
    run("block", { name: "INNER", handles: [rectangle], base: [0, 0] });
    const inner = run("insert", { name: "INNER", at: [0, 0] }).handle;
    run("block", { name: "OUTER", handles: [inner], base: [0, 0] });
    const outer = run("insert", { name: "OUTER", at: [20, 20] }).handle;
    const result = run("explode", { handles: [outer] });
    assert.equal(result.handles.length, 1);
    assert.equal(
      scene().entities.find((e) => e.handle === result.handles[0]).type,
      "Block Reference",
    );
  }));
test("pattern hatches explode into the visible pattern lines without their source boundary", () =>
  drawing((s, run, scene) => {
    const boundary = run("rectang", { p1: [0, 0], p2: [20, 20] }).handle;
    const hatch = run("hatch", { handles: [boundary], pattern: "ANSI31", scale: 2 }).handle;
    const pattern = scene().primitives.filter((p) => p.handle === hatch);
    const result = run("explode", { handles: [hatch] });
    assert.equal(result.changed, true);
    assert.ok(result.handles.length > 1);
    assert.ok(scene().entities.some((e) => e.handle === boundary));
    assert.ok(!scene().entities.some((e) => e.handle === hatch));
    assert.ok(
      result.handles.every((h) => scene().entities.find((e) => e.handle === h).type === "Line"),
    );
    assert.equal(
      scene().primitives.filter((p) => result.handles.includes(p.handle)).length,
      pattern.length,
    );
    run("undo");
    assert.ok(scene().entities.some((e) => e.handle === hatch));
  }));
test("nonuniformly scaled block circles become exact ellipses", () =>
  drawing((s, run, scene) => {
    const c = run("circle", { center: [0, 0], radius: 5 }).handle;
    run("block", { name: "OVAL", handles: [c], base: [0, 0] });
    const block = run("insert", { name: "OVAL", at: [10, 20], scale: [2, 1, 1] }).handle;
    const result = run("explode", { handles: [block] });
    const ellipse = scene().entities.find((e) => e.handle === result.handles[0]);
    assert.equal(ellipse.type, "Ellipse");
    assert.equal(ellipse.geometry.ratio, 0.5);
    assert.deepEqual([ellipse.geometry.center.x, ellipse.geometry.center.y], [10, 20]);
  }));
test("wrapped rotated mtext becomes editable text at its displayed positions", () =>
  drawing((s, run, scene) => {
    const m = run("mtext", {
      at: [20, 30],
      text: "one two three four five",
      height: 2,
      width: 8,
      rotation: 30,
    }).handle;
    const before = scene()
      .primitives.filter((p) => p.handle === m)
      .flatMap((p) => p.points);
    const bounds = (ps) => [
      Math.min(...ps.map((p) => p[0])),
      Math.min(...ps.map((p) => p[1])),
      Math.max(...ps.map((p) => p[0])),
      Math.max(...ps.map((p) => p[1])),
    ];
    const result = run("explode", { handles: [m] });
    assert.ok(result.handles.length >= 2);
    assert.ok(
      scene()
        .entities.filter((e) => result.handles.includes(e.handle))
        .every((e) => e.type === "Text"),
    );
    const after = scene()
      .primitives.filter((p) => result.handles.includes(p.handle))
      .flatMap((p) => p.points);
    bounds(before).forEach((value, i) => assert.ok(Math.abs(value - bounds(after)[i]) < 1e-5));
  }));
test("EXPLODE does not dissolve a group of simple objects", () =>
  drawing((s, run, scene) => {
    const a = run("circle", { center: [0, 0], radius: 2 }).handle;
    const b = run("line", {
      points: [
        [5, 0],
        [10, 0],
      ],
    }).handles[0];
    run("group", { name: "PAIR", handles: [a, b] });
    const result = run("explode", { handles: [a, b] });
    assert.equal(result.changed, false);
    assert.equal(scene().groups.length, 1);
    assert.deepEqual(scene().groups[0].members, [a, b]);
  }));
test("locked objects are retained while an unlocked composite is exploded", () =>
  drawing((s, run, scene) => {
    run("layer.new", { name: "LOCKED" });
    run("layer.current", { name: "LOCKED" });
    const locked = run("rectang", { p1: [0, 0], p2: [4, 4] }).handle;
    run("layer.current", { name: "0" });
    run("layer.set", { name: "LOCKED", locked: true });
    const free = run("rectang", { p1: [10, 0], p2: [14, 4] }).handle;
    const result = run("explode", { handles: [locked, free] });
    assert.equal(result.exploded, 1);
    assert.equal(result.skipped.length, 1);
    assert.ok(scene().entities.some((e) => e.handle === locked));
  }));
test("exploded parts keep the source draw position rather than moving in front of newer objects", () =>
  drawing((s, run, scene) => {
    const a = run("rectang", { p1: [0, 0], p2: [4, 4] }).handle;
    const b = run("circle", { center: [0, 0], radius: 8 }).handle;
    const result = run("explode", { handles: [a] });
    assert.equal(scene().entities.at(-1).handle, b);
    assert.deepEqual(
      scene()
        .entities.slice(0, 4)
        .map((e) => e.handle),
      result.handles,
    );
  }));
test("a mirrored nonuniform block keeps an arc as an analytic elliptical arc", () =>
  drawing((s, run, scene) => {
    const a = run("arc.sce", { start: [5, 0], center: [0, 0], end: [0, 5] }).handle;
    run("block", { name: "CURVE", handles: [a], base: [0, 0] });
    const b = run("insert", {
      name: "CURVE",
      at: [20, 10],
      scale: [-2, 1, 1],
      rotation: 30,
    }).handle;
    const result = run("explode", { handles: [b] });
    const e = scene().entities.find((e) => e.handle === result.handles[0]);
    assert.equal(e.type, "Ellipse");
    assert.ok(Math.abs(e.geometry.ratio - 0.5) < 1e-10);
    assert.ok(Math.abs(e.geometry.end - e.geometry.start) < Math.PI * 1.5);
  }));
test("formatted and stacked mtext keeps displayed geometry and editable text", () =>
  drawing((s, run, scene) => {
    const a = run("mtext", {
      at: [10, 20],
      text: "A {\\H2x;\\C1;BIG}\\P1\\S1/2;",
      height: 2,
      width: 20,
      rotation: 20,
    }).handle;
    const before = scene().primitives.filter((p) => p.handle === a);
    const result = run("explode", { handles: [a] });
    const after = scene().primitives.filter((p) => result.handles.includes(p.handle));
    const box = (ps) => {
      const all = ps.flatMap((p) => p.points);
      return [
        Math.min(...all.map((p) => p[0])),
        Math.min(...all.map((p) => p[1])),
        Math.max(...all.map((p) => p[0])),
        Math.max(...all.map((p) => p[1])),
      ];
    };
    box(before).forEach((v, i) => assert.ok(Math.abs(v - box(after)[i]) < 1e-5));
    assert.ok(scene().entities.some((e) => e.type === "Text" && e.text === "BIG"));
    assert.ok(after.some((p) => p.color[0] > p.color[1]));
  }));
test("solid hatches retain their filled area and holes after decomposition", () =>
  drawing((s, run, scene) => {
    const boundary = run("rectang", { p1: [0, 0], p2: [20, 20] }).handle;
    const hole = run("circle", { center: [10, 10], radius: 3 }).handle;
    const hatch = run("hatch", { handles: [boundary, hole], pattern: "SOLID" }).handle;
    const area = (ps) =>
      ps
        .filter((p) => p.kind === "triangles")
        .reduce((sum, p) => {
          for (let i = 0; i < p.points.length; i += 3) {
            const [a, b, c] = p.points.slice(i, i + 3);
            sum += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
          }
          return sum;
        }, 0);
    const expected = area(scene().primitives.filter((p) => p.handle === hatch));
    const result = run("explode", { handles: [hatch] });
    assert.ok(
      result.handles.every((h) => scene().entities.find((e) => e.handle === h).type === "2D Solid"),
    );
    assert.ok(
      Math.abs(
        expected - area(scene().primitives.filter((p) => result.handles.includes(p.handle))),
      ) < 0.1,
    );
  }));
test("exploding an associative hatch boundary retains the visible hatch", () =>
  drawing((s, run, scene) => {
    const boundary = run("rectang", { p1: [0, 0], p2: [20, 20] }).handle;
    const hatch = run("hatch", { handles: [boundary], pattern: "ANSI31", scale: 2 }).handle;
    const before = scene()
      .primitives.filter((p) => p.handle === hatch)
      .map((p) => p.points);
    run("explode", { handles: [boundary] });
    assert.deepEqual(
      scene()
        .primitives.filter((p) => p.handle === hatch)
        .map((p) => p.points),
      before,
    );
    const saved = s.export_dxf();
    s.load_dxf(saved);
    assert.ok(scene().entities.some((e) => e.handle === hatch));
  }));
for (const content of ["\\A0;1\\S12^3;", "\\A2;1\\S12^3;", "\\C1;\\LRED\\l\\S12^3;"])
  test(`stacked text preserves baseline and decoration: ${content}`, () =>
    drawing((s, run, scene) => {
      const m = run("mtext", {
        at: [10, 20],
        text: content,
        height: 3,
        width: 30,
        rotation: 40,
      }).handle;
      const bounds = (ps) => {
        const points = ps.flatMap((p) => p.points);
        return [
          Math.min(...points.map((p) => p[0])),
          Math.min(...points.map((p) => p[1])),
          Math.max(...points.map((p) => p[0])),
          Math.max(...points.map((p) => p[1])),
        ];
      };
      const original = bounds(scene().primitives.filter((p) => p.handle === m));
      const result = run("explode", { handles: [m] });
      const after = scene().primitives.filter((p) => result.handles.includes(p.handle));
      original.forEach((n, i) => assert.ok(Math.abs(n - bounds(after)[i]) < 1e-5));
      if (content.includes("C1")) assert.ok(after.every((p) => p.color[0] > p.color[1]));
    }));
test("a DXF block marked non-explodable is retained", () =>
  drawing((s, run, scene) => {
    const a = run("rectang", { p1: [0, 0], p2: [10, 10] }).handle;
    run("block", { name: "KEEP", handles: [a], base: [0, 0] });
    const b = run("insert", { name: "KEEP", at: [20, 0] }).handle;
    const lines = new TextDecoder()
      .decode(s.export_dxf())
      .replaceAll("\r\n", "\n")
      .trimEnd()
      .split("\n");
    let changed = false;
    for (let i = 0; i < lines.length; i += 2)
      if (lines[i].trim() === "0" && lines[i + 1] === "BLOCK_RECORD") {
        let end = i + 2;
        while (end < lines.length && lines[end].trim() !== "0") end += 2;
        if (lines.slice(i, end).includes("KEEP"))
          for (let j = i; j < end; j += 2)
            if (lines[j].trim() === "280") {
              lines[j + 1] = "0";
              changed = true;
            }
      }
    assert.ok(changed);
    s.load_dxf(new TextEncoder().encode(lines.join("\n") + "\n"));
    const before = s.export_dxf();
    const result = run("explode", { handles: [b] });
    assert.equal(result.changed, false);
    assert.deepEqual(s.export_dxf(), before);
    assert.ok(scene().entities.some((e) => e.handle === b));
  }));
test("an invalid imported block rolls the entire batch back and later edits remain usable", () =>
  drawing((s, run, scene) => {
    const c = run("circle", { center: [0, 0], radius: 3 }).handle;
    run("block", { name: "BAD", handles: [c], base: [0, 0] });
    const block = run("insert", { name: "BAD", at: [20, 0] }).handle;
    const rectangle = run("rectang", { p1: [40, 0], p2: [50, 10] }).handle;
    const lines = new TextDecoder()
      .decode(s.export_dxf())
      .replaceAll("\r\n", "\n")
      .trimEnd()
      .split("\n");
    let changed = false;
    for (let i = 0; i < lines.length; i += 2)
      if (lines[i].trim() === "0" && lines[i + 1] === "INSERT") {
        let end = i + 2;
        while (end < lines.length && lines[end].trim() !== "0") end += 2;
        if (lines.slice(i, end).includes(block))
          for (let j = i; j < end; j += 2)
            if (lines[j].trim() === "41") {
              lines[j + 1] = "0";
              changed = true;
            }
      }
    assert.ok(changed);
    s.load_dxf(new TextEncoder().encode(lines.join("\n") + "\n"));
    const before = s.export_dxf();
    const result = run("explode", { handles: [rectangle, block] });
    assert.equal(result.changed, false);
    assert.equal(typeof result.problem, "string");
    assert.deepEqual(s.export_dxf(), before);
    const count = scene().entities.length;
    run("line", {
      points: [
        [0, 50],
        [10, 50],
      ],
    });
    assert.equal(scene().entities.length, count + 1);
    run("undo");
    assert.equal(scene().entities.length, count);
  }));
