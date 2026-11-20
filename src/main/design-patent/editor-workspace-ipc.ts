import {
  DesignEditorWorkspaceReleaseSchema,
  DesignEditorWorkspaceRequestSchema,
  IPC_CHANNELS,
} from "../../shared/ipc/contract.js";
import type { EditorWorkspaceLeases } from "./editor-workspace-leases.js";

/** Shared by the application and hidden native integration probes; sender/session policy stays at the host boundary. */
export function registerEditorWorkspaceResources(
  register: (channel: string, handler: (...args: unknown[]) => unknown) => void,
  options: {
    leases: EditorWorkspaceLeases;
    requireActive(sessionId: string): void;
    failure(error: unknown): unknown;
  },
): void {
  type Sender = {
    on(
      event: string,
      listener: (details?: { isMainFrame?: boolean; isSameDocument?: boolean }) => void,
    ): unknown;
  };
  const owners = new WeakMap<Sender, Map<string, string>>();
  const track = (event: unknown, lease: { sessionId: string; leaseId: string }) => {
    const sender = (event as { sender?: Sender } | undefined)?.sender;
    if (!sender || typeof sender.on !== "function") return;
    let owned = owners.get(sender);
    if (!owned) {
      owned = new Map();
      owners.set(sender, owned);
      const release = () => {
        for (const [sessionId, leaseId] of owned!) options.leases.release(sessionId, leaseId);
        owned!.clear();
      };
      sender.on("did-start-navigation", (details) => {
        if (details?.isMainFrame && !details.isSameDocument) release();
      });
      sender.on("render-process-gone", release);
      sender.on("destroyed", release);
    }
    owned.set(lease.sessionId, lease.leaseId);
  };
  register(IPC_CHANNELS.assetsAcquireDesignEditorWorkspace, (_event, input) => {
    try {
      const request = DesignEditorWorkspaceRequestSchema.parse(input);
      options.requireActive(request.sessionId);
      const value = options.leases.acquire(
        request.sessionId,
        request.frameId,
        request.scope === "application",
      );
      track(_event, value);
      return { ok: true, value };
    } catch (error) {
      return options.failure(error);
    }
  });
  register(IPC_CHANNELS.assetsReleaseDesignEditorWorkspace, (_event, input) => {
    try {
      const request = DesignEditorWorkspaceReleaseSchema.parse(input);
      options.leases.release(request.sessionId, request.leaseId);
      return { ok: true, value: undefined };
    } catch (error) {
      return options.failure(error);
    }
  });
}
