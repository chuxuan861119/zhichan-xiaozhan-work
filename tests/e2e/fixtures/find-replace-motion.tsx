import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FindReplacePanel } from "../../../src/renderer/src/editor/ui/find-replace-panel";
import { SpatialCollapse } from "../../../src/renderer/src/shared/spatial-collapse";

function CollapseStack({
  id,
  className,
  gap,
}: {
  id: string;
  className: string;
  gap: number | string;
}) {
  const [open, setOpen] = useState(true);
  const Tag = id === "scope" ? "fieldset" : "section";
  return (
    <Tag id={id} className={className}>
      {id === "scope" ? <legend>导出范围</legend> : null}
      <button type="button" onClick={() => setOpen(!open)}>
        切换
      </button>
      <SpatialCollapse open={open} parentGap={gap}>
        {open ? <div style={{ height: 60 }}>可折叠设置</div> : null}
      </SpatialCollapse>
      <p className="following">后续内容</p>
    </Tag>
  );
}

function Fixture() {
  const [mode, setMode] = useState<"find" | "replace">("replace");
  return (
    <>
      <CollapseStack id="password" className="migration-password-step__fields" gap={14} />
      <CollapseStack id="print" className="print-settings-panel" gap={14} />
      <aside className="flowchart-export-options">
        <CollapseStack
          id="export"
          className="flowchart-export-format"
          gap="var(--flowchart-export-option-gap)"
        />
      </aside>
      <CollapseStack
        id="scope"
        className="flowchart-export-section flowchart-export-section--collapsible"
        gap={10}
      />
      <div className="patent-global-function-rail" style={{ width: 300 }}>
        <FindReplacePanel editor={null} mode={mode} onModeChange={setMode} onClose={() => {}} />
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
