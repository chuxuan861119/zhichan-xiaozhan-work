import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { EditorCommandBus } from "../../app/command-bus";
import { TableRailPanel } from "./table-rail-panel";
import { EMPTY_TABLE_SELECTION } from "./table-selection";

test("offers structure and content tools without layout-design controls", () => {
  const bus = {
    getTableSelection: () => ({ ...EMPTY_TABLE_SELECTION, kind: "text", selectedCellCount: 1 }),
    subscribeTableSelection: () => () => undefined,
    runTableCommand: vi.fn(() => true),
    previewTableInsertion: vi.fn(),
  } as unknown as EditorCommandBus;
  render(<TableRailPanel editorId="description" commandBus={bus} />);
  expect(screen.getByRole("region", { name: "表格结构" })).toBeDefined();
  expect(screen.getByRole("region", { name: "表格内容" })).toBeDefined();
  for (const name of ["行距与留白", "尺寸", "自动调整宽度", "边框", "平均分布列宽", "删除表格"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  expect(screen.getByRole("button", { name: "顶部对齐" })).toBeDefined();
  expect(screen.getByRole("button", { name: "垂直居中" })).toBeDefined();
  expect(screen.getByRole("button", { name: "底部对齐" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "将首行设为标题行" }));
  expect(bus.runTableCommand).toHaveBeenCalledWith("description", "toggle-header-row");
  expect(screen.queryByRole("button", { name: "还原合并" })).toBeNull();
});
