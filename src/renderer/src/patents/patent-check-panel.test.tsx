import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  InspectionIssue,
  PatentInspectionReport,
} from "../../../shared/patent-inspection/types";
import { PatentCheckPanel } from "./patent-check-panel";

function issue(overrides: Partial<InspectionIssue> = {}): InspectionIssue {
  return {
    fingerprint: "test.issue@1:00000001",
    ruleId: "test.issue",
    ruleVersion: 1,
    source: "deterministic",
    category: "claims",
    legacyCode: "claim-reference-warning",
    severity: "warning",
    confidence: "certain",
    summary: "权利要求存在问题。",
    evidence: [],
    locations: [{ bookKind: "claims", targetId: null }],
    recommendation: null,
    legalBasis: null,
    ...overrides,
  };
}

function reportWithIssues(
  issues: readonly InspectionIssue[],
  degradedRules: PatentInspectionReport["degradedRules"] = [],
): PatentInspectionReport {
  return {
    engineVersion: 1,
    patentId: "00000000-0000-4000-8000-000000000901",
    patentRevision: 7,
    mode: "full",
    checkedAt: "2026-08-11T08:01:00.000Z",
    issues,
    degradedRules,
  };
}

describe("patent check panel", () => {
  test("prioritizes certain findings and keeps candidates and advice separate", async () => {
    const user = userEvent.setup();
    render(
      <PatentCheckPanel
        phase="result"
        report={reportWithIssues([
          issue({ summary: "引用了不存在的权利要求9。" }),
          issue({
            fingerprint: "candidate",
            ruleId: "candidate",
            confidence: "likely",
            summary: "需要核对的候选项。",
          }),
          issue({
            fingerprint: "advice",
            ruleId: "advice",
            legacyCode: "table-fixed-row-height-warning",
            severity: "suggestion",
            confidence: "likely",
            summary: "表格使用固定行高。",
          }),
        ])}
        stale={false}
        onRun={vi.fn()}
        onRecheck={vi.fn()}
        onClose={vi.fn()}
        onLocate={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "需处理 1" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryByText("需要核对的候选项。")).toBeNull();
    expect(screen.queryByText("表格使用固定行高。")).toBeNull();
    await user.click(screen.getByRole("button", { name: "待核对 1" }));
    expect(screen.getByText("需要核对的候选项。")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "写作建议 1" }));
    expect(screen.getByText("表格使用固定行高。")).toBeDefined();
  });
  test("can temporarily ignore and restore findings without hiding them on a new report", async () => {
    const user = userEvent.setup();
    const props = {
      phase: "result" as const,
      stale: false,
      onRun: vi.fn(),
      onRecheck: vi.fn(),
      onClose: vi.fn(),
      onLocate: vi.fn(),
    };
    const report = reportWithIssues([issue({ summary: "引用无效。" })]);
    const view = render(<PatentCheckPanel {...props} report={report} />);
    await user.click(screen.getByRole("button", { name: "本次忽略" }));
    expect(screen.queryByText("引用无效。")).toBeNull();
    expect(screen.queryByText("当前检查范围内未发现问题")).toBeNull();
    await user.click(screen.getByRole("button", { name: "恢复已忽略的 1 项" }));
    expect(screen.getByText("引用无效。")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "本次忽略" }));
    view.rerender(<PatentCheckPanel {...props} report={{ ...report, patentRevision: 8 }} />);
    expect(screen.getByText("引用无效。")).toBeDefined();
  });
  test("groups missing explanations while retaining each location", async () => {
    const user = userEvent.setup();
    const problems = [1, 2].map((number) =>
      issue({
        fingerprint: `figure-${number}`,
        ruleId: "core.drawings.missing-figure",
        legacyCode: "drawing-missing-figure",
        category: "drawing-reference",
        identityKey: `explanation:figure-${number}`,
        summary: `图${number}缺少附图说明。`,
        locations: [{ bookKind: "description-drawings", targetId: `figure-${number}` }],
      }),
    );
    const onLocate = vi.fn();
    render(
      <PatentCheckPanel
        phase="result"
        report={reportWithIssues(problems)}
        stale={false}
        onRun={vi.fn()}
        onRecheck={vi.fn()}
        onClose={vi.fn()}
        onLocate={onLocate}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("图1、图2缺少附图说明")).toBeDefined();
    expect(screen.getByText("1 项")).toBeDefined();
    expect(screen.getByText("查看2处问题").closest("details")?.open).toBe(false);
    await user.click(screen.getByText("查看2处问题"));
    expect(screen.queryByText("检查依据")).toBeNull();
    const buttons = screen.getAllByRole("button", { name: "前往文档" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1] as HTMLElement);
    expect(onLocate).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: "figure-2",
        locations: [{ bookKind: "description-drawings", targetId: null }],
      }),
    );
    await user.click(screen.getByRole("tab", { name: "附图" }));
    expect(screen.getByText("图1、图2缺少附图说明")).toBeDefined();
  });
  test("pages large reports instead of rendering every issue", async () => {
    const user = userEvent.setup();
    render(
      <PatentCheckPanel
        phase="result"
        report={reportWithIssues(
          Array.from({ length: 120 }, (_, i) =>
            issue({ fingerprint: String(i), ruleId: `test.issue.${i}` }),
          ),
        )}
        patentName="测试专利"
        refreshing={false}
        stale={false}
        onRun={vi.fn()}
        onRecheck={vi.fn()}
        onLocate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
  });
  test("summarizes, filters and locates report issues", async () => {
    const user = userEvent.setup();
    const claimIssue = issue({
      severity: "error",
      summary: "权利要求引用无效。",
      recommendation: "请修改为有效的权利要求编号。",
    });
    const drawingIssue = issue({
      fingerprint: "test.drawing@1:00000002",
      ruleId: "test.drawing",
      category: "drawings",
      legacyCode: "missing-abstract-drawing",
      summary: "摘要附图尚未选择。",
      locations: [{ bookKind: "abstract-drawing", targetId: null }],
    });
    const onLocate = vi.fn();
    const onRecheck = vi.fn();
    const onClose = vi.fn();

    render(
      <PatentCheckPanel
        phase="result"
        report={reportWithIssues([claimIssue, drawingIssue])}
        patentName="测试专利"
        refreshing={false}
        stale={false}
        onRun={vi.fn()}
        onRecheck={onRecheck}
        onLocate={onLocate}
        onClose={onClose}
      />,
    );

    const panel = screen.getByRole("complementary", { name: "本地检查" });
    expect(panel.classList.contains("assistant-side-panel")).toBe(true);
    expect(panel.classList.contains("patent-check-panel--mint")).toBe(true);
    expect(within(panel).getByRole("heading", { name: "本地检查" })).toBeDefined();
    expect(within(panel).queryByText("本地校验")).toBeNull();
    expect(panel.querySelector(".assistant-side-panel__header")).not.toBeNull();
    expect(panel.querySelector(".assistant-side-panel__body")).not.toBeNull();
    expect(screen.getByText("2 项")).toBeDefined();
    expect(screen.getByRole("button", { name: "需处理 2" })).toBeDefined();
    expect(screen.getByRole("button", { name: "待核对 0" })).toBeDefined();
    expect(panel.querySelector(".patent-check-panel__meta")?.textContent).toContain("测试专利");
    expect(panel.querySelector(".patent-check-panel__meta")?.textContent).toContain("2026");
    expect(within(panel).getByRole("tablist", { name: "本地检查筛选" })).toBeDefined();
    expect(within(panel).getAllByRole("tab")).toHaveLength(6);
    await user.click(within(panel).getByRole("tab", { name: "权利要求" }));
    expect(within(panel).getByRole("tab", { name: "权利要求" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("权利要求引用无效。")).toBeDefined();
    expect(screen.queryByText("摘要附图尚未选择。")).toBeNull();

    const item = screen.getByRole("listitem", { name: "权利要求书：权利要求引用无效。" });
    expect(item.querySelector(".patent-check-panel__issue-title")?.textContent).toBe(
      "权利要求引用无效。",
    );
    expect(item.querySelector(".patent-check-panel__issue-recommendation")?.textContent).toBe(
      "核对引用的权利要求编号。",
    );
    expect(item.getAttribute("data-severity")).toBe("error");
    await user.click(within(item).getByRole("button", { name: "前往文档" }));
    expect(onLocate).toHaveBeenCalledWith(claimIssue);
    await user.click(screen.getByRole("button", { name: "重新检查" }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "关闭本地检查" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("keeps the selected filter and visible results while a report refreshes", async () => {
    const user = userEvent.setup();
    const claimIssue = issue({ summary: "权利要求筛选结果。" });
    const abstractIssue = issue({
      fingerprint: "test.abstract@1:00000003",
      category: "formal",
      summary: "摘要筛选结果。",
      locations: [{ bookKind: "abstract", targetId: null }],
    });
    const props = {
      phase: "result" as const,
      patentName: "筛选保持",
      stale: false,
      onRun: vi.fn(),
      onRecheck: vi.fn(),
      onCancel: vi.fn(),
      onLocate: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(
      <PatentCheckPanel
        {...props}
        report={reportWithIssues([claimIssue, abstractIssue])}
        refreshing={false}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "权利要求" }));

    rerender(
      <PatentCheckPanel
        {...props}
        report={reportWithIssues([claimIssue, abstractIssue])}
        refreshing
      />,
    );

    expect(screen.getByRole("tab", { name: "权利要求" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("权利要求筛选结果。")).toBeDefined();
    expect(screen.queryByText("摘要筛选结果。")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("正在更新");
    expect(screen.getByRole("button", { name: "停止检查" })).toBeDefined();
  });

  test("marks an outdated report without presenting it as clean", () => {
    render(
      <PatentCheckPanel
        phase="result"
        report={reportWithIssues([])}
        patentName="测试专利"
        refreshing={false}
        stale
        onRun={vi.fn()}
        onRecheck={vi.fn()}
        onLocate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("文档已修改，请重新检查。")).toBeDefined();
    expect(screen.queryByText("未发现问题")).toBeNull();
  });
  test("ignores only the visible occurrences after filtering by document", async () => {
    const user = userEvent.setup();
    render(
      <PatentCheckPanel
        phase="result"
        report={reportWithIssues([
          issue({ summary: "权利要求中的问题。" }),
          issue({
            fingerprint: "other-book",
            category: "formal",
            summary: "说明书中的问题。",
            locations: [{ bookKind: "description", targetId: null }],
          }),
        ])}
        stale={false}
        onRun={vi.fn()}
        onRecheck={vi.fn()}
        onClose={vi.fn()}
        onLocate={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "权利要求" }));
    await user.click(screen.getByRole("button", { name: "本次忽略" }));
    await user.click(screen.getByRole("tab", { name: "说明书" }));
    expect(screen.getByText("说明书中的问题。")).toBeDefined();
  });
  test("includes a finding in each document involved in its locations", async () => {
    const user = userEvent.setup();
    render(
      <PatentCheckPanel
        phase="result"
        report={reportWithIssues([
          issue({
            category: "numeric",
            summary: "跨文档核对项。",
            locations: [
              { bookKind: "claims", targetId: null },
              { bookKind: "description", targetId: null },
            ],
          }),
        ])}
        stale={false}
        onRun={vi.fn()}
        onRecheck={vi.fn()}
        onClose={vi.fn()}
        onLocate={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "说明书" }));
    expect(screen.getByText("跨文档核对项。")).toBeDefined();
    await user.click(screen.getByRole("tab", { name: "权利要求" }));
    expect(screen.getByText("跨文档核对项。")).toBeDefined();
  });

  test("describes a current lightweight report as incomplete, not expired or clean", () => {
    render(
      <PatentCheckPanel
        phase="result"
        report={{ ...reportWithIssues([]), mode: "instant" }}
        stale={false}
        onRun={vi.fn()}
        onRecheck={vi.fn()}
        onLocate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("当前为基础结果，请运行全文检查。")).toBeDefined();
    expect(screen.queryByText(/已过期|文档已修改|未发现问题/)).toBeNull();
  });

  test("reports degraded rules without presenting the result as clean", () => {
    render(
      <PatentCheckPanel
        phase="result"
        report={reportWithIssues(
          [],
          [{ ruleId: "core.claims.reference-chain", message: "该项检查未完成。" }],
        )}
        patentName="测试专利"
        refreshing={false}
        stale={false}
        onRun={vi.fn()}
        onRecheck={vi.fn()}
        onLocate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("部分检查未完成")).toBeDefined();
    expect(screen.getByText("权利要求引用关系")).toBeDefined();
    expect(screen.queryByText("未发现问题")).toBeNull();
  });

  test("shows a clean result only for a current complete report", () => {
    render(
      <PatentCheckPanel
        phase="result"
        report={reportWithIssues([])}
        patentName="测试专利"
        refreshing={false}
        stale={false}
        onRun={vi.fn()}
        onRecheck={vi.fn()}
        onLocate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("当前检查范围内未发现问题")).toBeDefined();
  });

  test("opens on a preparatory state without running or presenting results", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(
      <PatentCheckPanel
        phase="ready"
        report={null}
        patentName="测试专利"
        refreshing={false}
        stale={false}
        onRun={onRun}
        onRecheck={vi.fn()}
        onLocate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const panel = screen.getByRole("complementary", { name: "本地检查" });
    expect(within(panel).getByRole("heading", { name: "本地检查" })).toBeDefined();
    expect(within(panel).getByRole("button", { name: "全文检查" })).toBeDefined();
    expect(within(panel).getByText("检查全文、附图及标记。")).toBeDefined();
    expect(within(panel).queryByRole("tablist", { name: "本地检查筛选" })).toBeNull();
    expect(within(panel).queryByText(/项/u)).toBeNull();
    expect(within(panel).queryByRole("button", { name: "重新检查" })).toBeNull();

    await user.click(within(panel).getByRole("button", { name: "全文检查" }));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  test("shows a running state while a requested check is in progress", () => {
    render(
      <PatentCheckPanel
        phase="running"
        report={null}
        patentName="测试专利"
        refreshing
        stale={false}
        onRun={vi.fn()}
        onRecheck={vi.fn()}
        onCancel={vi.fn()}
        onLocate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const panel = screen.getByRole("complementary", { name: "本地检查" });
    expect(within(panel).getByRole("status")).toBeDefined();
    expect(within(panel).getByRole("button", { name: "停止检查" })).toBeDefined();
    expect(within(panel).queryByRole("button", { name: "全文检查" })).toBeNull();
    expect(within(panel).queryByRole("tablist", { name: "本地检查筛选" })).toBeNull();
  });
});

test("combines the three claim graph pauses into one actionable reason", () => {
  const message = "权利要求编号重复，引用关系检查暂时无法完成。请先修正编号，再重新检查。";
  render(
    <PatentCheckPanel
      phase="result"
      report={reportWithIssues(
        [],
        ["choice", "base", "cycle"].map((rule) => ({ ruleId: `core.claims.${rule}`, message })),
      )}
      stale={false}
      onRun={() => undefined}
      onClose={() => undefined}
      onRecheck={() => undefined}
      onLocate={() => undefined}
    />,
  );
  expect(
    within(screen.getByRole("list", { name: "未完成的检查项" })).getAllByRole("listitem"),
  ).toHaveLength(1);
  expect(screen.getAllByText(message)).toHaveLength(1);
});
