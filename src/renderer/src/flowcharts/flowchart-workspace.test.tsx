import { readFileSync } from "node:fs";

import { runInNewContext } from "node:vm";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import type { PatentApi } from "../../../shared/ipc/contract";
import { CANONICAL_PATENT_FORMAT_VERSION } from "../../../shared/patent/model";

const bridgeMocks = vi.hoisted(() => {
  const instances: Array<{
    context: { sessionId: string; projectId: string; projectRevision: number };
    acknowledgeToolbarAction: ReturnType<typeof vi.fn>;
    configure: ReturnType<typeof vi.fn>;
    activateSession: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    requestExport: ReturnType<typeof vi.fn>;
    requestSave: ReturnType<typeof vi.fn>;
    redo: ReturnType<typeof vi.fn>;
    setEditorMode: ReturnType<typeof vi.fn>;
    setPage: ReturnType<typeof vi.fn>;
    undo: ReturnType<typeof vi.fn>;
    updateToolbar: ReturnType<typeof vi.fn>;
  }> = [];
  return { instances };
});

const closeParticipantMock = vi.hoisted(() => vi.fn());

vi.mock("../app/application-close-coordinator", () => ({
  useApplicationCloseParticipant: closeParticipantMock,
}));

vi.mock("./drawio-frame-bridge", () => ({
  DRAWIO_FRAME_ORIGIN: "patent-diagram://editor",
  DrawioFrameBridge: class {
    acknowledgeToolbarAction = vi.fn();
    context: { sessionId: string; projectId: string; projectRevision: number };
    configure = vi.fn();
    activateSession = vi.fn();
    dispose = vi.fn();
    load = vi.fn();
    requestExport = vi.fn(() => Promise.resolve("<svg/>"));
    requestSave = vi.fn(() => Promise.resolve("<mxfile saved='1'/>>"));
    redo = vi.fn();
    setEditorMode = vi.fn();
    setPage = vi.fn();
    undo = vi.fn();
    updateToolbar = vi.fn();
    constructor(
      _iframe: HTMLIFrameElement,
      context: { sessionId: string; projectId: string; projectRevision: number },
    ) {
      this.context = context;
      bridgeMocks.instances.push(this);
    }
  },
}));

import { FlowchartWorkspace, type FlowchartWorkspaceHandle } from "./flowchart-workspace";

test("native history belongs to the focused ready flowchart, not outer inputs", async () => {
  const handle = createRef<FlowchartWorkspaceHandle>();
  render(
    <FlowchartWorkspace
      ref={handle}
      patentId={patentId}
      patentRevision={7}
      api={createApi()}
      onExit={vi.fn()}
    />,
  );
  const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
  fireEvent.load(frame);
  dispatchFrameMessage(frame, {
    type: "ready",
    pages: [{ id: "page-1", name: "第1页" }],
    activePageId: "page-1",
  });
  frame.focus();
  expect(handle.current?.dispatchNativeHistory("undo")).toBe(true);
  expect(handle.current?.dispatchNativeHistory("redo")).toBe(true);
  expect(bridge().undo).toHaveBeenCalledOnce();
  expect(bridge().redo).toHaveBeenCalledOnce();
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  expect(handle.current?.dispatchNativeHistory("undo")).toBe(false);
  input.remove();
});

const project = {
  projectId: "00000000-0000-4000-8000-000000000101",
  name: "控制方法流程图",
  revision: 3,
  pageCount: 1,
  lastPageId: "page-1",
  sourceSha256: "A".repeat(64),
  createdAt: "2026-08-10T00:00:00.000Z",
  modifiedAt: "2026-08-11T00:00:00.000Z",
};
const source = new TextEncoder().encode(
  '<mxfile><diagram id="page-1" name="第1页"><mxGraphModel/></diagram></mxfile>',
);
const patentId = "00000000-0000-4000-8000-000000000001";
let dispatchedToolbarActionSequence = 0;

function createApi() {
  return {
    list: vi.fn<PatentApi["flowcharts"]["list"]>(async () => ({
      ok: true as const,
      value: [project],
    })),
    create: vi.fn(async () => ({
      ok: true as const,
      value: { project: { ...project, revision: 0 }, source, patentRevision: 9 },
    })),
    importFile: vi.fn(async () => ({ ok: true as const, value: null })),
    load: vi.fn<PatentApi["flowcharts"]["load"]>(async () => ({
      ok: true as const,
      value: { project, source, patentRevision: 8 },
    })),
    save: vi.fn(async () => ({
      ok: true as const,
      value: { project: { ...project, revision: 4 }, source, patentRevision: 9 },
    })),
    rename: vi.fn(),
    duplicate: vi.fn(),
    delete: vi.fn(),
    exportBackup: vi.fn(async () => ({ ok: true as const, value: source })),
    renderPreview: vi.fn(async () => ({
      ok: true as const,
      value: {
        previewToken: "77777777-7777-4777-8777-777777777777",
        outputWidthMm: 36,
        preview: Uint8Array.from([137, 80, 78, 71]),
        widthPx: 100,
        heightPx: 50,
        warnings: [],
      },
    })),
    commitPreview: vi.fn(async () => ({
      ok: true as const,
      value: {
        patent: {
          formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
          patentId: "00000000-0000-4000-8000-000000000001",
          revision: 9,
        } as never,
        savedAt: "2026-08-11T00:00:00.000Z",
      },
    })),
  } satisfies PatentApi["flowcharts"];
}

function bridge() {
  const value = bridgeMocks.instances.at(-1);
  if (!value) throw new Error("frame bridge missing");
  return value;
}

