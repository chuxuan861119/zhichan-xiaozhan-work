import { useCallback, useEffect, useRef, useState } from "react";
import type { BackupEntry } from "../../../shared/backup/model";
import type { AppError } from "../../../shared/ipc/result";
import { MotionPresence } from "../app/motion-presence";
import { DialogCloseIcon } from "../shared/dialog-close-icon";
import { SpatialPresence } from "../shared/spatial-presence";
import { StandardDialog } from "../shared/standard-dialog";
import { useModalDialog } from "../shared/use-modal-dialog";

type BackupManagerProps = {
  open: boolean;
  onClose: () => void;
  onRestored: () => unknown | Promise<unknown>;
  embedded?: boolean;
  recoveryReadOnly?: boolean;
  recoveryContext?: boolean;
  restore?: typeof window.patentApi.backup.restore;
  onOpenSettings?: () => void;
};

export function BackupManager({
  open,
  onClose,
  onRestored,
  embedded = false,
  recoveryReadOnly = false,
  recoveryContext = false,
  restore,
  onOpenSettings,
}: BackupManagerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [entries, setEntries] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<{ action: "restore" | "delete"; fileName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  useModalDialog({
    open: open && !embedded,
    onClose: () => {
      if (!busy) onClose();
    },
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
  });

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await window.patentApi.backup.list();
      if (result.ok) {
        setEntries(result.value);
      } else {
        setEntries([]);
        setError(formatAppError(result.error));
      }
    } catch (caught) {
      setEntries([]);
      setError(`加载备份列表失败：${errorMessage(caught)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) loadEntries();
  }, [open, loadEntries]);

  async function handleRestore(fileName: string) {
    setBusy({ action: "restore", fileName });
    setError(null);
    setSuccess(null);
    let restoredDisplayName: string | null = null;
    try {
      const result = await (restore ?? window.patentApi.backup.restore)(fileName);
      if (result.ok) {
        restoredDisplayName = result.value.displayName;
      } else {
        if (result.error.code !== "CANCELLED")
          setError(`恢复失败：${formatAppError(result.error)}`);
      }
    } catch (caught) {
      setError(`恢复失败：${errorMessage(caught)}`);
    }
    if (restoredDisplayName) {
      try {
        await onRestored();
        await loadEntries();
        setSuccess(`已恢复“${restoredDisplayName}”，专利库已刷新。`);
      } catch {
        setError(null);
        setSuccess(
          `已恢复“${restoredDisplayName}”，但专利库刷新失败，请手动刷新或重新打开专利库。`,
        );
      }
    }
    setBusy(null);
  }

  async function handleDelete(fileName: string) {
    setBusy({ action: "delete", fileName });
    setError(null);
    try {
      const result = await window.patentApi.backup.delete(fileName);
      if (result.ok) {
        setDeleteTarget(null);
        await loadEntries();
      } else setError(`删除失败：${formatAppError(result.error)}`);
    } catch (caught) {
      setError(`删除失败：${errorMessage(caught)}`);
    } finally {
      setBusy(null);
    }
  }

  if (!open) return null;
  const surfaceProps = embedded
    ? { role: "region" as const, "aria-label": "备份管理器" }
    : {
        role: "dialog" as const,
        "aria-modal": true,
        "aria-labelledby": "backup-manager-title",
      };

  return (
    <div
      className={embedded ? "backup-manager--embedded settings-page" : undefined}
      style={embedded ? embeddedRootStyle : overlayStyle}
    >
      {!embedded ? (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.3)", border: 0 }}
          onClick={() => {
            if (!busy) onClose();
          }}
        />
      ) : null}
      <div
        ref={dialogRef}
        className={
          embedded
            ? "settings-page__card backup-manager__card"
            : "backup-manager__card dialog-with-standard-close"
        }
        {...surfaceProps}
        tabIndex={-1}
        style={embedded ? embeddedPanelStyle : dialogStyle}
      >
        {!embedded ? (
          <button
            type="button"
            className="dialog-close-button dialog-close-button--corner dialog-close-control"
            aria-label="关闭备份管理器"
            onClick={onClose}
            disabled={busy !== null}
          >
            <DialogCloseIcon />
          </button>
        ) : null}
        {!embedded ? (
          <h2
            id="backup-manager-title"
            style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}
          >
            备份管理器
          </h2>
        ) : null}

        {
          <SpatialPresence>
            {error && (
              <div role="alert" style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>
                {error}
              </div>
            )}
          </SpatialPresence>
        }
        {
          <SpatialPresence>
            {success ? (
              <div role="status" style={{ color: "#15803d", fontSize: 13, marginBottom: 12 }}>
                {success}
              </div>
            ) : null}
          </SpatialPresence>
        }

        {
          <SpatialPresence>
            {loading ? (
              <p style={{ color: "#666", fontSize: 13 }}>加载中...</p>
            ) : error ? null : entries.length === 0 ? (
              <div className="backup-manager__empty">
                <strong>
                  {embedded ? "暂无备份文件" : "暂无备份文件。请先在「定时备份」中启用定时备份。"}
                </strong>
                {recoveryContext ? (
                  <p>
                    没有找到已有备份。新启用定时备份不能补回过去的内容，请选择其他已有的 PATDOC
                    文件。
                  </p>
                ) : embedded ? (
                  <p>启用定时备份后，备份文件会显示在这里。</p>
                ) : null}
                <div className="settings-page__actions">
                  {onOpenSettings ? (
                    <button
                      type="button"
                      className="settings-action-button"
                      onClick={onOpenSettings}
                    >
                      设置定时备份
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={loading || busy !== null}
                    onClick={() => void loadEntries()}
                    style={footerButtonStyle}
                  >
                    刷新
                  </button>
                </div>
              </div>
            ) : (
              <div className={embedded ? "backup-manager__list-scroll" : undefined}>
                <table
                  className={embedded ? "backup-manager__list" : undefined}
                  style={{
                    width: "100%",
                    borderCollapse: "separate",
                    borderSpacing: 0,
                    fontSize: 13,
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: "2px solid #eee", textAlign: "left" }}>
                      <th style={{ padding: "8px 4px" }}>文档名</th>
                      <th style={{ padding: "8px 4px" }}>类型</th>
                      <th style={{ padding: "8px 4px" }}>大小</th>
                      <th style={{ padding: "8px 4px" }}>备份时间</th>
                      <th style={{ padding: "8px 4px", width: 140 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.fileName} style={{ borderBottom: "1px solid #eee" }}>
                        <td
                          style={{
                            padding: "6px 4px",
                            maxWidth: 160,
                          }}
                        >
                          <div
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {entry.displayName}
                          </div>
                          {entry.revision !== null ? (
                            <div style={{ color: "#64748b", fontSize: 11, marginTop: 2 }}>
                              版本 {entry.revision}
                            </div>
                          ) : null}
                          {entry.errorMessage ? (
                            <div style={{ color: "#dc2626", fontSize: 11, marginTop: 2 }}>
                              {entry.errorMessage}
                            </div>
                          ) : null}
                        </td>
                        <td style={{ padding: "6px 4px" }}>
                          {entry.status === "damaged"
                            ? "损坏"
                            : !entry.managed
                              ? "外部 PATDOC"
                              : entry.documentType === "patent"
                                ? "专利自动备份"
                                : "文档自动备份"}
                        </td>
                        <td style={{ padding: "6px 4px", color: "#666" }}>
                          {entry.sizeBytes > 1024 * 1024
                            ? `${(entry.sizeBytes / 1024 / 1024).toFixed(1)} MB`
                            : `${(entry.sizeBytes / 1024).toFixed(0)} KB`}
                        </td>
                        <td style={{ padding: "6px 4px", color: "#666", fontSize: 12 }}>
                          {new Date(entry.backedUpAt).toLocaleString("zh-CN")}
                        </td>
                        <td style={{ padding: "6px 4px", display: "flex", gap: 6 }}>
                          <button
                            type="button"
                            disabled={busy !== null || loading || entry.status === "damaged"}
                            title={entry.errorMessage ?? ""}
                            onClick={() => handleRestore(entry.fileName)}
                            style={{
                              padding: "2px 8px",
                              border: "1px solid #2563eb",
                              borderRadius: 3,
                              backgroundColor: "#fff",
                              color: "#2563eb",
                              cursor:
                                busy !== null || loading || entry.status === "damaged"
                                  ? "not-allowed"
                                  : "pointer",
                              fontSize: 12,
                            }}
                          >
                            {busy?.action === "restore" && busy.fileName === entry.fileName
                              ? "恢复中..."
                              : "恢复"}
                          </button>
                          <button
                            type="button"
                            disabled={
                              recoveryReadOnly || busy !== null || loading || !entry.managed
                            }
                            title={entry.managed ? "" : "外部 PATDOC 不由本软件删除"}
                            onClick={() => setDeleteTarget(entry.fileName)}
                            style={{
                              padding: "2px 8px",
                              border: "1px solid #dc2626",
                              borderRadius: 3,
                              backgroundColor: "#fff",
                              color: "#dc2626",
                              cursor:
                                busy === null && !loading && entry.managed
                                  ? "pointer"
                                  : "not-allowed",
                              opacity: busy === null && !loading && entry.managed ? 1 : 0.5,
                              fontSize: 12,
                            }}
                          >
                            {busy?.action === "delete" && busy.fileName === entry.fileName
                              ? "删除中..."
                              : "删除"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SpatialPresence>
        }

        {loading || error || entries.length > 0 ? (
          <div className="backup-manager__actions">
            <button
              type="button"
              disabled={loading || busy !== null}
              onClick={() => void loadEntries()}
              style={footerButtonStyle}
            >
              刷新
            </button>
            {!embedded ? (
              <button
                ref={closeButtonRef}
                type="button"
                disabled={busy !== null}
                onClick={onClose}
                style={footerButtonStyle}
              >
                关闭
              </button>
            ) : null}
          </div>
        ) : null}
        <MotionPresence>
          {deleteTarget !== null ? (
            <BackupDeleteConfirmation
              open
              busy={busy !== null}
              onCancel={() => setDeleteTarget(null)}
              onConfirm={() => void handleDelete(deleteTarget)}
            />
          ) : null}
        </MotionPresence>
      </div>
    </div>
  );
}

function BackupDeleteConfirmation({
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <StandardDialog
      open={open}
      title="永久删除备份"
      size="s"
      dialogRole="alertdialog"
      onCancel={onCancel}
      closeDisabled={busy}
      initialFocusRef={cancelRef}
      footer={
        <>
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="standard-dialog__danger-button"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "删除中..." : "确认删除"}
          </button>
        </>
      }
    >
      <p className="standard-dialog__danger-message">确定要永久删除这份备份吗？此操作无法撤销。</p>
    </StandardDialog>
  );
}

function formatAppError(error: AppError): string {
  return `${error.message}${error.nextAction ? ` ${error.nextAction}` : ""}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "未知错误";
}

const footerButtonStyle = {
  padding: "6px 16px",
  border: "1px solid #ccc",
  borderRadius: 4,
  backgroundColor: "#fff",
  cursor: "pointer",
  fontSize: 13,
} as const;
const overlayStyle = {
  position: "fixed",
  inset: 0,
  zIndex: 1001,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
} as const;
const embeddedRootStyle = { position: "relative", width: "100%" } as const;
const dialogStyle = {
  position: "relative",
  backgroundColor: "#fff",
  borderRadius: 8,
  boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
  width: 640,
  maxHeight: "80vh",
  overflow: "auto",
  padding: 24,
} as const;
const embeddedPanelStyle = { position: "relative", width: "100%" } as const;
