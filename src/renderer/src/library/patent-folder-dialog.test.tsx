import { fireEvent, render, screen, within } from "@testing-library/react";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { PatentFolderDialog } from "./patent-folder-dialog";

test("single, modifier multi, range, select all and double click preserve targets", () => {
  const onOpen = vi.fn();
  const onExport = vi.fn();
  render(
    <PatentFolderDialog
      patent={createBlankPatent({ patentType: "utility-model", name: "测试" })}
      onOpen={onOpen}
      onExport={onExport}
      onCancel={vi.fn()}
      busy={false}
    />,
  );
  const files = screen.getAllByRole("option");
  fireEvent.click(files[0]!);
  expect(files[0]!.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(files[2]!, { shiftKey: true });
  expect(files.filter((f) => f.getAttribute("aria-selected") === "true")).toHaveLength(3);
  fireEvent.click(files[1]!, { ctrlKey: true });
  expect(files[1]!.getAttribute("aria-selected")).toBe("false");
  fireEvent.click(screen.getByRole("checkbox", { name: "全选文件" }));
  fireEvent.click(screen.getByRole("button", { name: "导出所选" }));
  expect(onExport.mock.calls[0]![0]).toHaveLength(5);
  expect(onExport.mock.calls[0]![0].every((i: { format: string }) => i.format === "docx")).toBe(
    true,
  );
  fireEvent.doubleClick(files[2]!);
  expect(onOpen.mock.calls[0]![0]).toMatchObject({ kind: "book", id: "description-drawings" });
});

test("single export offers formats and does not strip internal dots", () => {
  const onExport = vi.fn();
  render(
    <PatentFolderDialog
      patent={createBlankPatent({ patentType: "invention", name: "测试" })}
      onOpen={vi.fn()}
      onExport={onExport}
      onCancel={vi.fn()}
      busy={false}
    />,
  );
  fireEvent.click(screen.getAllByRole("option")[0]!);
  fireEvent.change(screen.getByLabelText("导出格式"), { target: { value: "pdf" } });
  fireEvent.click(screen.getByRole("button", { name: "导出所选" }));
  expect(onExport).toHaveBeenCalledWith([{ key: "book:claims", format: "pdf" }]);
});

test("Ctrl A works from the footer and Escape never closes the folder", () => {
  const onCancel = vi.fn();
  render(
    <PatentFolderDialog
      patent={createBlankPatent({ patentType: "invention", name: "测试" })}
      busy={false}
      onCancel={onCancel}
      onOpen={vi.fn()}
      onExport={vi.fn()}
    />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "关闭" }), { key: "a", ctrlKey: true });
  expect(
    screen.getAllByRole("option").every((e) => e.getAttribute("aria-selected") === "true"),
  ).toBe(true);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onCancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭文件夹" }));
  expect(onCancel).toHaveBeenCalledTimes(2);
});

test.each(["测试专利", null])(
  "folder title uses the patent name (%s) and omits the usage hint",
  (name) => {
    render(
      <PatentFolderDialog
        patent={createBlankPatent({ patentType: "invention", name })}
        busy={false}
        onCancel={vi.fn()}
        onOpen={vi.fn()}
        onExport={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: name ?? "未命名专利" })).toBeDefined();
    expect(screen.getByRole("heading", { name: name ?? "未命名专利" })).toBeDefined();
    expect(screen.queryByText("专利文件夹")).toBeNull();
    expect(screen.queryByText(/拖动框选/u)).toBeNull();
  },
);

test("each row exports only its own file with an explicit format, preserving the batch selection", () => {
  const onExport = vi.fn();
  const onOpen = vi.fn();
  render(
    <PatentFolderDialog
      patent={createBlankPatent({ patentType: "invention", name: "测试" })}
      busy={false}
      onCancel={vi.fn()}
      onOpen={onOpen}
      onExport={onExport}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "全选文件" }));
  fireEvent.click(screen.getByRole("button", { name: "导出权利要求书" }));
  const chooser = screen.getByRole("dialog", { name: "导出文件" });
  fireEvent.change(within(chooser).getByLabelText("文件格式"), { target: { value: "pdf" } });
  fireEvent.click(within(chooser).getByRole("button", { name: "导出" }));
  expect(onExport).toHaveBeenCalledWith([{ key: "book:claims", format: "pdf" }]);
  expect(onOpen).not.toHaveBeenCalled();
  expect(
    screen.getAllByRole("option").every((e) => e.getAttribute("aria-selected") === "true"),
  ).toBe(true);
});

test("mouse marquee selects intersecting rows, adds with Ctrl, and releases its rectangle", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  try {
    render(
      <PatentFolderDialog
        patent={createBlankPatent({ patentType: "invention", name: "测试" })}
        busy={false}
        onCancel={vi.fn()}
        onOpen={vi.fn()}
        onExport={vi.fn()}
      />,
    );
    const list = screen.getByRole("listbox", { name: "专利文件" });
    const rows = screen.getAllByRole("option");
    list.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 500,
      bottom: 400,
      width: 500,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    rows.forEach((row, i) => {
      row.getBoundingClientRect = () => ({
        left: 10,
        top: i * 42,
        right: 450,
        bottom: i * 42 + 40,
        width: 440,
        height: 40,
        x: 10,
        y: i * 42,
        toJSON: () => ({}),
      });
    });
    fireEvent.pointerDown(list, { button: 0, clientX: 1, clientY: 1 });
    fireEvent.pointerMove(list, { clientX: 200, clientY: 95 });
    expect(rows.filter((r) => r.getAttribute("aria-selected") === "true")).toHaveLength(3);
    expect(screen.getByTestId("folder-selection-rectangle")).toBeDefined();
    fireEvent.pointerUp(list, { clientX: 200, clientY: 95 });
    expect(screen.queryByTestId("folder-selection-rectangle")).toBeNull();
    fireEvent.pointerDown(list, { button: 0, ctrlKey: true, clientX: 1, clientY: 170 });
    fireEvent.pointerMove(list, { clientX: 200, clientY: 195 });
    fireEvent.pointerUp(list, { clientX: 200, clientY: 195 });
    expect(rows.filter((r) => r.getAttribute("aria-selected") === "true")).toHaveLength(4);
  } finally {
    vi.unstubAllGlobals();
  }
});
