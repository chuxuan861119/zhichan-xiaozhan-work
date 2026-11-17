import { fireEvent, render, screen } from "@testing-library/react";
import type { FlowchartProjectDescriptor } from "../../../shared/flowcharts/model";
import { FlowchartProjectMenu } from "./flowchart-project-menu";

function descriptor(projectId: string, name: string): FlowchartProjectDescriptor {
  return {
    projectId,
    name,
    revision: 0,
    pageCount: 1,
    lastPageId: "page-1",
    sourceSha256: "A".repeat(64),
    createdAt: "2026-08-12T00:00:00.000Z",
    modifiedAt: "2026-08-12T00:00:00.000Z",
  };
}

describe("FlowchartProjectMenu", () => {
  test("lists projects as a pure selector without management actions", () => {
    const current = descriptor("00000000-0000-4000-8000-000000000001", "当前工程");
    const other = descriptor("00000000-0000-4000-8000-000000000002", "另一个工程");
    const onClose = vi.fn();
    const onSelect = vi.fn();

    render(
      <FlowchartProjectMenu
        projects={[current, other]}
        currentProjectId={current.projectId}
        linkedFigureLabels={new Map([[other.projectId, ["图1", "图3"]]])}
        busy={false}
        onClose={onClose}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByRole("menu", { name: "流程图工程列表" })).toBeTruthy();
    expect(
      screen.getByRole("menuitemradio", { name: /当前工程.*当前/ }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /另一个工程.*图1、图3/ }));
    expect(onSelect).toHaveBeenCalledWith(other);

    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(screen.queryByText("新建流程图")).toBeNull();
    expect(screen.queryByText("删除当前流程图")).toBeNull();

    fireEvent.keyDown(screen.getByRole("menu", { name: "流程图工程列表" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("moves focus between project choices and disables them when busy", () => {
    const current = descriptor("00000000-0000-4000-8000-000000000001", "当前工程");
    const other = descriptor("00000000-0000-4000-8000-000000000002", "另一个工程");
    const props = {
      projects: [current, other],
      currentProjectId: current.projectId,
      linkedFigureLabels: new Map<string, readonly string[]>(),
      busy: false,
      onClose: vi.fn(),
      onSelect: vi.fn(),
    };
    const { rerender } = render(<FlowchartProjectMenu {...props} />);
    const menu = screen.getByRole("menu", { name: "流程图工程列表" });
    const currentItem = screen.getByRole("menuitemradio", { name: /当前工程/ });
    currentItem.focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: /另一个工程/ }));

    rerender(<FlowchartProjectMenu {...props} busy />);
    expect(
      screen.getAllByRole("menuitemradio").every((item) => item.hasAttribute("disabled")),
    ).toBe(true);
  });
});
