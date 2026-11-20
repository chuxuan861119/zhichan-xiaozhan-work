import { expect, test } from "vitest";
import { rulerClusterLabel, rulerMarkerClusters } from "./ruler-marker-clusters";

test("summarizes errors, paragraph ranges and chapters meaningfully", () => {
  expect(
    rulerClusterLabel([
      { label: "[0036]", kind: "description-paragraph" },
      { label: "[0038]", kind: "description-paragraph" },
    ]),
  ).toBe("0036–0038");
  expect(
    rulerClusterLabel([
      { label: "缺少背景技术", kind: "warning", error: true },
      { label: "缺少发明内容", kind: "warning", error: true },
    ]),
  ).toBe("2 处问题");
  expect(
    rulerClusterLabel([
      { label: "技术领域", kind: "description-chapter" },
      { label: "[0001]", kind: "description-paragraph" },
    ]),
  ).toBe("技术领域\n[0001]");
  expect(
    rulerClusterLabel([
      { label: "具体实施方式", kind: "description-chapter" },
      { label: "[0009]", kind: "description-paragraph" },
      { label: "[0010]", kind: "description-paragraph" },
    ]),
  ).toBe("实施方式\n[0009–0010]");
});

test("groups overlapping labels without moving their document targets", () => {
  const result = rulerMarkerClusters(
    new Map([
      ["chapter", { top: 10 }],
      ["missing", { top: 10 }],
      ["paragraph", { top: 28 }],
      ["next", { top: 40 }],
    ]),
  );
  expect(result.get("chapter")).toEqual(["chapter", "missing", "paragraph"]);
  expect(result.has("missing")).toBe(false);
  expect(result.has("paragraph")).toBe(false);
  expect(result.get("next")).toEqual(["next"]);
});

test("sorts geometry rather than marker order and leaves separated labels alone", () => {
  expect([
    ...rulerMarkerClusters(
      new Map([
        ["last", { top: 100 }],
        ["first", { top: 0 }],
        ["second", { top: 24 }],
      ]),
    ),
  ]).toEqual([
    ["first", ["first"]],
    ["second", ["second"]],
    ["last", ["last"]],
  ]);
});

test("deferred geometry cannot group removed markers or hide a current marker behind a removed head", () => {
  const geometry = new Map([
    ["removed-head", { top: 0 }],
    ["current-first", { top: 4 }],
    ["removed-member", { top: 8 }],
    ["current-second", { top: 12 }],
    ["current-third", { top: 40 }],
  ]);
  expect([
    ...rulerMarkerClusters(geometry, new Set(["current-first", "current-second", "current-third"])),
  ]).toEqual([
    ["current-first", ["current-first", "current-second"]],
    ["current-third", ["current-third"]],
  ]);
  expect([...rulerMarkerClusters(geometry, new Set())]).toEqual([]);
});
