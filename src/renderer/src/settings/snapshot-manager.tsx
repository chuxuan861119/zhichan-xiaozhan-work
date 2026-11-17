import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppError } from "../../../shared/ipc/result";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import type {
  SnapshotContentPreview,
  SnapshotEntry,
  SnapshotListWarning,
} from "../../../shared/snapshot/model";
import { MotionPresence } from "../app/motion-presence";
import { SpatialPresence } from "../shared/spatial-presence";
import { StandardDialog } from "../shared/standard-dialog";
import { useModalDialog } from "../shared/use-modal-dialog";
import { useSpatialViewMotion } from "../shared/use-spatial-view-motion";
import { SnapshotContentPreviewDialog } from "./snapshot-preview/snapshot-content-preview-dialog";

type SnapshotManagerProps = {
  patentId?: string;
  open: boolean;
  active?: boolean;
  prepareSnapshot?: (patentId: string) => Promise<boolean>;
  onClose: () => void;
  onRestored: (documentId: string) => unknown | Promise<unknown>;
  embedded?: boolean;
  recoveryReadOnly?: boolean;
  recoveryContext?: boolean;
  restore?: typeof window.patentApi.snapshot.restore;
  onPreview?: (
    preview: SnapshotContentPreview,
    documentId: string,
    resourceMissing: boolean,
  ) => void;
};

type PatentGroup = {
  displayName: string;
  latestAt: string;
  versions: SnapshotEntry[];
};

