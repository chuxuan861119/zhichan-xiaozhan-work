import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const bundle = await build({
  entryPoints: ["src/renderer/src/drawing-markup/cad-rectangle.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { rectangleGeometry } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const root = new URL("../../../resources/cadcraft/wasm/", import.meta.url);
const source = await readFile(new URL("cadcraft.js", root), "utf8");
const bridge = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
bridge.initSync({ module: await readFile(new URL("cadcraft_bg.wasm", root)) });
const distance = (p, a, b) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    d = dx * dx + dy * dy;
  const t = d ? Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / d)) : 0;
  return Math.hypot(p.x - a[0] - t * dx, p.y - a[1] - t * dy);
};
for (const method of ["rectang", "rectang.center", "rectang.3p", "rectang.center-rotated"])
  for (const corner of ["sharp", "round", "chamfer"])
    for (const sign of [-1, 1])
      test(`${method} ${corner} ${sign}: local preview, native grips, history and DXF/SVG stay consistent`, () => {
        const s = new bridge.CadcraftSession(),
          restored = new bridge.CadcraftSession();
        const run = (command, params = {}) =>
          JSON.parse(s.execute(command, JSON.stringify(params)));
        try {
          const points =
            method.includes("3p") || method.includes("rotated")
              ? [
                  { x: 10, y: 20 },
                  { x: 40, y: 60 },
                  { x: 10 + sign * 40, y: 20 - sign * 30 },
                ]
              : [
                  { x: 10, y: 20 },
                  { x: 10 + sign * 50, y: 20 - sign * 30 },
                ];
          const before = s.export_dxf();
          const { command, params, path } = rectangleGeometry(method, points, { corner, size: 3 });
          assert.deepEqual(s.export_dxf(), before, "preview must not edit the document");
          const handle = run(command, params).handle;
          const scene = JSON.parse(s.scene());
          assert.equal(scene.entities.length, 1);
          assert.ok(scene.entities[0].grips.length >= 8);
          const segments = scene.primitives.flatMap((p) =>
            p.points.slice(1).map((b, i) => [p.points[i], b]),
          );
          for (const p of path)
            assert.ok(
              Math.min(...segments.map(([a, b]) => distance(p, a, b))) < 0.05,
              "local preview matches native edges",
            );
          assert.match(s.export_svg(), /<svg/);
          run("undo");
          assert.equal(JSON.parse(s.scene()).entities.length, 0);
          run("redo");
          assert.deepEqual(JSON.parse(s.scene()).entities[0].geometry, scene.entities[0].geometry);
          restored.load_dxf(s.export_dxf());
          const reloaded = JSON.parse(restored.scene());
          assert.equal(reloaded.entities.length, 1);
          assert.deepEqual(reloaded.entities[0].geometry, scene.entities[0].geometry);
          if (process.platform === "win32") {
            const codec = (mode, input) =>
              execFileSync(fileURLToPath(new URL("../cadcraft-codec.exe", root)), [mode], {
                input,
                maxBuffer: 20 * 1024 * 1024,
                windowsHide: true,
              });
            const dwg = codec("dxf-to-dwg", s.export_dxf());
            assert.equal(dwg.subarray(0, 2).toString(), "AC");
            restored.load_dxf(codec("dwg-to-dxf", dwg));
            const after = JSON.parse(restored.scene());
            assert.equal(after.entities.length, 1);
            assert.deepEqual(
              after.entities[0].geometry,
              scene.entities[0].geometry,
              "DWG preserves corners and editable polyline",
            );
          }
          const grip = scene.entities[0].grips[0];
          run("grip.move", { handle, index: 0, to: [grip[0] + 1, grip[1] + 1] });
          assert.notDeepEqual(
            JSON.parse(s.scene()).entities[0].geometry,
            scene.entities[0].geometry,
          );
          run("undo");
          assert.deepEqual(JSON.parse(s.scene()).entities[0].geometry, scene.entities[0].geometry);
          const [a, b] = [params.p1, params.p2];
          run("hatch", {
            points: [[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]],
            pattern: "ANSI31",
            scale: 1,
          });
          assert.equal(
            JSON.parse(s.scene()).entities.length,
            2,
            "point-picked hatch recognizes the closed rectangle",
          );
        } finally {
          s.free();
          restored.free();
        }
      });
