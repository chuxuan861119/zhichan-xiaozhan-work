import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { PatentWorkspaceTabDragLayer } from "./patent-workspace-tab-drag-layer";
import type { WorkspaceTabDragSession } from "./use-patent-workspace-tab-drag";

const session: WorkspaceTabDragSession = {
  sequence: 1,
  status: "dragging",
  source: {
    key: "book:patent-a:description",
    label: "说明书",
    target: { patentId: "patent-a", bookKind: "description" },
  },
  sourceRect: { left: 120, top: 10, right: 340, bottom: 44, width: 220, height: 34 },
  origin: { x: 150, y: 25 },
  point: { x: 300, y: 400 },
  offset: { x: 30, y: 15 },
  workspaceRect: { left: 0, top: 160, right: 1200, bottom: 800, width: 1200, height: 640 },
  pane: "left",
  effect: "split-other",
};

describe("PatentWorkspaceTabDragLayer", () => {
  test("renders the drag ghost at the pointer offset and highlights the target half", () => {
    const { container } = render(<PatentWorkspaceTabDragLayer session={session} />);

    const layer = container.querySelector<HTMLElement>(".patent-workspace-tab-drag");
    const ghost = screen.getByText("说明书");
    const left = screen.getByTestId("workspace-tab-drop-left");
    const right = screen.getByTestId("workspace-tab-drop-right");

    expect(layer?.dataset.status).toBe("dragging");
    expect(layer?.dataset.effect).toBe("split-other");
    expect(layer?.dataset.pane).toBe("left");
    expect(layer?.getAttribute("aria-hidden")).toBe("true");
    expect(layer?.style.pointerEvents).toBe("none");
    expect(ghost.getAttribute("style")).toContain(
      "left: 270px; top: 385px; width: 220px; height: 34px",
    );
    expect(left.classList.contains("is-target")).toBe(true);
    expect(right.classList.contains("is-target")).toBe(false);
    expect(left.getAttribute("style")).toContain(
      "left: 0px; top: 160px; width: 600px; height: 640px",
    );
  });

  test("returns the ghost to the source rect and removes drop zones while cancelling", () => {
    const { container } = render(
      <PatentWorkspaceTabDragLayer
        session={{
          ...session,
          status: "cancelling",
          workspaceRect: null,
          pane: null,
          effect: null,
        }}
      />,
    );

    expect(
      container
        .querySelector<HTMLElement>(".patent-workspace-tab-drag")
        ?.style.getPropertyValue("--workspace-tab-drag-duration"),
    ).toBe("200ms");
    expect(screen.getByText("说明书").getAttribute("style")).toContain("left: 120px; top: 10px");
    expect(screen.queryByTestId("workspace-tab-drop-left")).toBeNull();
    expect(screen.queryByTestId("workspace-tab-drop-right")).toBeNull();
  });

  test("labels an opposite-pane drop as a document swap", () => {
    render(
      <PatentWorkspaceTabDragLayer
        session={{
          ...session,
          pane: "right",
          effect: "swap",
        }}
      />,
    );

    expect(screen.getByTestId("workspace-tab-drop-right").textContent).toBe("交换左右文档");
  });

  test("does not render before a drag crosses the movement threshold", () => {
    const { container } = render(<PatentWorkspaceTabDragLayer session={null} />);
    expect(container.childElementCount).toBe(0);
  });
});

test("keeps the drop-zone picture for a cancellation instead of removing it abruptly", () => {
  const view = render(<PatentWorkspaceTabDragLayer session={session} />);
  view.rerender(
    <PatentWorkspaceTabDragLayer
      session={{ ...session, status: "cancelling", workspaceRect: null, pane: null, effect: null }}
    />,
  );
  expect(screen.getByTestId("workspace-tab-drop-left").isConnected).toBe(true);
  expect(
    view.container.querySelector<HTMLElement>(".patent-workspace-tab-drag")?.dataset.status,
  ).toBe("cancelling");
  view.rerender(<PatentWorkspaceTabDragLayer session={null} />);
  expect(screen.queryByTestId("workspace-tab-drop-left")).toBeNull();
});
