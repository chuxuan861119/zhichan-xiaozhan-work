import type {
  DataTransferLibraryInspection,
  DataTransferProgress,
  FullDataExportResult,
  FullDataImportPreview,
  TransferDestinationSelection,
  TransferSourceSelection,
} from "../../../shared/data-transfer/model";
import type { AppError } from "../../../shared/ipc/result";

type LandingState = Readonly<{
  step: "landing";
  cancellable: false;
}>;

type ExportSummaryState = Readonly<{
  step: "export-summary";
  inspection: DataTransferLibraryInspection;
  cancellable: false;
}>;

type ExportDestinationState = Readonly<{
  step: "export-destination";
  inspection: DataTransferLibraryInspection;
  destination: TransferDestinationSelection | null;
  operationId: string | null;
  cancellable: false;
}>;

type ExportPasswordState = Readonly<{
  step: "export-password";
  inspection: DataTransferLibraryInspection;
  destination: TransferDestinationSelection;
  operationId: string;
  password: string;
  confirmPassword: string;
  passwordHint: string;
  passwordRecorded: boolean;
  cancellable: false;
}>;

type ExportRunningState = Readonly<{
  step: "export-running";
  inspection: DataTransferLibraryInspection;
  destination: TransferDestinationSelection;
  operationId: string;
  password: "";
  confirmPassword: "";
  progress: DataTransferProgress | null;
  cancelRequested: boolean;
  cancellable: boolean;
}>;

type ExportResultState = Readonly<{
  step: "export-result";
  result: FullDataExportResult;
  cancellable: false;
}>;

type ImportEmptyCheckState = Readonly<{
  step: "import-empty-check";
  inspection: DataTransferLibraryInspection | null;
  cancellable: false;
}>;

type ImportSourceState = Readonly<{
  step: "import-source";
  inspection: DataTransferLibraryInspection;
  source: TransferSourceSelection | null;
  operationId: string | null;
  cancellable: false;
}>;

type ImportPasswordState = Readonly<{
  step: "import-password";
  inspection: DataTransferLibraryInspection;
  source: TransferSourceSelection;
  operationId: string;
  password: string;
  confirmPassword: string;
  cancellable: false;
}>;

type ImportRunningState = Readonly<{
  step: "import-running";
  inspection: DataTransferLibraryInspection;
  source: TransferSourceSelection;
  operationId: string;
  password: "";
  confirmPassword: "";
  progress: DataTransferProgress | null;
  cancelRequested: boolean;
  cancellable: boolean;
}>;

type ImportPreviewState = Readonly<{
  step: "import-preview";
  inspection: DataTransferLibraryInspection;
  source: TransferSourceSelection;
  operationId: string;
  preview: FullDataImportPreview;
  cancelRequested: boolean;
  cancellable: boolean;
}>;

type ImportCommittingState = Readonly<{
  step: "import-committing";
  operationId: string;
  preview: FullDataImportPreview;
  progress: DataTransferProgress | null;
  restartPending: boolean;
  cancellable: false;
}>;

type ImportCommitFailureState = Readonly<{
  step: "import-commit-failure";
  operationId: string;
  error: AppError;
  cancellable: false;
}>;

type FailureState = Readonly<{
  step: "failure";
  flow: "export" | "import";
  error: AppError;
  cancellable: false;
}>;

export type TransferState =
  | LandingState
  | ExportSummaryState
  | ExportDestinationState
  | ExportPasswordState
  | ExportRunningState
  | ExportResultState
  | ImportEmptyCheckState
  | ImportSourceState
  | ImportPasswordState
  | ImportRunningState
  | ImportPreviewState
  | ImportCommittingState
  | ImportCommitFailureState
  | FailureState;

export type TransferAction =
  | { type: "export-opened"; inspection: DataTransferLibraryInspection }
  | { type: "export-destination-requested" }
  | {
      type: "export-destination-selected";
      operationId: string;
      destination: TransferDestinationSelection;
    }
  | { type: "export-destination-confirmed" }
  | { type: "import-opened" }
  | { type: "empty-check-completed"; inspection: DataTransferLibraryInspection }
  | { type: "import-empty-check-confirmed" }
  | { type: "import-source-selected"; operationId: string; source: TransferSourceSelection }
  | { type: "import-source-confirmed" }
  | { type: "import-preview-discarded"; operationId: string; nextOperationId: string }
  | { type: "password-updated"; password: string }
  | { type: "password-confirmation-updated"; confirmPassword: string }
  | { type: "password-hint-updated"; passwordHint: string }
  | { type: "password-recorded-updated"; passwordRecorded: boolean }
  | { type: "password-submitted" }
  | { type: "progress-received"; progress: DataTransferProgress }
  | { type: "export-completed"; result: FullDataExportResult }
  | { type: "import-prepared"; preview: FullDataImportPreview }
  | { type: "commit-started" }
  | { type: "restart-pending"; operationId: string }
  | { type: "cancel-requested" }
  | { type: "cancel-completed"; operationId: string }
  | { type: "failed"; error: AppError; operationId?: string }
  | { type: "back" }
  | { type: "reset" };

