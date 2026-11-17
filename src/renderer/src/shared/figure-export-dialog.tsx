import type { ReactNode } from "react";
import { StandardDialog } from "./standard-dialog";
import "../flowcharts/flowchart.css";

/** Common window and responsive layout for CAD and flowchart figure output. */
export function FigureExportDialog({
  open,
  title,
  busy,
  onCancel,
  options,
  footer,
  children,
}: Readonly<{
  open: boolean;
  title: string;
  busy: boolean;
  onCancel(): void;
  options: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}>) {
  return (
    <StandardDialog
      open={open}
      title={title}
      size="xl"
      portal
      movable
      onCancel={onCancel}
      closeDisabled={busy}
      className="flowchart-dialog flowchart-export-dialog flowchart-export-dialog--patent"
      bodyClassName="flowchart-dialog-body"
      footer={footer}
    >
      <div className="flowchart-export-layout">
        <aside className="flowchart-export-options" aria-label="导出设置">
          {options}
        </aside>
        <section className="flowchart-export-preview" aria-label="附图预览">
          {children}
        </section>
      </div>
    </StandardDialog>
  );
}
