import type { KlecksDocumentIdentity } from "./klecks-document-port";
import type { KlecksFrameClient } from "./klecks-frame-client";
import { KlecksKernelSessions } from "./klecks-kernel-sessions";
import { createOwnedKlecksFrame } from "./klecks-owned-frame";

type Options = Parameters<typeof createOwnedKlecksFrame>[0] & { active: boolean };
type Attachment = { container: HTMLElement; active: boolean };
type Kernel = {
  owner: ReturnType<typeof createOwnedKlecksFrame>;
  ready: Promise<KlecksKernelSessions>;
  sessions: Map<string, Attachment>;
  manager: KlecksKernelSessions | null;
  releases: Map<string, Promise<void>>;
  host: HTMLDivElement;
  overlay: HTMLDivElement;
  update(): void;
  park(): void;
  release(): void;
};
const kernels = new WeakMap<Options["api"], Kernel>();

export async function withKlecksScratchFrame<T>(
  api: Options["api"],
  sessionId: string,
  run: (
    frame: KlecksFrameClient,
    sessionId: string,
    sync: (docs: KlecksDocumentIdentity[]) => Promise<boolean>,
  ) => Promise<T>,
): Promise<T> {
  const existing = kernels.get(api);
  if (existing) return (await existing.ready).withScratch(run);
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;left:-2000px;top:0;width:640px;height:480px;pointer-events:none";
  container.setAttribute("aria-hidden", "true");
  document.body.append(container);
  const owner = createOwnedKlecksFrame({
    container,
    sessionId,
    api,
    platform: /Mac/i.test(navigator.platform)
      ? "mac"
      : /Harmony|OpenHarmony/i.test(navigator.userAgent)
        ? "harmony"
        : "windows",
  });
  try {
    const frame = await owner.ready;
    return await run(frame, sessionId, (docs) => frame.documents.sync(sessionId, docs));
  } finally {
    try {
      await owner.dispose();
    } finally {
      container.remove();
    }
  }
}

function createKernel(options: Options): Kernel {
  // Only atomic moveBefore may reparent a loaded iframe. append/insertBefore would reload it.
  const host = document.createElement("div"),
    overlay = document.createElement("div");
  host.dataset.designEditorKernel = "shared";
  host.style.cssText = "position:absolute;inset:0;display:none;overflow:hidden";
  overlay.style.cssText = "position:absolute;inset:0;pointer-events:none";
  document.body.append(host);
  // Admission still requires a real, authorized patent session. The lease itself lives until the kernel closes.
  const sessionId = options.sessionId;
  const sessions = new Map<string, Attachment>();
  let manager: KlecksKernelSessions | null = null;
  const update = () => {
    const attachment = manager?.selectedId ? sessions.get(manager.selectedId) : undefined;
    const target = attachment?.container;
    if (target?.isConnected && host.parentElement !== target) target.moveBefore(host, null);
    host.style.display =
      attachment?.active && target?.isConnected && host.parentElement === target ? "block" : "none";
    host.style.visibility = manager?.displayingId === manager?.selectedId ? "visible" : "hidden";
  };
  const park = () => {
    if (host.isConnected && host.parentElement !== document.body)
      document.body.moveBefore(host, null);
    host.style.display = "none";
  };
  const owner = createOwnedKlecksFrame({
    platform: options.platform,
    api: options.api,
    sessionId,
    scope: "application",
    container: host,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const kernel: Kernel = {
    owner,
    sessions,
    host,
    overlay,
    manager,
    releases: new Map(),
    ready: owner.ready.then((client) => {
      manager = new KlecksKernelSessions(client, sessionId, update);
      kernel.manager = manager;
      host.append(overlay);
      return manager;
    }),
    update,
    park,
    release: () => {
      manager?.dispose();
      host.remove();
    },
  };
  return kernel;
}

export function createSharedKlecksFrame(options: Options) {
  let kernel = kernels.get(options.api);
  if (!kernel) {
    kernel = createKernel(options);
    kernels.set(options.api, kernel);
  }
  const current = kernel;
  const previousRelease = current.releases.get(options.sessionId);
  const attachment = { container: options.container, active: options.active };
  current.sessions.set(options.sessionId, attachment);
  let closed = false,
    client: KlecksFrameClient | null = null,
    detach: (() => void) | undefined;
  const ready = current.ready.then(async (manager) => {
    await previousRelease;
    if (closed) throw new Error("图片编辑器启动已取消。");
    if (typeof options.container.moveBefore !== "function")
      throw new Error("当前平台尚不支持安全切换共享画布，请升级 WebView；未重新载入或丢弃图片。");
    client = manager.attach(options.sessionId);
    client.canvasOverlayHost = current.overlay;
    // The component reports pending-operation rejection; still attach its logical controller.
    if (attachment.active) {
      try {
        manager.select(options.sessionId);
      } catch {}
    }
    detach = options.connected?.(client);
    return client;
  });
  void ready.catch(() => {});
  return {
    ready,
    park() {
      if (current.host.parentElement === attachment.container) current.park();
    },
    setContainer(container: HTMLElement) {
      attachment.container = container;
      current.update();
    },
    setActive(active: boolean) {
      attachment.active = active;
      if (active && client) current.manager?.select(options.sessionId);
      current.update();
    },
    dispose(): Promise<void> {
      if (closed) return current.releases.get(options.sessionId) ?? Promise.resolve();
      closed = true;
      const work = (async () => {
        await ready.catch(() => {});
        detach?.();
        client?.close();
        if (client) await current.manager?.detach(options.sessionId);
        if (current.sessions.get(options.sessionId) === attachment)
          current.sessions.delete(options.sessionId);
        if (!current.sessions.size) {
          if (kernels.get(options.api) === current) kernels.delete(options.api);
          await current.owner.dispose();
          current.release();
        } else current.update();
      })();
      current.releases.set(options.sessionId, work);
      void work
        .finally(() => {
          if (current.releases.get(options.sessionId) === work)
            current.releases.delete(options.sessionId);
        })
        .catch(() => {});
      return work;
    },
  };
}
