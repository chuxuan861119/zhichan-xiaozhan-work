import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { DrawingProjectRow } from "./drawing-project-row";
afterEach(cleanup);

test.each(["dwg", "dxf"] as const)(
  "sidebar exports the clicked inactive drawing as %s",
  async (format) => {
    const project = drawingProjectFixture("source");
    project.cad = {
      version: 1,
      engine: "cadcraft",
      engineVersion: "a".repeat(40),
      assetId: "cad",
      mapping: { originX: 0, originY: 0, scale: 1 },
    };
    const onExport = vi.fn(async () => {}),
      onActivate = vi.fn();
    render(
      <DrawingProjectRow
        project={project}
        selected={false}
        busy={false}
        onActivate={onActivate}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onExport={onExport}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: `${project.name}的更多操作` }));
    fireEvent.click(screen.getByRole("menuitem", { name: "导出CAD" }));
    await screen.findByRole("dialog", { name: "导出CAD" });
    fireEvent.click(screen.getByRole("button", { name: `导出 ${format.toUpperCase()}` }));
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(project.projectId, format));
    expect(onActivate).not.toHaveBeenCalled();
  },
);

test("cancel closes export without starting it", async () => {
  const project = drawingProjectFixture("source");
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "a".repeat(40),
    assetId: "cad",
    mapping: { originX: 0, originY: 0, scale: 1 },
  };
  const onExport = vi.fn();
  render(
    <DrawingProjectRow
      project={project}
      selected
      busy={false}
      onActivate={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onExport={onExport}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: `${project.name}的更多操作` }));
  fireEvent.click(screen.getByRole("menuitem", { name: "导出CAD" }));
  await screen.findByRole("dialog", { name: "导出CAD" });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onExport).not.toHaveBeenCalled();
});
