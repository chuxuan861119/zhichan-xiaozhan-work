import { Copy, Database, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IPC_DATA_ORIGIN, IpcFrameMessageSchema } from "../../../shared/ipc-data-center";
import { DialogCloseIcon } from "../shared/dialog-close-icon";
import { DialogResizeHandles } from "../shared/dialog-resize-handles";
import { SpatialPresence } from "../shared/spatial-presence";
import { useRetainedTransientVisibility } from "../shared/transient-function-rail-slot";
import { useDialogDrag } from "../shared/use-dialog-drag";
import { useSurfaceResizeMotion } from "../shared/use-surface-resize-motion";
import "./ipc-data-center.css";

export function IpcDataCenter() {
  const [opened, setOpened] = useState(false);
  const [mounted, setMounted] = useState(false);
  return (
    <>
      <button
        type="button"
        className="ipc-data-center-trigger"
        title="IPC数据中心"
        aria-expanded={opened}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setMounted(true);
          setOpened(true);
        }}
      >
        <Database size={15} aria-hidden="true" />
        IPC数据中心
      </button>
      {mounted &&
        createPortal(
          <IpcDataWindow open={opened} onClose={() => setOpened(false)} />,
          document.body,
        )}
    </>
  );
}

function IpcDataWindow({ open, onClose }: { open: boolean; onClose(): void }) {
  const visible = useRetainedTransientVisibility(open);
  const [maximized, setMaximized] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const drag = useDialogDrag<HTMLDivElement>({
    positionKey: "ipc-data-center",
    memory: "session",
    stackable: open,
    movable: open && !maximized,
  });
  useSurfaceResizeMotion(drag.surfaceRef, maximized);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  const saving = useRef(false);
  const triggerFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open)
      triggerFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rememberFocus = (event: FocusEvent) => {
      if (
        open &&
        event.target instanceof HTMLElement &&
        event.target !== frameRef.current &&
        !drag.surfaceRef.current?.contains(event.target)
      )
        triggerFocus.current = event.target;
    };
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, [open, drag.surfaceRef]);
  const close = () => {
    if (
      document.activeElement === frameRef.current ||
      drag.surfaceRef.current?.contains(document.activeElement)
    ) {
      triggerFocus.current?.isConnected && triggerFocus.current.focus({ preventScroll: true });
    }
    onClose();
  };
  const handleEscape = () => {
    if (maximized) setMaximized(false);
    else close();
  };
  useEffect(() => {
    if (!open || !maximized) return;
    const restoreFromWorkbench = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        event.defaultPrevented ||
        !drag.isTopmost()
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      event.preventDefault();
      setMaximized(false);
    };
    window.addEventListener("keydown", restoreFromWorkbench);
    return () => window.removeEventListener("keydown", restoreFromWorkbench);
  }, [open, maximized, drag.isTopmost]);
  useEffect(() => {
    if (loadState !== "loading") return;
    const timer = window.setTimeout(() => setLoadState("failed"), 30_000);
    return () => clearTimeout(timer);
  }, [loadState]);
  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== IPC_DATA_ORIGIN)
        return;
      const parsed = IpcFrameMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.action === "ready") {
        setLoadState("ready");
        return;
      }
      if (message.action === "failed") {
        setLoadState("failed");
        return;
      }
      if (!open) return;
      if (message.action === "interact") {
        drag.bringToFront();
        return;
      }
      if (message.action === "close") {
        handleEscape();
        return;
      }
      if (message.action !== "copy" && message.action !== "save-report") return;
      const sender = frameRef.current?.contentWindow;
      const reply = (result: { ok: boolean; canceled?: boolean; error?: string }) =>
        sender?.postMessage(
          { source: "ipc-data-host", id: message.id, ...result },
          IPC_DATA_ORIGIN,
        );
      try {
        if (message.action === "copy") {
          const result = await window.patentApi.clipboard.writeText(message.text);
          reply(result.ok ? { ok: true } : { ok: false, error: result.error.message });
        } else {
          if (saving.current) {
            reply({ ok: false, error: "请先完成当前图片保存。" });
            return;
          }
          saving.current = true;
          try {
            const api = window.patentApi.ipcDataCenter;
            if (!api) throw new Error("报告保存接口不可用，请重新启动应用。");
            const result = await api.saveReport(message.report);
            reply(
              result.ok
                ? { ok: true, canceled: result.value === null }
                : { ok: false, error: result.error.message },
            );
          } finally {
            saving.current = false;
          }
        }
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : "操作失败，请重试。" });
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  });
  return (
    <div
      hidden={!visible}
      data-motion={open ? "enter" : "exit"}
      inert={open ? undefined : true}
      aria-hidden={open ? undefined : true}
      className="ipc-data-center-layer dialog-layer--modeless"
      style={drag.layerStyle}
    >
      <div
        ref={drag.surfaceRef}
        role="dialog"
        aria-label="IPC数据中心"
        className="ipc-data-center-window dialog-surface--floating"
        data-resizing={resizing}
        data-dragging={drag.dragging}
        data-maximized={maximized}
        style={
          maximized
            ? {
                ...drag.style,
                position: "fixed",
                left: 0,
                top: "38px",
                right: 0,
                bottom: 0,
                width: "100%",
                height: "calc(100% - 38px)",
                maxWidth: "none",
                maxHeight: "none",
                minWidth: 0,
                minHeight: 0,
              }
            : { ...drag.style, ...size }
        }
        onPointerDownCapture={drag.bringToFront}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.stopPropagation();
            handleEscape();
          }
        }}
      >
        <header
          ref={drag.titleBarRef}
          className="ipc-data-center-header dialog-titlebar--draggable"
        >
          <strong>IPC数据中心</strong>
          <div className="ipc-data-center-window-actions">
            <button
              type="button"
              className="ipc-data-center-window-button ipc-data-center-window-button--labeled"
              disabled={loadState !== "ready"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                frameRef.current?.contentWindow?.postMessage(
                  { source: "ipc-data-host", action: "show-help" },
                  IPC_DATA_ORIGIN,
                );
                frameRef.current?.focus();
              }}
            >
              使用说明
            </button>
            <button
              type="button"
              aria-label={maximized ? "还原IPC数据中心" : "最大化IPC数据中心"}
              title={maximized ? "还原" : "最大化"}
              className="ipc-data-center-window-button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setMaximized((value) => !value)}
            >
              {maximized ? (
                <Copy size={15} strokeWidth={1.8} />
              ) : (
                <Square size={15} strokeWidth={1.8} />
              )}
            </button>
            <button
              type="button"
              aria-label="返回编辑器"
              title="返回编辑器，保留查询结果"
              className="ipc-data-center-window-button ipc-data-center-window-button--close"
              onMouseDown={(event) => event.preventDefault()}
              onClick={close}
            >
              <DialogCloseIcon />
            </button>
          </div>
        </header>
        <div className="ipc-data-center-content">
          <SpatialPresence>
            {loadState !== "ready" && (
              <div className="ipc-data-center-loading" role="status">
                {loadState === "loading" ? (
                  "正在加载分类数据库…"
                ) : (
                  <>
                    分类数据库加载失败。
                    <button
                      type="button"
                      onClick={() => {
                        setLoadState("loading");
                        setAttempt((value) => value + 1);
                      }}
                    >
                      重新加载
                    </button>
                  </>
                )}
              </div>
            )}
          </SpatialPresence>
          <iframe
            key={attempt}
            ref={frameRef}
            title="IPC数据中心查询页面"
            src={`${IPC_DATA_ORIGIN}/index.html`}
            sandbox="allow-scripts allow-same-origin"
            onLoad={() =>
              frameRef.current?.contentWindow?.postMessage(
                { source: "ipc-data-host", action: "init" },
                IPC_DATA_ORIGIN,
              )
            }
            onError={() => setLoadState("failed")}
          />
        </div>
        {!maximized && (
          <DialogResizeHandles
            drag={drag}
            setSize={setSize}
            setResizing={setResizing}
            label="IPC窗口"
          />
        )}{" "}
      </div>
    </div>
  );
}
