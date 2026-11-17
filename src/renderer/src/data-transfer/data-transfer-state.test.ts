import type {
  DataTransferLibraryInspection,
  DataTransferProgress,
  FullDataExportResult,
  FullDataImportPreview,
} from "../../../shared/data-transfer/model";
import type { AppError } from "../../../shared/ipc/result";
import {
  createInitialTransferState,
  reduceTransferState,
  type TransferState,
} from "./data-transfer-state";

const EXPORT_OPERATION_ID = "00000000-0000-4000-8000-000000000923";
const IMPORT_OPERATION_ID = "00000000-0000-4000-8000-000000000924";
const NEXT_OPERATION_ID = "00000000-0000-4000-8000-000000000926";
const SECRET = "虚构迁移口令仅用于状态测试";
const SUMMARY = {
  activePatents: 1,
  trashedPatents: 1,
  documents: 1,
  legacyDrafts: 1,
  snapshots: 1,
  assets: 1,
  flowchartProjects: 1,

  totalBytes: 128,
} as const;
const EMPTY_INSPECTION: DataTransferLibraryInspection = {
  empty: true,
  blockers: [],
  summary: { ...SUMMARY, activePatents: 0, trashedPatents: 0, documents: 0 },
};
const NON_EMPTY_INSPECTION: DataTransferLibraryInspection = {
  empty: false,
  blockers: [{ kind: "patents", count: 1 }],
  summary: SUMMARY,
};
const PREVIEW: FullDataImportPreview = {
  operationId: IMPORT_OPERATION_ID,
  packageId: "00000000-0000-4000-8000-000000000925",
  exportedAt: "2026-08-16T00:00:00.000Z",
  summary: SUMMARY,
  packageVerified: true,
  versionCompatible: true,
  targetLibraryEmpty: true,
  settingsRequiringSetup: ["backup-folder", "ai-credentials", "printer"],
};
const EXPORT_RESULT: FullDataExportResult = {
  operationId: EXPORT_OPERATION_ID,
  displayPath: "移动磁盘",
  sizeBytes: 128,
  cutoffAt: "2026-08-16T00:00:00.000Z",
  packageFormatVersion: 2,
  summary: SUMMARY,
  fullVerificationPassed: true,
};
const ERROR: AppError = {
  code: "PACKAGE_TAMPERED",
  message: "数据包未通过完整性验证。",
  nextAction: "请重新复制数据包。",
};

const SOURCE = {
  selectionId: "import-selection",
  fileName: "完整数据.zxwbackup",
  sizeBytes: 128,
  packageFormatVersion: 2,
  minimumImporterVersion: "0.1.0",
  passwordHint: null,
} as const;

function progress(
  operationId: string,
  kind: DataTransferProgress["kind"],
  phase: DataTransferProgress["phase"],
  cancellable = true,
): DataTransferProgress {
  return {
    operationId,
    kind,
    phase,
    completedBytes: 1,
    totalBytes: 2,
    currentCategory: kind === "library-swap" ? "switching" : "verification",
    elapsedMs: 10,
    remainingMs: 10,
    cancellable,
  };
}

function exportPasswordState(): TransferState {
  let state = reduceTransferState(createInitialTransferState(), {
    type: "export-opened",
    inspection: NON_EMPTY_INSPECTION,
  });
  state = reduceTransferState(state, { type: "export-destination-requested" });
  state = reduceTransferState(state, {
    type: "export-destination-selected",
    operationId: EXPORT_OPERATION_ID,
    destination: {
      selectionId: "export-selection",
      displayPath: "移动磁盘",
      suggestedFileName: "完整数据.zxwbackup",
    },
  });
  return reduceTransferState(state, { type: "export-destination-confirmed" });
}

function importPasswordState(): TransferState {
  let state = reduceTransferState(createInitialTransferState(), { type: "import-opened" });
  state = reduceTransferState(state, {
    type: "empty-check-completed",
    inspection: EMPTY_INSPECTION,
  });
  state = reduceTransferState(state, { type: "import-empty-check-confirmed" });
  state = reduceTransferState(state, {
    type: "import-source-selected",
    operationId: IMPORT_OPERATION_ID,
    source: SOURCE,
  });
  return reduceTransferState(state, { type: "import-source-confirmed" });
}

function importSourceState(): TransferState {
  let state = reduceTransferState(createInitialTransferState(), { type: "import-opened" });
  state = reduceTransferState(state, {
    type: "empty-check-completed",
    inspection: EMPTY_INSPECTION,
  });
  return reduceTransferState(state, { type: "import-empty-check-confirmed" });
}

function submitPassword(state: TransferState): TransferState {
  state = reduceTransferState(state, { type: "password-updated", password: SECRET });
  state = reduceTransferState(state, {
    type: "password-confirmation-updated",
    confirmPassword: SECRET,
  });
  return reduceTransferState(state, { type: "password-submitted" });
}

