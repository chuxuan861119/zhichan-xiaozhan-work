import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ApplicationCloseProvider } from "../../../src/renderer/src/app/application-close-coordinator";
import { ApplicationSettingsDialog } from "../../../src/renderer/src/settings/application-settings-dialog";
import { StandardDialog } from "../../../src/renderer/src/shared/standard-dialog";

window.patentApi = {
  application: { onPrepareClose: () => () => {}, closeResult: async () => ({ ok: true }) },
  patentTemplates: { readSummary: async () => ({ ok: false }) },
};
function Fixture() {
  const [settings, setSettings] = useState(false);
  const [print, setPrint] = useState(false);
  return (
    <ApplicationCloseProvider>
      <div style={{ position: "fixed", inset: 0, zIndex: 1, background: "#163c60" }}>
        <button type="button" onClick={() => setSettings(true)}>
          打开设置
        </button>
        <button type="button" onClick={() => setPrint(true)}>
          打开打印
        </button>
      </div>
      <ApplicationSettingsDialog open={settings} onClose={() => setSettings(false)} />
      <StandardDialog open={print} title="打印" onCancel={() => setPrint(false)}>
        打印内容
      </StandardDialog>
    </ApplicationCloseProvider>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
