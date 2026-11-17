import { type DragEvent, type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import type {
  DataTransferProgress as DataTransferProgressValue,
  FullDataImportPrepareRequest,
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

export type ImportWizardApi = Pick<
  PatentApi["dataTransfer"],
  | "inspectLibrary"
  | "selectImportPackage"
  | "prepareImport"
  | "commitImport"
  | "cancel"
  | "onProgress"
>;

type ImportWizardProps = Readonly<{
  closeGuardRegistrar: Pick<ApplicationPersistence, "registerCloseGuard">;
  open: boolean;
  onClose: () => void;
  onExportCurrent?: () => void;
  api?: ImportWizardApi;
  createOperationId?: () => string;
  delay?: (milliseconds: number) => Promise<void>;
}>;

type TerminalState =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "failure"; error: AppError }>;

const STEPS = [
  { id: "empty-check", label: "确认空库" },
  { id: "source", label: "选择数据包" },
  { id: "password", label: "输入密码" },
  { id: "verification", label: "完整验证" },
  { id: "preview", label: "确认导入" },
  { id: "restart", label: "安全切换" },
] as const;

const BLOCKER_LABELS: Readonly<Record<string, (count: number) => string>> = {
  patents: (count) => `${count} 项专利`,
  documents: (count) => `${count} 份文档`,
  "legacy-drafts": (count) => `${count} 份旧草稿`,
  snapshots: (count) => `${count} 份恢复快照`,
  "edit-logs": (count) => `${count} 份待保存编辑记录`,
  assets: (count) => `${count} 个附件与图片`,
  projects: (count) => `${count} 个图表工程`,
  "library-state": () => "专利库包含本机状态",
  "pending-operation": () => "专利库有未完成操作",
  "unknown-files": (count) => `${count} 个未知文件`,
  "unreadable-library": () => "无法安全读取当前专利库",
};

const SETTING_LABELS: Readonly<Record<string, string>> = {
  "backup-folder": "备份位置需要重新选择",
  "ai-credentials": "AI 凭据需要重新配置",
  printer: "打印机需要重新选择",
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} GB`;
}

function currentStep(
  state: TransferState,
  checking: boolean,
  preparing: boolean,
  terminal: TerminalState | null,
): string {
  if (state.step === "import-committing" || state.step === "import-commit-failure") {
    return "restart";
  }
  if (terminal) return "verification";
  if (preparing) return "verification";
  if (state.step === "import-preview") return "preview";
  if (state.step === "import-password") return "password";
  if (state.step === "import-source") return "source";
  if (state.step === "import-empty-check" || checking) return "empty-check";
  return "empty-check";
}

function initialPrepareProgress(operationId: string): DataTransferProgressValue {
  return {
    operationId,
    kind: "full-data-import",
    phase: "verifying-package",
    completedBytes: 0,
    totalBytes: null,
    currentCategory: "verification",
    elapsedMs: 0,
    remainingMs: null,
    cancellable: true,
  };
}

export function ImportWizard({
  closeGuardRegistrar,
  open,
  onClose,
  onExportCurrent,
  api = window.patentApi.dataTransfer,
  createOperationId = createDataTransferOperationId,
  delay = wait,
}: ImportWizardProps) {
  const [state, dispatch] = useReducer(reduceTransferState, undefined, createInitialTransferState);
  const [checking, setChecking] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [inspectionFailed, setInspectionFailed] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [latestProgress, setLatestProgress] = useState<DataTransferProgressValue | null>(null);
  const [terminal, setTerminal] = useState<TerminalState | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [returningFromPreview, setReturningFromPreview] = useState(false);
  const passwordFailures = useRef(0);
  const cancelledPrepare = useRef<string | null>(null);
  const sessionToken = useRef(0);
  const commitLocked = useRef(false);
  const ownedOperation = useRef<string | null>(null);
  const cleanup = useRef<() => Promise<boolean>>(async () => true);
  const [closing, setClosing] = useState(false);
  cleanup.current = async () => {
    if (commitLocked.current) return false;
    const id = ownedOperation.current;
    if (!id) return true;
    const result = await api.cancel(id);
    if (!result.ok && result.error.code !== "NOT_FOUND") {
      setValidationError(result.error.message);
      return false;
    }
    if (ownedOperation.current === id) ownedOperation.current = null;
    return true;
  };

  const requestClose = async () => {
    if (closing || returningFromPreview || commitLocked.current) return;
    setClosing(true);
    if (await cleanup.current()) onClose();
    setClosing(false);
  };

  useEffect(
    () =>
      closeGuardRegistrar.registerCloseGuard(
        "full-data-import",
        async () => await cleanup.current(),
      ),
    [closeGuardRegistrar],
  );

  useEffect(() => {
    const currentSession = sessionToken.current + 1;
    sessionToken.current = currentSession;
    if (!open) return;
    dispatch({ type: "reset" });
    setChecking(false);
    setSelecting(false);
    setInspectionFailed(false);
    setDropError(null);
    setValidationError(null);
    setPreparing(false);
    setCancelRequested(false);
    setLatestProgress(null);
    setTerminal(null);
    setAcknowledged(false);
    setReturningFromPreview(false);
    passwordFailures.current = 0;
    cancelledPrepare.current = null;
    commitLocked.current = false;
    return () => {
      if (sessionToken.current === currentSession) sessionToken.current += 1;
      // The main process retains durable cleanup ownership if shutdown interrupts this call.
      if (!commitLocked.current && ownedOperation.current) void cleanup.current();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return api.onProgress((progress) => setLatestProgress(progress));
  }, [api, open]);

  const beginImport = async () => {
    if (state.step !== "landing" || checking) return;
    const currentSession = sessionToken.current;
    setChecking(true);
    setInspectionFailed(false);
    dispatch({ type: "import-opened" });
    const result = await api.inspectLibrary();
    if (sessionToken.current !== currentSession) return;
    setChecking(false);
    if (!result.ok) {
      setInspectionFailed(true);
      return;
    }
    dispatch({ type: "empty-check-completed", inspection: result.value });
  };

  const chooseSource = async () => {
    if (state.step !== "import-source" || selecting) return;
    const currentSession = sessionToken.current;
    setSelecting(true);
    setDropError(null);
    const result = await api.selectImportPackage();
    if (sessionToken.current !== currentSession) return;
    setSelecting(false);
    if (!result.ok) {
      setTerminal({ kind: "failure", error: result.error });
      return;
    }
    if (!result.value) return;
    dispatch({
      type: "import-source-selected",
      operationId: createOperationId(),
      source: result.value,
    });
  };

  const acceptDroppedFiles = (files: readonly File[]) => {
    if (files.length !== 1) {
      setDropError("一次只能选择一个数据包。");
      return;
    }
    const file = files[0];
    if (!file?.name.toLocaleLowerCase().endsWith(".zxwbackup")) {
      setDropError("请选择 .zxwbackup 文件。");
      return;
    }
    setDropError(null);
    void chooseSource();
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    acceptDroppedFiles(Array.from(event.dataTransfer.files));
  };

  const prepare = async () => {
    if (state.step !== "import-password" || preparing) return;
    if (state.password.length === 0) {
      setValidationError("请输入迁移密码。");
      return;
    }
    const request: FullDataImportPrepareRequest = {
      operationId: state.operationId,
      sourceSelectionId: state.source.selectionId,
      password: state.password,
    };
    ownedOperation.current = request.operationId;
    const currentSession = sessionToken.current;
    cancelledPrepare.current = null;
    setPreparing(true);
    setCancelRequested(false);
    setValidationError(null);
    setLatestProgress(null);
    dispatch({ type: "password-updated", password: "" });
    dispatch({ type: "password-confirmation-updated", confirmPassword: "" });
    const result = await api.prepareImport(request);
    if (sessionToken.current !== currentSession) return;
    if (!result.ok) {
      if (result.error.code !== "IMPORT_RECOVERY_REQUIRED") ownedOperation.current = null;
      if (result.error.code === "CANCELLED") {
        setPreparing(false);
        setTerminal({ kind: "cancelled" });
        return;
      }
      if (result.error.code === "PASSWORD_OR_PACKAGE_INVALID") {
        passwordFailures.current += 1;
        setValidationError("密码错误或数据包已损坏，请检查密码和文件后重试。");
        const milliseconds =
          passwordFailures.current <= 3 ? 0 : passwordFailures.current <= 6 ? 2_000 : 5_000;
        if (milliseconds > 0) await delay(milliseconds);
        if (sessionToken.current !== currentSession) return;
        setPreparing(false);
        setCancelRequested(false);
        return;
      }
      setPreparing(false);
      setTerminal({ kind: "failure", error: result.error });
      return;
    }
    if (cancelledPrepare.current === request.operationId) {
      setPreparing(false);
      setTerminal({ kind: "cancelled" });
      return;
    }
    setPreparing(false);
    setCancelRequested(false);
    setAcknowledged(false);
    dispatch({ type: "password-submitted" });
    dispatch({ type: "import-prepared", preview: result.value });
  };

  const cancelPrepare = async () => {
    if (state.step !== "import-password" || !preparing || cancelRequested) return;
    cancelledPrepare.current = state.operationId;
    setCancelRequested(true);
    await api.cancel(state.operationId);
  };

  const commit = async () => {
    if (
      state.step !== "import-preview" ||
      !acknowledged ||
      returningFromPreview ||
      closing ||
      commitLocked.current
    )
      return;
    const operationId = state.operationId;
    commitLocked.current = true;
    dispatch({ type: "commit-started" });
    setLatestProgress(null);
    const result = await api.commitImport({
      operationId,
      acknowledgedEmptyLibraryAndRestart: true,
    });
    if (!result.ok) {
      commitLocked.current = false;
      dispatch({ type: "failed", operationId, error: result.error });
      return;
    }
    dispatch({ type: "restart-pending", operationId });
    ownedOperation.current = null;
  };

  const backToSource = () => {
    dispatch({ type: "back" });
    setValidationError(null);
    setLatestProgress(null);
  };

  const backFromSource = () => {
    dispatch({ type: "back" });
    setDropError(null);
  };

  const returnFromPreview = async () => {
    if (state.step !== "import-preview" || returningFromPreview) return;
    const currentSession = sessionToken.current;
    const operationId = state.operationId;
    setReturningFromPreview(true);
    setValidationError(null);
    const result = await api.cancel(operationId);
    if (sessionToken.current !== currentSession) return;
    if (!result.ok) {
      setReturningFromPreview(false);
      setValidationError(result.error.message);
      return;
    }
    setAcknowledged(false);
    setReturningFromPreview(false);
    ownedOperation.current = null;
    dispatch({
      type: "import-preview-discarded",
      operationId,
      nextOperationId: createOperationId(),
    });
  };

  let content: ReactNode;
  if (terminal?.kind === "cancelled") {
    content = (
      <section className="data-transfer-card data-transfer-card--notice" role="status">
        <h3>已取消验证</h3>
        <p>当前空专利库未改变，数据包没有被导入。</p>
        <p>如需继续，可以重新选择数据包并再次验证。</p>
        <div className="data-transfer-card__actions">
          <button type="button" onClick={() => void requestClose()}>
            返回专利库
          </button>
        </div>
      </section>
    );
  } else if (terminal?.kind === "failure") {
    content = (
      <section className="data-transfer-card data-transfer-card--danger" role="alert">
        <h3>无法读取完整数据包</h3>
        <p>{terminal.error.message}</p>
        <p>当前专利库未改变。</p>
        <p>{terminal.error.nextAction ?? "请重新选择有效的数据包。"}</p>
        <div className="data-transfer-card__actions">
          <button type="button" onClick={() => void requestClose()}>
            返回专利库
          </button>
        </div>
      </section>
    );
  } else if (state.step === "import-commit-failure") {
    content = (
      <section className="data-transfer-card data-transfer-card--locked" role="alert">
        <h3>导入恢复需要处理</h3>
        <p>{state.error.message}</p>
        <p>{state.error.nextAction ?? "请勿删除任何迁移候选目录，并联系技术支持。"}</p>
      </section>
    );
  } else if (state.step === "import-committing") {
    content = state.restartPending ? (
      <section className="data-transfer-card data-transfer-card--locked" aria-live="assertive">
        <h3>正在安全切换并重新启动</h3>
        <p>请保持电脑供电。若意外断电，软件会在下次启动时自动恢复。</p>
      </section>
    ) : (
      <section className="data-transfer-card data-transfer-card--locked" aria-live="polite">
        <h3>正在准备安全切换</h3>
        <p>此阶段不可取消或关闭，请保持电脑供电。</p>
      </section>
    );
  } else if (state.step === "import-preview") {
    const { preview } = state;
    content = (
      <DataTransferStepPage
        key="import-preview"
        title="确认导入内容"
        description="请确认导入内容无误后开始导入。"
        footer={
          <DataTransferWizardActions
            onBack={returnFromPreview}
            backDisabled={returningFromPreview}
            primaryAction={
              <button
                type="button"
                className="primary-button"
                disabled={!acknowledged || returningFromPreview}
                onClick={commit}
              >
                导入并重新启动
              </button>
            }
          />
        }
      >
        {
          <SpatialPresence>
            {returningFromPreview ? (
              <p className="data-transfer-note" role="status">
                正在返回…
              </p>
            ) : null}
          </SpatialPresence>
        }
        <ul className="data-transfer-status-list">
          <li>
            <span aria-hidden="true">✓</span>
            密码正确
          </li>
          <li>
            <span aria-hidden="true">✓</span>
            文件完整
          </li>
          <li>
            <span aria-hidden="true">✓</span>
            版本兼容
          </li>
          <li>
            <span aria-hidden="true">✓</span>
            当前专利库为空
          </li>
        </ul>
        <h4>将恢复</h4>
        <div className="data-transfer-summary-grid">
          <div className="data-transfer-summary-grid__card">
            {preview.summary.activePatents} 项在用专利
          </div>
          <div className="data-transfer-summary-grid__card">
            {preview.summary.trashedPatents} 项回收站专利
          </div>
          <div className="data-transfer-summary-grid__card">{preview.summary.documents} 份文档</div>
          <div className="data-transfer-summary-grid__card">
            {preview.summary.assets} 个附件与图片
          </div>
          <div className="data-transfer-summary-grid__card">
            {preview.summary.snapshots} 份恢复快照
          </div>
        </div>
        <h4>需要在这台电脑重新设置</h4>
        {(preview.settingsRequiringSetup as readonly string[]).length === 0 ? (
          <p className="data-transfer-settings-list__empty">无需重新设置本机专属项</p>
        ) : (
          <ul className="data-transfer-settings-list">
            {preview.settingsRequiringSetup.map((setting) => (
              <li key={setting}>{SETTING_LABELS[setting] ?? "本机专属设置"}</li>
            ))}
          </ul>
        )}
        <label className="data-transfer-acknowledgement">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={returningFromPreview}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          我确认当前专利库为空，并同意导入后重新启动
        </label>
        <SpatialPresence>
          {validationError ? (
            <p className="data-transfer-notice-card data-transfer-notice-card--danger" role="alert">
              {validationError}
            </p>
          ) : null}
        </SpatialPresence>
      </DataTransferStepPage>
    );
  } else if (preparing && state.step === "import-password") {
    content = (
      <DataTransferStepPage key="import-verifying" title="正在验证数据包">
        <TransferProgress progress={latestProgress ?? initialPrepareProgress(state.operationId)} />
        {
          <SpatialPresence>
            {validationError ? <p role="alert">{validationError}</p> : null}
          </SpatialPresence>
        }
      </DataTransferStepPage>
    );
  } else if (state.step === "import-password") {
    content = (
      <DataTransferStepPage
        key="import-password"
        title="输入密码"
        description="密码仅用于在本机解锁所选数据包。"
        footer={
          <DataTransferWizardActions
            onBack={backToSource}
            primaryAction={
              <button
                type="button"
                className="primary-button"
                disabled={preparing}
                onClick={prepare}
              >
                验证数据包
              </button>
            }
          />
        }
      >
        <div className="data-transfer-selection-card data-transfer-selection-card--compact">
          <span className="data-transfer-selection-card__label">所选数据包</span>
          <strong className="data-transfer-selection-card__value">{state.source.fileName}</strong>
          <span className="data-transfer-selection-card__meta">
            大小 {formatBytes(state.source.sizeBytes)} · 格式版本{" "}
            {state.source.packageFormatVersion}
          </span>
        </div>
        <MigrationPasswordStep
          mode="unlock"
          password={state.password}
          publicPasswordHint={state.source.passwordHint}
          onPasswordChange={(password) => {
            setValidationError(null);
            dispatch({ type: "password-updated", password });
          }}
        />
        {
          <SpatialPresence>
            {validationError ? <p role="alert">{validationError}</p> : null}
          </SpatialPresence>
        }
      </DataTransferStepPage>
    );
  } else if (state.step === "import-source") {
    content = (
      <DataTransferStepPage
        key="import-source"
        title="选择完整数据包"
        description="请选择旧电脑导出的单个 .zxwbackup 文件。"
        footer={
          <DataTransferWizardActions
            onBack={backFromSource}
            onNext={() => dispatch({ type: "import-source-confirmed" })}
            nextDisabled={!state.source}
            {...(!state.source ? { nextDisabledReason: "请先选择一个 .zxwbackup 文件。" } : {})}
            secondaryActions={
              <button
                type="button"
                className="data-transfer-wizard-actions__assist"
                disabled={selecting}
                onClick={chooseSource}
              >
                {state.source ? "重新选择" : "浏览数据包"}
              </button>
            }
          />
        }
      >
        <button
          type="button"
          className="data-transfer-drop-zone"
          aria-label="拖放完整数据包"
          onClick={chooseSource}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          将一个完整数据包拖到这里
        </button>
        {<SpatialPresence>{dropError ? <p role="alert">{dropError}</p> : null}</SpatialPresence>}
        <SpatialView viewKey={String(state.source)}>
          {state.source ? (
            <div className="data-transfer-selection-card">
              <span className="data-transfer-selection-card__label">已选择数据包</span>
              <strong className="data-transfer-selection-card__value">
                {state.source.fileName}
              </strong>
              <span className="data-transfer-selection-card__meta">
                大小 {formatBytes(state.source.sizeBytes)} · 格式版本{" "}
                {state.source.packageFormatVersion}
              </span>
            </div>
          ) : (
            <div className="data-transfer-selection-card data-transfer-selection-card--empty">
              <p>尚未选择数据包。</p>
            </div>
          )}
        </SpatialView>
      </DataTransferStepPage>
    );
  } else if (state.step === "import-empty-check" && state.inspection && !state.inspection.empty) {
    content = (
      <section className="data-transfer-card data-transfer-card--warning">
        <h3>当前专利库不是空库</h3>
        <p>为保护现有数据，不能在此专利库中导入完整数据包。</p>
        <ul className="data-transfer-blocker-list">
          {state.inspection.blockers.map((blocker) => (
            <li key={blocker.kind}>
              {(BLOCKER_LABELS[blocker.kind] ?? (() => "现有专利库内容"))(blocker.count)}
            </li>
          ))}
        </ul>
        <div className="data-transfer-card__actions">
          {onExportCurrent ? (
            <button type="button" onClick={onExportCurrent}>
              导出当前完整数据包
            </button>
          ) : null}
          <button type="button" onClick={onClose}>
            返回专利库
          </button>
        </div>
      </section>
    );
  } else if (inspectionFailed) {
    content = (
      <section className="data-transfer-card data-transfer-card--danger" role="alert">
        <h3>无法确认当前专利库为空</h3>
        <p>为保护现有数据，当前不会选择或读取任何完整数据包。</p>
        <div className="data-transfer-card__actions">
          <button type="button" onClick={onClose}>
            返回专利库
          </button>
        </div>
      </section>
    );
  } else if (state.step === "import-empty-check" && state.inspection?.empty) {
    content = (
      <DataTransferStepPage
        key="import-empty-confirmed"
        title="当前专利库为空"
        description="可以在此电脑导入完整的 .zxwbackup 数据包。"
        footer={
          <DataTransferWizardActions
            onNext={() => dispatch({ type: "import-empty-check-confirmed" })}
          />
        }
      >
        <div className="data-transfer-notice-card data-transfer-notice-card--success">
          <p>空库确认完成，可以继续选择数据包。</p>
        </div>
      </DataTransferStepPage>
    );
  } else if (checking || state.step === "import-empty-check") {
    content = (
      <DataTransferStepPage key="import-checking" title="正在确认当前专利库为空">
        <p aria-live="polite">正在确认当前专利库是否为空…</p>
      </DataTransferStepPage>
    );
  } else {
    content = (
      <DataTransferStepPage
        key="import-landing"
        title="从旧电脑恢复完整数据"
        description="导入只允许在完全空白的专利库中进行，不会覆盖现有内容。"
      >
        <button type="button" className="primary-button" onClick={beginImport}>
          导入完整数据包
        </button>
      </DataTransferStepPage>
    );
  }

  const committing = state.step === "import-committing" || state.step === "import-commit-failure";
  return (
    <DataTransferDialog
      open={open}
      steps={STEPS}
      currentStep={currentStep(state, checking, preparing, terminal)}
      cancellable={preparing && !cancelRequested}
      locked={committing || closing || (preparing && cancelRequested) || returningFromPreview}
      onCancel={cancelPrepare}
      onClose={() => void requestClose()}
    >
      {content}
    </DataTransferDialog>
  );
}