describe("data transfer state", () => {
  test("walks the export setup states and clears password values on submit", () => {
    const passwordReady = reduceTransferState(
      reduceTransferState(exportPasswordState(), {
        type: "password-updated",
        password: SECRET,
      }),
      { type: "password-confirmation-updated", confirmPassword: SECRET },
    );
    const acknowledged = reduceTransferState(passwordReady, {
      type: "password-recorded-updated",
      passwordRecorded: true,
    });
    const next = reduceTransferState(acknowledged, { type: "password-submitted" });

    expect(next).toMatchObject({
      step: "export-running",
      operationId: EXPORT_OPERATION_ID,
      password: "",
      confirmPassword: "",
      cancellable: true,
    });
    expect(JSON.stringify(next)).not.toContain(SECRET);
  });

  test("checks for an empty library before allowing import source selection", () => {
    const checking = reduceTransferState(createInitialTransferState(), { type: "import-opened" });
    const blocked = reduceTransferState(checking, {
      type: "empty-check-completed",
      inspection: NON_EMPTY_INSPECTION,
    });
    const confirmed = reduceTransferState(checking, {
      type: "empty-check-completed",
      inspection: EMPTY_INSPECTION,
    });
    const sourceStep = reduceTransferState(confirmed, { type: "import-empty-check-confirmed" });

    expect(blocked).toMatchObject({
      step: "import-empty-check",
      inspection: NON_EMPTY_INSPECTION,
    });
    expect(confirmed).toMatchObject({
      step: "import-empty-check",
      inspection: EMPTY_INSPECTION,
    });
    expect(sourceStep).toMatchObject({
      step: "import-source",
      inspection: EMPTY_INSPECTION,
      source: null,
      operationId: null,
    });
    expect(reduceTransferState(checking, { type: "import-empty-check-confirmed" })).toBe(checking);
    expect(reduceTransferState(blocked, { type: "import-empty-check-confirmed" })).toBe(blocked);
  });

  test("keeps a selected import source on the source step until it is confirmed", () => {
    const sourceStep = importSourceState();
    const selected = reduceTransferState(sourceStep, {
      type: "import-source-selected",
      operationId: IMPORT_OPERATION_ID,
      source: SOURCE,
    });
    expect(selected).toMatchObject({
      step: "import-source",
      source: { fileName: "完整数据.zxwbackup" },
      operationId: IMPORT_OPERATION_ID,
    });
    expect(
      reduceTransferState(selected, {
        type: "import-source-confirmed",
      }),
    ).toMatchObject({
      step: "import-password",
      inspection: EMPTY_INSPECTION,
      source: { fileName: "完整数据.zxwbackup" },
      operationId: IMPORT_OPERATION_ID,
      password: "",
      confirmPassword: "",
    });
    expect(reduceTransferState(sourceStep, { type: "import-source-confirmed" })).toBe(sourceStep);
  });

  test("replaces the import source and operation id when reselecting", () => {
    const sourceStep = importSourceState();
    const first = reduceTransferState(sourceStep, {
      type: "import-source-selected",
      operationId: IMPORT_OPERATION_ID,
      source: SOURCE,
    });
    const second = reduceTransferState(first, {
      type: "import-source-selected",
      operationId: NEXT_OPERATION_ID,
      source: { ...SOURCE, fileName: "另一数据包.zxwbackup" },
    });
    expect(second).toMatchObject({
      step: "import-source",
      operationId: NEXT_OPERATION_ID,
      source: { fileName: "另一数据包.zxwbackup" },
    });
  });

  test("discards a prepared import before returning to a clean password step", () => {
    const previewReady = reduceTransferState(submitPassword(importPasswordState()), {
      type: "import-prepared",
      preview: PREVIEW,
    });
    const returned = reduceTransferState(previewReady, {
      type: "import-preview-discarded",
      operationId: IMPORT_OPERATION_ID,
      nextOperationId: NEXT_OPERATION_ID,
    });
    expect(returned).toMatchObject({
      step: "import-password",
      inspection: EMPTY_INSPECTION,
      source: { fileName: "完整数据.zxwbackup" },
      operationId: NEXT_OPERATION_ID,
      password: "",
      confirmPassword: "",
    });
    expect(JSON.stringify(returned)).not.toContain(PREVIEW.packageId);
    expect(JSON.stringify(returned)).not.toContain(SECRET);
  });

  test("ignores preview discard when the operation id does not match or the commit is irreversible", () => {
    const previewReady = reduceTransferState(submitPassword(importPasswordState()), {
      type: "import-prepared",
      preview: PREVIEW,
    });
    expect(
      reduceTransferState(previewReady, {
        type: "import-preview-discarded",
        operationId: EXPORT_OPERATION_ID,
        nextOperationId: NEXT_OPERATION_ID,
      }),
    ).toBe(previewReady);

    const committing = reduceTransferState(previewReady, { type: "commit-started" });
    expect(
      reduceTransferState(committing, {
        type: "import-preview-discarded",
        operationId: IMPORT_OPERATION_ID,
        nextOperationId: NEXT_OPERATION_ID,
      }),
    ).toBe(committing);

    const failed = reduceTransferState(committing, {
      type: "failed",
      operationId: IMPORT_OPERATION_ID,
      error: ERROR,
    });
    expect(
      reduceTransferState(failed, {
        type: "import-preview-discarded",
        operationId: IMPORT_OPERATION_ID,
        nextOperationId: NEXT_OPERATION_ID,
      }),
    ).toBe(failed);
  });

  test("moves a verified import from password through preview to an irreversible commit", () => {
    const running = submitPassword(importPasswordState());
    const previewReady = reduceTransferState(running, {
      type: "import-prepared",
      preview: PREVIEW,
    });
    const swapping = reduceTransferState(previewReady, { type: "commit-started" });

    expect(running).toMatchObject({
      step: "import-running",
      password: "",
      confirmPassword: "",
    });
    expect(previewReady).toMatchObject({ step: "import-preview", preview: PREVIEW });
    expect(swapping).toMatchObject({
      step: "import-committing",
      operationId: IMPORT_OPERATION_ID,
      cancellable: false,
      restartPending: false,
    });
    expect(reduceTransferState(swapping, { type: "cancel-requested" })).toBe(swapping);
    expect(reduceTransferState(swapping, { type: "back" })).toBe(swapping);
    expect(reduceTransferState(swapping, { type: "reset" })).toBe(swapping);
    expect(
      reduceTransferState(swapping, {
        type: "restart-pending",
        operationId: IMPORT_OPERATION_ID,
      }),
    ).toMatchObject({ step: "import-committing", restartPending: true, cancellable: false });
  });

  test("keeps a failed import commit in an irreversible recovery state", () => {
    const running = submitPassword(importPasswordState());
    const previewReady = reduceTransferState(running, {
      type: "import-prepared",
      preview: PREVIEW,
    });
    const committing = reduceTransferState(previewReady, { type: "commit-started" });
    const failed = reduceTransferState(committing, {
      type: "failed",
      operationId: IMPORT_OPERATION_ID,
      error: ERROR,
    });

    expect(failed).toMatchObject({
      step: "import-commit-failure",
      operationId: IMPORT_OPERATION_ID,
      error: ERROR,
      cancellable: false,
    });
    expect(reduceTransferState(failed, { type: "back" })).toBe(failed);
    expect(reduceTransferState(failed, { type: "reset" })).toBe(failed);
    expect(reduceTransferState(failed, { type: "cancel-requested" })).toBe(failed);
  });

  test("enters the export result only for the active operation", () => {
    const running = submitPassword(exportPasswordState());
    expect(
      reduceTransferState(running, {
        type: "export-completed",
        result: { ...EXPORT_RESULT, operationId: IMPORT_OPERATION_ID },
      }),
    ).toBe(running);

    const completed = reduceTransferState(running, {
      type: "export-completed",
      result: EXPORT_RESULT,
    });
    expect(completed).toEqual({
      step: "export-result",
      result: EXPORT_RESULT,
      cancellable: false,
    });
    expect(reduceTransferState(completed, { type: "back" })).toEqual(createInitialTransferState());
  });

  test("accepts only current, flow-compatible and monotonic export progress", () => {
    const running = submitPassword(exportPasswordState());

    expect(
      reduceTransferState(running, {
        type: "progress-received",
        progress: progress(IMPORT_OPERATION_ID, "full-data-export", "encrypting"),
      }),
    ).toBe(running);
    expect(
      reduceTransferState(running, {
        type: "progress-received",
        progress: progress(EXPORT_OPERATION_ID, "full-data-import", "decrypting"),
      }),
    ).toBe(running);
    expect(
      reduceTransferState(running, {
        type: "progress-received",
        progress: progress(EXPORT_OPERATION_ID, "full-data-export", "decrypting"),
      }),
    ).toBe(running);

    const verifying = reduceTransferState(running, {
      type: "progress-received",
      progress: progress(EXPORT_OPERATION_ID, "full-data-export", "verifying-package", false),
    });
    expect(verifying).toMatchObject({
      step: "export-running",
      progress: { phase: "verifying-package" },
      cancellable: false,
    });
    expect(
      reduceTransferState(verifying, {
        type: "progress-received",
        progress: {
          ...progress(EXPORT_OPERATION_ID, "full-data-export", "verifying-package", false),
          completedBytes: 0,
        },
      }),
    ).toBe(verifying);
    expect(
      reduceTransferState(verifying, {
        type: "progress-received",
        progress: progress(EXPORT_OPERATION_ID, "full-data-export", "encrypting"),
      }),
    ).toBe(verifying);

    const completedProgress = reduceTransferState(verifying, {
      type: "progress-received",
      progress: progress(EXPORT_OPERATION_ID, "full-data-export", "completed", false),
    });
    expect(
      reduceTransferState(completedProgress, {
        type: "progress-received",
        progress: progress(EXPORT_OPERATION_ID, "full-data-export", "failed", false),
      }),
    ).toBe(completedProgress);
  });

  test("accepts only authoritative library-swap progress after commit starts", () => {
    const previewReady = reduceTransferState(submitPassword(importPasswordState()), {
      type: "import-prepared",
      preview: PREVIEW,
    });
    const committing = reduceTransferState(previewReady, { type: "commit-started" });
    expect(
      reduceTransferState(committing, {
        type: "progress-received",
        progress: progress(IMPORT_OPERATION_ID, "full-data-import", "preparing-swap"),
      }),
    ).toBe(committing);

    const swapping = reduceTransferState(committing, {
      type: "progress-received",
      progress: progress(IMPORT_OPERATION_ID, "library-swap", "swapping"),
    });
    expect(swapping).toMatchObject({
      progress: { kind: "library-swap", phase: "swapping" },
      cancellable: false,
    });
  });

  test("marks a cancellable operation once and ignores cancellation after it is locked", () => {
    const running = submitPassword(importPasswordState());
    const requested = reduceTransferState(running, { type: "cancel-requested" });

    expect(requested).toMatchObject({ cancelRequested: true, cancellable: false });
    expect(reduceTransferState(requested, { type: "cancel-requested" })).toBe(requested);
    expect(
      reduceTransferState(requested, {
        type: "cancel-completed",
        operationId: EXPORT_OPERATION_ID,
      }),
    ).toBe(requested);
    expect(
      reduceTransferState(requested, {
        type: "cancel-completed",
        operationId: IMPORT_OPERATION_ID,
      }),
    ).toEqual(createInitialTransferState());
  });

  test("ignores stale completions and failures from expired operation ids", () => {
    const running = submitPassword(importPasswordState());
    expect(
      reduceTransferState(running, {
        type: "import-prepared",
        preview: { ...PREVIEW, operationId: EXPORT_OPERATION_ID },
      }),
    ).toBe(running);
    expect(
      reduceTransferState(running, {
        type: "failed",
        operationId: EXPORT_OPERATION_ID,
        error: ERROR,
      }),
    ).toBe(running);
    expect(
      reduceTransferState(running, {
        type: "failed",
        operationId: IMPORT_OPERATION_ID,
        error: ERROR,
      }),
    ).toMatchObject({ step: "failure", flow: "import", error: ERROR });
  });

  test("supports safe back paths without retaining a password", () => {
    const exportPassword = reduceTransferState(
      reduceTransferState(exportPasswordState(), { type: "password-updated", password: SECRET }),
      { type: "password-confirmation-updated", confirmPassword: SECRET },
    );
    const exportDestination = reduceTransferState(exportPassword, { type: "back" });
    expect(exportDestination).toMatchObject({
      step: "export-destination",
      operationId: EXPORT_OPERATION_ID,
      destination: { selectionId: "export-selection" },
    });
    expect(JSON.stringify(exportDestination)).not.toContain(SECRET);
    expect(reduceTransferState(exportDestination, { type: "back" })).toMatchObject({
      step: "export-summary",
    });

    const importPassword = reduceTransferState(importPasswordState(), {
      type: "password-updated",
      password: SECRET,
    });
    const importSource = reduceTransferState(importPassword, { type: "back" });
    expect(importSource).toMatchObject({
      step: "import-source",
      source: { fileName: "完整数据.zxwbackup" },
      operationId: IMPORT_OPERATION_ID,
    });
    expect(JSON.stringify(importSource)).not.toContain(SECRET);
    expect(reduceTransferState(importSource, { type: "back" })).toMatchObject({
      step: "import-empty-check",
      inspection: EMPTY_INSPECTION,
    });
  });

  test("returns the same object for actions that are illegal in the current state", () => {
    const state = createInitialTransferState();
    expect(reduceTransferState(state, { type: "password-submitted" })).toBe(state);
    expect(reduceTransferState(state, { type: "commit-started" })).toBe(state);
    expect(
      reduceTransferState(state, {
        type: "progress-received",
        progress: progress(EXPORT_OPERATION_ID, "full-data-export", "encrypting"),
      }),
    ).toBe(state);
  });
});
