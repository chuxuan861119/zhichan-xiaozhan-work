import { Component, type ErrorInfo, type ReactNode } from "react";
import type { RendererFailureReport } from "../../../shared/ipc/contract";
import { rendererFailureLocations } from "./renderer-failure-locations";
import { rendererSaveRecovery } from "./renderer-save-recovery";

type AppErrorBoundaryProps = { children: ReactNode };
type AppErrorBoundaryState = {
  failed: boolean;
  busy: boolean;
  notice: string;
  failureKind?: RendererFailureReport["failureKind"];
};

function classifyFailure(error: unknown): NonNullable<RendererFailureReport["failureKind"]> {
  if (error instanceof TypeError) return "type-error";
  if (error instanceof ReferenceError) return "reference-error";
  if (
    error instanceof Error &&
    /Maximum update depth exceeded|Too many re-renders/u.test(error.message)
  )
    return "render-loop";
  return "other";
}

function reportRendererFailure(source: RendererFailureReport["source"], error: unknown) {
  const report = window.patentApi?.application?.reportRendererFailure;
  const locations = rendererFailureLocations(error);
  if (report)
    void report({
      source,
      failureKind: classifyFailure(error),
      ...(locations.length ? { locations } : {}),
    }).catch(() => {
      // Diagnostics are optional; recovery must remain available if IPC is unavailable.
    });
}

export function installGlobalRendererFailureReporting(): () => void {
  const onError = (event: ErrorEvent) => reportRendererFailure("window-error", event.error);
  const onUnhandledRejection = (event: PromiseRejectionEvent) =>
    reportRendererFailure("unhandled-rejection", event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { failed: false, busy: false, notice: "" };
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoverySubscriptions: Array<() => void> = [];

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { failed: true, busy: false, notice: "", failureKind: classifyFailure(error) };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    reportRendererFailure("react-boundary", error);
    // The normal close provider was part of the failed tree. The recovery page
    // must take over its handshake, including title-bar/tray/system shutdown.
    const api = window.patentApi?.application;
    const close = api?.onPrepareClose?.((token) => {
      void this.saveRetainedChanges()
        .then((proceed) => api.closeResult({ token, proceed }))
        .catch(() => this.setState({ notice: "无法确认保存状态，请勿强制退出。" }));
    });
    const backgroundReply = api?.backgroundSaveResult;
    const background =
      backgroundReply &&
      api?.onBackgroundSave?.((token) => {
        void this.saveRetainedChanges()
          .then((ok) => backgroundReply({ token, ok }))
          .catch(() => this.setState({ notice: "无法确认保存状态，请勿强制退出。" }));
      });
    if (close) this.recoverySubscriptions.push(close);
    if (background) this.recoverySubscriptions.push(background);
  }

  override componentWillUnmount(): void {
    clearTimeout(this.recoveryTimer);
    for (const unsubscribe of this.recoverySubscriptions) unsubscribe();
  }

  private saveRetainedChanges = async (): Promise<boolean> => {
    this.setState({ notice: "正在保存最近修改，请稍候…" });
    const saved = await rendererSaveRecovery.flush();
    this.setState({
      notice: saved
        ? "最近修改已保存。"
        : "保存未完成，最近修改仍保留在当前进程中。请勿强制退出，可稍后重试。",
    });
    return saved;
  };

  private recover = async (action: "reload" | "exit") => {
    if (this.state.busy) return;
    this.setState({
      busy: true,
      notice: action === "reload" ? "正在重新加载界面…" : "正在退出软件…",
    });
    clearTimeout(this.recoveryTimer);
    try {
      const application = window.patentApi?.application;
      const request = action === "reload" ? application?.reloadRenderer : application?.forceClose;
      if (!request) {
        clearTimeout(this.recoveryTimer);
        this.setState({
          busy: false,
          notice: "当前实例尚不支持此恢复操作，请关闭窗口后重新启动软件。",
        });
        return;
      }
      if (!(await this.saveRetainedChanges())) {
        this.setState({ busy: false });
        return;
      }
      this.setState({ notice: action === "reload" ? "正在重新加载界面…" : "正在退出软件…" });
      // A slow save is not a timeout authorization to discard it. This timer
      // applies only after saves are confirmed and the native action is sent.
      this.recoveryTimer = setTimeout(() => {
        this.setState({
          busy: false,
          notice: "操作未完成，请重试；如果仍无响应，请关闭窗口后重新启动软件。",
        });
      }, 8000);
      const result = await request();
      if (!result.ok) {
        clearTimeout(this.recoveryTimer);
        this.setState({
          busy: false,
          notice:
            action === "reload"
              ? "重新加载失败，请重试或关闭窗口后重新启动软件。"
              : "退出未完成，请尝试关闭窗口。",
        });
      }
    } catch {
      clearTimeout(this.recoveryTimer);
      this.setState({ busy: false, notice: "无法连接恢复服务，请关闭窗口后重新启动软件。" });
    }
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-crash-fallback" role="alert">
        <section>
          <h1>编辑界面发生错误</h1>
          <p>
            已保存的文档不受影响。请重新加载界面；恢复后请检查最近的修改是否完整。正在进行的 AI
            纠错将停止，恢复后请重新检查。
          </p>
          <details className="spatial-disclosure">
            <summary>查看详情</summary>
            <p>错误类型：{this.state.failureKind ?? "other"}</p>
          </details>
          {this.state.notice ? (
            <p role="status" aria-live="polite">
              {this.state.notice}
            </p>
          ) : null}
          <div>
            <button
              type="button"
              disabled={this.state.busy}
              onClick={() => void this.recover("reload")}
            >
              {this.state.busy ? "正在处理…" : "重新加载界面"}
            </button>
            <button
              type="button"
              disabled={this.state.busy}
              onClick={() => void this.recover("exit")}
            >
              退出软件
            </button>
          </div>
        </section>
      </main>
    );
  }
}
