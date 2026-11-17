import { type CSSProperties, useRef } from "react";
import type { WorkspacePane } from "./patent-workspace-layout";
import type { WorkspaceRect } from "./patent-workspace-tab-drag";
import type { WorkspaceTabDragSession } from "./use-patent-workspace-tab-drag";
import { workspaceTabDragTiming } from "./workspace-tab-drag-motion";

type PatentWorkspaceTabDragLayerProps = Readonly<{
  session: WorkspaceTabDragSession | null;
}>;

function paneStyle(rect: WorkspaceRect, pane: WorkspacePane): CSSProperties {
  const width = rect.width / 2;
  return {
    left: pane === "left" ? rect.left : rect.left + width,
    top: rect.top,
    width,
    height: rect.height,
  };
}

function paneLabel(pane: WorkspacePane, swapsDocuments: boolean): string {
  if (swapsDocuments) return "交换左右文档";
  return pane === "left" ? "放到左侧" : "放到右侧";
}

export function PatentWorkspaceTabDragLayer({ session }: PatentWorkspaceTabDragLayerProps) {
  const lastWorkspace = useRef<WorkspaceRect | null>(null);
  if (session?.workspaceRect) lastWorkspace.current = session.workspaceRect;
  if (!session) lastWorkspace.current = null;
  if (!session) return null;
  const workspace =
    session.workspaceRect ?? (session.status !== "dragging" ? lastWorkspace.current : null);

  const ghostLeft =
    session.status === "cancelling" ? session.sourceRect.left : session.point.x - session.offset.x;
  const ghostTop =
    session.status === "cancelling" ? session.sourceRect.top : session.point.y - session.offset.y;

  return (
    <div
      className="patent-workspace-tab-drag"
      data-status={session.status}
      data-effect={session.effect ?? undefined}
      data-pane={session.pane ?? undefined}
      aria-hidden="true"
      style={
        {
          pointerEvents: "none",
          "--workspace-tab-drag-duration": `${workspaceTabDragTiming(session).duration}ms`,
        } as CSSProperties
      }
    >
      {workspace
        ? (["left", "right"] as const).map((pane) => (
            <div
              key={pane}
              className={`patent-workspace-tab-drag__zone ${session.pane === pane ? "is-target" : ""}`}
              data-testid={`workspace-tab-drop-${pane}`}
              style={paneStyle(workspace, pane)}
            >
              <span>{paneLabel(pane, session.effect === "swap")}</span>
            </div>
          ))
        : null}
      <div
        className="patent-workspace-tab-drag__ghost"
        style={{
          left: ghostLeft,
          top: ghostTop,
          width: session.sourceRect.width,
          height: session.sourceRect.height,
        }}
      >
        {session.source.label}
      </div>
    </div>
  );
}
