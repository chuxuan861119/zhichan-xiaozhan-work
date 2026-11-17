import { isNetworkAiAvailable } from "../../../shared/platform";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  useApplicationCloseGuard,
  useApplicationPersistence,
} from "../app/application-close-coordinator";
import { MotionPresence } from "../app/motion-presence";
import { ExportWizard } from "../data-transfer/export-wizard";
import { ImportWizard } from "../data-transfer/import-wizard";
import { confirmAppAction } from "../shared/app-dialog";

type DataTransferSettingsProps = Readonly<{
  open: boolean;
}>;

export function DataTransferSettings({ open }: DataTransferSettingsProps) {
  const persistence = useApplicationPersistence();
  const pageRef = useRef<HTMLDivElement>(null);
  const activeExport = useRef<{
    cancel(): Promise<boolean>;
    finish(): void;
    task: Promise<void>;
  } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const transferApi = useMemo(() => {
    const api = window.patentApi.dataTransfer;
    return {
      ...api,
      exportPackage: (request: Parameters<typeof api.exportPackage>[0]) => {
        const task = api.exportPackage(request);
        let finish!: () => void;
        const operation = {
          cancel: async () => (await api.cancel(request.operationId)).ok,
          finish: () => finish(),
          task: new Promise<void>((resolve) => {
            finish = resolve;
          }),
        };
        activeExport.current?.finish();
        activeExport.current = operation;
        void task.then(
          () => {
            operation.finish();
            if (activeExport.current === operation) activeExport.current = null;
          },
          () => {
            operation.finish();
            if (activeExport.current === operation) activeExport.current = null;
          },
        );
        return task;
      },
    };
  }, []);

  const protectActiveExport = useCallback(async () => {
    const operation = activeExport.current;
    if (!operation) return true;
    const cancelAndExit = await confirmAppAction(
      "完整数据包仍在导出。\n\n选择“确定”将取消导出并退出；选择“取消”将继续导出。",
    );
    if (!cancelAndExit) return false;
    if (!(await operation.cancel())) return false;
    await operation.task;
    return true;
  }, []);

  useApplicationCloseGuard("full-data-export", protectActiveExport);

  const flushBeforeExport = useCallback(
    async (reason: "application-close" | "full-data-transfer") => {
      if (reason !== "full-data-transfer") return persistence.flushAll(reason);
      let cancelRequested = false;
      let finish!: () => void;
      const operation = {
        cancel: async () => {
          cancelRequested = true;
          return true;
        },
        finish: () => finish(),
        task: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      };
      activeExport.current = operation;
      const report = await persistence.flushAll(reason);
      if (!report.ok || cancelRequested) {
        operation.finish();
        if (activeExport.current === operation) activeExport.current = null;
      }
      if (report.ok && cancelRequested) {
        return { ok: false, failedParticipantIds: ["full-data-export"] };
      }
      return report;
    },
    [persistence],
  );

  if (!open) return null;

  return (
    <section className="data-transfer-settings--embedded settings-page" aria-label="数据迁移">
      <div ref={pageRef} className="data-transfer-settings__content">
        <p className="data-transfer-settings__intro">
          用于更换电脑、重装系统或搬迁整个专利库。完整数据包包含专利库和可移植设置，并使用单独的迁移密码加密。
        </p>
        <div className="data-transfer-settings__actions">
          <article aria-label="导出完整数据包" data-risk="routine">
            <div>
              <span>安全导出</span>
              <h4>导出完整数据包</h4>
              <p>创建加密迁移包，不会改变当前专利库。</p>
            </div>
            <button type="button" aria-label="导出完整数据包" onClick={() => setExportOpen(true)}>
              开始导出
            </button>
          </article>
          <article aria-label="导入完整数据包" data-risk="high">
            <div>
              <span>高风险操作</span>
              <h4>导入完整数据包</h4>
              <p>导入只允许在空专利库中进行；完成后需要重新启动软件。</p>
            </div>
            <button type="button" aria-label="导入完整数据包" onClick={() => setImportOpen(true)}>
              开始导入
            </button>
          </article>
        </div>
        <p className="settings-page__help data-transfer-settings__note">
          {isNetworkAiAvailable()
            ? "AI 密钥、备份目录和打印机等本机设置不会迁移。"
            : "备份目录和打印机等本机设置不会迁移。"}
        </p>
      </div>
      <MotionPresence>
        {exportOpen ? (
          <ExportWizard
            open
            api={transferApi}
            flushAll={flushBeforeExport}
            backgroundElement={pageRef.current}
            onClose={() => setExportOpen(false)}
          />
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {importOpen ? (
          <ImportWizard
            open
            api={transferApi}
            closeGuardRegistrar={persistence}
            onClose={() => setImportOpen(false)}
            onExportCurrent={() => {
              setImportOpen(false);
              setExportOpen(true);
            }}
          />
        ) : null}
      </MotionPresence>
    </section>
  );
}