export function SnapshotManager({
  patentId,
  open,
  active = true,
  prepareSnapshot,
  onClose,
  onRestored,
  embedded = false,
  recoveryReadOnly = false,
  recoveryContext = false,
  restore,
  onPreview,
}: SnapshotManagerProps) {
  const listRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [entries, setEntries] = useState<SnapshotEntry[]>([]);
  const [libraryPatents, setLibraryPatents] = useState<LibraryPatentSummary[]>([]);
  const listRequestIdRef = useRef(0);
  const listPendingRef = useRef(false);
  const lastAutomaticSnapshotRef = useRef<string | null>(null);
  const [listWarnings, setListWarnings] = useState<SnapshotListWarning[]>([]);
  const [operationWarnings, setOperationWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<SnapshotEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SnapshotEntry | null>(null);
  const [previewTarget, setPreviewTarget] = useState<SnapshotEntry | null>(null);
  const [previewData, setPreviewData] = useState<SnapshotContentPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewOriginRef = useRef<HTMLButtonElement | null>(null);
  const previewRequestIdRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ message: string } | null>(null);
  const [selectedPatentId, setSelectedPatentId] = useState<string | null>(null);

  const nestedDialogOpen =
    restoreTarget !== null || deleteTarget !== null || previewTarget !== null;
  useModalDialog({
    open: open && !embedded,
    active: !nestedDialogOpen,
    onClose,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
  });

  const loadEntries = useCallback(async (preserveMessages = false, background = false) => {
    const requestId = ++listRequestIdRef.current;
    listPendingRef.current = true;
    if (!background) setLoading(true);
    if (!background) setError(null);
    if (!preserveMessages) {
      setSuccess(null);
      setOperationWarnings([]);
    }
    try {
      const result = await window.patentApi.snapshot.list();
      if (requestId !== listRequestIdRef.current) return false;
      if (!result.ok) {
        setError(formatAppError(result.error));
        return false;
      }
      setEntries(result.value.entries);
      setListWarnings(result.value.warnings);
      const patents = await window.patentApi.patents.list("active");
      if (requestId !== listRequestIdRef.current) return false;
      if (!patents.ok) {
        setError(formatAppError(patents.error));
        return false;
      }
      setLibraryPatents(patents.value);
      setError(null);
      return true;
    } catch (caught) {
      if (requestId !== listRequestIdRef.current) return false;
      setError(`加载快照列表失败：${errorMessage(caught)}`);
      return false;
    } finally {
      if (requestId === listRequestIdRef.current) {
        listPendingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing view identity cancels pending previews, even if the request callback outlives the view.
  useEffect(() => {
    setPreviewTarget(null);
    setPreviewData(null);
    setPreviewLoading(false);
    return () => {
      previewRequestIdRef.current += 1;
    };
  }, [open, active, patentId, selectedPatentId]);

  useEffect(() => {
    if (!open) return;
    setSelectedPatentId(patentId ?? null);
  }, [open, patentId]);

  useEffect(() => {
    if (!open || !active) return;
    void loadEntries(true);
    return () => {
      listRequestIdRef.current += 1;
      listPendingRef.current = false;
    };
  }, [open, active, loadEntries]);

  useEffect(() => {
    if (!open || !active || busy || nestedDialogOpen) return;
    let cancelled = false;
    let timer: number;
    const refresh = () => {
      if (!listPendingRef.current && document.visibilityState !== "hidden")
        void loadEntries(true, true);
    };
    const check = async () => {
      try {
        if (document.visibilityState !== "hidden" && !listPendingRef.current) {
          const result = await window.patentApi.snapshot.status();
          if (cancelled) return;
          if (!result.ok) setError(formatAppError(result.error));
          else if (result.value.lastAutomaticSnapshotAt !== lastAutomaticSnapshotRef.current) {
            if (await loadEntries(true, true))
              lastAutomaticSnapshotRef.current = result.value.lastAutomaticSnapshotAt;
          }
        }
      } catch (caught) {
        if (!cancelled) setError(`检查快照更新失败：${errorMessage(caught)}`);
      } finally {
        if (!cancelled) timer = window.setTimeout(check, 3000);
      }
    };
    timer = window.setTimeout(check, 3000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open, active, busy, nestedDialogOpen, loadEntries]);

  const patentGroups = useMemo(() => {
    const groups = new Map<string, PatentGroup>();
    for (const entry of entries) {
      if (patentId && entry.documentId !== patentId) continue;
      if (entry.documentType !== "patent") continue;
      const group = groups.get(entry.documentId);
      if (group) {
        group.versions.push(entry);
        if (entry.createdAt > group.latestAt) group.latestAt = entry.createdAt;
      } else {
        groups.set(entry.documentId, {
          displayName: entry.displayName,
          latestAt: entry.createdAt,
          versions: [entry],
        });
      }
    }
    for (const patent of libraryPatents) {
      if (patentId && patent.patentId !== patentId) continue;
      if (!groups.has(patent.patentId))
        groups.set(patent.patentId, {
          displayName: patent.name ?? "未命名专利",
          latestAt: patent.modifiedAt,
          versions: [],
        });
    }
    for (const group of groups.values()) {
      group.versions.sort((left, right) => right.revision - left.revision);
    }
    return groups;
  }, [entries, libraryPatents, patentId]);

  const sortedPatents = useMemo(
    () =>
      [...patentGroups.entries()].sort(([, left], [, right]) =>
        right.latestAt.localeCompare(left.latestAt),
      ),
    [patentGroups],
  );
  const selectedPatent = selectedPatentId ? (patentGroups.get(selectedPatentId) ?? null) : null;
  const isFirstLevel = selectedPatent === null;
  useSpatialViewMotion(listRef, selectedPatentId ?? "list");

  async function handleManualCreate() {
    if (!selectedPatentId) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    setOperationWarnings([]);
    try {
      if (!prepareSnapshot || !(await prepareSnapshot(selectedPatentId))) {
        setError("最新修改尚未保存，未创建快照。请先完成保存后重试。");
        return;
      }
      const result = await window.patentApi.snapshot.create({
        documentType: "patent",
        documentId: selectedPatentId,
        source: "manual-create",
      });
      if (!result.ok) {
        setError(formatAppError(result.error));
        return;
      }
      const refreshed = await loadEntries(true);
      setSuccess({
        message:
          result.value.outcome === "already-exists"
            ? "当前修订已有快照，已通过完整性校验。"
            : "当前版本快照已创建并通过完整性校验。",
      });
      if (!refreshed)
        setOperationWarnings(["快照已创建，但列表刷新失败；重新打开管理器即可重试读取。"]);
    } catch (caught) {
      setError(`创建快照失败：${errorMessage(caught)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    if (!restoreTarget) return;
    setBusy(true);
    setError(null);
    setOperationWarnings([]);
    try {
      const result = await (restore ?? window.patentApi.snapshot.restore)({
        documentType: restoreTarget.documentType,
        documentId: restoreTarget.documentId,
        revision: restoreTarget.revision,
      });
      if (!result.ok) {
        if (result.error.code !== "CANCELLED") setError(formatAppError(result.error));
        return;
      }
      setRestoreTarget(null);
      setSuccess({
        message: `恢复副本已创建：“${result.value.displayName}”。原专利没有被覆盖。`,
      });
      setOperationWarnings(result.value.warning ? [result.value.warning] : []);
      try {
        await onRestored(result.value.documentId);
      } catch (caught) {
        setError(`恢复副本已创建，但专利库刷新失败：${errorMessage(caught)}`);
      }
    } catch (caught) {
      setError(`恢复快照失败：${errorMessage(caught)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.patentApi.snapshot.delete({
        documentType: deleteTarget.documentType,
        documentId: deleteTarget.documentId,
        revision: deleteTarget.revision,
      });
      if (!result.ok) {
        setError(formatAppError(result.error));
        return;
      }
      setDeleteTarget(null);
      const refreshed = await loadEntries(true);
      setSuccess({ message: `快照 v${deleteTarget.revision} 已永久删除。` });
      setOperationWarnings([
        ...(result.value.cleanupError
          ? [`快照已删除，未使用资源尚未清理，将在后续维护时重试：${result.value.cleanupError}`]
          : []),
        ...(!refreshed ? ["快照已删除，但列表刷新失败；重新打开管理器即可重试读取。"] : []),
      ]);
    } catch (caught) {
      setError(`删除快照失败：${errorMessage(caught)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handlePreview(entry: SnapshotEntry, origin: HTMLButtonElement) {
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    previewOriginRef.current = origin;
    setPreviewTarget(entry);
    setPreviewData(null);
    setPreviewLoading(true);
    setError(null);
    try {
      const result = await window.patentApi.snapshot.preview({
        documentType: "patent",
        documentId: entry.documentId,
        revision: entry.revision,
      });
      if (previewRequestIdRef.current !== requestId) return;
      if (!result.ok) {
        setError(formatAppError(result.error));
        setPreviewTarget(null);
        return;
      }
      setPreviewData(result.value);
      onPreview?.(result.value, entry.documentId, entry.status === "resource-missing");
    } catch (caught) {
      if (previewRequestIdRef.current !== requestId) return;
      setError(`加载内容预览失败：${errorMessage(caught)}`);
      setPreviewTarget(null);
    } finally {
      if (previewRequestIdRef.current === requestId) setPreviewLoading(false);
    }
  }

  function closePreview() {
    previewRequestIdRef.current += 1;
    setPreviewTarget(null);
    setPreviewData(null);
    previewOriginRef.current?.focus();
  }

  if (!open) return null;

  const visibleWarnings = [
    ...listWarnings.map((warning) => `${warning.displayName}：${warning.message}`),
    ...operationWarnings,
  ];
  const surfaceProps = embedded
    ? { role: "region" as const, "aria-label": "快照管理器" }
    : {
        role: "dialog" as const,
        "aria-modal": true,
        "aria-labelledby": "snapshot-manager-title",
      };

  return (
    <div
      className={embedded ? "snapshot-manager--embedded settings-page" : undefined}
      style={embedded ? embeddedOverlayStyle : overlayStyle}
    >
      {!embedded ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => {
            if (isFirstLevel && !nestedDialogOpen) onClose();
          }}
          style={{ position: "absolute", inset: 0, border: 0, background: "transparent" }}
        />
      ) : null}
      <div
        ref={dialogRef}
        className={embedded ? "snapshot-manager__card settings-page__card" : undefined}
        {...surfaceProps}
        tabIndex={-1}
        style={embedded ? embeddedDialogStyle : dialogStyle}
      >
        <header style={{ padding: "22px 24px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            {!isFirstLevel ? (
              <button
                type="button"
                onClick={() => {
                  setSelectedPatentId(null);
                  setPreviewTarget(null);
                  setPreviewData(null);
                }}
                style={secondaryButtonStyle}
              >
                ← 返回
              </button>
            ) : null}
            {!embedded || !isFirstLevel ? (
              <h2 id="snapshot-manager-title" style={{ margin: 0, fontSize: 18, flex: 1 }}>
                {isFirstLevel ? "快照管理器" : selectedPatent.displayName}
              </h2>
            ) : null}
            {!isFirstLevel && !recoveryReadOnly && !recoveryContext ? (
              <button
                type="button"
                onClick={() => void handleManualCreate()}
                disabled={busy}
                style={primaryButtonStyle(busy)}
              >
                {busy ? "处理中…" : "立即创建快照"}
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy || loading}
              onClick={() => void loadEntries(true)}
              style={secondaryButtonStyle}
            >
              刷新列表
            </button>
          </div>
          <p style={{ fontSize: 12, lineHeight: 1.6, color: "#4b5563", margin: "0 0 14px" }}>
            {isFirstLevel
              ? recoveryContext
                ? "选择专利和历史版本，预览后恢复为新副本；没有可用快照时可改用定时备份。"
                : "选择专利查看历史或创建快照。快照按时间定期记录，不会为每次编辑单独创建。"
              : `共 ${selectedPatent.versions.length} 个版本。最近 1 小时全部保留；1～24 小时每小时 2 个；1～7 天每天 2 个；7 天～1 个月每周 2 个；1 个月～1 年每月 2 个；超过 1 年每年 2 个。自动整理会额外保留最近的有效恢复点；损坏历史暂停整理，最后一个有效恢复点不能手动删除。`}
          </p>
        </header>

        <main
          ref={listRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: embedded ? "visible" : "auto",
            padding: embedded ? "0 0 20px" : "0 24px 20px",
          }}
        >
          <MotionPresence>
            {error ? <Message role="alert" tone="error" text={error} /> : null}
          </MotionPresence>
          <SpatialPresence>
            {success ? (
              <div role="status" style={successStyle}>
                <span>{success.message}</span>
              </div>
            ) : null}
          </SpatialPresence>
          {
            <SpatialPresence>
              {visibleWarnings.length > 0 ? (
                <div role="alert" style={warningStyle}>
                  <strong>部分操作需要注意：</strong>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                    {visibleWarnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </SpatialPresence>
          }

          {
            <SpatialPresence>
              {loading ? (
                <p style={{ color: "#4b5563", fontSize: 13 }}>正在读取快照历史…</p>
              ) : isFirstLevel ? (
                sortedPatents.length === 0 ? (
                  <div
                    className={embedded ? "snapshot-manager__empty" : undefined}
                    style={emptyStyle}
                  >
                    <strong>{embedded ? "暂无快照版本" : "当前没有可显示的专利快照"}</strong>
                    {!embedded ? (
                      <span>
                        新建专利会自动保留初始版本；已有专利可在这里手动创建当前版本快照。
                      </span>
                    ) : null}
                  </div>
                ) : (
                  sortedPatents.map(([patentId, group]) => (
                    <button
                      key={patentId}
                      type="button"
                      aria-label={`打开“${group.displayName}”的快照历史`}
                      onClick={() => setSelectedPatentId(patentId)}
                      className={embedded ? "snapshot-manager__patent-row" : undefined}
                      style={patentButtonStyle}
                    >
                      <span>
                        <span
                          style={{
                            display: "block",
                            fontSize: 14,
                            fontWeight: 600,
                            color: "#1f2937",
                          }}
                        >
                          {group.displayName}
                        </span>
                        <span
                          style={{ display: "block", fontSize: 12, color: "#4b5563", marginTop: 3 }}
                        >
                          {group.versions.length > 0
                            ? `最新：${formatTime(group.latestAt)}`
                            : "暂无快照，可立即创建"}
                        </span>
                      </span>
                      <span style={{ fontSize: 12, color: "#374151" }}>
                        {group.versions.length} 个版本　→
                      </span>
                    </button>
                  ))
                )
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {selectedPatent.versions.length === 0 ? (
                    <p>暂无快照，点击“立即创建快照”保存当前版本。</p>
                  ) : null}
                  {selectedPatent.versions.map((entry) => {
                    const restoreDisabled = busy || entry.status !== "healthy";
                    const deleteDisabled = recoveryReadOnly || busy || !entry.deletable;
                    return (
                      <article
                        key={`${entry.documentId}-${entry.revision}`}
                        className={embedded ? "snapshot-manager__version-row" : undefined}
                        style={versionCardStyle}
                      >
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "70px minmax(150px, 1fr) 100px 90px auto",
                            gap: 10,
                            alignItems: "center",
                          }}
                        >
                          <strong>v{entry.revision}</strong>
                          <span style={{ fontSize: 12, color: "#4b5563" }}>
                            {formatTime(entry.createdAt)}
                            <span style={{ display: "block", marginTop: 3 }}>
                              {sourceLabel(entry.source)}
                            </span>
                          </span>
                          <span style={{ fontSize: 12, color: statusColor(entry.status) }}>
                            {statusLabel(entry.status)}
                          </span>
                          <span style={{ fontSize: 12, color: "#4b5563" }}>
                            {formatBytes(entry.sizeBytes)}
                          </span>
                          <span
                            style={{
                              display: "flex",
                              justifyContent: "flex-end",
                              gap: 6,
                              flexWrap: "wrap",
                            }}
                          >
                            {entry.status !== "damaged" ? (
                              <button
                                type="button"
                                aria-label={`查看 v${entry.revision} 内容预览`}
                                onClick={(event) => void handlePreview(entry, event.currentTarget)}
                                style={secondaryButtonStyle}
                              >
                                内容预览
                              </button>
                            ) : null}
                            <button
                              type="button"
                              aria-label={`恢复 v${entry.revision}`}
                              onClick={() => setRestoreTarget(entry)}
                              disabled={restoreDisabled}
                              style={outlineActionStyle("#2563eb", restoreDisabled)}
                            >
                              恢复
                            </button>
                            <button
                              type="button"
                              aria-label={`删除 v${entry.revision}`}
                              onClick={() => setDeleteTarget(entry)}
                              disabled={deleteDisabled}
                              style={outlineActionStyle("#b91c1c", deleteDisabled)}
                            >
                              删除
                            </button>
                          </span>
                        </div>
                        {
                          <SpatialPresence>
                            {entry.errorMessage ? (
                              <p style={{ margin: "8px 0 0", color: "#b91c1c", fontSize: 12 }}>
                                {entry.errorMessage}
                              </p>
                            ) : null}
                          </SpatialPresence>
                        }
                        {
                          <SpatialPresence>
                            {!entry.deletable ? (
                              <p style={{ margin: "6px 0 0", color: "#4b5563", fontSize: 12 }}>
                                最后一个可恢复到当前内容的有效快照，暂不可删除。完成后续修改并生成新的有效快照后，可再删除此版本。
                              </p>
                            ) : null}
                          </SpatialPresence>
                        }
                      </article>
                    );
                  })}
                </div>
              )}
            </SpatialPresence>
          }
        </main>

        {!embedded ? (
          <footer style={{ padding: "0 24px 18px", textAlign: "right", flexShrink: 0 }}>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              style={secondaryButtonStyle}
            >
              关闭
            </button>
          </footer>
        ) : null}
        <MotionPresence>
          {restoreTarget !== null ? (
            <ConfirmationDialog
              open
              title="恢复快照"
              confirmLabel="确认恢复"
              busy={busy}
              onCancel={() => setRestoreTarget(null)}
              onConfirm={() => void handleRestore()}
            >
              <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                将根据版本 v{restoreTarget.revision}（{formatTime(restoreTarget.createdAt)}
                ）创建一个新的专利副本。
              </p>
              <p style={{ margin: 0, color: "#b91c1c", fontSize: 13 }}>
                原专利不会被覆盖。恢复副本创建完成后，可单独打开检查。
              </p>
            </ConfirmationDialog>
          ) : null}
        </MotionPresence>

        <MotionPresence>
          {deleteTarget !== null ? (
            <ConfirmationDialog
              open
              title="永久删除快照"
              confirmLabel="确认删除"
              busy={busy}
              onCancel={() => setDeleteTarget(null)}
              onConfirm={() => void handleDelete()}
            >
              <p style={{ margin: 0, color: "#b91c1c", fontSize: 13 }}>
                快照 v{deleteTarget.revision} 将被永久删除，且无法撤销。原专利内容不会改变。
              </p>
            </ConfirmationDialog>
          ) : null}
        </MotionPresence>
      </div>

      <SpatialPresence>
        {previewTarget && previewLoading && onPreview ? (
          <p role="status" style={{ margin: 0, fontSize: 13 }}>
            正在生成五书内容预览…
          </p>
        ) : null}
      </SpatialPresence>
      <MotionPresence>
        {previewTarget && previewLoading && !onPreview ? (
          <SnapshotPreviewLoadingDialog revision={previewTarget.revision} onClose={closePreview} />
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {previewTarget && previewData && !onPreview ? (
          <SnapshotContentPreviewDialog
            preview={previewData}
            documentId={previewTarget.documentId}
            resourceMissing={previewTarget.status === "resource-missing"}
            onClose={closePreview}
          />
        ) : null}
      </MotionPresence>
    </div>
  );
}

function SnapshotPreviewLoadingDialog({
  revision,
  onClose,
}: {
  revision: number;
  onClose(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <StandardDialog
      open
      title={`v${revision} 内容预览`}
      size="s"
      onCancel={onClose}
      closeLabel="关闭内容预览"
      initialFocusRef={cancelRef}
      footer={
        <button ref={cancelRef} type="button" aria-label="取消内容预览" onClick={onClose}>
          取消
        </button>
      }
    >
      <p>正在生成五书内容预览…</p>
    </StandardDialog>
  );
}

function ConfirmationDialog({
  open,
  title,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children: React.ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <StandardDialog
      open={open}
      title={title}
      size="s"
      dialogRole="alertdialog"
      onCancel={onCancel}
      closeDisabled={busy}
      initialFocusRef={cancelRef}
      footer={
        <>
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="standard-dialog__danger-button"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "处理中…" : confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </StandardDialog>
  );
}

function Message({ role, tone, text }: { role: "alert"; tone: "error"; text: string }) {
  return (
    <div role={role} style={tone === "error" ? errorStyle : warningStyle}>
      {text}
    </div>
  );
}

function formatAppError(error: AppError): string {
  return `${error.message}${error.nextAction ? ` ${error.nextAction}` : ""}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN");
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceLabel(source: SnapshotEntry["source"]): string {
  const labels: Record<SnapshotEntry["source"], string> = {
    initial: "初始版本",
    automatic: "自动快照",
    "manual-save": "手动保存",
    "manual-create": "手动快照",
    "patent-close": "关闭专利",
    "application-close": "退出软件",
    historical: "历史版本",
  };
  return labels[source];
}

function statusLabel(status: SnapshotEntry["status"]): string {
  if (status === "healthy") return "正常";
  if (status === "resource-missing") return "资源缺失";
  return "损坏";
}

function statusColor(status: SnapshotEntry["status"]): string {
  return status === "healthy" ? "#166534" : "#b91c1c";
}

const overlayStyle = {
  position: "fixed",
  inset: 0,
  zIndex: 1001,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  backgroundColor: "rgba(0,0,0,0.3)",
} as const;
const embeddedOverlayStyle = {
  position: "relative",
  width: "100%",
} as const;
const dialogStyle = {
  position: "relative",
  backgroundColor: "#fff",
  borderRadius: 8,
  boxShadow: "0 4px 24px rgba(0,0,0,0.18)",
  width: "min(820px, calc(100vw - 32px))",
  maxHeight: "calc(100vh - 32px)",
  display: "flex",
  flexDirection: "column",
} as const;
const embeddedDialogStyle = {
  position: "relative",
  width: "100%",
  display: "flex",
  flexDirection: "column",
} as const;
const secondaryButtonStyle = {
  padding: "5px 10px",
  border: "1px solid #c7cdd4",
  borderRadius: 4,
  backgroundColor: "#fff",
  color: "#374151",
  cursor: "pointer",
  fontSize: 12,
} as const;
const patentButtonStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  width: "100%",
  padding: "12px 16px",
  marginBottom: 8,
  border: "1px solid #dfe3e8",
  borderRadius: 6,
  cursor: "pointer",
  backgroundColor: "#fafafa",
  textAlign: "left",
  font: "inherit",
} as const;
const versionCardStyle = {
  padding: 12,
  overflowX: "auto",
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  backgroundColor: "#fff",
} as const;
const errorStyle = {
  color: "#b91c1c",
  backgroundColor: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 6,
  padding: 10,
  fontSize: 13,
  marginBottom: 10,
} as const;
const warningStyle = {
  color: "#92400e",
  backgroundColor: "#fffbeb",
  border: "1px solid #fde68a",
  borderRadius: 6,
  padding: 10,
  fontSize: 13,
  marginBottom: 10,
} as const;
const successStyle = {
  color: "#166534",
  backgroundColor: "#f0fdf4",
  border: "1px solid #bbf7d0",
  borderRadius: 6,
  padding: 10,
  fontSize: 13,
  marginBottom: 10,
} as const;
const emptyStyle = {
  display: "grid",
  gap: 8,
  minHeight: 300,
  boxSizing: "border-box",
  alignContent: "center",
  textAlign: "center",
  background: "#fbfcfe",
  justifyItems: "center",
  color: "#4b5563",
  padding: "44px 20px",
  border: "1px dashed #cbd5e1",
  borderRadius: 10,
  fontSize: 13,
} as const;

function outlineActionStyle(color: string, disabled: boolean) {
  return {
    ...secondaryButtonStyle,
    borderColor: disabled ? "#d1d5db" : color,
    color: disabled ? "#9ca3af" : color,
    backgroundColor: disabled ? "#f3f4f6" : "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function primaryButtonStyle(disabled: boolean) {
  return {
    ...secondaryButtonStyle,
    borderColor: disabled ? "#9ca3af" : "#2563eb",
    backgroundColor: disabled ? "#9ca3af" : "#2563eb",
    color: "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
