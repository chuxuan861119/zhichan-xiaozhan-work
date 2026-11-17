// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { loadDrawioRuntimeFiles } from "./helpers/drawio-runtime-test-harness";

type Terminal = {
  cellId: string;
  portId: string;
  x?: number;
  y?: number;
  constraint?: { id: string; point?: { x: number; y: number } };
};

type Runtime = {
  createStateMachine(): {
    getState(): { phase: string; sourceKey: string | null };
    enable(): void;
    disable(): void;
    selectTerminal(
      terminal: Terminal,
    ):
      | { kind: "selected" }
      | { kind: "same-terminal" }
      | { kind: "connect"; sourceKey: string; targetKey: string };
    cancelSelection(): void;
    escape(): "cancelled-selection" | "disabled";
  };
  createNativeConnectionGuard(handler: {
    isEnabled(): boolean;
    setEnabled(value: boolean): void;
  }): { suspend(): void; restore(): void };
  terminalPairKey(left: string, right: string): string;
  isDuplicateTerminalPair(existingPairs: Iterable<string>, left: string, right: string): boolean;
  resolvePorts(options: {
    nativeConstraints: Array<{ id?: string; point?: { x: number; y: number } }>;
    makeConstraint?: (x: number, y: number, id: string) => unknown;
  }): Array<{ id: string; x: number; y: number; constraint: unknown }>;
  connect(
    graph: ReturnType<typeof createTransactionalGraph>,
    source: { id: string },
    sourcePort: { constraint: { id: string } },
    target: { id: string },
    targetPort: { constraint: { id: string } },
  ): unknown;
  install(options: Record<string, unknown>): {
    enable(): void;
    disable(): void;
    setBusy(value: boolean): void;
    setEditorMode(mode: string): void;
    dispose(): void;
    isActive(): boolean;
  };
};

async function loadRuntime(): Promise<Runtime> {
  const global = await loadDrawioRuntimeFiles(["circuit-domain.js", "circuit-quick-wiring.js"]);
  return global.PatentCircuitQuickWiring as Runtime;
}

const createToggle = (initial: boolean) => ({
  enabled: initial,
  isEnabled() {
    return this.enabled;
  },
  setEnabled(value: boolean) {
    this.enabled = value;
  },
});

function createTransactionalGraph(options: { failConstraint?: boolean } = {}) {
  const calls: string[] = [];
  const edges: Array<{
    id: string;
    source: { id: string };
    target: { id: string };
    style: string;
  }> = [];
  const undoHistory: unknown[] = [];
  let dirty = false;
  const currentEdit = {
    changes: [] as Array<{ execute(): void }>,
    isEmpty() {
      return this.changes.length === 0;
    },
  };
  const model = {
    currentEdit,
    updateLevel: 0,
    beginUpdate() {
      calls.push("beginUpdate");
      this.updateLevel += 1;
    },
    endUpdate() {
      calls.push("endUpdate");
      this.updateLevel -= 1;
      if (this.updateLevel === 0 && !this.currentEdit.isEmpty()) {
        undoHistory.push([...this.currentEdit.changes]);
        dirty = true;
      }
    },
    execute(change: { execute(): void }) {
      change.execute();
      this.currentEdit.changes.push(change);
    },
  };
  const graph = {
    calls,
    edges,
    undoHistory,
    model,
    isDirty: () => dirty,
    getModel: () => model,
    getDefaultParent: () => ({ id: "parent" }),
    insertEdge(
      _parent: unknown,
      _id: unknown,
      _value: unknown,
      source: { id: string },
      target: { id: string },
      style: string,
    ) {
      const edge = { id: `edge-${edges.length + 1}`, source, target, style };
      model.execute({
        execute() {
          const index = edges.indexOf(edge);
          if (index < 0) edges.push(edge);
          else edges.splice(index, 1);
        },
      });
      calls.push(`insertEdge:${style}`);
      return edge;
    },
    setConnectionConstraint(
      _edge: unknown,
      _cell: unknown,
      source: boolean,
      constraint: { id: string },
    ) {
      let applied = false;
      model.execute({ execute: () => (applied = !applied) });
      calls.push(`${source ? "source" : "target"}Constraint:${constraint.id}`);
      if (!source && options.failConstraint) throw new Error("constraint failed");
    },
    setSelectionCell: () => calls.push("setSelectionCell"),
  };
  return graph;
}

