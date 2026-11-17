import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MotionPresence } from "../app/motion-presence";
import { prefersReducedMotion as isMotionReduced } from "./motion-preference";
import { OperationFeedbackOverlay } from "./operation-feedback";
import { SPATIAL_MOTION_RETENTION_MS } from "./spatial-motion";
import { StandardDialog } from "./standard-dialog";
import "./app-dialog.css";

type DialogRequest = {
  kind: "alert" | "confirm" | "prompt";
  message: string;
  initialValue?: string;
  resolve(value: string | boolean | null): void;
};

let active = false;
const alerts: DialogRequest[] = [];

function AppDialog({
  request,
  finish,
}: {
  request: DialogRequest;
  finish(value: string | boolean | null): void;
}) {
  const [value, setValue] = useState(request.initialValue ?? "");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isPrompt = request.kind === "prompt";
  const isAlert = request.kind === "alert";
  const cancel = () => finish(isPrompt ? null : false);
  const accept = () => finish(isPrompt ? value : true);
  if (isAlert)
    return (
      <OperationFeedbackOverlay
        dialogRole="dialog"
        feedback={{ tone: "error", title: "提示", message: request.message }}
        onClose={accept}
      />
    );
  return (
    <StandardDialog
      open
      title={isAlert ? "提示" : isPrompt ? "修改名称" : "请确认"}
      size="s"
      onCancel={cancel}
      initialFocusRef={isPrompt ? inputRef : cancelRef}
      footer={
        <>
          {!isAlert && (
            <button ref={cancelRef} type="button" onClick={cancel}>
              取消
            </button>
          )}
          <button
            ref={isAlert ? cancelRef : undefined}
            className="primary-button"
            type="button"
            onClick={accept}
          >
            {isAlert ? "知道了" : "确定"}
          </button>
        </>
      }
    >
      {isPrompt ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            accept();
          }}
        >
          <label className="app-dialog__prompt">
            {request.message}
            <input
              ref={inputRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        </form>
      ) : (
        <p className="app-dialog__message">{request.message}</p>
      )}
    </StandardDialog>
  );
}

function openDialog(request: DialogRequest): void {
  active = true;
  const host = document.createElement("div");
  host.className = "app-dialog-host";
  const background = [...document.body.children].filter(
    (element): element is HTMLElement => element instanceof HTMLElement && !element.inert,
  );
  document.body.append(host);
  const root = createRoot(host);
  let finished = false;
  const finish = (value: string | boolean | null) => {
    if (finished) return;
    finished = true;
    // Leave React's event handler before unmounting. Restore the background before
    // useModalDialog restores focus. The inert exit paint never delays the action result.
    queueMicrotask(() => {
      for (const element of background) element.inert = false;
      flushSync(() => root.render(<MotionPresence>{null}</MotionPresence>));
      const reduced =
        document.documentElement.dataset.reducedMotion === "true" || isMotionReduced();
      const removePaint = () => {
        root.unmount();
        host.remove();
      };
      if (reduced) removePaint();
      else window.setTimeout(removePaint, SPATIAL_MOTION_RETENTION_MS);
      active = false;
      request.resolve(value);
      queueMicrotask(() => {
        if (active) return;
        const next = alerts.shift();
        if (next) openDialog(next);
      });
    });
  };
  // Install the overlay synchronously so another click cannot start the same action.
  flushSync(() =>
    root.render(
      <MotionPresence>
        <AppDialog request={request} finish={finish} />
      </MotionPresence>,
    ),
  );
  for (const element of background) element.inert = true;
}

export function showAppAlert(message: string): void {
  const request: DialogRequest = { kind: "alert", message, resolve: () => {} };
  alerts.push(request);
  // Alerts can originate in React effects. Mount outside the current render/effect.
  queueMicrotask(() => {
    if (active) return;
    const next = alerts.shift();
    if (next) openDialog(next);
  });
}

export function confirmAppAction(message: string): Promise<boolean> {
  // Concurrent requests must not share an affirmative result and execute twice.
  if (active) return Promise.resolve(false);
  return new Promise((resolve) =>
    openDialog({
      kind: "confirm",
      message,
      resolve: (value) => resolve(value === true),
    }),
  );
}

export function promptAppText(message: string, initialValue = ""): Promise<string | null> {
  if (active) return Promise.resolve(null);
  return new Promise((resolve) =>
    openDialog({
      kind: "prompt",
      message,
      initialValue,
      resolve: (value) => resolve(typeof value === "string" ? value : null),
    }),
  );
}
