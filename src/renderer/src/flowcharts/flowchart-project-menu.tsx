import type { KeyboardEvent } from "react";
import type { FlowchartProjectDescriptor } from "../../../shared/flowcharts/model";

type FlowchartProjectMenuProps = Readonly<{
  projects: readonly FlowchartProjectDescriptor[];
  currentProjectId: string | null;
  linkedFigureLabels: ReadonlyMap<string, readonly string[]>;
  busy: boolean;
  onClose(): void;
  onSelect(project: FlowchartProjectDescriptor): void;
}>;

function moveFocus(container: HTMLElement, direction: 1 | -1) {
  const items = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)'),
  );
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(current + direction + items.length) % items.length]?.focus();
}

export function FlowchartProjectMenu({
  projects,
  currentProjectId,
  linkedFigureLabels,
  busy,
  onClose,
  onSelect,
}: FlowchartProjectMenuProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
    }
  };

  return (
    <div className="flowchart-project-menu-layer">
      <button
        type="button"
        className="flowchart-project-menu-scrim"
        aria-label="关闭流程图工程列表"
        onClick={onClose}
      />
      <div
        className="flowchart-project-menu"
        role="menu"
        aria-label="流程图工程列表"
        onKeyDown={handleKeyDown}
      >
        <fieldset className="flowchart-project-menu__projects" aria-label="选择流程图">
          {projects.map((project) => {
            const selected = project.projectId === currentProjectId;
            const linked = linkedFigureLabels.get(project.projectId) ?? [];
            const details = linked.length > 0 ? `关联${linked.join("、")}` : "未关联说明书附图";
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-label={`${project.name}，${selected ? "当前工程" : details}`}
                className={selected ? "is-current" : undefined}
                disabled={busy}
                key={project.projectId}
                onClick={() => onSelect(project)}
              >
                <strong>{project.name}</strong>
                <span>{selected ? `当前工程 · ${details}` : details}</span>
              </button>
            );
          })}
        </fieldset>
      </div>
    </div>
  );
}
