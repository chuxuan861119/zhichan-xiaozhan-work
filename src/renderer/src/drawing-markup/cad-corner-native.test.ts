// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import init, { CadcraftSession } from "../../../../resources/cadcraft/wasm/cadcraft.js";
import { cornerCandidates, cornerGeometry } from "./cad-corner";
import type { CadScene } from "./cadcraft-client";
await init({
  module_or_path: readFileSync(
    new URL("../../../../resources/cadcraft/wasm/cadcraft_bg.wasm", import.meta.url),
  ),
});
test.each(["lines", "polyline", "rectangle"])(
  "%s round and asymmetric chamfer remain editable after native DXF reload",
  (shape) => {
    for (const kind of ["fillet", "chamfer"] as const) {
      const k = new CadcraftSession();
      try {
        if (shape === "lines") {
          k.execute(
            "line",
            JSON.stringify({
              points: [
                [100, 0],
                [0, 0],
              ],
            }),
          );
          k.execute(
            "line",
            JSON.stringify({
              points: [
                [0, 0],
                [0, 100],
              ],
            }),
          );
        } else if (shape === "polyline")
          k.execute(
            "pline",
            JSON.stringify({
              points: [
                [100, 0],
                [0, 0],
                [0, 100],
              ],
              closed: false,
            }),
          );
        else k.execute("rectang", JSON.stringify({ p1: [0, 0], p2: [100, 100] }));
        const before = JSON.parse(k.scene()) as CadScene,
          t = cornerCandidates(before, kind)[0]!;
        const value = { kind, a: 20, b: 10 };
        k.execute("bridge.corner", JSON.stringify(cornerGeometry(t, value).params));
        const after = JSON.parse(k.scene()) as CadScene;
        expect(after.entityCount).toBe(shape === "lines" ? 3 : 1);
        k.load_dxf(k.export_dxf());
        const restored = JSON.parse(k.scene()) as CadScene;
        const selected = cornerCandidates(restored, kind).find((t) => t.existing)!;
        expect(selected).toBeDefined();
        const change = cornerGeometry(selected, { kind, a: 30, b: 15 });
        k.execute("bridge.corner", JSON.stringify(change.params));
        expect((JSON.parse(k.scene()) as CadScene).entityCount).toBe(after.entityCount);
        k.execute("undo", "{}");
        expect((JSON.parse(k.scene()) as CadScene).entities.map((e) => e.geometry)).toEqual(
          restored.entities.map((e) => e.geometry),
        );
      } finally {
        k.free();
      }
    }
  },
);
test("a rounded polyline refreshes its associative hatch in the same undo record", () => {
  const k = new CadcraftSession();
  try {
    k.execute("rectang", JSON.stringify({ p1: [0, 0], p2: [100, 100] }));
    k.execute("hatch", JSON.stringify({ points: [[50, 50]], pattern: "ANSI31", scale: 2 }));
    const before = JSON.parse(k.scene()) as CadScene;
    const h = before.entities.find((e) => e.type === "Hatch")!;
    const corner = cornerCandidates(before, "fillet")[0]!;
    k.execute(
      "bridge.corner",
      JSON.stringify(cornerGeometry(corner, { kind: "fillet", a: 30, b: 30 }).params),
    );
    const after = JSON.parse(k.scene()) as CadScene;
    expect(after.entities.find((e) => e.handle === h.handle)?.geometry).not.toEqual(h.geometry);
    k.execute("undo", "{}");
    expect((JSON.parse(k.scene()) as CadScene).entities.map((e) => e.geometry)).toEqual(
      before.entities.map((e) => e.geometry),
    );
  } finally {
    k.free();
  }
});
