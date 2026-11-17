import { act, fireEvent, render, screen } from "@testing-library/react";
import { FigureReplacementDialog } from "./figure-replacement-dialog";

test("both comparison panes use physical size viewers, including CAD's default mode", async () => {
  URL.createObjectURL = vi.fn(() => "blob:original");
  URL.revokeObjectURL = vi.fn();
  window.patentApi = {
    assets: { getPreview: vi.fn(async () => ({ ok: true, value: new Uint8Array([1]) })) },
  } as unknown as typeof window.patentApi;
  render(
    <FigureReplacementDialog
      sessionId="session"
      figures={[{ figureId: "one", assetId: "one", widthMm: 15 }]}
      sourceLabel="当前选区"
      previewAlt="成图"
      onPreview={async () => ({ url: "preview.png", value: null })}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  const original = await screen.findByAltText("现有图 1");
  const replacement = await screen.findByAltText("成图");
  expect((original as HTMLImageElement).style.width).toBe("15mm");
  expect((replacement as HTMLImageElement).style.width).toBe("15mm");
  expect(screen.getAllByRole("button", { name: "实际尺寸（100%）" })).toHaveLength(2);
});

test("switching target reloads an unchanged prepared preview so readiness cannot get stuck", async () => {
  URL.createObjectURL = vi.fn(() => "blob:original");
  URL.revokeObjectURL = vi.fn();
  window.patentApi = {
    assets: { getPreview: vi.fn(async () => ({ ok: true, value: new Uint8Array([1]) })) },
  } as unknown as typeof window.patentApi;
  render(
    <FigureReplacementDialog
      sessionId="session"
      figures={[
        { figureId: "one", assetId: "one", widthMm: 80 },
        { figureId: "two", assetId: "two", widthMm: 90 },
      ]}
      sourceLabel="公式"
      previewAlt="成图"
      interactivePreview
      onPreview={async () => ({ url: "same.png", value: null })}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  const first = await screen.findByAltText("成图");
  fireEvent.load(first);
  fireEvent.load(await screen.findByAltText("现有图 1"));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "two" } });
  await act(async () => {});
  const second = await screen.findByAltText("成图");
  expect(second).not.toBe(first);
  fireEvent.load(second);
  fireEvent.load(await screen.findByAltText("现有图 2"));
  expect(screen.getByRole("button", { name: "替换图 2" }).hasAttribute("disabled")).toBe(false);
});

test("changed settings invalidate the old preview immediately and ignore late results", async () => {
  URL.createObjectURL = vi.fn(() => "blob:original");
  URL.revokeObjectURL = vi.fn();
  window.patentApi = {
    assets: { getPreview: vi.fn(async () => ({ ok: true, value: new Uint8Array([1]) })) },
  } as unknown as typeof window.patentApi;
  const onConfirm = vi.fn();
  let finish!: (value: { url: string; value: string }) => void;
  const dispose = vi.fn();
  const onPreview = vi
    .fn()
    .mockResolvedValueOnce({ url: "first.png", value: "first", dispose })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({ url: "latest.png", value: "latest" });
  const props = {
    sessionId: "session",
    figures: [{ figureId: "figure", assetId: "asset", widthMm: 90 }],
    sourceLabel: "流程图",
    previewAlt: "成图",
    onPreview,
    onConfirm,
    onCancel: vi.fn(),
  };
  const view = render(<FigureReplacementDialog {...props} previewKey="first" />);
  fireEvent.load(await screen.findByAltText("现有图 1"));
  fireEvent.load(await screen.findByAltText("成图"));
  expect(screen.getByRole("button", { name: "替换图 1" }).hasAttribute("disabled")).toBe(false);
  view.rerender(<FigureReplacementDialog {...props} previewKey="second" />);
  fireEvent.click(screen.getByRole("button", { name: "替换图 1" }));
  expect(onConfirm).not.toHaveBeenCalled();
  view.rerender(<FigureReplacementDialog {...props} previewKey="latest" />);
  await screen.findByAltText("成图");
  await act(async () => finish({ url: "stale.png", value: "stale" }));
  expect(screen.getByAltText("成图").getAttribute("src")).toBe("latest.png");
  fireEvent.load(screen.getByAltText("成图"));
  fireEvent.click(screen.getByRole("button", { name: "替换图 1" }));
  expect(onConfirm).toHaveBeenCalledWith(props.figures[0], "latest");
  expect(dispose).toHaveBeenCalledOnce();
});
