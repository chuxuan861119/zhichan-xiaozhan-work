import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { KetcherAdapter } from "../../../src/renderer/src/chemistry/ketcher-adapter";
import { KetcherEditor } from "../../../src/renderer/src/chemistry/ketcher-editor";
import { ToolActionTooltips } from "../../../src/renderer/src/shared/tool-action-tooltips";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../src/shared/settings/shortcuts";

function Fixture() {
  const mode =
    new URLSearchParams(location.search).get("mode") === "macromolecule"
      ? "macromolecule"
      : "molecule";
  const adapterRef = useRef<KetcherAdapter | null>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState("closed");
  const [content, setContent] = useState({ hasContent: false, dirty: false });
  return (
    <main>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <button
        type="button"
        onClick={async () => {
          const adapter = adapterRef.current;
          if (!adapter) return;
          const source = JSON.stringify({
            root: { nodes: [{ $ref: "mol0" }] },
            mol0: {
              type: "molecule",
              atoms: [
                { label: "C", location: [0, 0, 0] },
                { label: "O", location: [1, 0, 0] },
              ],
              bonds: [{ type: 1, atoms: [0, 1] }],
            },
          });
          setState("loading-data");
          const loaded = await adapter.loadKet(source, mode);
          if (!loaded.ok) {
            setState(loaded.error.code);
            return;
          }
          setState("reading-data");
          const draft = await adapter.readDraft();
          setState(
            draft.ok &&
              JSON.parse(draft.value.ket).root.nodes.length > 0 &&
              draft.value.svg.includes("<svg") &&
              draft.value.editorMode === mode
              ? "draft-ready"
              : draft.ok
                ? "draft-failed"
                : draft.error.code,
          );
        }}
      >
        验证结构式数据
      </button>
      <button
        type="button"
        onClick={() => {
          setState("loading");
          setOpen(true);
        }}
      >
        打开结构式
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setState("closed");
        }}
      >
        关闭结构式
      </button>
      <output aria-label="运行状态">{state}</output>
      <output aria-label="结构内容">{JSON.stringify(content)}</output>
      <div style={{ width: 1100, height: 700 }}>
        {open && (
          <KetcherEditor
            initialMode={mode}
            onReady={(adapter) => {
              adapterRef.current = adapter;
              setState("ready");
            }}
            onError={(e) => setState(e.code)}
            onContentChange={setContent}
          />
        )}
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
