import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FlowchartExportDialog } from "./flowchart-export-dialog";

const FIGURES = [
  {
    figureId: "11111111-1111-4111-8111-111111111111",
    assetId: "asset-1",
    label: "图1",
    widthMm: 120,
  },
  {
    figureId: "22222222-2222-4222-8222-222222222222",
    assetId: "asset-2",
    label: "图2",
    widthMm: 150,
  },
];

test("replacement opens a two-pane comparison without an add/replace radio", async () => {
  URL.createObjectURL = vi.fn(() => "blob:original");
  URL.revokeObjectURL = vi.fn();
  window.patentApi = {
    assets: { getPreview: vi.fn(async () => ({ ok: true, value: new Uint8Array([1]) })) },
  } as unknown as typeof window.patentApi;
  render(
    <FlowchartExportDialog
      mode="replace"
      sessionId="session"
      figureOptions={FIGURES}
      selectedCellIds={[]}
      onPreview={vi
        .fn()
        .mockResolvedValue({ previewToken: "token", previewUrl: "new.png", warnings: [] })}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  expect(
    screen
      .getByRole("dialog", { name: "替换说明书附图" })
      .classList.contains("drawing-replace-dialog"),
  ).toBe(true);
  expect(screen.queryByRole("radio", { name: /替换现有附图/ })).toBeNull();
  expect(await screen.findByRole("img", { name: "现有图1" })).toBeDefined();
  expect(await screen.findByRole("img", { name: "流程图成图预览" })).toBeDefined();
});

test("automatically previews a new figure with 2 mm margin when the dialog opens", async () => {
  const onPreview = vi.fn().mockResolvedValue({
    previewToken: "token-1",
    previewUrl: "data:image/png;base64,AA==",
    warnings: ["位图细节可能变化"],
  });
  render(
    <FlowchartExportDialog
      figureOptions={FIGURES}
      selectedCellIds={[]}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      onPreview={onPreview}
    />,
  );

  expect((screen.getByLabelText("当前选取") as HTMLInputElement).disabled).toBe(true);
  const dialog = screen.getByRole("dialog", { name: "插入到说明书附图" });
  expect(dialog.classList.contains("standard-dialog--xl")).toBe(true);
  expect(dialog.classList.contains("flowchart-export-dialog--patent")).toBe(true);
  expect(dialog.querySelectorAll(".flowchart-export-choice-card")).toHaveLength(2);
  expect(dialog.querySelector(".flowchart-export-settings-grid")).toBeTruthy();
  expect(dialog.querySelector(".flowchart-input-with-suffix")?.textContent).toContain("mm");
  expect(dialog.querySelector(".standard-dialog__footer")).toBeTruthy();
  expect((screen.getByLabelText("四周留白（外边距）") as HTMLInputElement).value).toBe("2");
  await waitFor(() => expect(onPreview).toHaveBeenCalled());
  expect(onPreview).toHaveBeenCalledWith({
    scope: "page",
    selectedCellIds: [],
    borderMm: 2,
    target: { kind: "new", insertIndex: 2 },
  });
  expect(screen.getByAltText("最终黑白专利附图预览")).toBeTruthy();
  expect(screen.getByRole("button", { name: "放大预览" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "缩小预览" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "重置预览" })).toBeTruthy();
  expect(screen.getByText("位图细节可能变化")).toBeTruthy();
  expect((screen.getByRole("button", { name: "添加为图 3" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

test("defaults to replacing the linked figure, recalculates its fitted width and confirms only the generated token", async () => {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onPreview = vi.fn().mockResolvedValue({
    previewToken: "token-2",
    previewUrl: "data:image/png;base64,AA==",
    warnings: [],
  });
  render(
    <FlowchartExportDialog
      figureOptions={FIGURES}
      selectedCellIds={["cell-1"]}
      mode="replace"
      sessionId="session"
      defaultReplaceFigureId={FIGURES[0]?.figureId}
      onCancel={vi.fn()}
      onConfirm={onConfirm}
      onPreview={onPreview}
    />,
  );

  expect(screen.queryByLabelText("替换现有附图")).toBeNull();
  await screen.findByAltText("流程图成图预览");
  fireEvent.click(screen.getByLabelText("当前选取"));
  await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(2));
  expect(onPreview).toHaveBeenLastCalledWith({
    scope: "selection",
    selectedCellIds: ["cell-1"],
    borderMm: 2,
    outputWidthMm: 120,
    target: {
      kind: "replace",
      figureId: FIGURES[0]?.figureId,
      assetId: FIGURES[0]?.assetId,
    },
  });
  fireEvent.load(await screen.findByAltText("现有图1"));
  fireEvent.load(await screen.findByAltText("流程图成图预览"));
  fireEvent.click(screen.getByRole("button", { name: "替换图1" }));
  await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("token-2"));
});

test("automatically refreshes the preview when output settings change", async () => {
  const onPreview = vi.fn().mockResolvedValue({
    previewToken: "token-3",
    previewUrl: "data:image/png;base64,AA==",
    warnings: [],
  });
  render(
    <FlowchartExportDialog
      figureOptions={FIGURES}
      selectedCellIds={[]}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      onPreview={onPreview}
    />,
  );
  await screen.findByAltText("最终黑白专利附图预览");
  fireEvent.change(screen.getByLabelText("四周留白（外边距）"), { target: { value: "5" } });
  await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(2));
  expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ borderMm: 5 }));
});

test("keeps the replacement figure selector available and previews the chosen figure", async () => {
  const onPreview = vi.fn().mockResolvedValue({
    previewToken: "replacement",
    previewUrl: "figure.png",
    warnings: [],
  });
  render(
    <FlowchartExportDialog
      mode="replace"
      sessionId="session"
      figureOptions={FIGURES}
      selectedCellIds={[]}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      onPreview={onPreview}
    />,
  );
  await screen.findByAltText("流程图成图预览");
  const selector = screen.getByRole("combobox", { name: "选择要替换的附图" });
  fireEvent.change(selector, { target: { value: FIGURES[1]?.figureId } });
  await waitFor(() =>
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: { kind: "replace", figureId: FIGURES[1]?.figureId, assetId: "asset-2" },
      }),
    ),
  );
  fireEvent.load(await screen.findByAltText("现有图2"));
  fireEvent.load(await screen.findByAltText("流程图成图预览"));
  expect(screen.getByRole("button", { name: "替换图2" }).hasAttribute("disabled")).toBe(false);
});

