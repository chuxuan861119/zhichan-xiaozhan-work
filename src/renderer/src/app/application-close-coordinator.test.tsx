import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import type { PatentApi } from "../../../shared/ipc/contract";
import type { AppError } from "../../../shared/ipc/result";
import { onApplicationError } from "../shared/error-dialog";
import {
  ApplicationCloseProvider,
  type ApplicationPersistence,
  useApplicationCloseParticipant,
  useApplicationPersistence,
} from "./application-close-coordinator";

type CloseListener = (token: string) => void;
type TestClosePhase = "editor" | "aggregate" | "backup";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function installApplicationApi() {
  const closeListeners: CloseListener[] = [];
  const unsubscribe = vi.fn();
  const closeResult = vi.fn(async () => ({ ok: true as const, value: undefined }));
  window.patentApi = {
    application: {
      onPrepareClose: vi.fn((listener: CloseListener) => {
        closeListeners.push(listener);
        return unsubscribe;
      }),
      closeResult,
    },
  } as unknown as PatentApi;
  return { closeListeners, closeResult, unsubscribe };
}

function Participant({ id, flush }: Readonly<{ id: string; flush: () => Promise<boolean> }>) {
  useApplicationCloseParticipant(id, flush);
  return null;
}

function CapturePersistence({
  capture,
}: Readonly<{ capture: (persistence: ApplicationPersistence) => void }>) {
  capture(useApplicationPersistence());
  return null;
}

function renderPersistence(children?: ReactNode) {
  let persistence: ApplicationPersistence | undefined;
  const view = render(
    <ApplicationCloseProvider>
      <CapturePersistence capture={(value) => (persistence = value)} />
      {children}
    </ApplicationCloseProvider>,
  );
  if (!persistence) throw new Error("Persistence probe did not render");
  return { persistence, view };
}

