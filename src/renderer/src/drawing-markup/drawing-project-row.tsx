import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { StandardDialog } from "../shared/standard-dialog";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { useObjectContextMenu } from "../editor/ui/object-context-menu";

export function DrawingProjectRow({
  project,
  selected,
  busy,
  backgroundSaving = false,
  onActivate,
  onRename,
  onDelete,
  onExport,
}: {
  project: DrawingProject;
  selected: boolean;
  busy: boolean;
  backgroundSaving?: boolean;
  onActivate(id: string): void;
  onRename(id: string): Promise<void>;
  onDelete(id: string): Promise<void>;
  onExport?(id: string, format: "dwg" | "dxf"): Promise<void>;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  const menu = useObjectContextMenu(
    `drawing-project-${project.projectId}`,
    [
      { label: "重命名", disabled: busy, run: () => onRename(project.projectId) },
      {
        label: "导出CAD",
        disabled: busy || !project.cad || !onExport,
        run: () => setExportOpen(true),
      },
      { label: "删除", disabled: busy, run: () => onDelete(project.projectId) },
    ],
    "图纸菜单",
  );
  return (
    <div
      className="drawing-project-row"
      data-project-id={project.projectId}
      data-cad-save-locked={backgroundSaving}
    >
      <button
        type="button"
        className="drawing-project-name"
        disabled={busy}
        aria-pressed={selected}
        onClick={() => onActivate(project.projectId)}
        title={project.name}
      >
        {project.name}
      </button>
      <button
        type="button"
        className="drawing-icon-button"
        disabled={busy}
        aria-label={`${project.name}的更多操作`}
        title="更多操作"
        aria-haspopup="menu"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          menu.open(event, { x: box.left, y: box.bottom });
        }}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      {menu.menu}
      <StandardDialog
        open={exportOpen}
        portal
        title="导出CAD"
        size="s"
        onCancel={() => setExportOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setExportOpen(false)}>
              取消
            </button>
            {(["dxf", "dwg"] as const).map((format) => (
              <button
                key={format}
                type="button"
                disabled={busy}
                onClick={() => {
                  setExportOpen(false);
                  void onExport?.(project.projectId, format);
                }}
              >
                导出 {format.toUpperCase()}
              </button>
            ))}
          </>
        }
      >
        <p>导出“{project.name}”的完整可编辑图纸，包含已完成的最新编辑、标号和局部放大图。</p>
        <p>DXF 便于交换编辑；DWG 使用 CAD 二进制格式。位图及 PDF 底图不能转换为可编辑线条。</p>
      </StandardDialog>
    </div>
  );
}
