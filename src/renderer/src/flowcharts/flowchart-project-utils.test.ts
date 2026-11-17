import type { FlowchartProjectDescriptor } from "../../../shared/flowcharts/model";
import { buildAutomaticFlowchartName, sortFlowchartProjects } from "./flowchart-project-utils";

function descriptor(
  projectId: string,
  name: string,
  modifiedAt: string,
): FlowchartProjectDescriptor {
  return {
    projectId,
    name,
    revision: 0,
    pageCount: 1,
    lastPageId: "page-1",
    sourceSha256: "A".repeat(64),
    createdAt: "2026-08-12T00:00:00.000Z",
    modifiedAt,
  };
}

describe("flowchart project utilities", () => {
  test("sorts projects by most recently modified with a stable id tie-break", () => {
    const older = descriptor(
      "00000000-0000-4000-8000-000000000002",
      "旧工程",
      "2026-08-11T00:00:00.000Z",
    );
    const tiedB = descriptor(
      "00000000-0000-4000-8000-000000000003",
      "并列乙",
      "2026-08-12T00:00:00.000Z",
    );
    const tiedA = descriptor(
      "00000000-0000-4000-8000-000000000001",
      "并列甲",
      "2026-08-12T00:00:00.000Z",
    );

    expect(sortFlowchartProjects([older, tiedB, tiedA]).map((item) => item.name)).toEqual([
      "并列甲",
      "并列乙",
      "旧工程",
    ]);
  });

  test("builds the first unused automatic name and preserves its suffix", () => {
    const projects = [
      descriptor(
        "00000000-0000-4000-8000-000000000001",
        "测试专利-流程图1",
        "2026-08-12T00:00:00.000Z",
      ),
      descriptor(
        "00000000-0000-4000-8000-000000000002",
        "测试专利-流程图3",
        "2026-08-12T00:00:00.000Z",
      ),
    ];

    expect(buildAutomaticFlowchartName(" 测试专利 ", projects)).toBe("测试专利-流程图2");
    expect(buildAutomaticFlowchartName(null, [])).toBe("未命名专利-流程图1");
    const longName = buildAutomaticFlowchartName("专".repeat(240), []);
    expect(longName).toHaveLength(200);
    expect(longName.endsWith("-流程图1")).toBe(true);
  });
});