function dispatchFrameMessage(frame: HTMLIFrameElement, message: object) {
  const toolbarActionId =
    "type" in message && message.type === "toolbar-action" && !("actionId" in message)
      ? { actionId: `toolbar-action-${++dispatchedToolbarActionSequence}` }
      : {};
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "patent-diagram://editor",
        source: frame.contentWindow,
        data: {
          sessionId: bridge().context.sessionId,
          projectId: project.projectId,
          projectRevision: bridge().context.projectRevision,
          requestId: "event-1",
          ...toolbarActionId,
          ...message,
        },
      }),
    );
  });
}

describe("FlowchartWorkspace", () => {
  test("finishes opening when hidden and reactivated during project discovery", async () => {
    const api = createApi();
    let finish!: (value: Awaited<ReturnType<typeof api.list>>) => void;
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const props = { patentId, patentRevision: 8, api, onExit: vi.fn() };
    const { rerender } = render(<FlowchartWorkspace {...props} active />);
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce());
    rerender(<FlowchartWorkspace {...props} active={false} />);
    await act(async () => finish({ ok: true, value: [project] }));
    rerender(<FlowchartWorkspace {...props} active />);
    expect(await screen.findByTitle("流程图编辑器")).toBeTruthy();
    expect(api.create).not.toHaveBeenCalled();
  });

  test.each([true, false])(
    "flushes before opening another linked project: save succeeds=%s",
    async (succeeds) => {
      const api = createApi();
      const other = { ...project, projectId: "00000000-0000-4000-8000-000000000303" };
      api.list.mockResolvedValue({ ok: true, value: [project, other] });
      if (!succeeds)
        api.save.mockResolvedValueOnce({ ok: false, error: { message: "磁盘已满" } } as never);
      const props = { patentId, patentRevision: 8, api, onExit: vi.fn() };
      const { rerender } = render(
        <FlowchartWorkspace {...props} initialProjectId={project.projectId} />,
      );
      const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
      fireEvent.load(frame);
      dispatchFrameMessage(frame, { type: "changed" });
      rerender(<FlowchartWorkspace {...props} initialProjectId={other.projectId} />);
      await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
      if (succeeds) {
        await waitFor(() =>
          expect(api.load).toHaveBeenLastCalledWith({ patentId, projectId: other.projectId }),
        );
        expect(api.save.mock.invocationCallOrder[0]).toBeLessThan(
          api.load.mock.invocationCallOrder[1] ?? 0,
        );
      } else {
        expect(api.load).toHaveBeenCalledOnce();
        expect(screen.getByTitle("流程图编辑器")).toBe(frame);
        expect(bridge().dispose).not.toHaveBeenCalled();
      }
    },
  );

  test("re-entering via the generic toolbar preserves the linked project's live editor", async () => {
    const api = createApi();
    const props = { patentId, patentRevision: 8, api, onExit: vi.fn() };
    const { rerender } = render(
      <FlowchartWorkspace {...props} initialProjectId={project.projectId} />,
    );
    const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
    fireEvent.load(frame);
    const originalBridge = bridge();
    rerender(<FlowchartWorkspace {...props} initialProjectId={null} />);
    await act(async () => {});
    expect(screen.getByTitle("流程图编辑器")).toBe(frame);
    expect(originalBridge.dispose).not.toHaveBeenCalled();
    expect(api.load).toHaveBeenCalledOnce();
  });

  test("cancels a stale linked-project load without leaving the live canvas inert", async () => {
    const api = createApi();
    const other = { ...project, projectId: "00000000-0000-4000-8000-000000000303" };
    api.list.mockResolvedValue({ ok: true, value: [project, other] });
    const props = { patentId, patentRevision: 8, api, onExit: vi.fn() };
    const { rerender } = render(
      <FlowchartWorkspace {...props} initialProjectId={project.projectId} />,
    );
    const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
    fireEvent.load(frame);
    dispatchFrameMessage(frame, {
      type: "ready",
      pages: [{ id: "page-1", name: "第1页" }],
      activePageId: "page-1",
    });
    bridge().requestSave.mockResolvedValue(new TextDecoder().decode(source));
    let finish!: (value: Awaited<ReturnType<typeof api.load>>) => void;
    api.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    rerender(<FlowchartWorkspace {...props} initialProjectId={other.projectId} />);
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(2));
    rerender(<FlowchartWorkspace {...props} initialProjectId={null} />);
    expect(frame.hasAttribute("inert")).toBe(false);
    await act(async () =>
      finish({ ok: true, value: { project: other, source, patentRevision: 8 } }),
    );
    expect(screen.getByTitle("流程图编辑器")).toBe(frame);
    expect(bridge().dispose).not.toHaveBeenCalled();
  });

  test("reports a stalled editor and retries in a new frame session without rewriting the project", async () => {
    vi.useFakeTimers();
    const api = createApi();
    try {
      await act(async () => {
        render(
          <FlowchartWorkspace patentId={patentId} patentRevision={8} api={api} onExit={vi.fn()} />,
        );
      });
      const frame = screen.getByTitle("流程图编辑器") as HTMLIFrameElement;
      fireEvent.load(frame);
      const oldSession = bridge().context.sessionId;
      expect(screen.getByText("正在加载绘图编辑器…")).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(15000);
      });
      fireEvent.click(screen.getByRole("button", { name: "重新加载编辑器" }));
      const replacement = screen.getByTitle("流程图编辑器") as HTMLIFrameElement;
      expect(replacement).toBe(frame);
      fireEvent.load(replacement);
      expect(bridge().context.sessionId).not.toBe(oldSession);
      dispatchFrameMessage(replacement, {
        type: "ready",
        pages: [{ id: "page-1", name: "第1页" }],
        activePageId: "page-1",
      });
      expect(screen.getByText("正在加载绘图编辑器…").closest("[inert]")).not.toBeNull();
      act(() => vi.advanceTimersByTime(420));
      expect(screen.queryByText("正在加载绘图编辑器…")).toBeNull();
      expect(api.save).not.toHaveBeenCalled();
      expect(api.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  beforeEach(() => {
    bridgeMocks.instances.splice(0);
    dispatchedToolbarActionSequence = 0;
  });

  test.each([
    ["s", false, "save"],
    ["Tab", false, "cycle-tab-next"],
    ["Tab", true, "cycle-tab-previous"],
  ] as const)("forwards iframe key %s (reverse=%s) as %s", (key, shiftKey, action) => {
    let keydown: ((event: KeyboardEvent) => void) | undefined;
    let receiveMessage: ((event: MessageEvent<string>) => void) | undefined;
    const postMessage = vi.fn();
    const clearTimeout = vi.fn();
    const setTimeout = vi.fn(() => 7);
    const parent = { postMessage };
    runInNewContext(readFileSync("resources/drawio/app/embed-bridge.js", "utf8"), {
      document: {
        addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
          if (type === "keydown") keydown = listener;
        },
      },
      window: {
        addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) => {
          if (type === "message") receiveMessage = listener;
        },
        clearTimeout,
        parent,
        setTimeout,
      },
    });
    const event = {
      altKey: false,
      ctrlKey: true,
      key,
      shiftKey,
      metaKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    keydown?.(event);

    expect(keydown).toBeDefined();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    const actionMessage = JSON.parse(postMessage.mock.calls[0]?.[0] as string) as {
      action: string;
      actionId: string;
      event: string;
    };
    expect(actionMessage).toMatchObject({ event: "toolbar-action", action });
    expect(actionMessage.actionId).toMatch(/^toolbar-[a-z0-9]+-1$/u);
    expect(setTimeout).toHaveBeenCalledOnce();

    receiveMessage?.({
      source: parent,
      origin: "patent-diagram://editor",
      data: JSON.stringify({
        action: "patent-toolbar-action-ack",
        actionId: actionMessage.actionId,
      }),
    } as unknown as MessageEvent<string>);
    expect(clearTimeout).toHaveBeenCalledWith(7);
  });

  test("sets the requested editor mode and switches it without reloading or saving", async () => {
    const api = createApi();
    const onEditorModeChange = vi.fn();
    const view = render(
      <FlowchartWorkspace
        patentId={patentId}
        patentRevision={8}
        api={api}
        initialMode="circuit"
        onEditorModeChange={onEditorModeChange}
        onExit={vi.fn()}
      />,
    );
    const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
    fireEvent.load(frame);
    await waitFor(() => expect(bridge().setEditorMode).toHaveBeenCalledWith("circuit"));
    const currentBridge = bridge();
    const loadCount = currentBridge.activateSession.mock.calls.length;

    dispatchFrameMessage(frame, { type: "editor-mode-changed", mode: "flowchart" });
    expect(onEditorModeChange).not.toHaveBeenCalledWith("flowchart");
    expect(currentBridge.setEditorMode).toHaveBeenLastCalledWith("circuit");

    dispatchFrameMessage(frame, { type: "editor-mode-changed", mode: "circuit" });
    expect(onEditorModeChange).toHaveBeenCalledWith("circuit");

    view.rerender(
      <FlowchartWorkspace
        patentId={patentId}
        patentRevision={8}
        api={api}
        initialMode="flowchart"
        onEditorModeChange={onEditorModeChange}
        onExit={vi.fn()}
      />,
    );
    await waitFor(() => expect(currentBridge.setEditorMode).toHaveBeenLastCalledWith("flowchart"));
    expect(currentBridge.activateSession).toHaveBeenCalledTimes(loadCount);
    expect(currentBridge.requestSave).not.toHaveBeenCalled();

    dispatchFrameMessage(frame, { type: "editor-mode-changed", mode: "flowchart" });
    expect(onEditorModeChange).toHaveBeenCalledWith("flowchart");
    expect(currentBridge.requestSave).not.toHaveBeenCalled();
  });

  test("auto-creates and opens the first project without rendering a project list", async () => {
    const api = createApi();
    api.list.mockResolvedValueOnce({ ok: true, value: [] });
    api.create.mockResolvedValueOnce({
      ok: true,
      value: {
        project: { ...project, name: "图像识别专利-流程图1", revision: 0 },
        source,
        patentRevision: 9,
      },
    });
    render(
      <FlowchartWorkspace
        patentId={patentId}
        patentName="图像识别专利"
        patentRevision={8}
        api={api}
        onExit={vi.fn()}
      />,
    );

    expect(await screen.findByTitle("流程图编辑器")).toBeTruthy();
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "图像识别专利-流程图1", expectedPatentRevision: 8 }),
    );
    expect(screen.queryByRole("main", { name: "流程图工程列表" })).toBeNull();
    expect(api.load).not.toHaveBeenCalled();
  });

  test("routes the iframe save action through the outer explicit-save callback", async () => {
    const api = createApi();
    const onExplicitSave = vi.fn(async () => true);
    await act(async () => {
      render(
        <FlowchartWorkspace
          patentId={patentId}
          patentRevision={8}
          api={api}
          onExplicitSave={onExplicitSave}
          onExit={vi.fn()}
        />,
      );
    });
    const frame = screen.getByTitle("流程图编辑器") as HTMLIFrameElement;
    fireEvent.load(frame);
    dispatchFrameMessage(frame, {
      type: "ready",
      pages: [{ id: "page-1", name: "第1页" }],
      activePageId: "page-1",
    });
    await waitFor(() => expect(frame.hasAttribute("inert")).toBe(false));

    dispatchFrameMessage(frame, { type: "toolbar-action", action: "save" });

    await waitFor(() => expect(onExplicitSave).toHaveBeenCalledOnce());
    expect(bridge().requestSave).not.toHaveBeenCalled();
  });

  test("opens the most recently modified project by default", async () => {
    const api = createApi();
    const recent = {
      ...project,
      projectId: "00000000-0000-4000-8000-000000000202",
      name: "最近工程",
      modifiedAt: "2026-08-12T01:00:00.000Z",
    };
    api.list.mockResolvedValueOnce({ ok: true, value: [project, recent] });
    api.load.mockImplementation(
      async ({ projectId: requestedProjectId }: { projectId: string }) => ({
        ok: true as const,
        value: {
          project: requestedProjectId === recent.projectId ? recent : project,
          source,
          patentRevision: 8,
        },
      }),
    );

    render(
      <FlowchartWorkspace
        patentId={patentId}
        patentName="测试专利"
        patentRevision={8}
        api={api}
        onExit={vi.fn()}
      />,
    );

    expect(await screen.findByTitle("流程图编辑器")).toBeTruthy();
    expect(api.load).toHaveBeenCalledWith({ patentId, projectId: recent.projectId });
  });

  test("prefers a valid linked project and falls back to the most recent project", async () => {
    const api = createApi();
    const recent = {
      ...project,
      projectId: "00000000-0000-4000-8000-000000000202",
      name: "最近工程",
      modifiedAt: "2026-08-12T01:00:00.000Z",
    };
    api.list.mockResolvedValue({ ok: true, value: [project, recent] });
    const { rerender } = render(
      <FlowchartWorkspace
        patentId={patentId}
        patentName="测试专利"
        patentRevision={8}
        initialProjectId={project.projectId}
        api={api}
        onExit={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(api.load).toHaveBeenCalledWith({ patentId, projectId: project.projectId }),
    );

    const otherPatentId = "00000000-0000-4000-8000-000000000009";
    rerender(
      <FlowchartWorkspace
        patentId={otherPatentId}
        patentName="另一个专利"
        patentRevision={8}
        initialProjectId="00000000-0000-4000-8000-000000000999"
        api={api}
        onExit={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(api.load).toHaveBeenCalledWith({
        patentId: otherPatentId,
        projectId: recent.projectId,
      }),
    );
  });

  test("uses the host tab for navigation and fills an embedded content region", async () => {
    const api = createApi();
    const ref = createRef<FlowchartWorkspaceHandle>();
    render(
      <FlowchartWorkspace
        ref={ref}
        patentId="00000000-0000-4000-8000-000000000001"
        patentRevision={8}
        api={api}
        embedded
        onExit={vi.fn()}
      />,
    );

    const workspace = await screen.findByRole("main", { name: "流程图编辑工作区" });
    expect(workspace.classList).toContain("is-embedded");
    expect(screen.queryByRole("button", { name: "返回说明书附图" })).toBeNull();
    await expect(ref.current?.requestClose()).resolves.toBe(true);
    await expect(ref.current?.flush()).resolves.toBe(true);
    expect(closeParticipantMock).toHaveBeenCalledWith(
      `flowchart-workspace:${patentId}`,
      expect.any(Function),
      "editor",
    );
  });

  test("opens a persisted project and publishes its state without a second header row", async () => {
    const api = createApi();
    render(
      <FlowchartWorkspace
        patentId="00000000-0000-4000-8000-000000000001"
        patentRevision={8}
        api={api}
        onExit={vi.fn()}
      />,
    );
    const frame = await screen.findByTitle("流程图编辑器");
    fireEvent.load(frame);

    expect(frame.getAttribute("src")).toBe("patent-diagram://editor/adapter.html");
    expect(bridge().configure).toHaveBeenCalledOnce();
    expect(bridge().activateSession).toHaveBeenCalledWith(new TextDecoder().decode(source));
    expect(document.querySelector(".flowchart-workspace__header")).toBeNull();
    expect(bridge().updateToolbar).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: "控制方法流程图", saveStatus: "saved" }),
    );
    dispatchFrameMessage(frame as HTMLIFrameElement, {
      type: "ready",
      pages: [{ id: "page-1", name: "第1页" }],
      activePageId: "page-1",
    });
    dispatchFrameMessage(frame as HTMLIFrameElement, {
      type: "history-state",
      canUndo: true,
      canRedo: false,
    });
    await waitFor(() =>
      expect(bridge().updateToolbar).toHaveBeenLastCalledWith(
        expect.objectContaining({ activePageName: "第1页", canUndo: true, canRedo: false }),
      ),
    );
  });

  test("keeps the linked project open while toggling the project menu", async () => {
    const api = createApi();
    render(
      <FlowchartWorkspace
        patentId="00000000-0000-4000-8000-000000000001"
        patentRevision={8}
        initialProjectId={project.projectId}
        api={api}
        onExit={vi.fn()}
      />,
    );

    await screen.findByRole("main", { name: "流程图编辑工作区" });
    const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
    fireEvent.load(frame);
    dispatchFrameMessage(frame, { type: "toolbar-action", action: "toggle-project-menu" });

    await waitFor(() => expect(screen.getByRole("menu", { name: "流程图工程列表" })).toBeTruthy());
    expect(screen.getByTitle("流程图编辑器")).toBe(frame);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.load).toHaveBeenCalledOnce();
  });

  test("switches projects from the menu without unmounting the workspace", async () => {
    const api = createApi();
    const other = {
      ...project,
      projectId: "00000000-0000-4000-8000-000000000303",
      name: "另一个工程",
      modifiedAt: "2026-08-10T00:00:00.000Z",
    };
    api.list.mockResolvedValueOnce({ ok: true, value: [project, other] });
    api.load.mockImplementation(
      async ({ projectId: requestedProjectId }: { projectId: string }) => ({
        ok: true as const,
        value: {
          project: requestedProjectId === other.projectId ? other : project,
          source,
          patentRevision: 8,
        },
      }),
    );
    render(
      <FlowchartWorkspace
        patentId={patentId}
        patentName="测试专利"
        patentRevision={8}
        api={api}
        onExit={vi.fn()}
      />,
    );
    const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
    fireEvent.load(frame);
    dispatchFrameMessage(frame, { type: "toolbar-action", action: "toggle-project-menu" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /另一个工程/ }));

    await waitFor(() =>
      expect(api.load).toHaveBeenLastCalledWith({ patentId, projectId: other.projectId }),
    );
    expect(screen.getByRole("main", { name: "流程图编辑工作区" })).toBeTruthy();
    expect(screen.queryByRole("menu", { name: "流程图工程列表" })).toBeNull();
  });

  test("shows retry and return actions when project discovery fails", async () => {
    const api = createApi();
    api.list
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "INTERNAL", message: "工程读取失败" },
      })
      .mockResolvedValueOnce({ ok: true, value: [project] });
    const onExit = vi.fn();
    render(
      <FlowchartWorkspace
        patentId={patentId}
        patentName="测试专利"
        patentRevision={8}
        api={api}
        onExit={onExit}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toContain("工程读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTitle("流程图编辑器")).toBeTruthy();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(onExit).not.toHaveBeenCalled();
  });

  test("deleting the last project immediately creates and opens a replacement", async () => {
    const api = createApi();
    api.delete.mockResolvedValueOnce({
      ok: true,
      value: { patentRevision: 10, detachedFigureCount: 0 },
    });
    api.create.mockResolvedValueOnce({
      ok: true,
      value: {
        project: {
          ...project,
          projectId: "00000000-0000-4000-8000-000000000404",
          name: "测试专利-流程图1",
        },
        source,
        patentRevision: 11,
      },
    });
    render(
      <FlowchartWorkspace
        patentId={patentId}
        patentName="测试专利"
        patentRevision={8}
        api={api}
        onExit={vi.fn()}
      />,
    );
    const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
    fireEvent.load(frame);
    dispatchFrameMessage(frame, { type: "toolbar-action", action: "project-delete" });
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(api.create).toHaveBeenCalledOnce());
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPatentRevision: 10, name: "测试专利-流程图1" }),
    );
    expect(await screen.findByTitle("流程图编辑器")).toBeTruthy();
  });

  test("persists dirty source and blocks leaving when saving fails", async () => {
    const api = createApi();
    const onExit = vi.fn();
    render(
      <FlowchartWorkspace
        patentId="00000000-0000-4000-8000-000000000001"
        patentRevision={8}
        api={api}
        onExit={onExit}
      />,
    );
    const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
    fireEvent.load(frame);
    dispatchFrameMessage(frame, {
      type: "ready",
      pages: [{ id: "page-1", name: "第1页" }],
      activePageId: "page-1",
    });
    dispatchFrameMessage(frame, { type: "changed" });
    bridge().requestSave.mockRejectedValueOnce(new Error("disk full"));

    dispatchFrameMessage(frame, { type: "toolbar-action", action: "project-create" });

    await waitFor(() => expect(bridge().requestSave).toHaveBeenCalledOnce());
    expect(onExit).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(bridge().updateToolbar).toHaveBeenLastCalledWith(
        expect.objectContaining({ saveStatus: "error", dirty: true }),
      ),
    );
    expect(screen.getByRole("alert").textContent).toContain("修改仍保留在当前编辑会话中");
    expect(screen.getByRole("button", { name: "导出工程备份" })).toBeTruthy();
  });

  test("uses the revisions produced by a dirty save for the following rename", async () => {
    const api = createApi();
    api.rename.mockResolvedValueOnce({
      ok: true,
      value: {
        project: { ...project, name: "保存后重命名", revision: 5 },
        source,
        patentRevision: 10,
      },
    });
    render(
      <FlowchartWorkspace
        patentId={patentId}
        patentName="测试专利"
        patentRevision={8}
        api={api}
        onExit={vi.fn()}
      />,
    );
    const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
    fireEvent.load(frame);
    await waitFor(() => expect(bridge().activateSession).toHaveBeenCalledOnce());
    dispatchFrameMessage(frame, { type: "changed" });
    dispatchFrameMessage(frame, { type: "toolbar-action", action: "project-rename" });
    const dialog = await screen.findByRole("dialog", { name: "重命名流程图工程" });
    expect(dialog.classList.contains("standard-dialog--m")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "工程名称" }), {
      target: { value: "保存后重命名" },
    });
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(api.rename).toHaveBeenCalledOnce());
    expect(api.rename).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPatentRevision: 9, expectedProjectRevision: 4 }),
    );
    expect(screen.getByTitle("流程图编辑器")).toBe(frame);
    expect(bridge().dispose).not.toHaveBeenCalled();
  });

  test("uses the patent save coordinator supplied by the workspace host", async () => {
    const api = createApi();
    const saveProject = vi.fn(async () => ({
      ok: true as const,
      value: { project: { ...project, revision: 4 }, source, patentRevision: 9 },
    }));
    render(
      <FlowchartWorkspace
        patentId="00000000-0000-4000-8000-000000000001"
        patentRevision={8}
        api={api}
        saveProject={saveProject}
        onExit={vi.fn()}
      />,
    );
    const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
    fireEvent.load(frame);
    dispatchFrameMessage(frame, {
      type: "ready",
      pages: [{ id: "page-1", name: "第1页" }],
      activePageId: "page-1",
    });
    dispatchFrameMessage(frame, { type: "changed" });

    dispatchFrameMessage(frame, { type: "toolbar-action", action: "save" });

    await waitFor(() => expect(saveProject).toHaveBeenCalledOnce());
    expect(api.save).not.toHaveBeenCalled();
  });

  test("acknowledges repeated toolbar messages but handles an action id only once", async () => {
    const saveProject = vi.fn(async () => ({
      ok: true as const,
      value: { project: { ...project, revision: 4 }, source, patentRevision: 9 },
    }));
    render(
      <FlowchartWorkspace
        patentId={patentId}
        patentRevision={8}
        api={createApi()}
        saveProject={saveProject}
        onExit={vi.fn()}
      />,
    );
    const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
    fireEvent.load(frame);
    dispatchFrameMessage(frame, { type: "changed" });
    dispatchFrameMessage(frame, {
      type: "toolbar-action",
      action: "save",
      actionId: "toolbar-action-retry",
    });
    await waitFor(() => expect(saveProject).toHaveBeenCalledOnce());

    dispatchFrameMessage(frame, {
      type: "toolbar-action",
      action: "save",
      actionId: "toolbar-action-retry",
    });

    await waitFor(() => expect(bridge().acknowledgeToolbarAction).toHaveBeenCalledTimes(2));
    expect(saveProject).toHaveBeenCalledOnce();
  });

  test("coalesces concurrent save requests so insert actions do not race the autosave", async () => {
    const api = createApi();
    let resolveSave:
      | ((value: Awaited<ReturnType<PatentApi["flowcharts"]["save"]>>) => void)
      | null = null;
    const saveProject = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<PatentApi["flowcharts"]["save"]>>>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(
      <FlowchartWorkspace
        patentId={patentId}
        patentRevision={8}
        api={api}
        saveProject={saveProject}
        onExit={vi.fn()}
      />,
    );
    const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
    fireEvent.load(frame);
    dispatchFrameMessage(frame, { type: "changed" });

    dispatchFrameMessage(frame, { type: "toolbar-action", action: "save" });
    dispatchFrameMessage(frame, {
      type: "toolbar-action",
      action: "export-to-description-drawing",
    });
    await act(async () => Promise.resolve());

    expect(bridge().requestSave).toHaveBeenCalledOnce();
    expect(saveProject).toHaveBeenCalledOnce();
    await act(async () => {
      resolveSave?.({
        ok: true,
        value: { project: { ...project, revision: 4 }, source, patentRevision: 9 },
      });
    });
    await waitFor(() =>
      expect(bridge().updateToolbar).toHaveBeenLastCalledWith(
        expect.objectContaining({ saveStatus: "saved", dirty: false }),
      ),
    );
    await waitFor(() => expect(api.renderPreview).toHaveBeenCalledOnce());
  });

  test("starts when Electron does not expose crypto.randomUUID", async () => {
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    try {
      render(
        <FlowchartWorkspace
          patentId="00000000-0000-4000-8000-000000000001"
          patentRevision={8}
          api={createApi()}
          onExit={vi.fn()}
        />,
      );
      expect(await screen.findByRole("main", { name: "流程图编辑工作区" })).toBeTruthy();
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        value: original,
      });
    }
  });

  test("exports native draw.io source and disables selection export when nothing is selected", async () => {
    const api = createApi();
    const createObjectURL = vi.fn(() => "blob:flowchart-export");
    const revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    render(
      <FlowchartWorkspace
        patentId="00000000-0000-4000-8000-000000000001"
        patentRevision={8}
        api={api}
        onExit={vi.fn()}
      />,
    );
    const frame = await screen.findByTitle("流程图编辑器");
    fireEvent.load(frame);
    await waitFor(() => expect(bridge().activateSession).toHaveBeenCalledOnce());

    dispatchFrameMessage(frame as HTMLIFrameElement, {
      type: "toolbar-action",
      action: "export-external",
    });
    const dialog = await screen.findByRole("dialog", { name: "导出至电脑" });
    expect(dialog.classList.contains("standard-dialog--xl")).toBe(true);
    expect(dialog.classList.contains("flowchart-export-dialog--external")).toBe(true);
    expect(dialog.querySelectorAll(".flowchart-export-choice-card")).toHaveLength(2);
    expect(dialog.querySelector(".standard-dialog__footer")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "当前选取" }).hasAttribute("disabled")).toBe(true);
    const formatOptions = Array.from(
      dialog.querySelectorAll("option"),
      (option) => option.textContent,
    );
    expect(formatOptions).toEqual(["draw.io 工程", "SVG", "PNG", "JPG", "PDF"]);
    await waitFor(() =>
      expect(bridge().requestExport).toHaveBeenCalledWith({ format: "svg", selectionOnly: false }),
    );
    expect(screen.getByAltText("导出内容预览")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认导出" }));

    await waitFor(() => expect(bridge().requestSave).toHaveBeenCalledOnce());
    expect(bridge().requestExport).toHaveBeenCalledOnce();
    expect(dialog.closest("[inert]")).not.toBeNull();
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  test("generates the patent drawing preview through the isolated main-process renderer", async () => {
    const api = createApi();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:patent-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    render(
      <FlowchartWorkspace
        patentId="00000000-0000-4000-8000-000000000001"
        patentRevision={8}
        api={api}
        onExit={vi.fn()}
      />,
    );
    const frame = await screen.findByTitle("流程图编辑器");
    fireEvent.load(frame);
    await waitFor(() => {
      dispatchFrameMessage(frame as HTMLIFrameElement, {
        type: "ready",
        pages: [{ id: "page-1", name: "第1页" }],
        activePageId: "page-1",
      });
      expect(screen.queryByText("正在加载绘图编辑器…")).toBeNull();
    });
    dispatchFrameMessage(frame as HTMLIFrameElement, {
      type: "toolbar-action",
      action: "export-to-description-drawing",
    });
    await waitFor(() => expect(api.renderPreview).toHaveBeenCalledOnce());
    expect(bridge().requestExport).toHaveBeenCalledWith({ format: "svg", selectionOnly: false });
    expect(api.renderPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.projectId,
        pageId: "page-1",
        borderMm: 2,
        exportScope: "page",
        drawingPage: expect.objectContaining({ widthMm: 210 }),
        rotationDeg: 0,
      }),
    );
    expect(
      ((await screen.findByAltText("最终黑白专利附图预览")) as HTMLImageElement).style.width,
    ).toBe("36mm");
    fireEvent.click(screen.getByRole("button", { name: "添加为图 1" }));
    await waitFor(() => expect(api.commitPreview).toHaveBeenCalledOnce());
    expect(api.commitPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.projectId,
        previewToken: "77777777-7777-4777-8777-777777777777",
      }),
    );
  });

  test("asks for project deletion in an in-app confirmation dialog", async () => {
    render(
      <FlowchartWorkspace
        patentId="00000000-0000-4000-8000-000000000001"
        patentRevision={8}
        api={createApi()}
        onExit={vi.fn()}
      />,
    );

    const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
    fireEvent.load(frame);
    dispatchFrameMessage(frame, { type: "toolbar-action", action: "project-delete" });
    expect(
      screen
        .getByRole("alertdialog", { name: "删除流程图工程" })
        .classList.contains("standard-dialog--s"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消删除" }));
    expect(screen.queryByRole("alertdialog", { name: "删除流程图工程" })).toBeNull();
  });

  test("routes import and duplicate actions from the draw.io File menu", async () => {
    const api = createApi();
    render(
      <FlowchartWorkspace
        patentId={patentId}
        patentName="测试专利"
        patentRevision={8}
        api={api}
        onExit={vi.fn()}
      />,
    );
    const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
    fireEvent.load(frame);
    await waitFor(() => expect(bridge().activateSession).toHaveBeenCalledOnce());

    dispatchFrameMessage(frame, { type: "toolbar-action", action: "project-import" });
    await waitFor(() => expect(api.importFile).toHaveBeenCalledOnce());

    dispatchFrameMessage(frame, { type: "toolbar-action", action: "project-duplicate" });
    expect(await screen.findByRole("dialog", { name: "复制流程图工程" })).toBeTruthy();
  });
});

