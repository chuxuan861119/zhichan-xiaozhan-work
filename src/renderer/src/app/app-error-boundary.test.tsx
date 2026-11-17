import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppErrorBoundary } from "./app-error-boundary";
import { rendererSaveRecovery } from "./renderer-save-recovery";

function BrokenView(): ReactNode {
  throw new Error("private patent text must not leave the renderer");
}

test("replaces a crashed React tree with recovery controls and reports only safe metadata", async () => {
  const reportRendererFailure = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const reloadRenderer = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const forceClose = vi.fn(async () => ({ ok: true as const, value: undefined }));
  window.patentApi = {
    application: { reportRendererFailure, reloadRenderer, forceClose },
  } as never;
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

  render(
    <AppErrorBoundary>
      <BrokenView />
    </AppErrorBoundary>,
  );

  expect(screen.getByRole("heading", { name: "编辑界面发生错误" })).toBeTruthy();
  expect(reportRendererFailure).toHaveBeenCalledWith({
    source: "react-boundary",
    failureKind: "other",
  });
  expect(JSON.stringify(reportRendererFailure.mock.calls)).not.toContain("private patent text");

  fireEvent.click(screen.getByRole("button", { name: "退出软件" }));
  await vi.waitFor(() => expect(forceClose).toHaveBeenCalledOnce());
  consoleError.mockRestore();
});

function renderRecovery(reloadRenderer?: () => Promise<unknown>) {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  window.patentApi = {
    application: {
      reloadRenderer,
      reportRendererFailure: vi.fn(async () => ({ ok: true, value: undefined })),
      forceClose: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  } as never;
  render(
    <AppErrorBoundary>
      <BrokenView />
    </AppErrorBoundary>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("acknowledges reload immediately and invokes native recovery only once", async () => {
  const reload = vi.fn(() => new Promise(() => undefined));
  renderRecovery(reload);
  const button = screen.getByRole("button", { name: "重新加载界面" });
  fireEvent.click(button);
  fireEvent.click(button);
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(screen.getByRole("status").textContent).toBe("正在重新加载界面…");
  expect(button).toHaveProperty("disabled", true);
});

test("blocks reload and exit while detached saves fail, then allows retry", async () => {
  let failing = true;
  rendererSaveRecovery.retain({}, async () => {
    if (failing) throw Error("disk full");
  });
  const reload = vi.fn(async () => ({ ok: true, value: undefined }));
  renderRecovery(reload);
  fireEvent.click(screen.getByRole("button", { name: "重新加载界面" }));
  await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("保存未完成"));
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "退出软件" }));
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "退出软件" })).toHaveProperty("disabled", false),
  );
  expect(window.patentApi.application.forceClose).not.toHaveBeenCalled();
  failing = false;
  fireEvent.click(screen.getByRole("button", { name: "重新加载界面" }));
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
});

test.each([
  ["refused", async () => ({ ok: false, error: { message: "private data" } }), "重新加载失败"],
  [
    "unavailable",
    async () => {
      throw new Error("private data");
    },
    "无法连接恢复服务",
  ],
] as const)("shows an actionable error for %s recovery", async (_kind, reload, message) => {
  renderRecovery(reload);
  fireEvent.click(screen.getByRole("button", { name: "重新加载界面" }));
  await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain(message));
  expect(screen.getByRole("status").textContent).not.toContain("private data");
  expect(screen.getByRole("button", { name: "重新加载界面" })).toHaveProperty("disabled", false);
});

test("reports old preload rather than silently attempting a blocked page reload", () => {
  renderRecovery();
  fireEvent.click(screen.getByRole("button", { name: "重新加载界面" }));
  expect(screen.getByRole("status").textContent).toContain("当前实例尚不支持");
});

test("recovery page takes over close and background-save handshakes until detached work drains", async () => {
  let release!: () => void;
  rendererSaveRecovery.retain(
    {},
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let prepareClose!: (token: string) => void;
  let backgroundSave!: (token: string) => void;
  const closeResult = vi.fn(async () => ({ ok: true, value: undefined }));
  const backgroundSaveResult = vi.fn(async () => ({ ok: true, value: undefined }));
  const unsubscribeClose = vi.fn();
  const unsubscribeBackground = vi.fn();
  window.patentApi = {
    application: {
      reportRendererFailure: async () => ({ ok: true, value: undefined }),
      onPrepareClose: (listener: (token: string) => void) => {
        prepareClose = listener;
        return unsubscribeClose;
      },
      onBackgroundSave: (listener: (token: string) => void) => {
        backgroundSave = listener;
        return unsubscribeBackground;
      },
      closeResult,
      backgroundSaveResult,
    },
  } as never;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const view = render(
    <AppErrorBoundary>
      <BrokenView />
    </AppErrorBoundary>,
  );
  prepareClose("close-token");
  backgroundSave("background-token");
  await Promise.resolve();
  expect(closeResult).not.toHaveBeenCalled();
  expect(backgroundSaveResult).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() =>
    expect(closeResult).toHaveBeenCalledWith({ token: "close-token", proceed: true }),
  );
  expect(backgroundSaveResult).toHaveBeenCalledWith({ token: "background-token", ok: true });
  view.unmount();
  expect(unsubscribeClose).toHaveBeenCalledOnce();
  expect(unsubscribeBackground).toHaveBeenCalledOnce();
});

test("allows retry if an accepted reload never navigates or IPC stalls", async () => {
  vi.useFakeTimers();
  renderRecovery(() => new Promise(() => undefined));
  fireEvent.click(screen.getByRole("button", { name: "重新加载界面" }));
  await vi.advanceTimersByTimeAsync(8000);
  await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("操作未完成"));
  expect(screen.getByRole("button", { name: "重新加载界面" })).toHaveProperty("disabled", false);
});
