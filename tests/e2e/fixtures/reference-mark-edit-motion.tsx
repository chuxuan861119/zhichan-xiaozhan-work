import { createRoot } from "react-dom/client";
import { ReferenceMarkPanel } from "../../../src/renderer/src/patents/reference-marks/reference-mark-panel";
import { installMotionPreference } from "../../../src/renderer/src/shared/motion-preference";
import { createBlankPatent } from "../../../src/shared/patent/defaults";
import "../../../src/renderer/src/app/app.css";
import "../../../src/renderer/src/patents/function-rail/function-rail-appearance.css";
import "../../../resources/ui/workbench-ui.css";

document.documentElement.dataset.reducedMotion = "false";
installMotionPreference();
const patent = createBlankPatent({ patentType: "invention", name: "编辑动画回归" });
patent.referenceMarks = [
  { referenceMarkId: "mark-1", number: 1, keyword: "箱体" },
  { referenceMarkId: "mark-2", number: 2, keyword: "支架" },
];
const active = new URLSearchParams(location.search).get("active") === "true";
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <div
    className="patent-global-function-rail"
    style={{
      position: "relative",
      width: 300,
      padding: 16,
      // Match the color collision in the running default theme.
      ...{ "--editor-display-panel": "#ffffff", "--editor-display-panel-surface": "#f0f0f0" },
    }}
  >
    <div className="patent-book-tools">
      <ReferenceMarkPanel
        patent={patent}
        missingReferenceMarkIds={new Set()}
        keywordHighlightEnabled
        activeReferenceMarkId={active ? "mark-1" : null}
        onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
        onEdit={() => ({ ok: true, message: "" })}
        onCancel={() => ({ ok: true, message: "" })}
      />
    </div>
  </div>,
);