test("restores export cancellation when flushing fails", async () => {
  const api = createApi();
  api.save.mockResolvedValue({
    ok: false,
    error: { code: "IO_ERROR", message: "audit disk failure" },
  } as never);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:audit"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  render(<FlowchartWorkspace patentId={patentId} patentRevision={8} api={api} onExit={vi.fn()} />);
  const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
  fireEvent.load(frame);
  await waitFor(() => expect(bridge().activateSession).toHaveBeenCalled());
  dispatchFrameMessage(frame, { type: "changed" });
  dispatchFrameMessage(frame, { type: "toolbar-action", action: "export-external" });
  await screen.findByRole("dialog", { name: "导出至电脑" });
  fireEvent.click(screen.getByRole("button", { name: "确认导出" }));
  await waitFor(() => expect(api.save).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "确认导出" }).hasAttribute("disabled")).toBe(false),
  );
  expect(screen.getByRole("button", { name: "取消" }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByText(/audit disk failure|保存失败|未能保存/)).toBeTruthy();
});

test("automatically flushes edits that arrive during a pending save", async () => {
  vi.useFakeTimers();
  const api = createApi();
  let finishSave: (value: Awaited<ReturnType<typeof api.save>>) => void = () => {};
  api.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
  );
  try {
    await act(async () => {
      render(
        <FlowchartWorkspace patentId={patentId} patentRevision={8} api={api} onExit={vi.fn()} />,
      );
    });
    const frame = screen.getByTitle("流程图编辑器") as HTMLIFrameElement;
    fireEvent.load(frame);
    dispatchFrameMessage(frame, { type: "changed" });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(bridge().requestSave).toHaveBeenCalledWith(false);
    dispatchFrameMessage(frame, { type: "changed" });
    await act(async () => {
      finishSave({
        ok: true,
        value: { project: { ...project, revision: 4 }, source, patentRevision: 9 },
      });
    });
    expect(bridge().updateToolbar.mock.calls.at(-1)?.[0].saveStatus).toBe("saved");
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(api.save).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("suspending captures the editing caret once even when finishing text triggers another save", async () => {
  const api = createApi();
  const handle = createRef<FlowchartWorkspaceHandle>();
  render(<FlowchartWorkspace ref={handle} patentId={patentId} patentRevision={8} api={api} onExit={vi.fn()} />);
  const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
  fireEvent.load(frame);
  dispatchFrameMessage(frame, {type:"ready", pages:[{id:"page-1",name:"第1页"}],activePageId:"page-1"});
  bridge().requestSave.mockImplementationOnce(async () => {
    dispatchFrameMessage(frame, {type:"changed"});
    return "<mxfile edited='1'/>";
  });
  await act(async () => { expect(await handle.current?.suspend()).toBe(true); });
  expect(bridge().requestSave.mock.calls).toEqual([[true, true], [true]]);
});

test("closing during autosave captures unfinished editing after that save completes", async () => {
  vi.useFakeTimers();
  const api = createApi();
  const handle = createRef<FlowchartWorkspaceHandle>();
  let finishSave!: (value: Awaited<ReturnType<typeof api.save>>) => void;
  api.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
  );
  try {
    await act(async () => {
      render(
        <FlowchartWorkspace
          ref={handle}
          patentId={patentId}
          patentRevision={8}
          api={api}
          onExit={vi.fn()}
        />,
      );
    });
    const frame = screen.getByTitle("流程图编辑器") as HTMLIFrameElement;
    fireEvent.load(frame);
    dispatchFrameMessage(frame, {
      type: "ready",
      pages: [{ id: "page-1", name: "第1页" }],
      activePageId: "page-1",
    });
    dispatchFrameMessage(frame, { type: "changed" });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(bridge().requestSave).toHaveBeenLastCalledWith(false);
    const closing = handle.current?.requestClose();
    await act(async () => {
      finishSave({
        ok: true,
        value: { project: { ...project, revision: 4 }, source, patentRevision: 9 },
      });
      await closing;
    });
    expect(bridge().requestSave.mock.calls.map((args) => args[0])).toEqual([false, true]);
    await expect(closing).resolves.toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("backs up the current unsaved canvas instead of the last stored revision", async () => {
  const api = createApi();
  const handle = createRef<FlowchartWorkspaceHandle>();
  api.save.mockResolvedValue({
    ok: false,
    error: { code: "IO_ERROR", message: "disk failure" },
  } as never);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  const blobSpy = vi.fn(() => "blob:backup");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: blobSpy });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  render(
    <FlowchartWorkspace
      ref={handle}
      patentId={patentId}
      patentRevision={8}
      api={api}
      onExit={vi.fn()}
    />,
  );
  const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
  fireEvent.load(frame);
  await waitFor(() => expect(bridge().activateSession).toHaveBeenCalled());
  dispatchFrameMessage(frame, { type: "changed" });
  await act(async () => {
    await handle.current?.flush();
  });
  bridge().requestSave.mockResolvedValue("<mxfile current='unsaved'/>");
  const before = bridge().requestSave.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "导出工程备份" }));
  await waitFor(() => expect(blobSpy).toHaveBeenCalled());
  expect(bridge().requestSave).toHaveBeenCalledTimes(before + 1);
  expect(api.exportBackup).not.toHaveBeenCalled();
});

