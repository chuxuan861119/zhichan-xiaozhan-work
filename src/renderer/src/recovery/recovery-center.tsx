import { useRef, useState } from "react";
import type {
  PreparedRecovery,
  RecoverySource,
} from "../../../shared/recovery/self-service-recovery";
import type { StartupRecoveryReport } from "../../../shared/recovery/startup-recovery";
import type { SnapshotContentPreview } from "../../../shared/snapshot/model";
import { BackupManager } from "../settings/backup-manager";
import { SnapshotManager } from "../settings/snapshot-manager";
import { SnapshotContentPreviewDialog } from "../settings/snapshot-preview/snapshot-content-preview-dialog";
import { SpatialView } from "../shared/spatial-view";
import { StandardDialog } from "../shared/standard-dialog";
import "./recovery-center.css";

type Props = {
  report: StartupRecoveryReport | null;
  initialTab: "snapshots" | "backups";
  patentId?: string;
  onClose(): void;
  onRestored(id?: string): Promise<unknown>;
  onImportFile(): void;
};

export function RecoveryCenter({
  report,
  initialTab,
  patentId,
  onClose,
  onRestored,
  onImportFile,
}: Props) {
  const [tab, setTab] = useState(initialTab);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedRecovery | null>(null);
  const [preview, setPreview] = useState<{
    value: SnapshotContentPreview;
    id: string;
    missing: boolean;
  } | null>(null);
  const readOnly = report?.mode === "read-only";
  const snapshotsUnavailable =
    report?.recoverySourcesUnavailable || report?.dataImportRecovery === "manual-safe-recovery";
  const close = () => {
    if (!busyRef.current && !restarting) onClose();
  };
  async function prepare(source: RecoverySource) {
    const action = window.patentApi.application.prepareRecovery;
    if (!action) throw new Error("恢复服务尚未加载，请正常关闭后重新启动软件。");
    const result = await action(source);
    if (!result.ok)
      throw new Error(
        `${result.error.message} ${result.error.nextAction ?? "请选择其他快照或备份重试。"}`,
      );
    if (result.value) setPrepared(result.value);
    return result.value;
  }
  async function run<T>(action: () => Promise<T>): Promise<T> {
    if (busyRef.current) throw new Error("正在恢复，请稍候。");
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      return await action();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function chooseFile() {
    if (!readOnly) {
      close();
      onImportFile();
      return;
    }
    try {
      await run(() => prepare({ kind: "file" }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "恢复失败，请选择其他备份。");
    }
  }
  async function activate() {
    if (!prepared) return;
    try {
      await run(async () => {
        const action = window.patentApi.application.activateRecovery;
        if (!action) throw new Error("请重新启动后再试。");
        const result = await action(prepared.token);
        if (!result.ok)
          throw new Error(
            `${result.error.message} ${result.error.nextAction ?? "恢复副本仍保留，请重试。"}`,
          );
      });
      setRestarting(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "启用失败，恢复副本仍保留。");
    }
  }
  return (
    <StandardDialog
      open
      title="文档恢复"
      className="recovery-center"
      size="l"
      portal
      onCancel={close}
      closeDisabled={busy || restarting}
      footer={
        <>
          <button type="button" disabled={busy || restarting} onClick={close}>
            {prepared ? "保留副本，暂不切换" : "稍后处理"}
          </button>
          {prepared ? (
            <button
              type="button"
              className="primary-button"
              disabled={busy || restarting}
              onClick={() => void activate()}
            >
              {restarting ? "正在重启…" : "使用恢复库并重启"}
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void chooseFile()}>
              选择其他 PATDOC 备份
            </button>
          )}
        </>
      }
    >
      {error ? <p role="alert">{error}</p> : null}
      {prepared ? (
        <section role="status" aria-label="恢复副本已准备好">
          <h3>恢复副本已创建并通过检查</h3>
          <p>{prepared.displayName}</p>
          <p>保存位置：{prepared.libraryPath}</p>
          {prepared.sourceLibraryPath ? <p>原库保留位置：{prepared.sourceLibraryPath}</p> : null}
          <p>新库仅包含本次选中的恢复内容。原文档库及其他专利完整保留，没有覆盖或删除。</p>
          <p>选择“使用恢复库并重启”后，软件将打开新库。暂不切换也会保留已创建的副本。</p>
        </section>
      ) : (
        <>
          <p>
            优先选择快照并预览；没有可用快照时，再使用定时备份。恢复会创建新副本，原专利不会被覆盖。
          </p>
          {readOnly ? (
            <p>原库处于保护状态。选中的内容将恢复到独立的新库，校验成功后才允许切换。</p>
          ) : null}
          <div role="tablist" aria-label="恢复来源" className="recovery-center__tabs">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "snapshots"}
              disabled={busy}
              onClick={() => setTab("snapshots")}
            >
              快照版本
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "backups"}
              disabled={busy}
              onClick={() => setTab("backups")}
            >
              定时备份
            </button>
          </div>
          <SpatialView viewKey={tab}>
            {tab === "snapshots" ? (
              snapshotsUnavailable ? (
                <p>当前原库无法安全读取快照。请改用定时备份或其他 PATDOC 文件；原目录仍保留。</p>
              ) : (
                <SnapshotManager
                  embedded
                  open
                  {...(patentId ? { patentId } : {})}
                  recoveryReadOnly={readOnly}
                  recoveryContext
                  onClose={close}
                  onPreview={(value, id, missing) => setPreview({ value, id, missing })}
                  restore={(request) =>
                    run(async () => {
                      if (!readOnly) return window.patentApi.snapshot.restore(request);
                      const value = await prepare({
                        kind: "snapshot",
                        patentId: request.documentId,
                        revision: request.revision,
                      });
                      return value
                        ? {
                            ok: true,
                            value: {
                              documentType: "patent",
                              documentId: value.documentId,
                              displayName: value.displayName,
                            },
                          }
                        : {
                            ok: false,
                            error: { code: "CANCELLED", message: "已取消，原文档未改动。" },
                          };
                    })
                  }
                  onRestored={(id) => (readOnly ? undefined : onRestored(id))}
                />
              )
            ) : snapshotsUnavailable ? (
              <p>
                当前启动保护状态无法加载备份列表。请点击下方“选择其他 PATDOC
                备份”，从已设置的备份文件夹选择文件。
              </p>
            ) : (
              <BackupManager
                embedded
                open
                recoveryContext
                recoveryReadOnly={readOnly}
                onClose={close}
                restore={(fileName) =>
                  run(async () => {
                    if (!readOnly) return window.patentApi.backup.restore(fileName);
                    const value = await prepare({ kind: "backup", fileName });
                    return value
                      ? {
                          ok: true,
                          value: {
                            documentType: "patent",
                            documentId: value.documentId,
                            displayName: value.displayName,
                          },
                        }
                      : {
                          ok: false,
                          error: { code: "CANCELLED", message: "已取消，原文档未改动。" },
                        };
                  })
                }
                onRestored={() => (readOnly ? undefined : onRestored())}
              />
            )}
          </SpatialView>
          <p>
            没有可用快照或备份时，可选择其他已有的 PATDOC
            文件。未找到有效版本的内容无法保证恢复；原数据仍保留。
          </p>
        </>
      )}
      {preview ? (
        <SnapshotContentPreviewDialog
          preview={preview.value}
          documentId={preview.id}
          resourceMissing={preview.missing}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </StandardDialog>
  );
}
