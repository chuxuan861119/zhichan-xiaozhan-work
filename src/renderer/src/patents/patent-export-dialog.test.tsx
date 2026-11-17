import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LibraryPatentExportDialog, PatentExportDialog } from "./patent-export-dialog";

describe("patent export dialog", () => {
  test("disables empty names, trims valid names, and cancels without exporting", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    const onCancel = vi.fn();
    render(
      <PatentExportDialog
        format="docx"
        bookKind="claims"
        suggestedName="测试专利"
        onExport={onExport}
        onCancel={onCancel}
      />,
    );
    const name = screen.getByRole("textbox", { name: "文件名称" });
    await user.clear(name);
    await user.type(name, "   ");
    expect((screen.getByRole("button", { name: "导出" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onExport).not.toHaveBeenCalled();
    await user.type(name, "专利文件  ");
    await user.click(screen.getByRole("button", { name: "导出" }));
    expect(onExport).toHaveBeenCalledWith("docx", "combined", "专利文件");
    expect(screen.queryByRole("region", { name: "导出前检查" })).toBeNull();
    expect(screen.queryByText("尚未开始导出")).toBeNull();
  });

  test("uses the unified export form with all three formats", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    render(
      <PatentExportDialog
        format="docx"
        bookKind="description"
        suggestedName="往复式夹具"
        onExport={onExport}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "导出专利文档" });
    expect(dialog.classList.contains("standard-dialog--m")).toBe(true);
    expect(
      (within(dialog).getByRole("combobox", { name: "文件格式" }) as HTMLSelectElement).value,
    ).toBe("docx");
    expect(
      (within(dialog).getByRole("combobox", { name: "导出范围" }) as HTMLSelectElement).value,
    ).toBe("combined");
    expect(
      (within(dialog).getByRole("textbox", { name: "文件名称" }) as HTMLInputElement).value,
    ).toBe("往复式夹具");
    expect(within(dialog).queryByText("保存位置")).toBeNull();

    await user.selectOptions(within(dialog).getByRole("combobox", { name: "文件格式" }), "pdf");
    await user.click(within(dialog).getByRole("button", { name: "导出" }));
    expect(onExport).toHaveBeenCalledWith("pdf", "combined", "往复式夹具");
  });

  test("regenerates the typed patent file name when the export range changes", async () => {
    const user = userEvent.setup();
    render(
      <PatentExportDialog
        format="docx"
        bookKind="claims"
        suggestedName="电池冷却机构（新型）"
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "导出专利文档" });
    const range = within(dialog).getByRole("combobox", { name: "导出范围" });
    const fileName = within(dialog).getByRole("textbox", { name: "文件名称" });
    expect((fileName as HTMLInputElement).value).toBe("电池冷却机构（新型）");

    await user.selectOptions(range, "single");
    expect((fileName as HTMLInputElement).value).toBe("电池冷却机构（新型）-权利要求书");

    await user.clear(fileName);
    await user.type(fileName, "用户自定义名称");
    await user.selectOptions(range, "combined");
    expect((fileName as HTMLInputElement).value).toBe("电池冷却机构（新型）");
  });

  test("exports PATDOC as a complete patent and disables range selection", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    render(
      <PatentExportDialog
        format="docx"
        bookKind="claims"
        suggestedName="电池冷却机构"
        onExport={onExport}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "导出专利文档" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "导出范围" }), "single");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "文件格式" }), "patdoc");
    expect(
      (within(dialog).getByRole("combobox", { name: "导出范围" }) as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      within(dialog).getByText("PATDOC 将保留当前专利的全部书册、附图及可编辑数据。"),
    ).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "导出" }));
    expect(onExport).toHaveBeenCalledWith("patdoc", "combined", "电池冷却机构");
  });

  test("exports clean patents with the normal export action", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    render(
      <PatentExportDialog
        format="docx"
        bookKind="description"
        suggestedName="测试专利"
        onExport={onExport}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "导出" }));
    expect(onExport).toHaveBeenCalledWith("docx", "combined", "测试专利");
  });

  test("only offers combined five-book export in the library", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    render(
      <LibraryPatentExportDialog
        availableBookKinds={["claims", "description", "abstract"]}
        onExport={onExport}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "导出专利" });
    await user.click(within(dialog).getByRole("radio", { name: "PDF" }));
    expect(within(dialog).queryByRole("radio", { name: "单独书册" })).toBeNull();
    expect(within(dialog).queryByRole("combobox", { name: "书册" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "导出" }));

    expect(onExport).toHaveBeenCalledWith("pdf", "combined", "claims");
  });

  test("exports PATDOC as the complete patent with drawing books determined by its state", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    render(
      <LibraryPatentExportDialog
        availableBookKinds={["claims", "description", "abstract"]}
        onExport={onExport}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "导出专利" });
    await user.click(within(dialog).getByRole("radio", { name: "PATDOC" }));
    expect(within(dialog).getByText("PATDOC 会保留当前专利的附图书状态。")).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "导出" }));

    expect(onExport).toHaveBeenCalledWith("patdoc", "combined", "claims");
  });
});
