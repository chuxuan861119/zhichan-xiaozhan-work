import {
  type DrawioExportRequest,
  type DrawioFrameMessage,
  DrawioFrameMessageSchema,
  DrawioHostMessageSchema,
  type DrawioToolbarState,
  type FlowchartEditorMode,
} from "../../../shared/flowcharts/bridge.js";
import { FLOWCHART_MAX_FRAME_MESSAGE_BYTES } from "../../../shared/flowcharts/limits.js";
import { prefersReducedMotion, subscribeMotionPreference } from "../shared/motion-preference";

export const DRAWIO_FRAME_ORIGIN = "patent-diagram://editor";
export type DrawioBridgeErrorCode =
  | "DRAWIO_BRIDGE_TIMEOUT"
  | "DRAWIO_BRIDGE_DISPOSED"
  | "DRAWIO_BRIDGE_MESSAGE_TOO_LARGE"
  | "DRAWIO_BRIDGE_FRAME_ERROR";
export class DrawioBridgeError extends Error {
  readonly frameCode: string | undefined;
  readonly frameMessage: string | undefined;

  constructor(
    readonly code: DrawioBridgeErrorCode,
    frameCode?: string,
  ) {
    super(code);
    this.frameCode = frameCode;
    this.frameMessage = frameCode ? "流程图编辑器操作失败。" : undefined;
  }
}
type Context = { sessionId: string; projectId: string; projectRevision: number };
const OFFLINE_EDITOR_POLICY = {
  cloud: false,
  templates: false,
  help: false,
  updates: false,
  plugins: false,
  grid: false,
  shadow: false,
} as const;
type Pending = {
  resolve: (value: string) => void;
  reject: (reason: DrawioBridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
  type: "autosave" | "export-result";
  format: DrawioExportRequest["format"] | undefined;
};

function utf8ByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export class DrawioFrameBridge {
  private readonly pending = new Map<string, Pending>();
  private disposed = false;
  private readonly unsubscribeMotion: () => void;
  private sequence = 0;
  private readonly timeoutMs: number;
  private readonly receive = (event: MessageEvent<unknown>) => this.onMessage(event);
  constructor(
    private readonly iframe: HTMLIFrameElement,
    private readonly context: Context,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    window.addEventListener("message", this.receive);
    this.unsubscribeMotion = subscribeMotionPreference(() => {
      this.send("motion-preference", { reducedMotion: prefersReducedMotion() });
    });
  }
  load(source: string): void {
    this.send("load", { source });
  }
  activateSession(source: string): void {
    this.send("activate-session", { source });
  }
  configure(): void {
    this.send("configure", { locale: "zh_CN", policy: OFFLINE_EDITOR_POLICY });
    this.send("motion-preference", { reducedMotion: prefersReducedMotion() });
  }
  setPage(pageId: string): void {
    this.send("set-page", { pageId });
  }
  setEditorMode(mode: FlowchartEditorMode): void {
    this.send("set-editor-mode", { mode });
  }
  undo(): void {
    this.send("undo", {});
  }
  redo(): void {
    this.send("redo", {});
  }
  acknowledgeToolbarAction(actionId: string): void {
    this.send("toolbar-action-ack", { actionId });
  }
  updateToolbar(state: DrawioToolbarState): void {
    if (this.disposed || !this.iframe.contentWindow) return;
    const parsed = DrawioHostMessageSchema.safeParse({
      ...this.context,
      requestId: this.nextRequestId(),
      type: "toolbar-state",
      ...state,
    });
    if (!parsed.success || utf8ByteLength(parsed.data) > FLOWCHART_MAX_FRAME_MESSAGE_BYTES)
      throw new DrawioBridgeError("DRAWIO_BRIDGE_MESSAGE_TOO_LARGE");
    this.iframe.contentWindow.postMessage(parsed.data, DRAWIO_FRAME_ORIGIN);
  }
  requestSave(finishEditing = true, preserveEditing = false): Promise<string> {
    return this.request("request-save", { finishEditing, ...(preserveEditing ? { preserveEditing } : {}) });
  }
  requestExport(request: DrawioExportRequest): Promise<string> {
    return this.request("request-export", request);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeMotion();
    window.removeEventListener("message", this.receive);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DrawioBridgeError("DRAWIO_BRIDGE_DISPOSED"));
    }
    this.pending.clear();
  }
  private nextRequestId(): string {
    this.sequence += 1;
    return `drawio-${this.sequence}`;
  }
  private send(
    type:
      | "motion-preference"
      | "configure"
      | "load"
      | "activate-session"
      | "set-page"
      | "set-editor-mode"
      | "toolbar-action-ack"
      | "undo"
      | "redo",
    data: object,
  ): void {
    if (this.disposed || !this.iframe.contentWindow) return;
    const message = { ...this.context, requestId: this.nextRequestId(), type, ...data };
    if (utf8ByteLength(message) > FLOWCHART_MAX_FRAME_MESSAGE_BYTES)
      throw new DrawioBridgeError("DRAWIO_BRIDGE_MESSAGE_TOO_LARGE");
    this.iframe.contentWindow.postMessage(message, DRAWIO_FRAME_ORIGIN);
  }
  private request(type: "request-save" | "request-export", data: object): Promise<string> {
    if (this.disposed || !this.iframe.contentWindow)
      return Promise.reject(new DrawioBridgeError("DRAWIO_BRIDGE_DISPOSED"));
    const requestId = this.nextRequestId();
    const message = { ...this.context, requestId, type, ...data };
    if (utf8ByteLength(message) > FLOWCHART_MAX_FRAME_MESSAGE_BYTES)
      return Promise.reject(new DrawioBridgeError("DRAWIO_BRIDGE_MESSAGE_TOO_LARGE"));
    this.iframe.contentWindow.postMessage(message, DRAWIO_FRAME_ORIGIN);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DrawioBridgeError("DRAWIO_BRIDGE_TIMEOUT"));
      }, this.timeoutMs);
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        type: type === "request-save" ? "autosave" : "export-result",
        format: type === "request-export" ? (data as DrawioExportRequest).format : undefined,
      });
    });
  }
  private onMessage(event: MessageEvent<unknown>): void {
    if (
      this.disposed ||
      event.origin !== DRAWIO_FRAME_ORIGIN ||
      event.source !== this.iframe.contentWindow
    )
      return;
    if (!this.hasCurrentContext(event.data)) return;
    if (utf8ByteLength(event.data) > FLOWCHART_MAX_FRAME_MESSAGE_BYTES) {
      const requestId =
        typeof event.data === "object" && event.data !== null && "requestId" in event.data
          ? (event.data as { requestId?: unknown }).requestId
          : undefined;
      if (typeof requestId === "string") this.reject(requestId, "DRAWIO_BRIDGE_MESSAGE_TOO_LARGE");
      return;
    }
    const parsed = DrawioFrameMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    this.resolve(parsed.data);
  }
  private hasCurrentContext(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null) return false;
    const envelope = value as Record<string, unknown>;
    return (
      envelope.sessionId === this.context.sessionId &&
      envelope.projectId === this.context.projectId &&
      envelope.projectRevision === this.context.projectRevision
    );
  }
  private resolve(message: DrawioFrameMessage): void {
    if (message.type === "error") {
      this.reject(message.requestId, "DRAWIO_BRIDGE_FRAME_ERROR", message.code);
      return;
    }
    if (message.type !== "autosave" && message.type !== "export-result") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (
      pending.type !== message.type ||
      (message.type === "export-result" && pending.format !== message.format)
    )
      return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.resolve(message.type === "autosave" ? message.source : message.data);
  }
  private reject(requestId: string, code: DrawioBridgeErrorCode, frameCode?: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(new DrawioBridgeError(code, frameCode));
  }
}
