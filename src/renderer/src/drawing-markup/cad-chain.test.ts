import { describe, expect, it } from "vitest";
import {
  type ChainSpec,
  chainGrip,
  chainGrips,
  chainPaths,
  chainOtherRadius,
  chainMatchPitch,
} from "./cad-chain-geometry";
import { compileDrawMethod } from "./cad-draw-methods";

const spec: ChainSpec = {
  single: false,
  at: [0, 0],
  end: [108, 0],
  radius: 14,
  teeth: 23,
  otherTeeth: 17,
  hole: 2.5,
  otherHole: 1.5,
};
describe("chain drive", () => {
  it("repairs legacy mismatched wheels using the smaller unchanged tooth pitch", () => {
    for (const legacy of [
      { ...spec, otherRadius: 42 },
      { ...spec, radius: 42, otherRadius: chainOtherRadius(spec) },
    ]) {
      const next = chainMatchPitch(legacy);
      expect(2 * next.radius * Math.sin(Math.PI / next.teeth)).toBeCloseTo(
        2 * spec.radius * Math.sin(Math.PI / spec.teeth),
        10,
      );
      expect(2 * chainOtherRadius(next) * Math.sin(Math.PI / next.otherTeeth)).toBeCloseTo(
        2 * spec.radius * Math.sin(Math.PI / spec.teeth),
        10,
      );
    }
  });
  it("changes tooth count when resizing either wheel while keeping the chain pitch", () => {
    const pitch = 2 * spec.radius * Math.sin(Math.PI / spec.teeth);
    for (const index of [3, 4]) {
      const next = chainGrip(spec, index, { x: index === 3 ? 0 : 108, y: 42 });
      expect(2 * next.radius * Math.sin(Math.PI / next.teeth)).toBeCloseTo(pitch, 10);
      expect(2 * chainOtherRadius(next) * Math.sin(Math.PI / next.otherTeeth)).toBeCloseTo(
        pitch,
        10,
      );
      expect(index === 3 ? next.teeth : next.otherTeeth).toBeGreaterThan(60);
    }
  });
  it("connects both inner plate sides to adjacent outer plates around unequal wheels", () => {
    for (const resized of [spec, chainGrip(spec, 4, { x: 108, y: 42 })]) {
      const paths = chainPaths(resized);
      const outer = paths.filter((p) => p.length === 27);
      const inner = paths.filter((p) => p.length === 3);
      expect(inner.length).toBeGreaterThan(12);
      for (const path of inner)
        for (const end of [path[0]!, path[2]!]) {
          const gap = Math.min(...outer.flat().map((p) => Math.hypot(p.x - end.x, p.y - end.y)));
          expect(gap).toBeLessThan(1e-8);
        }
    }
  });
  it("keeps a usable hole grip even when the hole is disabled", () => {
    const grips = chainGrips({ ...spec, hole: 0, otherHole: 0 });
    expect(grips[5]).not.toEqual(grips[1]);
    expect(grips[6]).not.toEqual(grips[2]);
  });
  it("offers both reference assembly and single sprocket", () => {
    expect(
      compileDrawMethod(
        "chain.drive",
        [
          { x: 0, y: 0 },
          { x: 108, y: 0 },
        ],
        23,
      )?.command,
    ).toBe("bridge.chain");
    expect(
      compileDrawMethod(
        "chain.sprocket",
        [
          { x: 0, y: 0 },
          { x: 14, y: 0 },
        ],
        23,
      )?.params,
    ).toMatchObject({ single: true, radius: 14 });
  });
  it("produces closed pin circles and bounded finite reference contours", () => {
    const paths = chainPaths(spec);
    expect(paths.length).toBeGreaterThan(100);
    expect(paths.flat().every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(paths.flat().length).toBeLessThan(16000);
    expect(chainPaths({ ...spec, single: true }).length).toBe(4);
  });
  it("supports independent centers, holes, wheel size and whole scaling without mutating input", () => {
    expect(chainGrips(spec)).toHaveLength(8);
    expect(chainGrip(spec, 2, { x: 150, y: 20 }).end).toEqual([150, 20]);
    expect(chainGrip(spec, 5, { x: 0, y: -3 }).hole).toBe(3);
    expect(chainGrip(spec, 3, { x: 0, y: 20 }).radius).toBeCloseTo(20, 0);
    const g = chainGrips(spec)[7]!;
    const scaled = chainGrip(spec, 7, { x: g.x * 2, y: g.y * 2 });
    expect(scaled.radius).toBeCloseTo(28);
    expect(scaled.end[0]).toBeCloseTo(216);
    expect(spec.radius).toBe(14);
  });
  it("has deterministic lightweight synchronous previews", () => {
    const start = performance.now();
    for (let i = 0; i < 120; i++) chainPaths(chainGrip(spec, 2, { x: 108 + i / 10, y: 0 }));
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
