import { FLOWCHART_MAX_FRAME_MESSAGE_BYTES } from "../../../shared/flowcharts/limits.js";
import { DRAWIO_FRAME_ORIGIN, DrawioFrameBridge } from "./drawio-frame-bridge.js";

const envelope = { sessionId: "session-1", projectId: "project-1", projectRevision: 2 };
function createHarness() {
  const contentWindow = { postMessage: vi.fn() } as unknown as Window;
  const iframe = { contentWindow } as HTMLIFrameElement;
  return { bridge: new DrawioFrameBridge(iframe, envelope, { timeoutMs: 10 }), contentWindow };
}
function dispatch(source: Window, data: object, origin = DRAWIO_FRAME_ORIGIN) {
  window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
}

describe("DrawioFrameBridge", () => {
  test("sends the fixed offline editor policy to the exact local origin", () => {
    const { bridge, contentWindow } = createHarness();

    bridge.configure();

    expect(contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "configure",
        locale: "zh_CN",
        policy: {
          cloud: false,
          templates: false,
          help: false,
          updates: false,
          plugins: false,
          grid: false,
          shadow: false,
        },
      }),
      DRAWIO_FRAME_ORIGIN,
    );
    bridge.dispose();
  });
  test("loads source only to the exact local editor origin", () => {
    const { bridge, contentWindow } = createHarness();
    bridge.load("<mxfile />");
    expect(contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "load", ...envelope }),
      DRAWIO_FRAME_ORIGIN,
    );
    bridge.dispose();
  });
  test("forwards undo and redo commands to the isolated editor", () => {
    const { bridge, contentWindow } = createHarness();

    bridge.undo();
    bridge.redo();

    expect(contentWindow.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "undo", ...envelope }),
      DRAWIO_FRAME_ORIGIN,
    );
    expect(contentWindow.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "redo", ...envelope }),
      DRAWIO_FRAME_ORIGIN,
    );
    bridge.dispose();
  });
  test("sends only fixed editor modes to the isolated editor", () => {
    const { bridge, contentWindow } = createHarness();

    bridge.setEditorMode("circuit");

    expect(contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "set-editor-mode",
        mode: "circuit",
        ...envelope,
      }),
      DRAWIO_FRAME_ORIGIN,
    );
    bridge.dispose();
  });
  test("sends bounded toolbar state to the exact local editor origin", () => {
    const { bridge, contentWindow } = createHarness();
    const state = {
      projectName: "新建流程图",
      activePageName: "第1页",
      saveStatus: "dirty" as const,
      dirty: true,
      saveBusy: false,
      exportBusy: false,
      canUndo: true,
      canRedo: false,
    };

    bridge.updateToolbar(state);

    expect(contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "toolbar-state", ...envelope, ...state }),
      DRAWIO_FRAME_ORIGIN,
    );
    expect(() => bridge.updateToolbar({ ...state, projectName: "项目".repeat(257) })).toThrow(
      "DRAWIO_BRIDGE_MESSAGE_TOO_LARGE",
    );
    expect(contentWindow.postMessage).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });
  test("acknowledges an accepted toolbar action to the exact local editor origin", () => {
    const { bridge, contentWindow } = createHarness();

    bridge.acknowledgeToolbarAction("toolbar-action-1");

    expect(contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "toolbar-action-ack",
        actionId: "toolbar-action-1",
        ...envelope,
      }),
      DRAWIO_FRAME_ORIGIN,
    );
    bridge.dispose();
  });
  test("rejects an outbound host message larger than the frame byte limit", () => {
    const { bridge } = createHarness();
    expect(() => bridge.load("x".repeat(FLOWCHART_MAX_FRAME_MESSAGE_BYTES))).toThrow(
      "DRAWIO_BRIDGE_MESSAGE_TOO_LARGE",
    );
    bridge.dispose();
  });
  test("resolves a matching save response and ignores wrong origin, source and revision", async () => {
    const { bridge, contentWindow } = createHarness();
    const pending = bridge.requestSave();
    const request = vi.mocked(contentWindow.postMessage).mock.calls[0]?.[0] as {
      requestId: string;
    };
    dispatch({} as Window, {
      ...envelope,
      requestId: request.requestId,
      type: "autosave",
      source: "bad",
    });
    dispatch(
      contentWindow,
      { ...envelope, requestId: request.requestId, type: "autosave", source: "bad" },
      "https://evil.test",
    );
    dispatch(contentWindow, {
      ...envelope,
      requestId: request.requestId,
      projectRevision: 3,
      type: "autosave",
      source: "bad",
    });
    dispatch(contentWindow, {
      ...envelope,
      requestId: request.requestId,
      type: "autosave",
      source: "<mxfile saved/>",
    });
    await expect(pending).resolves.toBe("<mxfile saved/>");
    bridge.dispose();
  });
  test("rejects oversized, late, timed out and disposed requests with stable codes", async () => {
    const { bridge, contentWindow } = createHarness();
    const timedOut = bridge.requestSave();
    await expect(timedOut).rejects.toMatchObject({ code: "DRAWIO_BRIDGE_TIMEOUT" });
    const late = vi.mocked(contentWindow.postMessage).mock.calls[0]?.[0] as { requestId: string };
    dispatch(contentWindow, {
      ...envelope,
      requestId: late.requestId,
      type: "autosave",
      source: "<mxfile />",
    });
    const oversized = bridge.requestExport({ format: "svg" });
    const request = vi.mocked(contentWindow.postMessage).mock.calls[1]?.[0] as {
      requestId: string;
    };
    dispatch(contentWindow, {
      ...envelope,
      requestId: request.requestId,
      type: "export-result",
      format: "svg",
      data: "x".repeat(40 * 1024 * 1024 + 1),
    });
    await expect(oversized).rejects.toMatchObject({ code: "DRAWIO_BRIDGE_MESSAGE_TOO_LARGE" });
    const disposed = bridge.requestSave();
    bridge.dispose();
    await expect(disposed).rejects.toMatchObject({ code: "DRAWIO_BRIDGE_DISPOSED" });
  });
  test("does not let a save request accept an export result", async () => {
    const { bridge, contentWindow } = createHarness();
    const pending = bridge.requestSave();
    const request = vi.mocked(contentWindow.postMessage).mock.calls[0]?.[0] as {
      requestId: string;
    };
    dispatch(contentWindow, {
      ...envelope,
      requestId: request.requestId,
      type: "export-result",
      format: "svg",
      data: "wrong",
    });
    dispatch(contentWindow, {
      ...envelope,
      requestId: request.requestId,
      type: "autosave",
      source: "right",
    });
    await expect(pending).resolves.toBe("right");
    bridge.dispose();
  });
  test("does not let an SVG export accept PNG data", async () => {
    const { bridge, contentWindow } = createHarness();
    const pending = bridge.requestExport({ format: "svg" });
    const request = vi.mocked(contentWindow.postMessage).mock.calls[0]?.[0] as {
      requestId: string;
    };
    dispatch(contentWindow, {
      ...envelope,
      requestId: request.requestId,
      type: "export-result",
      format: "png",
      data: "wrong",
    });
    dispatch(contentWindow, {
      ...envelope,
      requestId: request.requestId,
      type: "export-result",
      format: "svg",
      data: "right",
    });
    await expect(pending).resolves.toBe("right");
    bridge.dispose();
  });
  test("maps a matching frame error immediately without retaining source data", async () => {
    const { bridge, contentWindow } = createHarness();
    const pending = bridge.requestSave();
    const request = vi.mocked(contentWindow.postMessage).mock.calls[0]?.[0] as {
      requestId: string;
    };
    dispatch(contentWindow, {
      ...envelope,
      requestId: request.requestId,
      type: "error",
      code: "DRAWIO_FAILED",
      message: "normalized",
    });
    await expect(pending).rejects.toMatchObject({
      code: "DRAWIO_BRIDGE_FRAME_ERROR",
      frameCode: "DRAWIO_FAILED",
      frameMessage: "流程图编辑器操作失败。",
    });
    bridge.dispose();
  });

  test("ignores an oversized stale-session message that collides with a current request id", async () => {
    const { bridge, contentWindow } = createHarness();
    const pending = bridge.requestSave();
    const request = vi.mocked(contentWindow.postMessage).mock.calls[0]?.[0] as {
      requestId: string;
    };
    dispatch(contentWindow, {
      ...envelope,
      sessionId: "old-session",
      requestId: request.requestId,
      type: "autosave",
      source: "x".repeat(FLOWCHART_MAX_FRAME_MESSAGE_BYTES),
    });
    dispatch(contentWindow, {
      ...envelope,
      requestId: request.requestId,
      type: "autosave",
      source: "current-session-save",
    });
    await expect(pending).resolves.toBe("current-session-save");
    bridge.dispose();
  });
});

test("propagates app motion reduction into the isolated diagram editor", async () => {
  const { bridge, contentWindow } = createHarness();
  try {
    bridge.configure();
    document.documentElement.dataset.reducedMotion = "true";
    await Promise.resolve();
    expect(contentWindow.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "motion-preference", reducedMotion: true }),
      DRAWIO_FRAME_ORIGIN,
    );
  } finally {
    bridge.dispose();
    delete document.documentElement.dataset.reducedMotion;
  }
});
