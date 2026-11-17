import { fireEvent, render, screen } from "@testing-library/react";
import { ChemicalStructureTools } from "./chemical-structure-tools";

describe("chemical structure tools", () => {
  test("constrains width and exposes three alignment controls", () => {
    const onWidthChange = vi.fn();
    const onAlignmentChange = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <ChemicalStructureTools
        widthMm={80}
        alignment="center"
        onWidthChange={onWidthChange}
        onAlignmentChange={onAlignmentChange}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    fireEvent.change(screen.getByRole("slider", { name: "结构式宽度" }), {
      target: { value: "166" },
    });
    fireEvent.click(screen.getByRole("button", { name: "左对齐" }));
    fireEvent.click(screen.getByRole("button", { name: "右对齐" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑结构式" }));
    fireEvent.click(screen.getByRole("button", { name: "删除结构式" }));

    expect(onWidthChange).toHaveBeenCalledWith(165);
    expect(onAlignmentChange).toHaveBeenNthCalledWith(1, "left");
    expect(onAlignmentChange).toHaveBeenNthCalledWith(2, "right");
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
  });
});
