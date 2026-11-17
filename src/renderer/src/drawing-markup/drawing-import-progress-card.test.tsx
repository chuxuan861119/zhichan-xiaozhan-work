import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { DrawingImportProgressEvent } from "../../../shared/drawing-markup/import-progress";
import { DrawingImportProgressCard } from "./drawing-import-progress-card";

afterEach(cleanup);
const progress: DrawingImportProgressEvent = {
  sessionId: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  stage: { phase: "draw", completed: 500, total: 1000 },
  elapsedMs: 80000,
  overallPercent: 60,
  estimatedRemainingMs: [40000, 70000],
  takingLonger: false,
};
test("keeps progress information rows mounted through stage changes and cancellation", () => {
  const view = render(<DrawingImportProgressCard progress={null} message="正在导入" />);
  const elapsed = screen.getByText("已用0秒");
  const count = screen.getByText("当前步骤处理中");
  view.rerender(<DrawingImportProgressCard progress={progress} message="正在导入" />);
  expect(screen.getByText("预计总体进度 60% · 已用1分20秒")).toBe(elapsed);
  expect(screen.getByText("已处理图形 500 / 1,000 个")).toBe(count);
  view.rerender(
    <DrawingImportProgressCard
      progress={{ ...progress, stage: { phase: "serialize", completed: null, total: null } }}
      message="正在导入"
    />,
  );
  expect(screen.getByText("当前步骤处理中")).toBe(count);
  expect(screen.getByText("已用1分20秒")).toBe(elapsed);
  view.rerender(<DrawingImportProgressCard progress={progress} message="正在取消导入" />);
  expect(screen.getByText("正在取消当前步骤")).toBe(count);
  expect(screen.queryByText(/已处理图形/)).toBeNull();
});
test("shows measured counts, estimated progress and elapsed time without remaining-time estimates", () => {
  render(<DrawingImportProgressCard progress={progress} message="正在导入1/1：测试图纸" />);
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("60");
  expect(screen.getByText("已处理图形 500 / 1,000 个")).toBeTruthy();
  expect(screen.getByText("预计总体进度 60% · 已用1分20秒")).toBeTruthy();
  expect(screen.queryByText(/预计还需|估算剩余时间/)).toBeNull();
});
test("unknown totals and exceeded estimates do not claim completion or count down to zero", () => {
  render(
    <DrawingImportProgressCard
      progress={{
        ...progress,
        stage: { phase: "read", completed: 500, total: null },
        estimatedRemainingMs: null,
        takingLonger: true,
      }}
      message="正在导入"
    />,
  );
  expect(screen.getByText("已读取图纸内部对象 500 个")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
  expect(screen.queryByText(/预计总体进度/)).toBeNull();
  expect(screen.getByText("已用1分20秒")).toBeTruthy();
  expect(screen.queryByText(/预计还需|估算剩余时间/)).toBeNull();
  expect(screen.queryByText(/剩余0秒|100%/)).toBeNull();
});

test("a long quiet stage offers waiting or cancellation without adding or removing progress rows", () => {
  const view = render(<DrawingImportProgressCard progress={progress} message="正在导入" />);
  const count = screen.getByText("已处理图形 500 / 1,000 个");
  view.rerender(
    <DrawingImportProgressCard
      progress={{ ...progress, waitingForActivity: true }}
      message="正在导入"
    />,
  );
  expect(screen.getByText("正在生成图形 · 可继续等待或取消")).toBeTruthy();
  expect(screen.getByText("已处理图形 500 / 1,000 个")).toBe(count);
});

test.each([
  ["read", "已读取图纸内部对象 878,336 个"],
  ["draw", "已处理图形 878,336 个"],
  ["svg", "已处理绘图指令 878,336 条"],
  ["serialize", "已整理预览分块 878,336 个"],
  ["preview", "已准备预览分块 878,336 个"],
] as const)("names the counted data in %s", (phase, label) => {
  render(
    <DrawingImportProgressCard
      progress={{ ...progress, stage: { phase, completed: 878336, total: null } }}
      message="正在导入"
    />,
  );
  const count = screen.getByText(label);
  if (phase === "read") expect(count.title).toContain("数量不代表文件数量");
  expect(screen.queryByText(/当前步骤已处理| 项/)).toBeNull();
});
