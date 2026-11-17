import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PatentFigure } from "../../../shared/patent/model";
import { DrawingReplaceDialog } from "./drawing-replace-dialog";

const figures: PatentFigure[] = [
  { figureId: "figure-1", assetId: "asset-1", widthMm: 80 },
  { figureId: "figure-2", assetId: "asset-2", widthMm: 90, rotationDeg: 90 },
];
const onPreview = vi.fn();
const onConfirm = vi.fn();
const onCancel = vi.fn();
const props = { open: true, sessionId: "session", figures, onPreview, onConfirm, onCancel };
const rendered = { bytes: new Uint8Array([1]), width: 400, height: 300 };

beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  window.patentApi = {
    assets: { getPreview: vi.fn(async () => ({ ok: true, value: new Uint8Array([2]) })) },
  } as unknown as typeof window.patentApi;
  onPreview.mockResolvedValue(rendered);
  onConfirm.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function readyImages() {
  const original = await screen.findByRole("img", { name: /现有图/ });
  const replacement = await screen.findByRole("img", { name: "当前选区成图预览" });
  fireEvent.load(original);
  fireEvent.load(replacement);
}

test("compares the chosen figure and actual rendered selection in a standard portal dialog", async () => {
  render(<DrawingReplaceDialog {...props} />);
  const dialog = screen.getByRole("dialog", { name: "替换说明书附图" });
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  expect(dialog.parentElement?.getAttribute("data-motion")).toBe("enter");
  expect(within(dialog).getByRole("button", { name: "替换图 1" }).hasAttribute("disabled")).toBe(
    true,
  );
  await readyImages();
  fireEvent.change(screen.getByRole("combobox", { name: "选择要替换的附图" }), {
    target: { value: "figure-2" },
  });
  await readyImages();
  await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(90));
  const button = screen.getByRole("button", { name: "替换图 2" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
  expect(onConfirm).toHaveBeenCalledWith(figures[1], rendered);
});

test("cancel changes nothing and retains the closing animation", async () => {
  const view = render(<DrawingReplaceDialog {...props} />);
  await readyImages();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
  view.rerender(<DrawingReplaceDialog {...props} open={false} />);
  expect(
    document.querySelector(".drawing-replace-dialog")?.parentElement?.getAttribute("data-motion"),
  ).toBe("exit");
});

test("a preview failure can be retried without allowing a premature replacement", async () => {
  onPreview.mockRejectedValueOnce(new Error("成图失败"));
  render(<DrawingReplaceDialog {...props} />);
  await screen.findByText("成图失败");
  expect(screen.getByRole("button", { name: "替换图 1" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "重新生成预览" }));
  await readyImages();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "替换图 1" }).hasAttribute("disabled")).toBe(false),
  );
});

test("ignores a late preview for the previous figure and revokes its resources on close", async () => {
  let resolveFirst!: (value: typeof rendered) => void;
  onPreview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  const view = render(<DrawingReplaceDialog {...props} />);
  fireEvent.change(screen.getByRole("combobox", { name: "选择要替换的附图" }), {
    target: { value: "figure-2" },
  });
  await readyImages();
  await act(async () => resolveFirst({ ...rendered, width: 999 }));
  expect(screen.queryByText("999 × 300 像素")).toBeNull();
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});

test("a changed target or failed save cannot silently confirm old preview data", async () => {
  const view = render(<DrawingReplaceDialog {...props} />);
  await readyImages();
  onConfirm.mockRejectedValueOnce(new Error("保存失败"));
  fireEvent.click(screen.getByRole("button", { name: "替换图 1" }));
  await screen.findByText("保存失败");
  view.rerender(<DrawingReplaceDialog {...props} figures={figures.slice(1)} />);
  expect(screen.getByRole("button", { name: "确认替换" }).hasAttribute("disabled")).toBe(true);
});
