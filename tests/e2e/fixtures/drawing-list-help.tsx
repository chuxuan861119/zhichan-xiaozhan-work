import { createRoot } from "react-dom/client";
import { ToolActionTooltips } from "../../../src/renderer/src/shared/tool-action-tooltips";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../src/shared/settings/shortcuts";
import "../../../src/renderer/src/app/app.css";

const disabled = new URLSearchParams(location.search).has("disabled");
createRoot(document.getElementById("root")!).render(
  <>
    <div style={{ height: "100vh" }}>
      <aside
        className="patent-global-function-rail-slot"
        style={{ position: "fixed", right: 32, top: 100 }}
      >
        <section className="reference-mark-panel">
          <button
            type="button"
            className="reference-mark-panel__fill"
            disabled={disabled}
            title="旧提示"
          >
            填入说明书
          </button>
          <button
            type="button"
            className="reference-mark-panel__copy"
            disabled={disabled}
            title="旧提示"
          >
            复制
          </button>
        </section>
        <section className="drawing-explanation-rail">
          <button type="button" className="drawing-explanation-rail__fill" disabled={disabled}>
            填入说明书
          </button>
          <button type="button" className="drawing-explanation-rail__copy" disabled={disabled}>
            复制
          </button>
        </section>
      </aside>
    </div>
    <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
  </>,
);