const EXPORT_PROGRESS_PHASES: readonly DataTransferProgress["phase"][] = [
  "inspecting",
  "quiescing-writes",
  "checkpointing",
  "collecting-data",
  "compressing",
  "encrypting",
  "verifying-package",
  "completed",
  "cancelled",
  "failed",
];

const IMPORT_PROGRESS_PHASES: readonly DataTransferProgress["phase"][] = [
  "reading-header",
  "decrypting",
  "extracting-to-staging",
  "validating-files",
  "validating-database",
  "validating-domain-data",
  "preparing-local-data",
  "preview-ready",
  "completed",
  "cancelled",
  "failed",
];

const COMMIT_PROGRESS_PHASES: readonly DataTransferProgress["phase"][] = [
  "preparing-swap",
  "swapping",
  "restart-pending",
  "failed",
];

const TERMINAL_PROGRESS_PHASES: ReadonlySet<DataTransferProgress["phase"]> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

export function createInitialTransferState(): TransferState {
  return { step: "landing", cancellable: false };
}

function phaseAdvances(
  phases: readonly DataTransferProgress["phase"][],
  current: DataTransferProgress | null,
  next: DataTransferProgress,
): boolean {
  const nextIndex = phases.indexOf(next.phase);
  if (nextIndex < 0) return false;
  if (!current) return true;
  if (TERMINAL_PROGRESS_PHASES.has(current.phase) && next.phase !== current.phase) return false;
  const currentIndex = phases.indexOf(current.phase);
  return (
    currentIndex >= 0 &&
    nextIndex >= currentIndex &&
    (nextIndex > currentIndex || next.completedBytes >= current.completedBytes)
  );
}

function activeOperationId(state: TransferState): string | null {
  switch (state.step) {
    case "export-password":
    case "export-running":
    case "import-password":
    case "import-running":
    case "import-preview":
    case "import-committing":
    case "import-commit-failure":
      return state.operationId;
    case "export-result":
      return state.result.operationId;
    default:
      return null;
  }
}

function flowOf(state: TransferState): "export" | "import" | null {
  if (state.step.startsWith("export-")) return "export";
  if (state.step.startsWith("import-")) return "import";
  return state.step === "failure" ? state.flow : null;
}

function reduceProgress(state: TransferState, next: DataTransferProgress): TransferState {
  if (activeOperationId(state) !== next.operationId) return state;
  if (state.step === "export-running") {
    if (
      next.kind !== "full-data-export" ||
      !phaseAdvances(EXPORT_PROGRESS_PHASES, state.progress, next)
    ) {
      return state;
    }
    return {
      ...state,
      progress: next,
      cancellable:
        !state.cancelRequested && next.cancellable && !TERMINAL_PROGRESS_PHASES.has(next.phase),
    };
  }
  if (state.step === "import-running") {
    if (
      next.kind !== "full-data-import" ||
      !phaseAdvances(IMPORT_PROGRESS_PHASES, state.progress, next)
    ) {
      return state;
    }
    return {
      ...state,
      progress: next,
      cancellable:
        !state.cancelRequested && next.cancellable && !TERMINAL_PROGRESS_PHASES.has(next.phase),
    };
  }
  if (state.step === "import-committing") {
    if (
      next.kind !== "library-swap" ||
      !phaseAdvances(COMMIT_PROGRESS_PHASES, state.progress, next)
    ) {
      return state;
    }
    return {
      ...state,
      progress: next,
      restartPending: state.restartPending || next.phase === "restart-pending",
    };
  }
  return state;
}

function reduceBack(state: TransferState): TransferState {
  switch (state.step) {
    case "export-summary":
    case "import-empty-check":
    case "export-result":
    case "failure":
      return createInitialTransferState();
    case "export-destination":
      return { step: "export-summary", inspection: state.inspection, cancellable: false };
    case "export-password":
      return {
        step: "export-destination",
        inspection: state.inspection,
        destination: state.destination,
        operationId: state.operationId,
        cancellable: false,
      };
    case "import-source":
      return {
        step: "import-empty-check",
        inspection: state.inspection,
        cancellable: false,
      };
    case "import-password":
      return {
        step: "import-source",
        inspection: state.inspection,
        source: state.source,
        operationId: state.operationId,
        cancellable: false,
      };
    default:
      return state;
  }
}