test.each(["success", "conversion-failure", "navigation-failure"])(
  "exports a vector PDF to CAD: %s",
  async (outcome) => {
    const api = createApi();
    const pdf = Uint8Array.from([37, 80, 68, 70]);
    const flowchartPdf = vi.fn(async () =>
      outcome === "conversion-failure"
        ? { ok: false, error: { message: "转换失败" } }
        : { ok: true, value: pdf },
    );
    const originalApi = window.patentApi;
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        ...originalApi,
        exports: { ...originalApi?.exports, flowchartPdf },
      },
    });
    const onExportToCad = vi.fn(async () => {
      if (outcome === "navigation-failure") throw new Error("当前专利已切换");
    });
    try {
      render(
        <FlowchartWorkspace
          patentId={patentId}
          patentRevision={8}
          api={api}
          onExit={vi.fn()}
          onExportToCad={onExportToCad}
        />,
      );
      const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
      fireEvent.load(frame);
      await waitFor(() => expect(bridge().activateSession).toHaveBeenCalled());
      dispatchFrameMessage(frame, { type: "changed" });
      dispatchFrameMessage(frame, {
        type: "toolbar-action",
        action: "export-external",
      });
      const button = await screen.findByRole("button", {
        name: "导出至CAD标号",
      });
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(flowchartPdf).toHaveBeenCalledOnce());
      expect(api.save).toHaveBeenCalled();
      expect(bridge().requestExport).toHaveBeenCalledWith({
        format: "svg",
        selectionOnly: false,
      });
      if (outcome === "success") {
        await waitFor(() =>
          expect(screen.queryByRole("dialog", { name: "导出至电脑" })).toBeNull(),
        );
        expect(onExportToCad).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            name: `${project.name}.pdf`,
            type: "application/pdf",
            size: pdf.length,
          }),
          patentId,
        );
      } else {
        await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
        expect(screen.getByRole("dialog", { name: "导出至电脑" })).toBeTruthy();
        if (outcome === "conversion-failure") expect(onExportToCad).not.toHaveBeenCalled();
      }
    } finally {
      Object.defineProperty(window, "patentApi", {
        configurable: true,
        value: originalApi,
      });
    }
  },
);
test("leases the same heavy frame and restores the same session through a fresh isolated bridge", async () => {
  const handle = createRef<FlowchartWorkspaceHandle>();
  const api = createApi();
  const tree = (enabled: boolean) => (
    <FlowchartWorkspace
      ref={handle}
      patentId={patentId}
      patentRevision={7}
      api={api}
      onExit={vi.fn()}
      active={enabled}
      runtimeEnabled={enabled}
    />
  );
  const view = render(tree(true));
  const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
  fireEvent.load(frame);
  dispatchFrameMessage(frame, {
    type: "ready",
    pages: [{ id: "page-1", name: "第1页" }],
    activePageId: "page-1",
  });
  const oldBridge = bridge();
  await act(async () => expect(await handle.current?.flush()).toBe(true));
  view.rerender(tree(false));
  expect(screen.queryByTitle("流程图编辑器")).toBeNull();
  expect(oldBridge.dispose).toHaveBeenCalled();
  view.rerender(tree(true));
  const restored = await screen.findByTitle("流程图编辑器");
  expect(restored).toBe(frame);
  expect(bridge()).not.toBe(oldBridge);
  expect(bridge().context.sessionId).toBe(oldBridge.context.sessionId);
  expect(bridge().activateSession).toHaveBeenCalled();
});
test("restores the owning project's last page after the runtime is resumed", async () => {
  const api = createApi();
  api.load.mockResolvedValue({
    ok: true,
    value: {
      project: { ...project, lastPageId: "page-2", pageCount: 2 },
      source,
      patentRevision: 8,
    },
  });
  const tree = (enabled: boolean) => (
    <FlowchartWorkspace
      patentId={patentId}
      patentRevision={7}
      api={api}
      onExit={vi.fn()}
      active={enabled}
      runtimeEnabled={enabled}
    />
  );
  const view = render(tree(true));
  const frame = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
  fireEvent.load(frame);
  const ready = {
    type: "ready",
    pages: [
      { id: "page-1", name: "第1页" },
      { id: "page-2", name: "第2页" },
    ],
    activePageId: "page-1",
  };
  dispatchFrameMessage(frame, ready);
  expect(bridge().setPage).toHaveBeenCalledWith("page-2");
  view.rerender(tree(false));
  view.rerender(tree(true));
  const resumed = (await screen.findByTitle("流程图编辑器")) as HTMLIFrameElement;
  fireEvent.load(resumed);
  dispatchFrameMessage(resumed, ready);
  expect(bridge().setPage).toHaveBeenCalledWith("page-2");
});
