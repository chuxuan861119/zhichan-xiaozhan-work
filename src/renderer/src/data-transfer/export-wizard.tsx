import { type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import type {
  DataTransferProgress as DataTransferProgressValue,
  FullDataExportRequest,
} from "../../../shared/data-transfer/model";
import type { PatentApi } from "../../../shared/ipc/contract";
import type { AppError } from "../../../shared/ipc/result";
import type { ApplicationPersistence } from "../app/application-close-coordinator";
import { SpatialPresence } from "../shared/spatial-presence";
import { SpatialView } from "../shared/spatial-view";
import { createDataTransferOperationId } from "./create-operation-id";
import { DataTransferDialog } from "./data-transfer-dialog";
import {
  createInitialTransferState,
  reduceTransferState,
  type TransferState,
} from "./data-transfer-state";
import { DataTransferStepPage, DataTransferWizardActions } from "./data-transfer-step-page";
import { MigrationPasswordStep } from "./migration-password-step";
import { TransferProgress } from "./transfer-progress";
import { TransferResult } from "./transfer-result";

export type ExportWizardApi = Pick<
  PatentApi["dataTransfer"],
  "inspectLibrary" | "selectExportDestination" | "exportPackage" | "cancel" | "onProgress"
>;

type ExportWizardProps = Readonly<{
  open: boolean;
  onClose: () => void;
  flushAll: ApplicationPersistence["flushAll"];
  api?: ExportWizardApi;
  createOperationId?: () => string;
  backgroundElement?: HTMLElement | null;
}>;

type TerminalOutcome =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "failure"; error: AppError }>;

const STEPS = [
  { id: "summary", label: "确认数据" },
  { id: "destination", label: "保存位置" },
  { id: "password", label: "设置密码" },
  { id: "progress", label: "安全处理" },
  { id: "result", label: "完成" },
] as const;

const PARTICIPANT_LABELS: Readonly<Record<string, string>> = {
  documents: "文档编辑器",
  patents: "专利编辑器",
};

function participantLabel(participantId: string): string {
  if (participantId.startsWith("flowchart-workspace:")) return "流程图编辑器";
  return PARTICIPANT_LABELS[participantId] ?? "未保存的编辑内容";
}