export function reduceTransferState(state: TransferState, action: TransferAction): TransferState {
  switch (action.type) {
    case "export-opened":
      return state.step === "landing"
        ? { step: "export-summary", inspection: action.inspection, cancellable: false }
        : state;
    case "export-destination-requested":
      return state.step === "export-summary"
        ? {
            step: "export-destination",
            inspection: state.inspection,
            destination: null,
            operationId: null,
            cancellable: false,
          }
        : state;
    case "export-destination-selected":
      return state.step === "export-destination"
        ? {
            ...state,
            destination: action.destination,
            operationId: action.operationId,
          }
        : state;
    case "export-destination-confirmed":
      return state.step === "export-destination" && state.destination && state.operationId
        ? {
            step: "export-password",
            inspection: state.inspection,
            destination: state.destination,
            operationId: state.operationId,
            password: "",
            confirmPassword: "",
            passwordHint: "",
            passwordRecorded: false,
            cancellable: false,
          }
        : state;
    case "import-opened":
      return state.step === "landing"
        ? { step: "import-empty-check", inspection: null, cancellable: false }
        : state;
    case "empty-check-completed":
      if (state.step !== "import-empty-check") return state;
      return { ...state, inspection: action.inspection };
    case "import-empty-check-confirmed":
      return state.step === "import-empty-check" && state.inspection?.empty
        ? {
            step: "import-source",
            inspection: state.inspection,
            source: null,
            operationId: null,
            cancellable: false,
          }
        : state;
    case "import-source-selected":
      return state.step === "import-source"
        ? { ...state, source: action.source, operationId: action.operationId }
        : state;
    case "import-source-confirmed":
      return state.step === "import-source" && state.source && state.operationId
        ? {
            step: "import-password",
            inspection: state.inspection,
            source: state.source,
            operationId: state.operationId,
            password: "",
            confirmPassword: "",
            cancellable: false,
          }
        : state;
    case "import-preview-discarded":
      return state.step === "import-preview" && state.operationId === action.operationId
        ? {
            step: "import-password",
            inspection: state.inspection,
            source: state.source,
            operationId: action.nextOperationId,
            password: "",
            confirmPassword: "",
            cancellable: false,
          }
        : state;
    case "password-updated":
      return state.step === "export-password" || state.step === "import-password"
        ? { ...state, password: action.password }
        : state;
    case "password-confirmation-updated":
      return state.step === "export-password" || state.step === "import-password"
        ? { ...state, confirmPassword: action.confirmPassword }
        : state;
    case "password-hint-updated":
      return state.step === "export-password"
        ? { ...state, passwordHint: action.passwordHint }
        : state;
    case "password-recorded-updated":
      return state.step === "export-password"
        ? { ...state, passwordRecorded: action.passwordRecorded }
        : state;
    case "password-submitted":
      if (state.step === "export-password") {
        return {
          step: "export-running",
          inspection: state.inspection,
          destination: state.destination,
          operationId: state.operationId,
          password: "",
          confirmPassword: "",
          progress: null,
          cancelRequested: false,
          cancellable: true,
        };
      }
      if (state.step === "import-password") {
        return {
          step: "import-running",
          inspection: state.inspection,
          source: state.source,
          operationId: state.operationId,
          password: "",
          confirmPassword: "",
          progress: null,
          cancelRequested: false,
          cancellable: true,
        };
      }
      return state;
    case "progress-received":
      return reduceProgress(state, action.progress);
    case "export-completed":
      return state.step === "export-running" && state.operationId === action.result.operationId
        ? { step: "export-result", result: action.result, cancellable: false }
        : state;
    case "import-prepared":
      return state.step === "import-running" && state.operationId === action.preview.operationId
        ? {
            step: "import-preview",
            inspection: state.inspection,
            source: state.source,
            operationId: state.operationId,
            preview: action.preview,
            cancelRequested: false,
            cancellable: true,
          }
        : state;
    case "commit-started":
      return state.step === "import-preview" && !state.cancelRequested
        ? {
            step: "import-committing",
            operationId: state.operationId,
            preview: state.preview,
            progress: null,
            restartPending: false,
            cancellable: false,
          }
        : state;
    case "restart-pending":
      return state.step === "import-committing" && state.operationId === action.operationId
        ? { ...state, restartPending: true }
        : state;
    case "cancel-requested":
      if (
        (state.step === "export-running" ||
          state.step === "import-running" ||
          state.step === "import-preview") &&
        state.cancellable &&
        !state.cancelRequested
      ) {
        return { ...state, cancelRequested: true, cancellable: false };
      }
      return state;
    case "cancel-completed":
      return activeOperationId(state) === action.operationId &&
        (state.step === "export-running" ||
          state.step === "import-running" ||
          state.step === "import-preview") &&
        state.cancelRequested
        ? createInitialTransferState()
        : state;
    case "failed": {
      const operationId = activeOperationId(state);
      if (action.operationId !== undefined && operationId !== action.operationId) return state;
      if (state.step === "import-committing" || state.step === "import-commit-failure") {
        return {
          step: "import-commit-failure",
          operationId: state.operationId,
          error: action.error,
          cancellable: false,
        };
      }
      const flow = flowOf(state);
      return flow ? { step: "failure", flow, error: action.error, cancellable: false } : state;
    }
    case "back":
      return reduceBack(state);
    case "reset":
      return state.step === "import-committing" || state.step === "import-commit-failure"
        ? state
        : createInitialTransferState();
  }
}