describe("circuit direct-wiring state machine", () => {
  it("selects two terminals and remains ready for continuous wiring", async () => {
    const machine = (await loadRuntime()).createStateMachine();
    machine.enable();

    expect(machine.selectTerminal({ cellId: "a", portId: "right" })).toEqual({
      kind: "selected",
    });
    expect(machine.getState()).toEqual({ phase: "source-selected", sourceKey: "a::right" });
    expect(machine.selectTerminal({ cellId: "b", portId: "left" })).toEqual({
      kind: "connect",
      sourceKey: "a::right",
      targetKey: "b::left",
    });
    expect(machine.getState()).toEqual({ phase: "ready", sourceKey: null });
  });

  it("keeps a selected source when the same terminal is clicked", async () => {
    const machine = (await loadRuntime()).createStateMachine();
    machine.enable();
    machine.selectTerminal({ cellId: "a", portId: "right" });

    expect(machine.selectTerminal({ cellId: "a", portId: "right" })).toEqual({
      kind: "same-terminal",
    });
    expect(machine.getState()).toEqual({ phase: "source-selected", sourceKey: "a::right" });
  });

  it("uses Escape first for source cancellation and then mode exit", async () => {
    const machine = (await loadRuntime()).createStateMachine();
    machine.enable();
    machine.selectTerminal({ cellId: "a", portId: "right" });

    expect(machine.escape()).toBe("cancelled-selection");
    expect(machine.getState()).toEqual({ phase: "ready", sourceKey: null });
    expect(machine.escape()).toBe("disabled");
    expect(machine.getState()).toEqual({ phase: "disabled", sourceKey: null });
  });

  it("fails closed for terminal input while disabled", async () => {
    const machine = (await loadRuntime()).createStateMachine();

    expect(() => machine.selectTerminal({ cellId: "a", portId: "right" })).toThrowError(
      "INVALID_WIRING_TRANSITION",
    );
  });
});

describe("circuit direct-wiring graph adapter", () => {
  it("detects only the same unordered terminal pair as a duplicate", async () => {
    const runtime = await loadRuntime();
    const existing = new Set([runtime.terminalPairKey("a::right", "b::left")]);

    expect(runtime.isDuplicateTerminalPair(existing, "b::left", "a::right")).toBe(true);
    expect(runtime.isDuplicateTerminalPair(existing, "a::right", "c::left")).toBe(false);
    expect(runtime.isDuplicateTerminalPair(existing, "a::top", "b::left")).toBe(false);
  });

  it("restores exactly the native connection-handler state", async () => {
    const runtime = await loadRuntime();
    const enabledHandler = createToggle(true);
    const enabledGuard = runtime.createNativeConnectionGuard(enabledHandler);
    enabledGuard.suspend();
    expect(enabledHandler.enabled).toBe(false);
    enabledGuard.restore();
    expect(enabledHandler.enabled).toBe(true);

    const disabledHandler = createToggle(false);
    const disabledGuard = runtime.createNativeConnectionGuard(disabledHandler);
    disabledGuard.suspend();
    disabledGuard.restore();
    expect(disabledHandler.enabled).toBe(false);
  });

  it("uses native constraints before four deterministic fallback terminals", async () => {
    const runtime = await loadRuntime();
    const native = [{ id: "pin-a", point: { x: 0.25, y: 0 } }];

    expect(runtime.resolvePorts({ nativeConstraints: native })).toEqual([
      { id: "pin-a", x: 0.25, y: 0, constraint: native[0] },
    ]);
    expect(
      runtime
        .resolvePorts({
          nativeConstraints: [],
          makeConstraint: (x, y, id) => ({ id, point: { x, y } }),
        })
        .map(({ id }) => id),
    ).toEqual(["left", "top", "right", "bottom"]);
  });

  it("creates a no-arrow orthogonal edge as one transaction", async () => {
    const graph = createTransactionalGraph();
    const runtime = await loadRuntime();

    runtime.connect(
      graph,
      { id: "source" },
      { constraint: { id: "right" } },
      { id: "target" },
      { constraint: { id: "left" } },
    );

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.style).toContain("edgeStyle=orthogonalEdgeStyle");
    expect(graph.edges[0]?.style).toContain("startArrow=none");
    expect(graph.edges[0]?.style).toContain("endArrow=none");
    expect(graph.undoHistory).toHaveLength(1);
  });

  it("rolls failed changes back without undo or dirty pollution", async () => {
    const graph = createTransactionalGraph({ failConstraint: true });
    const runtime = await loadRuntime();

    expect(() =>
      runtime.connect(
        graph,
        { id: "source" },
        { constraint: { id: "right" } },
        { id: "target" },
        { constraint: { id: "left" } },
      ),
    ).toThrowError("constraint failed");
    expect(graph.model.updateLevel).toBe(0);
    expect(graph.edges).toHaveLength(0);
    expect(graph.model.currentEdit.changes).toHaveLength(0);
    expect(graph.undoHistory).toHaveLength(0);
    expect(graph.isDirty()).toBe(false);
  });
});

