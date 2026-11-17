import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { FormulaDialog } from "../../../src/renderer/src/editor/ui/formula-dialog";

function Fixture() {
  const [open, setOpen] = useState(true);
  const [target, setTarget] = useState<"new" | "a" | "b">("new");
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开公式
      </button>
      <input aria-label="其他输入框" />
      <button
        type="button"
        onClick={() => {
          setTarget("a");
          setOpen(true);
        }}
      >
        编辑公式 A
      </button>
      <button
        type="button"
        onClick={() => {
          setTarget("b");
          setOpen(true);
        }}
      >
        编辑公式 B
      </button>
      <FormulaDialog
        key={target}
        open={open}
        displayMode={
          new URLSearchParams(window.location.search).get("mode") === "modal" ? "modal" : "modeless"
        }
        initialLatex={target === "new" ? "" : target}
        initialMode={target === "b" ? "block" : "inline"}
        allowModeChange
        onConfirm={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
