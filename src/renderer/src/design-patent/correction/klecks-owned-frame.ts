import {
  type DesignEditorWorkspaceLease,
  DesignEditorWorkspaceLeaseSchema,
  type PatentApi,
} from "../../../../shared/ipc/contract";
import {
  connectKlecksFrame,
  createKlecksFrameNonce,
  type KlecksFrameClient,
} from "./klecks-frame-client";
import { grantedKlecksResourcePolicy } from "./klecks-resource-budget";

type Options = {
  scope?: "application";
  container: HTMLElement;
  sessionId: string;
  platform: "windows" | "mac" | "harmony";
  api: Pick<PatentApi["assets"], "acquireDesignEditorWorkspace" | "releaseDesignEditorWorkspace">;
  connected?(client: KlecksFrameClient): (() => void) | undefined;
  timeoutMs?: number;
};

// React development probing cleans up and immediately remounts the same container.
// The main-process lease must finish releasing before that replacement acquires it.
const pendingFrameReleases = new WeakMap<Options["api"], Map<string, Promise<void>>>();

/** Retain at case scope across workflow steps. Dispose only after checkpoint/close approval,
 * or while cancelling startup. This transport owner does not choose to discard unsaved work.
 */
export function createOwnedKlecksFrame(options: Options) {
  let sessionReleases = pendingFrameReleases.get(options.api);
  if (!sessionReleases) {
    sessionReleases = new Map();
    pendingFrameReleases.set(options.api, sessionReleases);
  }
  const releases = sessionReleases;
  const previousRelease = releases.get(options.sessionId);
  let frame: HTMLIFrameElement | null = null,
    client: KlecksFrameClient | null = null;
  let lease: DesignEditorWorkspaceLease | null = null,
    detach: (() => void) | undefined;
  let closed = false,
    closing: Promise<void> | null = null,
    releasing: Promise<void> | null = null;
  const abort = new AbortController();
  const destroyFrame = () => {
    const errors: unknown[] = [];
    try {
      detach?.();
    } catch (error) {
      errors.push(error);
    }
    detach = undefined;
    try {
      client?.close();
    } catch (error) {
      errors.push(error);
    }
    client = null;
    try {
      frame?.remove();
    } catch (error) {
      errors.push(error);
    }
    frame = null;
    return errors;
  };
  const releaseLease = (): Promise<void> => {
    if (releasing) return releasing;
    const current = lease;
    if (!current) return Promise.resolve();
    releasing = (async () => {
      const release = options.api.releaseDesignEditorWorkspace;
      if (!release) throw new Error("无法归还图片编辑器资源占位。");
      const result = await release.call(options.api, {
        sessionId: options.sessionId,
        leaseId: current.leaseId,
      });
      if (!result.ok) throw new Error(result.error.message);
      if (lease === current) lease = null;
    })().finally(() => {
      releasing = null;
    });
    return releasing;
  };
  const ready = (async () => {
    if (previousRelease) await previousRelease;
    if (closed) throw new Error("图片编辑器启动已取消。");
    const acquire = options.api.acquireDesignEditorWorkspace;
    if (!acquire || !options.api.releaseDesignEditorWorkspace)
      throw new Error("当前环境尚不支持图片编辑器资源管理。");
    const timeoutMs = options.timeoutMs ?? 10000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000)
      throw new Error("图片编辑器加载超时设置无效。");
    const frameId = crypto.randomUUID(),
      nonce = createKlecksFrameNonce();
    const result = await acquire.call(options.api, {
      sessionId: options.sessionId,
      frameId,
      ...(options.scope ? { scope: options.scope } : {}),
    });
    if (!result.ok) throw new Error(result.error.message);
    lease = DesignEditorWorkspaceLeaseSchema.parse(result.value);
    if (lease.sessionId !== options.sessionId || lease.frameId !== frameId)
      throw new Error("图片编辑器资源凭证不匹配。");
    grantedKlecksResourcePolicy(lease.limitBytes);
    if (closed) throw new Error("图片编辑器启动已取消。");
    const element = document.createElement("iframe");
    frame = element;
    element.title = "图片编辑画布";
    element.setAttribute("sandbox", "allow-scripts allow-same-origin");
    element.referrerPolicy = "no-referrer";
    element.style.cssText = "display:block;width:100%;height:100%;border:0";
    const url = new URL("patent-app://editor/index.html");
    url.search = new URLSearchParams({
      session: options.sessionId,
      platform: options.platform,
      budget: String(lease.limitBytes),
    }).toString();
    url.hash = nonce;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        element.removeEventListener("load", loaded);
        element.removeEventListener("error", failed);
        abort.signal.removeEventListener("abort", cancelled);
        if (error) reject(error);
        else resolve();
      };
      const loaded = () => finish(),
        failed = () => finish(new Error("图片编辑器加载失败。")),
        cancelled = () => finish(new Error("图片编辑器启动已取消。"));
      const timer = setTimeout(() => finish(new Error("图片编辑器加载超时。")), timeoutMs);
      element.addEventListener("load", loaded);
      element.addEventListener("error", failed);
      abort.signal.addEventListener("abort", cancelled, { once: true });
      element.src = url.href;
      options.container.append(element);
    });
    if (closed || !element.contentWindow) throw new Error("图片编辑器启动已取消。");
    client = await connectKlecksFrame(element.contentWindow, "patent-app://editor", nonce, {
      signal: abort.signal,
      timeoutMs,
    });
    if (closed) throw new Error("图片编辑器启动已取消。");
    detach = options.connected?.(client);
    return client;
  })().catch(async (error) => {
    closed = true;
    abort.abort();
    const failures = destroyFrame();
    try {
      await releaseLease();
    } catch (releaseError) {
      failures.push(releaseError);
    }
    if (failures.length)
      throw new AggregateError([error, ...failures], "图片编辑器启动失败，资源回收需要重试。");
    throw error;
  });
  // A caller may cancel startup before it begins awaiting ready.
  void ready.catch(() => {});
  return {
    ready,
    dispose(): Promise<void> {
      if (closing) return closing;
      closed = true;
      abort.abort();
      const failures = destroyFrame();
      closing = (async () => {
        await ready.catch(() => {});
        await releaseLease();
        if (failures.length) throw new AggregateError(failures, "图片编辑器关闭异常。");
      })().finally(() => {
        if (releases.get(options.sessionId) === closing) releases.delete(options.sessionId);
        closing = null;
      });
      releases.set(options.sessionId, closing);
      return closing;
    },
  };
}
