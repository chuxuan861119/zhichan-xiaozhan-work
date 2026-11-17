import type { AppError } from "../../../shared/ipc/result";
import { normalizeAppError } from "../../../shared/ipc/result";
import { OperationFeedbackOverlay } from "./operation-feedback";

const APPLICATION_ERROR_EVENT = "patent-workbench:application-error";

export function showApplicationError(error: AppError): void {
  if (error.code === "CANCELLED") return;
  window.dispatchEvent(
    new CustomEvent<AppError>(APPLICATION_ERROR_EVENT, { detail: normalizeAppError(error) }),
  );
}

export function onApplicationError(listener: (error: AppError) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<AppError>).detail);
  window.addEventListener(APPLICATION_ERROR_EVENT, handler);
  return () => window.removeEventListener(APPLICATION_ERROR_EVENT, handler);
}

type ErrorDialogProps = {
  error: AppError;
  onClose(): void;
};

export function ErrorDialog({ error, onClose }: ErrorDialogProps) {
  const safeError = normalizeAppError(error);
  return (
    <OperationFeedbackOverlay feedback={{ tone: "error", title: "操作未完成" }} onClose={onClose}>
      <p>{safeError.message}</p>
      <p>{safeError.nextAction}</p>
    </OperationFeedbackOverlay>
  );
}