function createControllerHarness() {
  const vertices = [
    { id: "a", style: "shape=mxgraph.electrical.logic_gates.buffer2;" },
    { id: "b", style: "shape=mxgraph.electrical.logic_gates.buffer2;" },
  ];
  const nativeConstraints = [
    { id: "left", point: { x: 0, y: 0.5 } },
    { id: "right", point: { x: 1, y: 0.5 } },
  ];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const mxTarget = () => ({
    addListener(type: string, listener: (...args: unknown[]) => void) {
      const values = listeners.get(type) ?? new Set();
      values.add(listener);
      listeners.set(type, values);
    },
    removeListener(listener: (...args: unknown[]) => void) {
      for (const values of listeners.values()) values.delete(listener);
    },
  });
  const model = {
    ...mxTarget(),
    isVertex: (cell: unknown) => vertices.includes(cell as never),
    isEdge: () => false,
    isVisible: () => true,
    contains: () => true,
    getStyle: (cell: { style: string }) => cell.style,
    getTerminal: () => null,
  };
  const connectionHandler = createToggle(true);
  const edgeHandler = createToggle(true);
  const graph = {
    container: document.createElement("div"),
    connectionHandler,
    edgeHandler,
    view: {
      ...mxTarget(),
      getState(cell: { id: string }) {
        const index = vertices.indexOf(cell as never);
        return { x: 100 + index * 200, y: 120, width: 80, height: 40 };
      },
    },
    getModel: () => model,
    getDefaultParent: () => ({ id: "parent" }),
    getChildVertices: () => vertices,
    getAllConnectionConstraints: () => nativeConstraints,
    getConnectionPoint: (
      state: { x: number; y: number; width: number; height: number },
      constraint: { point: { x: number; y: number } },
    ) => ({
      x: state.x + state.width * constraint.point.x,
      y: state.y + state.height * constraint.point.y,
    }),
    isCellLocked: () => false,
    getSelectionCells: () => [],
    getChildEdges: () => [],
  };
  document.body.replaceChildren(graph.container);
  const statuses: Array<[string, string]> = [];
  const activeChanges: boolean[] = [];
  return {
    graph,
    vertices,
    connectionHandler,
    edgeHandler,
    listeners,
    statuses,
    activeChanges,
    options: {
      editorUi: { editor: { ...mxTarget(), graph } },
      document,
      window,
      onStatus(message: string, status: string) {
        statuses.push([message, status]);
      },
      onActiveChange(active: boolean) {
        activeChanges.push(active);
      },
    },
  };
}

