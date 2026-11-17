import type { PatentDocumentTarget } from "../../../shared/patent/document-target";
import type { PatentBookKind } from "../../../shared/patent/model";
import {
  activateWorkspacePane,
  applyWorkspaceBookPair,
  applyWorkspaceCustomDualViewPreset,
  applyWorkspacePair,
  closeDualWorkspacePane,
  createSingleWorkspace,
  dropTargetIntoWorkspace,
  enterDualWorkspace,
  exitDualWorkspace,
  type PatentWorkspaceLayoutState,
  reconcileWorkspaceTargets,
  selectPaneTarget,
  setWorkspacePaneZoom,
  swapWorkspacePanes,
} from "./patent-workspace-layout";

const firstPatentId = "00000000-0000-4000-8000-000000000101";
const secondPatentId = "00000000-0000-4000-8000-000000000102";

function target(patentId: string, bookKind: PatentBookKind): PatentDocumentTarget {
  return { patentId, kind: "book", bookKind };
}

function documentTarget(
  state: PatentWorkspaceLayoutState,
  pane: "left" | "right",
): PatentDocumentTarget | null {
  const paneState = state[pane];
  return paneState.kind === "document" ? paneState.target : null;
}

describe("patent workspace layout", () => {
  test.each([
    ["flowchart", "description"],
    ["description", "flowchart"],
    ["drawing-markup", "claims"],
    ["claims", "drawing-markup"],
    ["flowchart", "drawing-markup"],
    ["drawing-markup", "flowchart"],
  ] as const)(
    "activates custom %s / %s using patent-scoped targets",
    (leftBookKind, rightBookKind) => {
      const initial = createSingleWorkspace(target(firstPatentId, "description"));
      const state = applyWorkspaceCustomDualViewPreset(
        initial,
        secondPatentId,
        { leftBookKind, rightBookKind },
        ["description", "claims"],
      );
      expect(state.mode).toBe("dual");
      for (const [pane, kind] of [
        ["left", leftBookKind],
        ["right", rightBookKind],
      ] as const) {
        expect(documentTarget(state, pane)).toEqual(
          kind === "flowchart" || kind === "drawing-markup"
            ? { patentId: secondPatentId, kind: "tool", tool: kind }
            : target(secondPatentId, kind),
        );
      }
      expect(
        reconcileWorkspaceTargets(state, [
          { patentId: secondPatentId, availableBookKinds: ["description", "claims"] },
        ]),
      ).toBe(state);
    },
  );

  test("rejects duplicate custom hosts and stale drawing books without changing the workspace", () => {
    const state = createSingleWorkspace(target(firstPatentId, "description"));
    expect(
      applyWorkspaceCustomDualViewPreset(
        state,
        firstPatentId,
        { leftBookKind: "flowchart", rightBookKind: "flowchart" },
        ["description"],
      ),
    ).toBe(state);
    expect(
      applyWorkspaceCustomDualViewPreset(
        state,
        firstPatentId,
        { leftBookKind: "description-drawings", rightBookKind: "flowchart" },
        ["description"],
      ),
    ).toBe(state);
  });
  test("opens auxiliary documents independently in both panes", () => {
    const first: PatentDocumentTarget = {
      patentId: firstPatentId,
      kind: "auxiliary",
      auxiliaryDocumentId: "00000000-0000-4000-8000-000000000401",
    };
    const second: PatentDocumentTarget = {
      patentId: firstPatentId,
      kind: "auxiliary",
      auxiliaryDocumentId: "00000000-0000-4000-8000-000000000402",
    };

    const state = selectPaneTarget(
      enterDualWorkspace(createSingleWorkspace(first)),
      "right",
      second,
    ).state;

    expect(documentTarget(state, "left")).toEqual(first);
    expect(documentTarget(state, "right")).toEqual(second);
    expect(closeDualWorkspacePane(state, "left")).toEqual(createSingleWorkspace(second));
  });

  test("enters dual mode with the current document on the left and a fresh picker on the right", () => {
    const current = target(firstPatentId, "claims");

    const state = enterDualWorkspace(createSingleWorkspace(current));

    expect(state).toMatchObject({
      mode: "dual",
      activePane: "left",
      singleTarget: current,
      left: { kind: "document", target: current, dualZoomPercent: 100 },
      right: { kind: "selection", selectedPatentId: firstPatentId },
    });
  });

  test("exits dual mode with the active pane document as the single document", () => {
    const entered = enterDualWorkspace(createSingleWorkspace(target(firstPatentId, "description")));
    const selected = selectPaneTarget(entered, "right", target(secondPatentId, "abstract")).state;

    const state = exitDualWorkspace(selected);

    expect(state.mode).toBe("single");
    expect(state.singleTarget).toEqual(target(secondPatentId, "abstract"));
    expect(documentTarget(state, "left")).toEqual(target(secondPatentId, "abstract"));
    expect(state.right.kind).toBe("selection");
  });

  test("closes the left dual pane and keeps the right document", () => {
    const entered = enterDualWorkspace(createSingleWorkspace(target(firstPatentId, "claims")));
    const selected = selectPaneTarget(
      entered,
      "right",
      target(secondPatentId, "description"),
    ).state;

    const state = closeDualWorkspacePane(selected, "left");

    expect(state).toEqual(createSingleWorkspace(target(secondPatentId, "description")));
  });

  test("closes the right dual pane and keeps the left document", () => {
    const entered = enterDualWorkspace(createSingleWorkspace(target(firstPatentId, "claims")));
    const selected = selectPaneTarget(
      entered,
      "right",
      target(secondPatentId, "description"),
    ).state;

    const state = closeDualWorkspacePane(selected, "right");

    expect(state).toEqual(createSingleWorkspace(target(firstPatentId, "claims")));
  });

  test("keeps the closed pane document when the other dual pane is a picker", () => {
    const entered = enterDualWorkspace(createSingleWorkspace(target(firstPatentId, "claims")));

    const state = closeDualWorkspacePane(entered, "left");

    expect(state).toEqual(createSingleWorkspace(target(firstPatentId, "claims")));
  });

  test("leaves a non-dual workspace unchanged when closing a pane", () => {
    const single = createSingleWorkspace(target(firstPatentId, "abstract"));

    expect(closeDualWorkspacePane(single, "left")).toBe(single);
    expect(closeDualWorkspacePane(single, "right")).toBe(single);
  });

  test("activating a pane never changes either displayed target", () => {
    const entered = enterDualWorkspace(createSingleWorkspace(target(firstPatentId, "claims")));
    const selected = selectPaneTarget(entered, "right", target(firstPatentId, "description")).state;

    const state = activateWorkspacePane(selected, "left");

    expect(state.activePane).toBe("left");
    expect(documentTarget(state, "left")).toEqual(target(firstPatentId, "claims"));
    expect(documentTarget(state, "right")).toEqual(target(firstPatentId, "description"));
  });

  test("reveals the other pane instead of displaying the same patent book twice", () => {
    const entered = enterDualWorkspace(createSingleWorkspace(target(firstPatentId, "claims")));
    const selected = selectPaneTarget(entered, "right", target(firstPatentId, "description")).state;

    const result = selectPaneTarget(selected, "left", target(firstPatentId, "description"));

    expect(result.revealedPane).toBe("right");
    expect(result.state.activePane).toBe("right");
    expect(documentTarget(result.state, "left")).toEqual(target(firstPatentId, "claims"));
    expect(documentTarget(result.state, "right")).toEqual(target(firstPatentId, "description"));
  });

  test("swaps complete pane state while keeping the active document active", () => {
    const entered = enterDualWorkspace(createSingleWorkspace(target(firstPatentId, "claims")));
    const selected = selectPaneTarget(
      entered,
      "right",
      target(secondPatentId, "description"),
    ).state;
    expect(selected.right.kind).toBe("document");
    if (selected.right.kind !== "document") return;
    const zoomed: PatentWorkspaceLayoutState = {
      ...selected,
      right: { ...selected.right, dualZoomPercent: 72 },
    };

    const state = swapWorkspacePanes(zoomed);

    expect(state.activePane).toBe("left");
    expect(documentTarget(state, "left")).toEqual(target(secondPatentId, "description"));
    expect(state.left).toMatchObject({ dualZoomPercent: 72 });
    expect(documentTarget(state, "right")).toEqual(target(firstPatentId, "claims"));
    expect(state.right).toMatchObject({ dualZoomPercent: 100 });
  });

  describe("dropTargetIntoWorkspace", () => {
    const claims = target(firstPatentId, "claims");
    const description = target(firstPatentId, "description");
    const abstract = target(firstPatentId, "abstract");

    test.each(["left", "right"] as const)(
      "opens the current single target on the %s and leaves the other pane selectable",
      (pane) => {
        const next = dropTargetIntoWorkspace(createSingleWorkspace(claims), pane, claims);
        const other = pane === "left" ? "right" : "left";

        expect(next.mode).toBe("dual");
        expect(next.activePane).toBe(pane);
        expect(next[pane]).toMatchObject({ kind: "document", target: claims });
        expect(next[other]).toEqual({
          kind: "selection",
          selectedPatentId: firstPatentId,
        });
      },
    );

    test.each(["left", "right"] as const)(
      "opens another target on the %s and moves the current document to the opposite pane",
      (pane) => {
        const next = dropTargetIntoWorkspace(createSingleWorkspace(claims), pane, description);
        const other = pane === "left" ? "right" : "left";

        expect(next.activePane).toBe(pane);
        expect(next[pane]).toMatchObject({ kind: "document", target: description });
        expect(next[other]).toMatchObject({ kind: "document", target: claims });
      },
    );

    test.each(["left", "right"] as const)(
      "keeps the tool that owns the screen on the %s drop's opposite pane",
      (pane) => {
        const drawingMarkup = {
          patentId: firstPatentId,
          kind: "tool",
          tool: "drawing-markup",
        } as const;

        const next = dropTargetIntoWorkspace(
          createSingleWorkspace(claims),
          pane,
          description,
          drawingMarkup,
        );
        const other = pane === "left" ? "right" : "left";

        expect(next.activePane).toBe(pane);
        expect(next[pane]).toMatchObject({ kind: "document", target: description });
        expect(next[other]).toMatchObject({ kind: "document", target: drawingMarkup });
      },
    );

    test("treats the tool on screen as the current document when its own tab is dropped", () => {
      const flowchart = { patentId: firstPatentId, kind: "tool", tool: "flowchart" } as const;

      const next = dropTargetIntoWorkspace(
        createSingleWorkspace(claims),
        "left",
        flowchart,
        flowchart,
      );

      expect(next.mode).toBe("dual");
      expect(next.left).toMatchObject({ kind: "document", target: flowchart });
      expect(next.right).toEqual({ kind: "selection", selectedPatentId: firstPatentId });
    });

    test("replaces the requested dual pane and leaves the opposite pane unchanged", () => {
      const dual = setWorkspacePaneZoom(
        selectPaneTarget(enterDualWorkspace(createSingleWorkspace(claims)), "right", description)
          .state,
        "left",
        73,
      );

      const next = dropTargetIntoWorkspace(dual, "left", abstract);

      expect(next.activePane).toBe("left");
      expect(next.left).toMatchObject({
        kind: "document",
        target: abstract,
        dualZoomPercent: 73,
      });
      expect(next.right).toMatchObject({ kind: "document", target: description });
    });

    test("only activates a pane that already contains the dropped target", () => {
      const dual = selectPaneTarget(
        enterDualWorkspace(createSingleWorkspace(claims)),
        "right",
        description,
      ).state;

      const next = dropTargetIntoWorkspace(dual, "left", claims);

      expect(next).toEqual({ ...dual, activePane: "left" });
    });

    test("swaps panes when the dropped target is already on the opposite side", () => {
      const dual = selectPaneTarget(
        enterDualWorkspace(createSingleWorkspace(claims)),
        "right",
        description,
      ).state;

      const next = dropTargetIntoWorkspace(dual, "right", claims);

      expect(next.activePane).toBe("right");
      expect(next.left).toMatchObject({ kind: "document", target: description });
      expect(next.right).toMatchObject({ kind: "document", target: claims });
    });
  });

  test("changes only the selected pane zoom in dual mode", () => {
    const entered = applyWorkspacePair(
      createSingleWorkspace(target(firstPatentId, "claims")),
      firstPatentId,
      "claims-description",
      ["claims", "description", "abstract"],
    );

    const state = setWorkspacePaneZoom(entered, "right", 68);

    expect(state.left).toMatchObject({ dualZoomPercent: 100 });
    expect(state.right).toMatchObject({ dualZoomPercent: 68 });
  });

  test("does not attach a zoom value to a selection pane", () => {
    const entered = enterDualWorkspace(createSingleWorkspace(target(firstPatentId, "claims")));

    expect(setWorkspacePaneZoom(entered, "right", 68)).toBe(entered);
  });

  test.each([
    ["claims-description", "claims", "description"],
    ["claims-drawings", "claims", "description-drawings"],
    ["drawings-description", "description-drawings", "description"],
  ] as const)("applies the %s quick pair in its fixed order", (pair, left, right) => {
    const state = applyWorkspacePair(
      createSingleWorkspace(target(firstPatentId, "abstract")),
      firstPatentId,
      pair,
      ["claims", "description", "description-drawings", "abstract", "abstract-drawing"],
    );

    expect(state.mode).toBe("dual");
    expect(documentTarget(state, "left")).toEqual(target(firstPatentId, left));
    expect(documentTarget(state, "right")).toEqual(target(firstPatentId, right));
  });

  test("leaves the layout unchanged when a quick pair contains an unavailable book", () => {
    const original = createSingleWorkspace(target(firstPatentId, "description"));

    const state = applyWorkspacePair(original, firstPatentId, "claims-drawings", [
      "claims",
      "description",
      "abstract",
    ]);

    expect(state).toBe(original);
  });

  test("applies an available custom book pair in its chosen left-right order", () => {
    const state = applyWorkspaceBookPair(
      createSingleWorkspace(target(firstPatentId, "abstract")),
      firstPatentId,
      "description",
      "claims",
      ["claims", "description", "abstract"],
    );

    expect(state.mode).toBe("dual");
    expect(documentTarget(state, "left")).toEqual(target(firstPatentId, "description"));
    expect(documentTarget(state, "right")).toEqual(target(firstPatentId, "claims"));
  });

  test("leaves the layout unchanged for duplicate or unavailable custom books", () => {
    const original = createSingleWorkspace(target(firstPatentId, "description"));

    expect(
      applyWorkspaceBookPair(original, firstPatentId, "description", "description", [
        "claims",
        "description",
      ]),
    ).toBe(original);
    expect(
      applyWorkspaceBookPair(original, firstPatentId, "description-drawings", "claims", [
        "claims",
        "description",
      ]),
    ).toBe(original);
  });

  test("turns only the invalid pane into a picker when its patent was closed", () => {
    const entered = enterDualWorkspace(createSingleWorkspace(target(firstPatentId, "claims")));
    const selected = selectPaneTarget(
      entered,
      "right",
      target(secondPatentId, "description"),
    ).state;

    const state = reconcileWorkspaceTargets(selected, [
      {
        patentId: firstPatentId,
        availableBookKinds: ["claims", "description", "abstract"],
      },
    ]);

    expect(documentTarget(state, "left")).toEqual(target(firstPatentId, "claims"));
    expect(state.right).toEqual({ kind: "selection", selectedPatentId: firstPatentId });
    expect(state.activePane).toBe("left");
  });

  test("falls back to the description when both drawing targets become unavailable", () => {
    const entered = applyWorkspacePair(
      createSingleWorkspace(target(firstPatentId, "description-drawings")),
      firstPatentId,
      "claims-drawings",
      ["claims", "description", "description-drawings", "abstract", "abstract-drawing"],
    );
    const drawingsOnBothSides: PatentWorkspaceLayoutState = {
      ...entered,
      left: {
        kind: "document",
        target: target(firstPatentId, "description-drawings"),
        dualZoomPercent: 80,
      },
      right: {
        kind: "document",
        target: target(firstPatentId, "abstract-drawing"),
        dualZoomPercent: 80,
      },
    };

    const state = reconcileWorkspaceTargets(drawingsOnBothSides, [
      {
        patentId: firstPatentId,
        availableBookKinds: ["claims", "description", "abstract"],
      },
    ]);

    expect(state.mode).toBe("single");
    expect(state.singleTarget).toEqual(target(firstPatentId, "description"));
    expect(documentTarget(state, "left")).toEqual(target(firstPatentId, "description"));
  });

  test("returns to an empty single workspace when both panes belonged to a closed patent", () => {
    const entered = applyWorkspacePair(
      createSingleWorkspace(target(firstPatentId, "claims")),
      firstPatentId,
      "claims-description",
      ["claims", "description", "abstract"],
    );

    const state = reconcileWorkspaceTargets(entered, []);

    expect(state).toEqual(createSingleWorkspace(null));
  });
});

test("manual dual zoom survives swapping and automatic fit explicitly clears manual mode", () => {
  const initial = enterDualWorkspace(createSingleWorkspace({ patentId: "p", bookKind: "claims" }));
  const manual = setWorkspacePaneZoom(initial, "left", 150, true);
  expect(manual.left.kind === "document" && manual.left.dualZoomManual).toBe(true);
  const swapped = swapWorkspacePanes(manual);
  expect(swapped.right).toEqual(manual.left);
  const fitted = setWorkspacePaneZoom(manual, "left", 67);
  expect(fitted.left.kind === "document" && fitted.left.dualZoomManual).toBe(false);
  expect(setWorkspacePaneZoom(fitted, "left", 67)).toBe(fitted);
});
