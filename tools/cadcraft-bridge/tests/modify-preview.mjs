import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../../resources/cadcraft/wasm/", import.meta.url);
const source = await readFile(new URL("cadcraft.js", root), "utf8");
const bridge = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
bridge.initSync({ module: await readFile(new URL("cadcraft_bg.wasm", root)) });

test("retained checkpoints checkout exact geometry and definitions and stay immutable", () => {
  const s = new bridge.CadcraftSession(),
    run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    run("rectang", { p1: [0, 0], p2: [10, 10] });
    const first = JSON.parse(s.scene());
    run("bridge.remember", { key: "first" });
    run("move", { handles: [first.entities[0].handle], delta: [30, 20] });
    run("group", { handles: [first.entities[0].handle] });
    const second = JSON.parse(s.scene());
    run("bridge.remember", { key: "second" });
    assert.equal(run("bridge.checkout", { key: "missing" }).restored, false);
    assert.equal(run("bridge.checkout", { key: "first" }).restored, true);
    assert.deepEqual(JSON.parse(s.scene()).primitives, first.primitives);
    assert.deepEqual(JSON.parse(s.scene()).groups, first.groups);
    run("erase", { handles: [first.entities[0].handle] });
    assert.equal(run("bridge.checkout", { key: "second" }).restored, true);
    assert.deepEqual(JSON.parse(s.scene()).primitives, second.primitives);
    assert.deepEqual(JSON.parse(s.scene()).groups, second.groups);
    run("bridge.remember", { key: "second", forget: ["first"] });
    assert.equal(run("bridge.checkout", { key: "first" }).restored, false);
  } finally {
    s.free();
  }
});

test("editing returns only changed geometry while retaining undo and export", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    run("line", {
      points: [
        [0, 0],
        [10, 0],
      ],
    });
    const h = JSON.parse(s.scene()).entities[0].handle;
    run("circle", { center: [30, 30], radius: 5 });
    const before = JSON.parse(s.scene());
    const edit = run("bridge.edit", { command: "move", params: { handles: [h], delta: [1, 2] } });
    assert.equal(edit.scene.partial, true);
    assert.equal(edit.scene.entities.length, 1);
    assert.equal(edit.scene.entities[0].handle, h);
    const full = JSON.parse(s.scene());
    assert.deepEqual(
      edit.scene.primitives,
      full.primitives.filter((p) => p.handle === h),
    );
    const restored = new bridge.CadcraftSession();
    try {
      restored.load_dxf(s.export_dxf());
      assert.deepEqual(JSON.parse(restored.scene()).primitives, full.primitives);
    } finally {
      restored.free();
    }
    run("undo", {});
    assert.deepEqual(JSON.parse(s.scene()).primitives, before.primitives);
  } finally {
    s.free();
  }
});

test("immutable command checkpoints reproduce edits, groups and hatches without mutating earlier revisions", () => {
  const live = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(live.execute(c, JSON.stringify(p)));
  const edits = [];
  const frames = [];
  const source = live.export_dxf();
  const edit = (command, params) => {
    const result = run("bridge.edit", { command, params }).result;
    edits.push({ command, params });
    frames.push({ edits: structuredClone(edits), scene: JSON.parse(live.scene()) });
    return result;
  };
  try {
    const h = edit("rectang", { p1: [0, 0], p2: [10, 10] }).handle;
    edit("hatch", { handles: [h], pattern: "SOLID", scale: 1, angle: 0 });
    edit("move", { handles: [h], delta: [3, 4] });
    const hs = JSON.parse(live.scene()).entities.map((e) => e.handle);
    edit("group", { handles: hs });
    edit("ungroup", { handles: hs });
    edit("trim", { handle: h, pick: [8, 4], mode: "quick" });
    for (const frame of frames) {
      const replay = new bridge.CadcraftSession(),
        reload = new bridge.CadcraftSession();
      try {
        replay.load_dxf(source);
        for (const e of frame.edits) replay.execute(e.command, JSON.stringify(e.params));
        assert.deepEqual(JSON.parse(replay.scene()).primitives, frame.scene.primitives);
        assert.deepEqual(JSON.parse(replay.scene()).groups, frame.scene.groups);
        reload.load_dxf(replay.export_dxf());
        assert.deepEqual(JSON.parse(reload.scene()).primitives, frame.scene.primitives);
      } finally {
        replay.free();
        reload.free();
      }
    }
  } finally {
    live.free();
  }
});
test("compact modify preview only returns changed geometry and deleted handles", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const h = run("rectang", { p1: [0, 0], p2: [10, 10] }).handle;
    run("circle", { center: [30, 30], radius: 5 });
    const before = s.scene();
    const params = { handle: h, pick: [5, 0], mode: "quick" };
    const preview = run("bridge.preview_modify", { command: "trim", params, compact: true });
    assert.equal(preview.partial, true);
    assert.deepEqual(preview.removedHandles, [h]);
    assert.equal(preview.entities.length, 1);
    assert.equal(s.scene(), before);
    run("trim", params);
    const result = JSON.parse(s.scene());
    assert.deepEqual(
      result.entities.filter((e) => e.type === "Polyline"),
      preview.entities,
    );
    run("undo", {});
    assert.deepEqual(JSON.parse(s.scene()).primitives, JSON.parse(before).primitives);
  } finally {
    s.free();
  }
});
test("a prior preview cannot overwrite an intervening edit and undo keeps that edit", () => {
  const s = new bridge.CadcraftSession(),
    run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const h = run("rectang", { p1: [0, 0], p2: [10, 10] }).handle;
    const params = { handle: h, pick: [5, 0], mode: "quick" };
    run("bridge.preview_modify", { command: "trim", params, compact: true });
    run("circle", { center: [30, 30], radius: 5 });
    run("trim", params);
    assert.equal(JSON.parse(s.scene()).entities.length, 2);
    run("undo", {});
    assert.equal(JSON.parse(s.scene()).entities.length, 2);
  } finally {
    s.free();
  }
});

for (const command of ["trim", "extend"])
  test(`${command} edge caches follow edits, undo and reused handles in other sessions`, () => {
    for (const initialX of [5, 3]) {
      const s = new bridge.CadcraftSession();
      const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
      try {
        const target = run("line", {
          points: [
            [0, 0],
            [command === "trim" ? 10 : 2, 0],
          ],
        }).handles[0];
        const edge = run("line", {
          points: [
            [initialX, -5],
            [initialX, 5],
          ],
        }).handles[0];
        const params = { handle: target, pick: [command === "trim" ? 9 : 2, 0], mode: "quick" };
        const preview = (expected) => {
          const before = s.scene();
          const result = run("bridge.preview_modify", { command, params });
          const horizontal = result.primitives.find(
            (p) => p.points.length > 1 && p.points.every((v) => v[1] === 0),
          );
          assert.ok(horizontal);
          assert.equal(Math.max(...horizontal.points.map((v) => v[0])), expected);
          assert.equal(s.scene(), before, "preview must not mutate history");
        };
        preview(initialX);
        run("move", { handles: [edge], delta: [2, 0] });
        preview(initialX + 2);
        run("undo", {});
        preview(initialX);
      } finally {
        s.free();
      }
    }
  });
