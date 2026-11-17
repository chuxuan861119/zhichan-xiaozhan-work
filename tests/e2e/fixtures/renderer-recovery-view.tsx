import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "../../../src/renderer/src/app/app-error-boundary";

function RecoveryView() {
  const [broken, setBroken] = useState(false);
  if (broken) throw new TypeError("synthetic renderer failure");
  return (
    <>
      <button type="button" onClick={() => setBroken(true)}>
        模拟界面错误
      </button>
      <fieldset>
        <legend>恢复测试表单</legend>
        {["选项一", "选项二", "选项三", "选项四"].map((label) => (
          <label key={label}>
            <input type="checkbox" />
            {label}
          </label>
        ))}
      </fieldset>
    </>
  );
}

document.body.dataset.boot = String(performance.timeOrigin);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <RecoveryView />
    </AppErrorBoundary>
  </StrictMode>,
);
