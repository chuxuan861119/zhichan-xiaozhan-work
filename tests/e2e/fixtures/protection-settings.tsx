import { createRoot } from "react-dom/client";
import { DataSafetyDialog } from "../../../src/renderer/src/settings/data-safety-dialog";
import type { PatentApi } from "../../../src/shared/ipc/contract";
import { DEFAULT_APP_SETTINGS } from "../../../src/shared/settings/model";
import "../../../src/renderer/src/app/app.css";

const time = "2026-09-11T04:36:24.000Z";
const section = new URLSearchParams(location.search).has("snapshot") ? "snapshot" : "backup";
window.patentApi = {
  settings: {
    read: async () => ({
      ok: true,
      value: {
        ...DEFAULT_APP_SETTINGS,
        backup: { ...DEFAULT_APP_SETTINGS.backup, enabled: true, folder: "D:\\专利备份" },
      },
    }),
  },
  backup: {
    status: async () => ({
      ok: true,
      value: {
        enabled: true,
        folder: "D:\\专利备份",
        intervalMinutes: 5,
        lastBackupAt: time,
        lastAttemptAt: time,
        nextBackupAt: time,
        lastRunSuccessCount: 2,
        lastRunFailureCount: 0,
        lastError: null,
      },
    }),
  },
  snapshot: {
    status: async () => ({
      ok: true,
      value: {
        enabled: true,
        intervalMinutes: 5,
        openPatentCount: 1,
        lastCheckAt: time,
        lastAutomaticSnapshotAt: time,
        nextCheckAt: time,
        lastError: null,
      },
    }),
  },
} as unknown as PatentApi;

createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", display: "grid", placeItems: "center" }}>
    <div className="application-settings-dialog__surface application-settings-dialog__surface--workspace">
      <header className="application-settings-dialog__header">
        <h2>设置</h2>
      </header>
      <div className="application-settings-dialog__body application-settings-dialog__body--workspace">
        <nav className="settings-workspace-navigation">定时备份 / 快照设置</nav>
        <section className="settings-workspace-content application-settings-dialog__content settings-workspace-content--protection">
          <div className="settings-workspace-content__header">
            <h3>{section === "backup" ? "定时备份" : "快照设置"}</h3>
          </div>
          <div className="settings-workspace-content__route">
            <div>
              <DataSafetyDialog embedded open section={section} onClose={() => {}} />
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>,
);
