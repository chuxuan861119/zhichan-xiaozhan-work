import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TabletControls } from "./tablet-controls";

vi.mock("./app-dialog", () => ({ showAppAlert: vi.fn() }));
const initial = {
  available: true,
  focusMode: false,
  windowed: false,
  contentHeightPx: 1495,
  topInsetPx: 105,
  bottomInsetPx: 0,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup() {
  vi.stubGlobal("documentFontPlatform", "openharmony");
  const read = vi.fn(async () => ({ ok: true, value: initial }));
  const focus = vi.fn(async (enabled: boolean) => ({
    ok: true,
    value: { ...initial, focusMode: enabled, topInsetPx: enabled ? 0 : 105 },
  }));
  vi.stubGlobal("patentApi", {
    application: { readTabletWindow: read, setTabletFocusMode: focus },
  });
  return { read, focus };
}
test("input focus refreshes settled native geometry without polling and cancels on unmount", async () => {
  const { read } = setup();
  vi.useFakeTimers();
  try {
    const view = render(<TabletControls editorMode />);
    await act(async () => {});
    read.mockResolvedValue({ ok: true, value: { ...initial, contentHeightPx: 696 } });
    fireEvent.focusIn(window);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(601);
    });
    expect(document.documentElement.style.getPropertyValue("--harmony-content-height")).toBe(
      `${696 / window.devicePixelRatio}px`,
    );
    const settled = read.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(read).toHaveBeenCalledTimes(settled);
    fireEvent.focusOut(window);
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(read).toHaveBeenCalledTimes(settled);
  } finally {
    vi.useRealTimers();
  }
});
test("tablet controls collapse navigation independently and preserve the desktop interface", async () => {
  const { read } = setup();
  vi.stubGlobal("documentFontPlatform", "darwin");
  const desktop = render(<TabletControls editorMode={false} />);
  expect(read).not.toHaveBeenCalled();
  expect(document.documentElement.dataset.deviceForm).toBeUndefined();
  desktop.unmount();
  vi.stubGlobal("documentFontPlatform", "openharmony");
  const tablet = render(<TabletControls editorMode={false} />);
  await screen.findByRole("button", { name: "展开专利库导航" });
  expect(document.documentElement.dataset.deviceForm).toBe("tablet");
  expect(document.documentElement.style.getPropertyValue("--harmony-content-height")).toBe(
    `${1495 / window.devicePixelRatio}px`,
  );
  fireEvent.click(screen.getByRole("button", { name: "展开专利库导航" }));
  expect(document.documentElement.dataset.tabletNav).toBe("expanded");
  tablet.unmount();
  expect(document.documentElement.dataset.deviceForm).toBeUndefined();
  expect(document.documentElement.style.getPropertyValue("--harmony-content-height")).toBe("");
});
test("focus mode makes hidden controls inert, can exit with Escape, and restores on library return", async () => {
  const { focus } = setup();
  const View = ({ editorMode = true }) => (
    <div className="window-shell">
      <nav className="menu-bar" />
      <div className="tool-bar" />
      <TabletControls editorMode={editorMode} />
    </div>
  );
  const { rerender } = render(<View />);
  await screen.findByRole("button", { name: "进入专注模式" });
  expect(document.querySelector<HTMLElement>(".tool-bar")?.inert).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "收起工具栏" }));
  expect(document.querySelector<HTMLElement>(".tool-bar")?.inert).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "展开工具栏" }));
  fireEvent.click(screen.getByRole("button", { name: "进入专注模式" }));
  await screen.findByRole("button", { name: "退出专注模式" });
  expect(document.querySelector<HTMLElement>(".tool-bar")?.inert).toBe(true);
  expect(document.querySelector<HTMLElement>(".menu-bar")?.inert).toBe(true);
  fireEvent.keyDown(window, { key: "Escape" });
  await screen.findByRole("button", { name: "进入专注模式" });
  expect(document.querySelector<HTMLElement>(".menu-bar")?.inert).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "进入专注模式" }));
  await screen.findByRole("button", { name: "退出专注模式" });
  rerender(<View editorMode={false} />);
  await waitFor(() => expect(focus).toHaveBeenLastCalledWith(false));
});
test("a rejected native transition preserves existing controls; repeated clicks share one request", async () => {
  const { focus } = setup();
  let finish: (value: unknown) => void = () => {};
  focus.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve as (value: unknown) => void;
      }),
  );
  render(<TabletControls editorMode />);
  const button = await screen.findByRole("button", { name: "进入专注模式" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(focus).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ok: false, error: {} }));
  expect(document.documentElement.dataset.tabletFocus).toBe("false");
  expect(screen.getByRole("button", { name: "进入专注模式" })).toBeTruthy();
});

test("a failed automatic exit is not retried in a loop and keeps an explicit exit control", async () => {
  const { focus } = setup();
  const view = render(<TabletControls editorMode />);
  fireEvent.click(await screen.findByRole("button", { name: "进入专注模式" }));
  await screen.findByRole("button", { name: "退出专注模式" });
  focus.mockResolvedValueOnce({ ok: false, error: {} } as never);
  view.rerender(<TabletControls editorMode={false} />);
  await waitFor(() => expect(focus).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "退出专注模式" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "退出专注模式" }));
  await waitFor(() => expect(focus).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.queryByRole("button", { name: "退出专注模式" })).toBeNull());
});

test("unmounting during an entering request restores the native window after it completes", async () => {
  const { focus } = setup();
  let finish: (value: unknown) => void = () => {};
  focus.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve as (value: unknown) => void;
      }),
  );
  const view = render(<TabletControls editorMode />);
  fireEvent.click(await screen.findByRole("button", { name: "进入专注模式" }));
  view.unmount();
  await act(async () => finish({ ok: true, value: { ...initial, focusMode: true } }));
  expect(focus).toHaveBeenLastCalledWith(false);
});