describe("application persistence coordinator", () => {
  test("shows delayed progress, keeps saving locked until cancellation settles, and permits a later close", async () => {
    vi.useFakeTimers();
    try {
      const api = installApplicationApi();
      window.patentApi.application.closeHeartbeat = vi.fn(async () => ({
        ok: true as const,
        value: undefined,
      }));
      const editor = deferred<boolean>();
      const aggregate = vi.fn(async () => true);
      render(
        <ApplicationCloseProvider>
          <PhasedParticipant id="editor" phase="editor" flush={() => editor.promise} />
          <PhasedParticipant id="patents" phase="aggregate" flush={aggregate} />
        </ApplicationCloseProvider>,
      );
      await act(async () => api.closeListeners[0]?.("attempt-1"));
      expect(screen.queryByRole("dialog")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(1_500));
      expect(screen.getByRole("dialog", { name: "正在完成退出" })).toBeDefined();
      await act(async () => vi.advanceTimersByTimeAsync(6_500));
      fireEvent.click(screen.getByRole("button", { name: "返回软件" }));
      expect(api.closeResult).not.toHaveBeenCalled();
      await act(async () => editor.resolve(true));
      expect(api.closeResult).toHaveBeenCalledWith({ token: "attempt-1", proceed: false });
      expect(aggregate).not.toHaveBeenCalled();
      await act(async () => api.closeListeners[0]?.("attempt-2"));
      expect(api.closeResult).toHaveBeenCalledWith({ token: "attempt-2", proceed: true });
      expect(aggregate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  test("background save omits close guards but a concurrent exit runs them afterwards", async () => {
    let finish!: (value: boolean) => void;
    const editor = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(true);
    const guard = vi.fn().mockResolvedValue(false);
    const { persistence } = renderPersistence(<Participant id="editor" flush={editor} />);
    persistence.registerCloseGuard("settings", guard);
    const background = persistence.flushAll("background-save");
    const exit = persistence.flushAll("application-close");
    expect(guard).not.toHaveBeenCalled();
    finish(true);
    expect(await background).toEqual({ ok: true, failedParticipantIds: [] });
    expect(await exit).toEqual({ ok: false, failedParticipantIds: ["settings"] });
    expect(guard).toHaveBeenCalledOnce();
    expect(editor).toHaveBeenCalledTimes(2);
  });
  beforeEach(() => {
    installApplicationApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("reports every false, synchronous throw, and asynchronous rejection in registration order", async () => {
    const errors: AppError[] = [];
    const stopListening = onApplicationError((error) => errors.push(error));
    const successful = vi.fn(async () => true);
    const returnedFalse = vi.fn(async () => false);
    const threw = vi.fn(() => {
      throw new Error("secret patent body from sync throw");
    });
    const rejected = vi.fn(async () => {
      throw new Error("secret patent body from rejection");
    });
    const { persistence } = renderPersistence(
      <>
        <Participant id="patent:1:description" flush={successful} />
        <Participant id="flowchart:1" flush={returnedFalse} />
        <Participant id="auxiliary-editor:1" flush={threw} />
        <Participant id="documents" flush={rejected} />
      </>,
    );

    const report = await persistence.flushAll("full-data-transfer");

    expect(report).toEqual({
      ok: false,
      failedParticipantIds: ["flowchart:1", "auxiliary-editor:1", "documents"],
    });
    expect(successful).toHaveBeenCalledOnce();
    expect(returnedFalse).toHaveBeenCalledOnce();
    expect(threw).toHaveBeenCalledOnce();
    expect(rejected).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain("secret patent body");
    expect(errors).toEqual([]);
    stopListening();
  });

  test("keeps the latest registration for an id and ignores cleanup from the replaced registration", async () => {
    const oldFlush = vi.fn(async () => true);
    const latestFlush = vi.fn(async () => true);
    const { persistence } = renderPersistence();

    const cleanupOld = persistence.register("patents", oldFlush);
    const cleanupLatest = persistence.register("patents", latestFlush);
    cleanupOld();

    await expect(persistence.flushAll("full-data-transfer")).resolves.toEqual({
      ok: true,
      failedParticipantIds: [],
    });
    expect(oldFlush).not.toHaveBeenCalled();
    expect(latestFlush).toHaveBeenCalledOnce();

    cleanupLatest();
    await persistence.flushAll("full-data-transfer");
    expect(latestFlush).toHaveBeenCalledOnce();
  });

  test("returns the exact same promise for concurrent flushes and reruns after it settles", async () => {
    const pending = deferred<boolean>();
    const flush = vi.fn(() => pending.promise);
    const { persistence } = renderPersistence(<Participant id="patents" flush={flush} />);

    const first = persistence.flushAll("full-data-transfer");
    const concurrent = persistence.flushAll("application-close");

    expect(concurrent).toBe(first);
    expect(flush).toHaveBeenCalledOnce();
    pending.resolve(true);
    await expect(first).resolves.toEqual({ ok: true, failedParticipantIds: [] });

    const rerun = persistence.flushAll("full-data-transfer");
    expect(rerun).not.toBe(first);
    await expect(rerun).resolves.toEqual({ ok: true, failedParticipantIds: [] });
    expect(flush).toHaveBeenCalledTimes(2);
  });

  test("uses a stable participant snapshot while registrations change during a flush", async () => {
    const pending = deferred<boolean>();
    const original = vi.fn(() => pending.promise);
    const replacement = vi.fn(async () => true);
    const addedLater = vi.fn(async () => true);
    const { persistence } = renderPersistence();
    const cleanupOriginal = persistence.register("patents", original);

    const first = persistence.flushAll("full-data-transfer");
    persistence.register("documents", addedLater);
    persistence.register("patents", replacement);
    cleanupOriginal();
    pending.resolve(true);

    await first;
    expect(original).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    expect(addedLater).not.toHaveBeenCalled();

    await persistence.flushAll("full-data-transfer");
    expect(original).toHaveBeenCalledOnce();
    expect(replacement).toHaveBeenCalledOnce();
    expect(addedLater).toHaveBeenCalledOnce();
  });

  test("does not leak registrations across StrictMode cleanup or component unmount", async () => {
    const flush = vi.fn(async () => true);
    let persistence: ApplicationPersistence | undefined;
    const view = render(
      <StrictMode>
        <ApplicationCloseProvider>
          <CapturePersistence capture={(value) => (persistence = value)} />
          <Participant id="patents" flush={flush} />
        </ApplicationCloseProvider>
      </StrictMode>,
    );
    if (!persistence) throw new Error("Persistence probe did not render");

    await persistence.flushAll("full-data-transfer");
    expect(flush).toHaveBeenCalledOnce();

    view.unmount();
    await persistence.flushAll("full-data-transfer");
    expect(flush).toHaveBeenCalledOnce();
  });

  test("isolates nested providers", async () => {
    const outerFlush = vi.fn(async () => true);
    const innerFlush = vi.fn(async () => true);
    let outer: ApplicationPersistence | undefined;
    let inner: ApplicationPersistence | undefined;
    render(
      <ApplicationCloseProvider>
        <CapturePersistence capture={(value) => (outer = value)} />
        <Participant id="outer" flush={outerFlush} />
        <ApplicationCloseProvider>
          <CapturePersistence capture={(value) => (inner = value)} />
          <Participant id="inner" flush={innerFlush} />
        </ApplicationCloseProvider>
      </ApplicationCloseProvider>,
    );
    if (!outer || !inner) throw new Error("Persistence probes did not render");

    await inner.flushAll("full-data-transfer");
    expect(innerFlush).toHaveBeenCalledOnce();
    expect(outerFlush).not.toHaveBeenCalled();

    await outer.flushAll("full-data-transfer");
    expect(outerFlush).toHaveBeenCalledOnce();
    expect(innerFlush).toHaveBeenCalledOnce();
  });

  test("throws when the persistence hook is used outside its provider", () => {
    function OutsideProvider() {
      useApplicationPersistence();
      return null;
    }

    expect(() => render(<OutsideProvider />)).toThrow(
      "useApplicationPersistence must be used within ApplicationCloseProvider",
    );
  });

  test("rejects blank or oversized participant ids at the registration boundary", () => {
    const { persistence } = renderPersistence();
    const flush = vi.fn(async () => true);

    expect(() => persistence.register("", flush)).toThrow("Participant id must not be blank");
    expect(() => persistence.register("   ", flush)).toThrow("Participant id must not be blank");
    const cleanup = persistence.register("a".repeat(160), flush);
    expect(() => persistence.register("a".repeat(161), flush)).toThrow(
      "Participant id must not exceed 160 characters",
    );
    cleanup();
  });

  test("application close joins the active flush and keeps the existing reply protocol", async () => {
    const api = installApplicationApi();
    const pending = deferred<boolean>();
    const flush = vi.fn(() => pending.promise);
    const { persistence } = renderPersistence(<Participant id="patents" flush={flush} />);
    const transferFlush = persistence.flushAll("full-data-transfer");

    act(() => api.closeListeners[0]?.("close-token"));
    expect(flush).toHaveBeenCalledOnce();
    expect(api.closeResult).not.toHaveBeenCalled();
    pending.resolve(true);

    await transferFlush;
    await waitFor(() =>
      expect(api.closeResult).toHaveBeenCalledWith({ token: "close-token", proceed: true }),
    );
    expect(api.closeResult).toHaveBeenCalledOnce();
  });

  test("runs a transfer close guard immediately when application close interrupts a save flush", async () => {
    const pendingSave = deferred<boolean>();
    const save = vi.fn(() => pendingSave.promise);
    const guard = vi.fn(async () => false);
    const { persistence } = renderPersistence(<Participant id="patents" flush={save} />);
    const closeGuardRegistrar = persistence as ApplicationPersistence & {
      registerCloseGuard(participantId: string, participant: () => Promise<boolean>): () => void;
    };

    expect(closeGuardRegistrar.registerCloseGuard).toBeTypeOf("function");
    closeGuardRegistrar.registerCloseGuard("full-data-export", guard);
    const transferFlush = persistence.flushAll("full-data-transfer");
    const closeFlush = persistence.flushAll("application-close");

    await waitFor(() => expect(guard).toHaveBeenCalledOnce());
    await expect(closeFlush).resolves.toEqual({
      ok: false,
      failedParticipantIds: ["full-data-export"],
    });
    expect(save).toHaveBeenCalledOnce();
    pendingSave.resolve(true);
    await transferFlush;
  });

  test("application close blocks on thrown participants and emits one sanitized error", async () => {
    const api = installApplicationApi();
    const errors: AppError[] = [];
    const stopListening = onApplicationError((error) => errors.push(error));
    const first = vi.fn(() => {
      throw new Error("first secret patent body");
    });
    const second = vi.fn(async () => {
      throw new Error("second secret patent body");
    });
    renderPersistence(
      <>
        <Participant id="patents" flush={first} />
        <Participant id="documents" flush={second} />
      </>,
    );

    act(() => api.closeListeners[0]?.("failed-close-token"));

    await waitFor(() =>
      expect(api.closeResult).toHaveBeenCalledWith({
        token: "failed-close-token",
        proceed: false,
      }),
    );
    expect(errors).toEqual([
      {
        code: "INTERNAL",
        message: "本地操作失败。",
        nextAction: "请重试；如果问题持续，请重新启动应用。",
      },
    ]);
    expect(JSON.stringify(errors)).not.toContain("secret patent body");
    stopListening();
  });
});

function PhasedParticipant({
  id,
  phase,
  flush,
}: Readonly<{
  id: string;
  phase: TestClosePhase;
  flush: () => Promise<boolean>;
}>) {
  useApplicationCloseParticipant(id, flush, phase);
  return null;
}

describe("application close phase ordering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("runs every editor participant before aggregate participants", async () => {
    const api = installApplicationApi();
    const order: string[] = [];
    const flowchart = deferred<boolean>();
    render(
      <ApplicationCloseProvider>
        <PhasedParticipant
          id="flowchart"
          phase="editor"
          flush={async () => {
            order.push("flowchart");
            return flowchart.promise;
          }}
        />
        <PhasedParticipant
          id="auxiliary-editor"
          phase="editor"
          flush={async () => {
            order.push("auxiliary-editor");
            return true;
          }}
        />
        <PhasedParticipant
          id="patents"
          phase="aggregate"
          flush={async () => {
            order.push("patents");
            return true;
          }}
        />
      </ApplicationCloseProvider>,
    );

    act(() => api.closeListeners[0]?.("close-token"));
    await act(async () => Promise.resolve());
    expect(order).toEqual(["flowchart", "auxiliary-editor"]);
    expect(api.closeResult).not.toHaveBeenCalled();

    await act(async () => flowchart.resolve(true));
    await waitFor(() =>
      expect(api.closeResult).toHaveBeenCalledWith({ token: "close-token", proceed: true }),
    );
    expect(order[2]).toBe("patents");
  });

  test("does not run aggregate participants when an editor participant fails", async () => {
    const api = installApplicationApi();
    const aggregate = vi.fn(async () => true);
    render(
      <ApplicationCloseProvider>
        <PhasedParticipant id="flowchart" phase="editor" flush={async () => false} />
        <PhasedParticipant id="patents" phase="aggregate" flush={aggregate} />
      </ApplicationCloseProvider>,
    );

    act(() => api.closeListeners[0]?.("blocked-token"));

    await waitFor(() =>
      expect(api.closeResult).toHaveBeenCalledWith({ token: "blocked-token", proceed: false }),
    );
    expect(aggregate).not.toHaveBeenCalled();
  });

  test("runs final backup after aggregate saves only for an application close", async () => {
    const order: string[] = [];
    const { persistence } = renderPersistence();
    persistence.register(
      "patents",
      async () => {
        order.push("patents");
        return true;
      },
      "aggregate",
    );
    persistence.register(
      "final-backup",
      async () => {
        order.push("backup");
        return true;
      },
      "backup",
      { reasons: ["application-close"] },
    );

    await persistence.flushAll("full-data-transfer");
    expect(order).toEqual(["patents"]);

    await persistence.flushAll("application-close");
    expect(order).toEqual(["patents", "patents", "backup"]);
  });
});
