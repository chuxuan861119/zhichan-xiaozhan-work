import { loadDrawioRuntimeFiles } from "./helpers/drawio-runtime-test-harness";

test("keeps bounded recent tools distinct and does not retain arbitrary canvas text", async () => {
  const runtime = await loadDrawioRuntimeFiles(["drawing-tools.js"]);
  const tools = runtime.PatentDrawingTools as {
    remember: (entries: object[], entry: object) => Array<{ label: string }>;
  };
  const item = { style: "rounded=0", width: 100, height: 50, label: "处理" };
  expect(tools.remember([item], item)).toHaveLength(1);
  expect(
    tools.remember(
      Array.from({ length: 20 }, (_, i) => ({ ...item, style: `shape=${i}` })),
      item,
    ),
  ).toHaveLength(12);
});
test("numbers selected steps once instead of accumulating old prefixes", async () => {
  const runtime = await loadDrawioRuntimeFiles(["drawing-tools.js"]);
  const tools = runtime.PatentDrawingTools as {
    stepLabel: (text: string, index: number) => string;
  };
  expect(tools.stepLabel("S20：检测", 0)).toBe("S10：检测");
  expect(tools.stepLabel("计算", 1)).toBe("S20：计算");
});
