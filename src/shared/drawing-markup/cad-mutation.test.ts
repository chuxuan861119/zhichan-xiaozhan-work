// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyCadMutation, type CadMutation, expandPatentSelection } from "./cad-mutation.js";
import { createDetailView } from "./detail-view.js";
import type { DrawingProject } from "./model.js";

const fixture = (): DrawingProject => ({
  projectId: "00000000-0000-4000-8000-000000000801",
  name: "图",
  sourceAssetId: "00000000-0000-4000-8000-000000000901",
  baseAssetId: "00000000-0000-4000-8000-000000000902",
  sourceKind: "dxf",
  pageNumber: 1,
  width: 100,
  height: 100,
  regions: [],
  warnings: [],
  revision: 0,
  annotations: [
    {
      id: "a",
      text: "12",
      x: 30,
      y: 20,
      fontSize: 10,
      lineWidth: 1,
      points: [
        { x: 10, y: 10 },
        { x: 30, y: 20 },
      ],
    },
  ],
  cad: {
    version: 1,
    engine: "cadcraft",
    engineVersion: "0".repeat(40),
    assetId: "00000000-0000-4000-8000-000000000903",
    mapping: { originX: 0, originY: 100, scale: 1 },
    unified: 1,
    objects: [{ id: "a", kind: "label", label: ["A", "B"] }],
  },
});
const edit = (
  command: string,
  params: Record<string, unknown>,
  extra: Partial<CadMutation> = {},
): CadMutation => ({
  command,
  params,
  result: {},
  before: ["1", "A", "B"],
  after: ["1", "A", "B"],
  ...extra,
});
describe("Unified CAD patent mutation", () => {
  it("moves fully enclosed stretch labels in semantic coordinates without moving unrelated labels",()=>{
    const p=fixture();
    const next=applyCadMutation(p,edit("stretch",{handles:["1","A","B"],moveHandles:["A","B"],delta:[10,5]}),()=>"unused");
    expect(next.annotations[0]).toMatchObject({x:40,y:15,fontSize:10,points:[{x:20,y:5},{x:40,y:15}]});
    const stationary=applyCadMutation(p,edit("stretch",{handles:["1"],moveHandles:[],delta:[10,5]}),()=>"unused");
    expect(stationary.annotations).toEqual(p.annotations);
  });
  it("keeps special object appearance in semantic metadata without changing geometry", () => {
    const p = fixture();
    const next = applyCadMutation(
      p,
      edit("bridge.appearance", {
        handles: ["A", "B"],
        color: "#123456",
        lineweight: 0.7,
        linetype: "DASHED",
      }),
      () => "unused",
    );
    expect(next.cad!.objects![0]).toMatchObject({
      appearance: { label: { color: "#123456", lineweight: 0.7, linetype: "DASHED" } },
    });
    expect(next.annotations).toEqual(p.annotations);
    expect(p.cad!.objects![0]).not.toHaveProperty("appearance");
  });
  it("assigns separately picked fills by their own boundaries, never all to the first detail", () => {
    const p = fixture();
    p.cad!.objects = [{ id: "d", kind: "detail", body: ["D1"], frame: ["F1"] }];
    const next = applyCadMutation(
      p,
      edit(
        "hatch",
        {
          points: [
            [80, 80],
            [20, 20],
          ],
          separate: true,
        },
        {
          before: ["D1", "F1", "1"],
          after: ["D1", "F1", "1", "H1", "H2"],
          result: {
            hatches: [
              { handle: "H1", sources: ["D1"] },
              { handle: "H2", sources: ["1"] },
            ],
          },
        },
      ),
      () => "unused",
    );
    expect(next.cad!.objects![0]!.body).toEqual(["D1", "H1"]);
  });
  it("expands number text and leader as one object while allowing mixed selection", () => {
    expect(expandPatentSelection(fixture(), ["1", "B"])).toEqual(["1", "B", "A"]);
  });
  it("moves mixed native geometry and patent semantics in the same coordinate system", () => {
    const p = fixture(),
      before = JSON.stringify(p);
    const next = applyCadMutation(
      p,
      edit("move", { handles: ["1", "A", "B"], delta: [10, 5] }),
      () => "copy",
    );
    expect(next.annotations[0]).toMatchObject({
      x: 40,
      y: 15,
      points: [
        { x: 20, y: 5 },
        { x: 40, y: 15 },
      ],
    });
    expect(JSON.stringify(p)).toBe(before);
  });
  it("copies patent metadata to returned native handles and keeps originals", () => {
    const next = applyCadMutation(
      fixture(),
      edit(
        "copy",
        { handles: ["1", "A", "B"], delta: [10, 0] },
        { result: { handles: ["2", "C", "D"] }, after: ["1", "2", "A", "B", "C", "D"] },
      ),
      () => "copy",
    );
    expect(next.annotations).toHaveLength(2);
    expect(next.cad!.objects![1]).toEqual({ id: "copy", kind: "label", label: ["C", "D"] });
    expect(next.annotations[1]!.x).toBe(40);
  });
  it("deletes the number and every semantic reference when deleting its group", () => {
    const next = applyCadMutation(
      fixture(),
      edit("erase", { handles: ["A", "B"] }, { after: ["1"] }),
      () => "copy",
    );
    expect(next.annotations).toEqual([]);
    expect(next.cad!.objects).toEqual([]);
  });
  it("keeps a detail's source fixed when moving its body and title", () => {
    const p = fixture();
    p.detailViews = [
      createDetailView(p, { x: 20, y: 20 }, 10, { x: 70, y: 70 }, "A", 2, 8, 1, "d"),
    ];
    p.cad!.objects!.push({ id: "d", kind: "detail", body: ["C"], frame: ["D"], source: ["E"] });
    const e = edit(
      "move",
      { handles: ["C", "D"], delta: [10, 0] },
      { before: ["A", "B", "C", "D", "E"], after: ["A", "B", "C", "D", "E"] },
    );
    const next = applyCadMutation(p, e, () => "copy");
    expect(next.detailViews![0]!.center).toEqual({ x: 80, y: 70 });
    expect(next.detailViews![0]!.source).toEqual({ x: 20, y: 20 });
    expect(next.detailViews![0]!.title.x).toBe(80);
  });
  it("adds newly drawn geometry to the edited detail without moving its semantic center", () => {
    const p = fixture();
    p.detailViews = [
      createDetailView(p, { x: 20, y: 20 }, 10, { x: 70, y: 70 }, "A", 2, 8, 1, "d"),
    ];
    p.cad!.objects!.push({ id: "d", kind: "detail", body: ["C"], frame: ["D"] });
    const next = applyCadMutation(
      p,
      edit(
        "line",
        {
          points: [
            [70, 30],
            [80, 30],
          ],
        },
        { inside: "d", before: ["A", "B", "C", "D"], after: ["A", "B", "C", "D", "E"] },
      ),
      () => "copy",
    );
    expect(next.cad!.objects!.find((o) => o.id === "d")!.body).toEqual(["C", "E"]);
    expect(next.detailViews).toEqual(p.detailViews);
  });
});

it("accepts the native EXTEND null result without discarding patent metadata", () => {
  const project = fixture();
  expect(
    applyCadMutation(project, edit("extend", { handle: "1" }, { result: null }), () => "unused"),
  ).toEqual(project);
});