test("keeps the newest automatic preview when an older request finishes later", async () => {
  let resolveFirst:
    | ((value: { previewToken: string; previewUrl: string; warnings: string[] }) => void)
    | undefined;
  const first = new Promise<{ previewToken: string; previewUrl: string; warnings: string[] }>(
    (resolve) => {
      resolveFirst = resolve;
    },
  );
  const onPreview = vi
    .fn()
    .mockReturnValueOnce(first)
    .mockResolvedValueOnce({ previewToken: "new", previewUrl: "new.png", warnings: [] });
  render(
    <FlowchartExportDialog
      figureOptions={FIGURES}
      selectedCellIds={["cell-1"]}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      onPreview={onPreview}
    />,
  );
  await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByLabelText("当前选取"));
  await waitFor(() =>
    expect(screen.getByAltText("最终黑白专利附图预览").getAttribute("src")).toBe("new.png"),
  );
  resolveFirst?.({ previewToken: "old", previewUrl: "old.png", warnings: [] });
  await Promise.resolve();
  expect(screen.getByAltText("最终黑白专利附图预览").getAttribute("src")).toBe("new.png");
});

test("uses a bounded scrollable body and a separate always-visible action row", () => {
  render(
    <FlowchartExportDialog
      figureOptions={FIGURES}
      selectedCellIds={[]}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      onPreview={vi
        .fn()
        .mockResolvedValue({ previewToken: "token", previewUrl: "tall.png", warnings: [] })}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "插入到说明书附图" });
  expect(dialog.querySelector(":scope > .flowchart-dialog-body")).toBeTruthy();
  expect(dialog.querySelector(":scope > .standard-dialog__footer")).toBeTruthy();
});