describe("circuit direct-wiring controller", () => {
  it("uses transformed engine connection points for rotated and flipped terminals", async () => {
    const harness = createControllerHarness();
    Object.assign(harness.graph, { getConnectionPoint: () => ({ x: 140, y: 100 }) });
    const controller = (await loadRuntime()).install(harness.options);
    controller.enable();
    const port = harness.graph.container.querySelector<HTMLButtonElement>(
      ".patent-circuit-quick-wiring-port",
    );
    expect(port?.style.left).toBe("140px");
    expect(port?.style.top).toBe("100px");
    controller.dispose();
  });

  it("rejects a duplicate wire using persisted constraint coordinates without transient ids", async () => {
    const harness = createControllerHarness();
    const edge = {
      source: harness.vertices[0],
      target: harness.vertices[1],
      style: "exitX=0;exitY=0.5;entryX=1;entryY=0.5;",
    };
    Object.assign(harness.graph, {
      getChildEdges: () => [edge],
      getConnectionConstraint: (_state: unknown, _terminal: unknown, source: boolean) => ({
        point: { x: source ? 0 : 1, y: 0.5 },
      }),
    });
    const controller = (await loadRuntime()).install(harness.options);
    controller.enable();
    const ports = harness.graph.container.querySelectorAll<HTMLButtonElement>(
      ".patent-circuit-quick-wiring-port",
    );
    ports[0]?.click();
    ports[3]?.click();
    expect(harness.statuses.at(-1)).toEqual(["这两个端子已经连接。", "error"]);
    controller.dispose();
  });

  it("renders every visible terminal immediately and marks source and targets", async () => {
    const harness = createControllerHarness();
    const controller = (await loadRuntime()).install(harness.options);

    controller.enable();
    const ports = harness.graph.container.querySelectorAll<HTMLButtonElement>(
      ".patent-circuit-quick-wiring-port",
    );
    expect(ports).toHaveLength(4);
    expect([...ports].every((port) => port.dataset.state === "available")).toBe(true);
    ports[0]?.click();
    expect(ports[0]?.dataset.state).toBe("source");
    expect([...ports].filter((port) => port.dataset.state === "target")).toHaveLength(3);
    expect(harness.statuses.at(-1)).toEqual(["请选择目标连接端子", "info"]);

    controller.dispose();
  });

  it("suspends terminals without losing active state and restores the native handler", async () => {
    const harness = createControllerHarness();
    const controller = (await loadRuntime()).install(harness.options);
    controller.enable();
    expect(harness.connectionHandler.enabled).toBe(false);
    expect(harness.edgeHandler.enabled).toBe(true);

    controller.setBusy(true);
    expect(
      harness.graph.container
        .querySelector(".patent-circuit-quick-wiring-ports")
        ?.getAttribute("data-suspended"),
    ).toBe("true");
    expect(controller.isActive()).toBe(true);
    controller.setBusy(false);
    controller.disable();

    expect(harness.connectionHandler.enabled).toBe(true);
    expect(harness.edgeHandler.enabled).toBe(true);
    expect(
      harness.graph.container.querySelectorAll(".patent-circuit-quick-wiring-port"),
    ).toHaveLength(0);
    controller.dispose();
  });

  it("uses two-level Escape and cleans editor listeners on dispose", async () => {
    const harness = createControllerHarness();
    const controller = (await loadRuntime()).install(harness.options);
    controller.enable();
    harness.graph.container
      .querySelector<HTMLButtonElement>(".patent-circuit-quick-wiring-port")
      ?.click();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(controller.isActive()).toBe(true);
    expect(harness.graph.container.querySelectorAll("[data-state='source']")).toHaveLength(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(controller.isActive()).toBe(false);

    controller.dispose();
    expect([...harness.listeners.values()].every((entries) => entries.size === 0)).toBe(true);
  });

  it("exposes only the approved lifecycle API", async () => {
    const controller = (await loadRuntime()).install(createControllerHarness().options);

    expect(Object.keys(controller).sort()).toEqual([
      "disable",
      "dispose",
      "enable",
      "isActive",
      "setBusy",
      "setEditorMode",
    ]);
    controller.dispose();
  });
});
