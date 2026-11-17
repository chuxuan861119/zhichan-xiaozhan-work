import { expect, test, vi } from "vitest";
import { MacCadMeshCache } from "./mac-cad-mesh-cache";
import type { CadScene } from "./cadcraft-client";

test("reuses a mesh across tool remounts but invalidates scene, handles and label widths", () => {
  const cache = new MacCadMeshCache();
  const scene = {} as CadScene,
    other = {} as CadScene;
  const build = vi.fn(() => ({
    vertices: new Float32Array(8),
    origin: [0, 0] as [number, number],
    fallback: [],
  }));
  const mesh = cache.get(scene, "handles/labels", build);
  expect(cache.get(scene, "handles/labels", build)).toBe(mesh);
  expect(build).toHaveBeenCalledTimes(1);
  expect(cache.get(scene, "changed handles/labels", build)).not.toBe(mesh);
  cache.get(other, "changed handles/labels", build);
  cache.get(scene, "changed handles/labels", build);
  expect(build).toHaveBeenCalledTimes(4);
});

test("does not retain a mesh above the memory budget", () => {
  const cache = new MacCadMeshCache(4),
    scene = {} as CadScene;
  const build = vi.fn(() => ({
    vertices: new Float32Array(8),
    origin: [0, 0] as [number, number],
    fallback: [],
  }));
  cache.get(scene, "a", build);
  cache.get(scene, "a", build);
  expect(build).toHaveBeenCalledTimes(2);
});
