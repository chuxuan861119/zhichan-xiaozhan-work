import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { AUTOMATION_GLOBAL_DOMAINS } from "../../../shared/automation/global";
import type { AutomationScope } from "../../../shared/automation/protocol";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import {
  AuthorizationPatentPicker,
  AuthorizationScopeEditor,
  requestedPatents,
} from "./authorization-scope-editor";

const a = {
  patentId: "a",
  name: "正常专利",
  createdAt: "2026-10-02T01:00:00Z",
  deletedAt: null,
  patentType: "invention",
} as LibraryPatentSummary;
const b = { ...a, patentId: "b", name: "旧月专利", createdAt: "2026-08-02T01:00:00Z" };
const trash = { ...a, patentId: "trash", name: "回收站专利", deletedAt: "2026-10-03T00:00:00Z" };
test("main page only shows requested or selected active patents and requests never grant access", () => {
  const change = vi.fn();
  render(
    <AuthorizationScopeEditor
      patents={[a, b, trash]}
      scope={{ patents: {}, createLimit: 0, workspace: {} }}
      requested={{
        task: "任务文本不应展示",
        patents: [{ patentId: a.patentId, access: "read" }],
        createLimit: 2,
      }}
      onChange={change}
      onChoosePatents={() => {}}
    />,
  );
  expect(screen.queryByText("本次任务")).toBeNull();
  expect(screen.queryByText("任务文本不应展示")).toBeNull();
  expect(screen.queryByText("正常专利")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "权限 正常专利" })).toBeNull();
  expect(screen.getByRole("button", { name: "从专利库选择" })).toBeDefined();
  expect(screen.queryByText("旧月专利")).toBeNull();
  expect(screen.queryByText("回收站专利")).toBeNull();
  expect(screen.queryByText(/完整权限可使用/)).toBeNull();
  expect(screen.queryByText(/材料与成果位置/)).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.getByText("新建专利（控制）权限")).toBeDefined();
  expect(screen.getByText("每次最多 5 件")).toBeDefined();
  expect(change).not.toHaveBeenCalled();
});
test("ambiguous names and trash are never uniquely resolved", () => {
  expect(
    requestedPatents(
      {
        patents: [
          { name: a.name!, access: "full" },
          { patentId: "trash", access: "full" },
        ],
      },
      [a, { ...a, patentId: "duplicate" }, trash],
    ).map((r) => [r.patent, r.ambiguous]),
  ).toEqual([
    [undefined, true],
    [undefined, false],
  ]);
});
test("picker groups by creation month and all selects only active patents with explicit permission", () => {
  const confirm = vi.fn();
  render(
    <AuthorizationPatentPicker
      patents={[a, b, trash]}
      selected={{}}
      onCancel={() => {}}
      onConfirm={confirm}
    />,
  );
  expect(screen.getByRole("button", { name: /2026年10月/ })).toBeDefined();
  expect(screen.getByRole("button", { name: /2026年8月/ })).toBeDefined();
  expect(screen.queryByText("回收站专利")).toBeNull();
  fireEvent.change(screen.getByLabelText("新增选择权限"), { target: { value: "read" } });
  fireEvent.click(screen.getByLabelText("全选", { exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "确定选择" }));
  expect(confirm).toHaveBeenCalledWith({ a: "read", b: "read" });
});
test("search select-all preserves selections outside the search and cancellation leaves the parent untouched", () => {
  const confirm = vi.fn(),
    cancel = vi.fn();
  render(
    <AuthorizationPatentPicker
      patents={[a, b]}
      selected={{ b: "read" }}
      onCancel={cancel}
      onConfirm={confirm}
    />,
  );
  fireEvent.change(screen.getByLabelText("搜索授权专利"), { target: { value: "正常" } });
  fireEvent.click(screen.getByLabelText("全选搜索结果"));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(cancel).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确定选择" }));
  expect(confirm).toHaveBeenCalledWith({ b: "read", a: "full" });
});
test("a large month renders in batches while select-all includes the complete month", () => {
  const many = Array.from({ length: 101 }, (_, i) => ({
    ...a,
    patentId: `p-${i}`,
    name: `专利 ${i}`,
  }));
  const confirm = vi.fn();
  render(
    <AuthorizationPatentPicker
      patents={many}
      selected={{}}
      onCancel={() => {}}
      onConfirm={confirm}
    />,
  );
  expect(screen.getAllByLabelText(/^选择 专利/)).toHaveLength(100);
  fireEvent.click(screen.getByRole("button", { name: /显示更多/ }));
  expect(screen.getAllByLabelText(/^选择 专利/)).toHaveLength(101);
  fireEvent.click(screen.getByLabelText("全选", { exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "确定选择" }));
  expect(Object.keys(confirm.mock.calls[0]![0])).toHaveLength(101);
});

test("compact patent summary reports selections without exposing names; the picker retains request hints", () => {
  const view = render(
    <AuthorizationScopeEditor
      patents={[a, b, trash]}
      scope={{
        patents: { [a.patentId]: "read", [trash.patentId]: "full" },
        createLimit: 0,
        workspace: {},
      }}
      requested={{ patents: [{ patentId: a.patentId, access: "read" }] }}
      onChange={() => {}}
      onChoosePatents={() => {}}
    />,
  );
  expect(screen.getByText("已选 1 件")).toBeDefined();
  expect(screen.queryByText("正常专利")).toBeNull();
  expect(screen.queryByText("回收站专利")).toBeNull();
  view.unmount();
  render(
    <AuthorizationPatentPicker
      patents={[a, b, trash]}
      selected={{}}
      requested={{ patents: [{ patentId: a.patentId, access: "read" }] }}
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );
  expect(screen.getByText("Agent 申请只读参考")).toBeDefined();
  expect(screen.getByLabelText("选择 正常专利")).toHaveProperty("checked", false);
});

test("global permissions support bulk levels, individual exceptions and clearing without changing patents", () => {
  function Probe() {
    const [scope, setScope] = useState<AutomationScope>({
      patents: { a: "read" as const },
      createLimit: 0,
      workspace: {},
      global: {},
    });
    return (
      <AuthorizationScopeEditor
        scope={scope}
        patents={[a]}
        onChange={setScope}
        onChoosePatents={() => {}}
      />
    );
  }
  render(<Probe />);
  const bulk = screen.getByLabelText("批量设置全局权限");
  fireEvent.change(bulk, { target: { value: "full" } });
  for (const label of Object.values(AUTOMATION_GLOBAL_DOMAINS))
    expect(screen.getByLabelText(`全局权限 ${label}`)).toHaveProperty("value", "full");
  const first = Object.values(AUTOMATION_GLOBAL_DOMAINS)[0]!;
  fireEvent.change(screen.getByLabelText(`全局权限 ${first}`), { target: { value: "read" } });
  expect(bulk).toHaveProperty("value", "custom");
  fireEvent.change(bulk, { target: { value: "read" } });
  for (const label of Object.values(AUTOMATION_GLOBAL_DOMAINS))
    expect(screen.getByLabelText(`全局权限 ${label}`)).toHaveProperty("value", "read");
  fireEvent.change(bulk, { target: { value: "none" } });
  for (const label of Object.values(AUTOMATION_GLOBAL_DOMAINS))
    expect(screen.getByLabelText(`全局权限 ${label}`)).toHaveProperty("value", "none");
  expect(screen.getByText("已选 1 件")).toBeDefined();
});
