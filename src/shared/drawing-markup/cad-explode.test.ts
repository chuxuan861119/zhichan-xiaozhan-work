// @vitest-environment node
import { describe, expect, it } from "vitest";
import { planCadExplode } from "./cad-explode.js";
import { applyCadMutation } from "./cad-mutation.js";
import { cadObjectGroup } from "./cad-objects.js";
import { createDetailView } from "./detail-view.js";
import { drawingProjectFixture } from "./test-fixture.js";

function project() {
  const p = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  p.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "0".repeat(40),
    assetId: p.sourceAssetId,
    unified: 1,
    mapping: { originX: 0, originY: 100, scale: 1 },
    objects: [
      { id: "d", kind: "detail", body: ["A"], frame: ["B"], source: ["C"] },
      { id: "label", kind: "label", label: ["D"] },
    ],
  };
  p.detailViews = [createDetailView(p, { x: 20, y: 20 }, 5, { x: 60, y: 60 }, "A", 2, 8, 1, "d")];
  return p;
}
describe("CAD semantic explode", () => {
  it("detaches an entire detail including its unselected source marker, never other labels", () => {
    const p = project();
    const plan = planCadExplode(p, ["A", "B", "D", "E"]);
    expect(plan.handles).toEqual(["E"]);
    expect(plan.retained).toBe(1);
    expect(plan.details).toEqual([
      {
        id: "d",
        handles: ["A", "B", "C"],
        groups: (["label", "body", "frame", "source"] as const).map((role) =>
          cadObjectGroup({ id: "d", kind: "detail", role }),
        ),
      },
    ]);
  });
  it("keeps internal detail editing and source-only selection distinct", () => {
    const p = project();
    expect(planCadExplode(p, ["A"], "d").handles).toEqual(["A"]);
    expect(planCadExplode(p, ["A"], "d").details).toEqual([]);
    expect(planCadExplode(p, ["C"]).details).toEqual([]);
    expect(planCadExplode(p, ["C"]).handles).toEqual([]);
  });
  it("retains bitmap details rather than deleting their non-native image content", () => {
    const p = project();
    p.cad!.overlayAssetId = p.baseAssetId;
    expect(planCadExplode(p, ["A", "B"]).details).toEqual([]);
    expect(planCadExplode(p, ["A", "B"]).handles).toEqual([]);
  });
  it("removes only successfully detached detail metadata and leaves ordinary annotations intact", () => {
    const p = project();
    const next = applyCadMutation(
      p,
      {
        command: "explode",
        params: { handles: [] },
        result: { detached: ["d"], changed: true },
        before: ["A", "B", "C", "D"],
        after: ["A", "B", "C", "D"],
      },
      () => "unused",
    );
    expect(next.detailViews).toEqual([]);
    expect(next.cad!.objects).toEqual([p.cad!.objects![1]]);
    expect(next.annotations).toEqual(p.annotations);
    expect(p.detailViews).toHaveLength(1);
  });
  it("does not detach on a failed or skipped native operation", () => {
    const p = project();
    const next = applyCadMutation(
      p,
      {
        command: "explode",
        params: { details: [{ id: "d" }] },
        result: { changed: false },
        before: [],
        after: [],
      },
      () => "unused",
    );
    expect(next.detailViews).toEqual(p.detailViews);
  });
});
