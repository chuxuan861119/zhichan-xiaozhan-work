import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormulaFigureInsertDialog } from "./formula-figure-insert-dialog";

test("insertion is separate from replacement and has no operation-kind switch", () => {
  render(
    <FormulaFigureInsertDialog
      figureOptions={[]}
      previewUrl="preview.png"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  expect(screen.queryByRole("radio", { name: /替换现有附图/ })).toBeNull();
});

test.each(["mathematical", "physics", "chemical-equation", "chemical-structure"] as const)(
  "%s replacement uses the CAD comparison dialog",
  async (contentKind) => {
    URL.createObjectURL = vi.fn(() => "blob:original");
    URL.revokeObjectURL = vi.fn();
    window.patentApi = {
      assets: { getPreview: vi.fn(async () => ({ ok: true, value: new Uint8Array([1]) })) },
    } as unknown as typeof window.patentApi;
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <FormulaFigureInsertDialog
        mode="replace"
        sessionId="session"
        contentKind={contentKind}
        figureOptions={[{ figureId: "figure-1", assetId: "asset-1", label: "图 1", widthMm: 90 }]}
        previewUrl="preview.png"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "替换说明书附图" });
    expect(dialog.classList.contains("drawing-replace-dialog")).toBe(true);
    fireEvent.load(await screen.findByRole("img", { name: "现有图 1" }));
    fireEvent.load(await screen.findByRole("img", { name: /成图预览/ }));
    expect((screen.getByRole("img", { name: /成图预览/ }) as HTMLImageElement).style.width).toBe(
      "90mm",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "替换图 1" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "替换图 1" }));
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "replace",
      figureId: "figure-1",
      assetId: "asset-1",
    });
  },
);

test("prevents duplicate submission and cancellation while an image is being inserted", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onConfirm = vi.fn(() => pending);
  const onCancel = vi.fn();
  render(
    <FormulaFigureInsertDialog
      figureOptions={[]}
      previewUrl="data:image/png;base64,AA=="
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  const confirm = screen.getByRole("button", { name: "添加为图 1" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onCancel).not.toHaveBeenCalled();
  await act(async () => finish());
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
});

test("an insertion failure keeps the preview and enables retry", async () => {
  const onConfirm = vi.fn().mockRejectedValue(new Error("磁盘写入失败"));
  render(
    <FormulaFigureInsertDialog
      figureOptions={[]}
      previewUrl="data:image/png;base64,AA=="
      onConfirm={onConfirm}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "添加为图 1" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("磁盘写入失败"));
  expect((screen.getByRole("button", { name: "添加为图 1" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

test("lets a formula preview be added as a new description drawing", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <FormulaFigureInsertDialog
      figureOptions={[]}
      previewUrl="data:image/png;base64,AA=="
      onConfirm={onConfirm}
      onCancel={vi.fn()}
    />,
  );

  expect(screen.getByRole("img", { name: "公式附图预览" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "添加为图 1" }));
  expect(onConfirm).toHaveBeenCalledWith({ kind: "new", insertIndex: 0 });
});

test("uses the standard foreground dialog shell above its source formula editor", () => {
  render(
    <FormulaFigureInsertDialog
      figureOptions={[]}
      previewUrl="data:image/png;base64,AA=="
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );

  const dialog = screen.getByRole("dialog");
  expect(dialog.classList.contains("formula-figure-insert-dialog")).toBe(true);
  expect(dialog.parentElement?.classList.contains("standard-dialog-overlay")).toBe(true);
  expect(screen.getByRole("complementary", { name: "附图设置" })).toBeDefined();
});

test("lets a formula preview replace an existing description drawing", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <FormulaFigureInsertDialog
      mode="replace"
      sessionId="session"
      figureOptions={[{ figureId: "figure-1", assetId: "asset-1", label: "图 1" }]}
      previewUrl="data:image/png;base64,AA=="
      onConfirm={onConfirm}
      onCancel={vi.fn()}
    />,
  );

  fireEvent.load(await screen.findByRole("img", { name: /现有图/ }));
  fireEvent.load(await screen.findByRole("img", { name: /成图预览/ }));
  await user.click(screen.getByRole("button", { name: "替换图 1" }));
  expect(onConfirm).toHaveBeenCalledWith({
    kind: "replace",
    figureId: "figure-1",
    assetId: "asset-1",
  });
});

test("identifies a chemical structure preview and keeps target changes independent of zoom", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <FormulaFigureInsertDialog
      mode="replace"
      sessionId="session"
      contentKind="chemical-structure"
      figureOptions={[{ figureId: "figure-1", assetId: "asset-1", label: "图1" }]}
      previewUrl="preview.png"
      onConfirm={onConfirm}
      onCancel={vi.fn()}
    />,
  );
  expect(await screen.findByRole("img", { name: "化学结构式成图预览" })).toBeDefined();
  fireEvent.load(await screen.findByRole("img", { name: /现有图/ }));
  fireEvent.load(await screen.findByRole("img", { name: /成图预览/ }));
  await user.click(
    within(screen.getByRole("region", { name: "化学结构式成图预览查看器" })).getByRole("button", {
      name: "放大预览",
    }),
  );
  expect(screen.getByText("125%")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "替换图1" }));
  expect(onConfirm).toHaveBeenCalledWith({
    kind: "replace",
    figureId: "figure-1",
    assetId: "asset-1",
  });
});