function approximateBytes(bytes: number): string {
  if (bytes < 1024) return `约 ${bytes} B`;
  if (bytes < 1024 * 1024) return `约 ${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `约 ${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} MB`;
  }
  return `约 ${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} GB`;
}

function currentStep(state: TransferState, terminal: TerminalOutcome | null): string {
  if (terminal || state.step === "export-result" || state.step === "failure") return "result";
  if (state.step === "export-running") return "progress";
  if (state.step === "export-password") return "password";
  if (state.step === "export-destination") return "destination";
  return "summary";
}

function initialProgress(state: Extract<TransferState, { step: "export-running" }>) {
  return {
    operationId: state.operationId,
    kind: "full-data-export",
    phase: "quiescing-writes",
    completedBytes: 0,
    totalBytes: null,
    currentCategory: "settings",
    elapsedMs: 0,
    remainingMs: null,
    cancellable: state.cancellable,
  } satisfies DataTransferProgressValue;
}

export function ExportWizard({
  open,
  onClose,
  flushAll,
  api = window.patentApi.dataTransfer,
  createOperationId = createDataTransferOperationId,
  backgroundElement = null,
}: ExportWizardProps) {
  const [state, dispatch] = useReducer(reduceTransferState, undefined, createInitialTransferState);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [saveFailureIds, setSaveFailureIds] = useState<readonly string[]>([]);
  const [terminal, setTerminal] = useState<TerminalOutcome | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const sessionToken = useRef(0);
  const latestReloadToken = useRef(reloadToken);
  latestReloadToken.current = reloadToken;

  useEffect(() => {
    const currentSessionToken = sessionToken.current + 1;
    sessionToken.current = currentSessionToken;
    if (!open) return;
    const requestToken = reloadToken;
    let active = true;
    dispatch({ type: "reset" });
    setTerminal(null);
    setSaveFailureIds([]);
    setValidationMessage(null);
    setSubmitting(false);
    setLoading(true);
    void api.inspectLibrary().then((result) => {
      if (!active || requestToken !== latestReloadToken.current) return;
      setLoading(false);
      if (result.ok) dispatch({ type: "export-opened", inspection: result.value });
      else setTerminal({ kind: "failure", error: result.error });
    });
    return () => {
      active = false;
      if (sessionToken.current === currentSessionToken) sessionToken.current += 1;
    };
  }, [api, open, reloadToken]);

  useEffect(() => {
    if (!open) return;
    return api.onProgress((progress) => dispatch({ type: "progress-received", progress }));
  }, [api, open]);

  const running = open && state.step === "export-running" && terminal === null;
  useEffect(() => {
    if (!backgroundElement) return;
    const previous = backgroundElement.inert;
    backgroundElement.inert = running;
    return () => {
      backgroundElement.inert = previous;
    };
  }, [backgroundElement, running]);

  const chooseDestination = async () => {
    setLoading(true);
    const result = await api.selectExportDestination();
    setLoading(false);
    if (!result.ok) {
      setTerminal({ kind: "failure", error: result.error });
      return;
    }
    if (!result.value) return;
    dispatch({
      type: "export-destination-selected",
      operationId: createOperationId(),
      destination: result.value,
    });
  };

  const goBack = () => {
    setValidationMessage(null);
    setSaveFailureIds([]);
    dispatch({ type: "back" });
  };

  const startExport = async () => {
    if (state.step !== "export-password" || submitting) return;
    if ([...state.password].length < 12) {
      setValidationMessage("迁移密码至少需要 12 个字符。");
      return;
    }
    if (state.password !== state.confirmPassword) {
      setValidationMessage("两次输入的迁移密码不一致。");
      return;
    }
    if (!state.passwordRecorded) {
      setValidationMessage("请先确认已经记录并妥善保管迁移密码。");
      return;
    }

    const request: FullDataExportRequest = {
      operationId: state.operationId,
      destinationSelectionId: state.destination.selectionId,
      password: state.password,
      passwordHint: state.passwordHint.trim().length > 0 ? state.passwordHint : null,
      passwordRecorded: true,
    };
    const currentSessionToken = sessionToken.current;
    setSubmitting(true);
    setValidationMessage(null);
    setSaveFailureIds([]);
    dispatch({ type: "password-updated", password: "" });
    dispatch({ type: "password-confirmation-updated", confirmPassword: "" });

    const flushReport = await flushAll("full-data-transfer");
    if (sessionToken.current !== currentSessionToken) return;
    if (!flushReport.ok) {
      setSubmitting(false);
      setSaveFailureIds(flushReport.failedParticipantIds);
      return;
    }

    setSubmitting(false);
    dispatch({ type: "password-submitted" });
    const result = await api.exportPackage(request);
    if (sessionToken.current !== currentSessionToken) return;
    if (!result.ok) {
      if (result.error.code === "CANCELLED") setTerminal({ kind: "cancelled" });
      else setTerminal({ kind: "failure", error: result.error });
      return;
    }
    if (result.value.operationId !== request.operationId) return;
    dispatch({ type: "export-completed", result: result.value });
  };

  const cancelExport = async () => {
    if (state.step !== "export-running" || !state.cancellable) return;
    const operationId = state.operationId;
    dispatch({ type: "cancel-requested" });
    await api.cancel(operationId);
  };

  const reset = () => {
    dispatch({ type: "reset" });
    setTerminal(null);
    setSaveFailureIds([]);
    setValidationMessage(null);
    setSubmitting(false);
    setReloadToken((current) => current + 1);
  };

  let content: ReactNode;
  if (terminal?.kind === "cancelled") {
    content = <TransferResult outcome="cancelled" onRetry={reset} />;
  } else if (terminal?.kind === "failure") {
    content = <TransferResult outcome="failure" error={terminal.error} onRetry={reset} />;
  } else if (state.step === "export-result") {
    content = <TransferResult outcome="success" result={state.result} onDone={onClose} />;
  } else if (state.step === "export-summary") {
    const { summary } = state.inspection;
    content = (
      <DataTransferStepPage
        key="export-summary"
        title="确认要迁移的数据"
        footer={
          <DataTransferWizardActions
            onNext={() => dispatch({ type: "export-destination-requested" })}
          />
        }
      >
        <div className="data-transfer-summary-grid">
          <div className="data-transfer-summary-grid__card">{summary.activePatents} 项在用专利</div>
          <div className="data-transfer-summary-grid__card">
            {summary.trashedPatents} 项回收站专利
          </div>
          <div className="data-transfer-summary-grid__card">{summary.documents} 份文档</div>
          <div className="data-transfer-summary-grid__card">{summary.assets} 个附件与图片</div>
          <div className="data-transfer-summary-grid__card">
            {summary.flowchartProjects} 个图表工程
          </div>
          <div className="data-transfer-summary-grid__card">{summary.snapshots} 份恢复快照</div>
          <div className="data-transfer-summary-grid__card data-transfer-summary-grid__card--total">
            预计数据量：{approximateBytes(summary.totalBytes)}
          </div>
        </div>
      </DataTransferStepPage>
    );
  } else if (state.step === "export-destination") {
    const selectedPath = state.destination
      ? `${state.destination.displayPath}\\${state.destination.suggestedFileName}`
      : null;
    content = (
      <DataTransferStepPage
        key="export-destination"
        title="选择保存位置"
        description="选择一个安全且空间充足的位置。"
        footer={
          <DataTransferWizardActions
            onBack={goBack}
            onNext={() => dispatch({ type: "export-destination-confirmed" })}
            nextDisabled={!state.destination}
            {...(!state.destination ? { nextDisabledReason: "请先选择保存位置。" } : {})}
            secondaryActions={
              <button
                type="button"
                className="data-transfer-wizard-actions__assist"
                disabled={loading}
                onClick={chooseDestination}
              >
                {state.destination ? "重新选择" : "浏览保存位置"}
              </button>
            }
          />
        }
      >
        <div className="data-transfer-notice-card data-transfer-notice-card--notice">
          <p>不能保存到当前专利库内部。</p>
          <p>超过 4 GB 的数据包不适合 FAT32 磁盘。</p>
          <p>导出不会覆盖已有文件，请使用新的文件名。</p>
        </div>
        <SpatialView viewKey={String(selectedPath)}>
          {selectedPath ? (
            <div className="data-transfer-selection-card">
              <span className="data-transfer-selection-card__label">已选择保存位置</span>
              <strong className="data-transfer-selection-card__value">{selectedPath}</strong>
            </div>
          ) : (
            <div className="data-transfer-selection-card data-transfer-selection-card--empty">
              <p>尚未选择保存位置。</p>
            </div>
          )}
        </SpatialView>
      </DataTransferStepPage>
    );
  } else if (state.step === "export-password") {
    content = (
      <DataTransferStepPage
        key="export-password"
        title="设置密码"
        description="为完整数据包设置迁移密码。"
        footer={
          <DataTransferWizardActions
            onBack={goBack}
            backDisabled={submitting}
            primaryAction={
              <button
                type="button"
                className="primary-button"
                disabled={submitting}
                onClick={startExport}
              >
                {submitting ? "正在保存编辑内容…" : "开始导出"}
              </button>
            }
          />
        }
      >
        <MigrationPasswordStep
          mode="create"
          password={state.password}
          confirmPassword={state.confirmPassword}
          passwordHint={state.passwordHint}
          passwordRecorded={state.passwordRecorded}
          disabled={submitting}
          onPasswordChange={(password) => dispatch({ type: "password-updated", password })}
          onConfirmPasswordChange={(confirmPassword) =>
            dispatch({ type: "password-confirmation-updated", confirmPassword })
          }
          onPasswordHintChange={(passwordHint) =>
            dispatch({ type: "password-hint-updated", passwordHint })
          }
          onPasswordRecordedChange={(passwordRecorded) =>
            dispatch({ type: "password-recorded-updated", passwordRecorded })
          }
        />
        {
          <SpatialPresence>
            {validationMessage ? <p role="alert">{validationMessage}</p> : null}
          </SpatialPresence>
        }
        <SpatialPresence>
          {saveFailureIds.length > 0 ? (
            <div
              className="data-transfer-notice-card data-transfer-notice-card--danger"
              role="alert"
            >
              <strong>有内容尚未保存，导出没有开始。</strong>
              <ul>
                {[...new Set(saveFailureIds.map(participantLabel))].map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
              <p>原专利库未改变、未生成正式数据包。请完成保存后重试。</p>
            </div>
          ) : null}
        </SpatialPresence>
      </DataTransferStepPage>
    );
  } else if (state.step === "export-running") {
    content = (
      <DataTransferStepPage key="export-running" title="正在安全处理数据">
        <TransferProgress progress={state.progress ?? initialProgress(state)} />
      </DataTransferStepPage>
    );
  } else if (loading) {
    content = (
      <DataTransferStepPage key="export-loading" title="正在检查专利库">
        <p aria-live="polite">正在检查专利库…</p>
      </DataTransferStepPage>
    );
  } else {
    content = (
      <DataTransferStepPage key="export-idle" title="正在准备导出">
        <p>正在准备导出…</p>
      </DataTransferStepPage>
    );
  }

  return (
    <DataTransferDialog
      open={open}
      steps={STEPS}
      currentStep={currentStep(state, terminal)}
      cancellable={state.step === "export-running" && state.cancellable && terminal === null}
      locked={
        submitting || (state.step === "export-running" && !state.cancellable && terminal === null)
      }
      onCancel={cancelExport}
      onClose={onClose}
    >
      {content}
    </DataTransferDialog>
  );
}
