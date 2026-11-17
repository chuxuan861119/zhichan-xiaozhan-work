import { type ReactNode, useEffect, useId, useRef } from "react";
import { useMotionPresenceClosing } from "../app/motion-presence";
import { DialogCloseIcon } from "./dialog-close-icon";
import { useModalDialog } from "./use-modal-dialog";

export type OperationFeedback = Readonly<{
  tone: "success" | "error";
  title: string;
  message?: string;
}>;

type OperationFeedbackOverlayProps = {
  feedback: OperationFeedback;
  onClose(): void;
  dialogRole?: "dialog" | "alertdialog";
  children?: ReactNode;
};

export function OperationFeedbackOverlay({
  feedback,
  onClose,
  dialogRole = "alertdialog",
  children,
}: OperationFeedbackOverlayProps) {
  const closing = useMotionPresenceClosing();
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const acknowledgeRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useModalDialog({
    open: feedback.tone === "error" && !closing,
    onClose,
    containerRef: dialogRef,
    initialFocusRef: acknowledgeRef,
  });

  useEffect(() => {
    if (feedback.tone !== "success" || closing) return;
    const timer = window.setTimeout(() => closeRef.current(), 1500);
    return () => window.clearTimeout(timer);
  }, [feedback, closing]);

  if (feedback.tone === "success") {
    return (
      <section
        className="operation-feedback is-success"
        data-motion={closing ? "exit" : "enter"}
        role="status"
        aria-live="polite"
      >
        <span className="operation-feedback__icon" aria-hidden="true">
          ✓
        </span>
        <div className="operation-feedback__success-text">
          <strong>{feedback.title}</strong>
        </div>
      </section>
    );
  }

  return (
    <div className="operation-feedback-backdrop" data-motion={closing ? "exit" : "enter"}>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: dialogRole is restricted to dialog or alertdialog, both of which support aria-modal. */}
      <section
        ref={dialogRef}
        className="operation-feedback is-error dialog-with-standard-close"
        role={dialogRole}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={feedback.message || children ? messageId : undefined}
      >
        <button
          type="button"
          className="dialog-close-button dialog-close-button--corner dialog-close-control"
          aria-label="关闭错误提示"
          onClick={onClose}
        >
          <DialogCloseIcon />
        </button>
        <span className="operation-feedback__icon" aria-hidden="true">
          !
        </span>
        <div className="operation-feedback__content">
          <h2 id={titleId}>{feedback.title}</h2>
          {children ? (
            <div id={messageId}>{children}</div>
          ) : feedback.message ? (
            <p id={messageId}>{feedback.message}</p>
          ) : null}
          <button
            ref={acknowledgeRef}
            type="button"
            className="operation-feedback__acknowledge"
            onClick={onClose}
          >
            知道了
          </button>
        </div>
      </section>
    </div>
  );
}
