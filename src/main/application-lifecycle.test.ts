import { installLibraryServiceShutdown, settleShutdownTasks } from "./application-lifecycle.js";
import { installDeferredQuit } from "./platform/deferred-quit.js";

test("keeps library services alive through before-quit and awaits shutdown on will-quit", async () => {
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  let releaseClose: (() => void) | undefined;
  const closePending = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const application = {
    on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) =>
      listeners.set(event, listener),
    ),
    quit: vi.fn(),
    exit: vi.fn(),
  };
  const closeLibraryServices = vi.fn(async () => closePending);

  installLibraryServiceShutdown(application, closeLibraryServices);

  listeners.get("before-quit")?.({ preventDefault: vi.fn() });
  expect(closeLibraryServices).not.toHaveBeenCalled();

  const firstEvent = { preventDefault: vi.fn() };
  listeners.get("will-quit")?.(firstEvent);
  expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
  expect(closeLibraryServices).toHaveBeenCalledOnce();
  expect(application.quit).not.toHaveBeenCalled();

  listeners.get("will-quit")?.({ preventDefault: vi.fn() });
  expect(closeLibraryServices).toHaveBeenCalledOnce();

  releaseClose?.();
  await closePending;
  await vi.waitFor(() => expect(application.exit).toHaveBeenCalledExactlyOnceWith(0));
  expect(application.quit).not.toHaveBeenCalled();

  const finalEvent = { preventDefault: vi.fn() };
  listeners.get("will-quit")?.(finalEvent);
  expect(finalEvent.preventDefault).not.toHaveBeenCalled();
});

test("a failed cleanup cannot interrupt other in-flight shutdown work", async () => {
  let release: (() => void) | undefined;
  let finished = false;
  const pending = new Promise<void>((resolve) => {
    release = () => {
      finished = true;
      resolve();
    };
  });
  const failure = new Error("synthetic cleanup failure");
  let listener: ((event: { preventDefault(): void }) => void) | undefined;
  const application = {
    on: (_event: string, callback: typeof listener) => {
      listener = callback;
    },
    quit: vi.fn(),
    exit: vi.fn(),
  };
  const report = vi.fn();
  installLibraryServiceShutdown(
    application,
    () =>
      settleShutdownTasks([
        () => {
          throw failure;
        },
        () => pending,
      ]),
    report,
  );
  listener?.({ preventDefault: vi.fn() });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(application.exit).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  release?.();
  await vi.waitFor(() => expect(application.exit).toHaveBeenCalledWith(1));
  expect(finished).toBe(true);
  const reported = report.mock.calls[0]?.[0];
  expect(reported).toBeInstanceOf(AggregateError);
  if (!(reported instanceof AggregateError)) throw new Error("missing shutdown error");
  expect(reported.errors).toContain(failure);
});

test("synchronous shutdown failures are reported before a nonzero exit", async () => {
  let listener: ((event: { preventDefault(): void }) => void) | undefined;
  const application = {
    on: (_event: string, callback: typeof listener) => {
      listener = callback;
    },
    quit: vi.fn(),
    exit: vi.fn(),
  };
  let finishReport: (() => void) | undefined;
  const reporting = new Promise<void>((resolve) => {
    finishReport = resolve;
  });
  const failure = new Error("synthetic failure");
  const report = vi.fn(() => reporting);
  installLibraryServiceShutdown(
    application,
    () => {
      throw failure;
    },
    report,
  );
  listener?.({ preventDefault: vi.fn() });
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith(failure));
  expect(application.exit).not.toHaveBeenCalled();
  finishReport?.();
  await vi.waitFor(() => expect(application.exit).toHaveBeenCalledWith(1));
});

test("resumes a quit interrupted by asynchronous window saving on macOS", () => {
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const app = {
    on: vi.fn((event: string, fn: (event: { preventDefault(): void }) => void) =>
      listeners.set(event, fn),
    ),
    quit: vi.fn(),
    exit: vi.fn(),
  };
  const close = vi.fn();
  installLibraryServiceShutdown(app, close);
  const guard = installDeferredQuit(app, () => true, "darwin");
  listeners.get("before-quit")?.({ preventDefault: vi.fn() });
  expect(close).not.toHaveBeenCalled();
  listeners.get("window-all-closed")?.({ preventDefault: vi.fn() });
  expect(app.quit).toHaveBeenCalledOnce();
  guard.cancel();
  listeners.get("window-all-closed")?.({ preventDefault: vi.fn() });
  expect(app.quit).toHaveBeenCalledOnce();
});
