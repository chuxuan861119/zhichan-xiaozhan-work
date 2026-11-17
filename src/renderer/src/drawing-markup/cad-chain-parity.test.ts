// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import init, { CadcraftSession } from "../../../../resources/cadcraft/wasm/cadcraft.js";
import { chainPaths, chainGrip, chainGrips, type ChainSpec } from "./cad-chain-geometry";
import type { CadScene } from "./cadcraft-client";
await init({
  module_or_path: readFileSync(
    new URL("../../../../resources/cadcraft/wasm/cadcraft_bg.wasm", import.meta.url),
  ),
});
const spec: ChainSpec = {
  single: false,
  at: [4, -5],
  end: [112, 25],
  radius: 14,
  teeth: 23,
  otherTeeth: 17,
  hole: 2.5,
  otherHole: 1.5,
};
test("native committed geometry equals pointer preview for every semantic grip", () => {
  for (const single of [false, true])
    for (const flip of [false, true]) {
      const s = { ...spec, single, flip };
      for (let index = 0; index < chainGrips(s).length; index++) {
        const engine = new CadcraftSession();
        try {
          const h = JSON.parse(engine.execute("bridge.chain", JSON.stringify(s))).handle;
          const grip = chainGrips(s)[index]!;
          const cursor = { x: grip.x + 2, y: grip.y + 1 };
          const expected = chainPaths(chainGrip(s, index, cursor));
          engine.execute(
            "grip.move",
            JSON.stringify({ handle: h, index, to: [cursor.x, cursor.y] }),
          );
          const scene: CadScene = JSON.parse(engine.scene());
          expect(scene.primitives.length).toBe(expected.length);
          scene.primitives.forEach((p, i) => {
            expect(p.points.length).toBe(expected[i]!.length);
            p.points.forEach(([x, y], j) => {
              expect(x).toBeCloseTo(expected[i]![j]!.x, 6);
              expect(y).toBeCloseTo(expected[i]![j]!.y, 6);
            });
          });
        } finally {
          engine.free();
        }
      }
    }
});
