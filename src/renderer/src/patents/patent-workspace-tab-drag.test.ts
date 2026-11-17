import { describe, expect, test } from "vitest";
import {
  createSingleWorkspace,
  enterDualWorkspace,
  selectPaneTarget,
} from "./patent-workspace-layout";
import {
  classifyWorkspaceTabDrop,
  passedWorkspaceTabDragThreshold,
  workspacePaneAtPoint,
} from "./patent-workspace-tab-drag";

const claims = { patentId: "patent-a", bookKind: "claims" } as const;
const description = { patentId: "patent-a", bookKind: "description" } as const;
const abstract = { patentId: "patent-a", bookKind: "abstract" } as const;
const drawingMarkup = { patentId: "patent-a", kind: "tool", tool: "drawing-markup" } as const;
const flowchart = { patentId: "patent-a", kind: "tool", tool: "flowchart" } as const;
const rect = {
  left: 100,
  top: 200,
  right: 1100,
  bottom: 800,
  width: 1000,
  height: 600,
};

describe("patent workspace tab drag", () => {
  test("requires six pixels before starting a drag", () => {
    expect(passedWorkspaceTabDragThreshold({ x: 10, y: 10 }, { x: 14, y: 13 })).toBe(false);
    expect(passedWorkspaceTabDragThreshold({ x: 10, y: 10 }, { x: 16, y: 10 })).toBe(true);
  });

  test("accepts the whole workspace and splits it at the horizontal midpoint", () => {
    expect(workspacePaneAtPoint(rect, { x: 101, y: 201 })).toBe("left");
    expect(workspacePaneAtPoint(rect, { x: 1099, y: 799 })).toBe("right");
    expect(workspacePaneAtPoint(rect, { x: 99, y: 500 })).toBeNull();
    expect(workspacePaneAtPoint(rect, { x: 500, y: 199 })).toBeNull();
  });

  test("classifies single-document current and other targets", () => {
    const single = createSingleWorkspace(claims);
    expect(classifyWorkspaceTabDrop(single, "left", claims)).toBe("split-current");
    expect(classifyWorkspaceTabDrop(single, "right", description)).toBe("split-other");
  });

  test("classifies dual activation, replacement, and swap", () => {
    const dual = selectPaneTarget(
      enterDualWorkspace(createSingleWorkspace(claims)),
      "right",
      description,
    ).state;
    expect(classifyWorkspaceTabDrop(dual, "left", claims)).toBe("activate");
    expect(classifyWorkspaceTabDrop(dual, "left", abstract)).toBe("replace");
    expect(classifyWorkspaceTabDrop(dual, "right", claims)).toBe("swap");
  });

  test("classifies tool tabs in both single and dual layouts", () => {
    const single = createSingleWorkspace(claims);

    // 单屏内嵌 CAD标号 时屏幕上显示的是工具：拖回同一个工具 = 当前文档。
    expect(classifyWorkspaceTabDrop(single, "left", drawingMarkup, drawingMarkup)).toBe(
      "split-current",
    );
    expect(classifyWorkspaceTabDrop(single, "left", claims, drawingMarkup)).toBe("split-other");
    // 没有覆盖值时沿用单屏记录的书册。
    expect(classifyWorkspaceTabDrop(single, "left", claims)).toBe("split-current");

    const dual = selectPaneTarget(
      enterDualWorkspace(createSingleWorkspace(claims)),
      "right",
      drawingMarkup,
    ).state;
    expect(classifyWorkspaceTabDrop(dual, "right", drawingMarkup)).toBe("activate");
    expect(classifyWorkspaceTabDrop(dual, "left", drawingMarkup)).toBe("swap");
    expect(classifyWorkspaceTabDrop(dual, "left", flowchart)).toBe("replace");
  });
});
