// biome-ignore lint/complexity/useArrowFunction: this file is shipped as a classic-script IIFE.
(function (root) {
  // biome-ignore lint/suspicious/noRedundantUseStrict: classic scripts are not modules at runtime.
  "use strict";

  const domain = root.PatentCircuitDomain;
  if (!domain) throw new Error("PATENT_CIRCUIT_DOMAIN_REQUIRED");

  const INVALID_TRANSITION = "INVALID_WIRING_TRANSITION";
  const createStateMachine = () => {
    let state = { phase: "disabled", sourceKey: null };
    return Object.freeze({
      getState: () => Object.freeze({ ...state }),
      enable: () => {
        state = { phase: "ready", sourceKey: null };
      },
      disable: () => {
        state = { phase: "disabled", sourceKey: null };
      },
      selectTerminal: ({ cellId, portId }) => {
        const key = domain.terminalKey(cellId, portId);
        if (state.phase === "ready") {
          state = { phase: "source-selected", sourceKey: key };
          return Object.freeze({ kind: "selected" });
        }
        if (state.phase !== "source-selected") throw new Error(INVALID_TRANSITION);
        if (key === state.sourceKey) return Object.freeze({ kind: "same-terminal" });
        const sourceKey = state.sourceKey;
        state = { phase: "ready", sourceKey: null };
        return Object.freeze({ kind: "connect", sourceKey, targetKey: key });
      },
      cancelSelection: () => {
        if (state.phase === "disabled") throw new Error(INVALID_TRANSITION);
        state = { phase: "ready", sourceKey: null };
      },
      escape: () => {
        if (state.phase === "source-selected") {
          state = { phase: "ready", sourceKey: null };
          return "cancelled-selection";
        }
        state = { phase: "disabled", sourceKey: null };
        return "disabled";
      },
    });
  };

  const createNativeConnectionGuard = (handler) => {
    let captured = false;
    let previousEnabled = false;
    return Object.freeze({
      suspend: () => {
        if (captured || !handler) return;
        previousEnabled = Boolean(handler.isEnabled?.());
        captured = true;
        handler.setEnabled?.(false);
      },
      restore: () => {
        if (!captured || !handler) return;
        handler.setEnabled?.(previousEnabled);
        captured = false;
      },
    });
  };

  const fallbackPorts = Object.freeze([
    Object.freeze({ id: "left", x: 0, y: 0.5 }),
    Object.freeze({ id: "top", x: 0.5, y: 0 }),
    Object.freeze({ id: "right", x: 1, y: 0.5 }),
    Object.freeze({ id: "bottom", x: 0.5, y: 1 }),
  ]);

  const resolvePorts = ({ nativeConstraints = [], makeConstraint }) => {
    if (nativeConstraints.length > 0) {
      return nativeConstraints.map((constraint, index) => {
        const point = constraint.point || { x: 0.5, y: 0.5 };
        return Object.freeze({
          id: constraint.id || `native-${index}`,
          x: Number(point.x),
          y: Number(point.y),
          constraint,
        });
      });
    }
    const createConstraint =
      makeConstraint ||
      ((x, y, id) => {
        const Point = root.mxPoint;
        const Constraint = root.mxConnectionConstraint;
        if (typeof Point === "function" && typeof Constraint === "function") {
          const constraint = new Constraint(new Point(x, y), true);
          constraint.id = id;
          return constraint;
        }
        return { id, point: { x, y }, perimeter: true };
      });
    return fallbackPorts.map(({ id, x, y }) =>
      Object.freeze({ id, x, y, constraint: createConstraint(x, y, id) }),
    );
  };

  const connect = (graph, source, sourcePort, target, targetPort) => {
    const model = graph.getModel();
    const transactionEdit = model.currentEdit;
    const transactionChangeIndex = Array.isArray(transactionEdit?.changes)
      ? transactionEdit.changes.length
      : null;
    let edge = null;
    model.beginUpdate();
    try {
      edge = graph.insertEdge(
        graph.getDefaultParent(),
        null,
        "",
        source,
        target,
        "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;startArrow=none;endArrow=none;jumpStyle=arc;jumpSize=6",
      );
      graph.setConnectionConstraint(edge, source, true, sourcePort.constraint);
      graph.setConnectionConstraint(edge, target, false, targetPort.constraint);
      graph.setSelectionCell(edge);
      return edge;
    } catch (error) {
      if (
        transactionChangeIndex !== null &&
        model.currentEdit === transactionEdit &&
        Array.isArray(transactionEdit.changes)
      ) {
        for (
          let index = transactionEdit.changes.length - 1;
          index >= transactionChangeIndex;
          index -= 1
        ) {
          transactionEdit.changes[index].execute();
        }
        transactionEdit.changes.length = transactionChangeIndex;
      } else if (edge) {
        model.remove(edge);
      }
      throw error;
    } finally {
      model.endUpdate();
    }
  };

  const terminalPairKey = (left, right) => [left, right].sort(domain.stableCompareId).join("<->");
  const isDuplicateTerminalPair = (existingPairs, left, right) =>
    new Set(existingPairs).has(terminalPairKey(left, right));

  const install = ({ editorUi, onStatus, onActiveChange, document, window }) => {
    const graph = editorUi.editor.graph;
    const model = graph.getModel();
    const doc = document || root.document;
    const win = window || root;
    const machine = createStateMachine();
    const nativeConnection = createNativeConnectionGuard(graph.connectionHandler);
    const cleanup = [];
    let editorMode = "circuit";
    let disposed = false;
    let busy = false;
    let selectedSource = null;
    let terminals = [];

    const portLayer = doc.createElement("div");
    portLayer.className = "patent-circuit-quick-wiring-ports";
    portLayer.style.position = "absolute";
    portLayer.style.inset = "0";
    portLayer.style.pointerEvents = "none";
    portLayer.dataset.suspended = "false";
    graph.container.appendChild(portLayer);

    const listenDom = (target, type, listener, options) => {
      target.addEventListener(type, listener, options);
      cleanup.push(() => target.removeEventListener(type, listener, options));
    };
    const listenMx = (target, type, listener) => {
      if (!target || typeof target.addListener !== "function") return;
      target.addListener(type, listener);
      cleanup.push(() => target.removeListener(listener));
    };
    const active = () => !disposed && machine.getState().phase !== "disabled";
    const notifyActive = () => onActiveChange(active());
    const isConnectable = (cell) =>
      Boolean(
        cell &&
          model.isVertex(cell) &&
          model.isVisible(cell) &&
          !graph.isCellLocked(cell) &&
          (!model.contains || model.contains(cell)),
      );
    const nativeConstraintsFor = (cell) => {
      const style = String(model.getStyle?.(cell) || cell.style || "");
      if (!domain.isCircuitStyle(style)) return [];
      const state = graph.view.getState(cell);
      return state && graph.getAllConnectionConstraints
        ? graph.getAllConnectionConstraints(state, true) || []
        : [];
    };
    const visibleVertices = () =>
      (graph.getChildVertices?.(graph.getDefaultParent()) || [])
        .filter(isConnectable)
        .sort((left, right) => domain.stableCompareId(String(left.id), String(right.id)));
    const updateTerminalStates = () => {
      const sourceKey = machine.getState().sourceKey;
      for (const terminal of terminals) {
        terminal.button.dataset.state = sourceKey
          ? terminal.key === sourceKey
            ? "source"
            : "target"
          : "available";
      }
    };
    const positionTerminals = () => {
      for (const terminal of terminals) {
        const state = graph.view.getState(terminal.cell);
        if (!state) {
          terminal.button.hidden = true;
          continue;
        }
        const point = graph.getConnectionPoint(state, terminal.port.constraint);
        terminal.button.hidden = !point;
        if (!point) continue;
        terminal.button.style.left = `${point.x}px`;
        terminal.button.style.top = `${point.y}px`;
      }
    };
    const clearTerminals = () => {
      terminals = [];
      portLayer.replaceChildren();
    };
    const terminalByKey = (key) => terminals.find((terminal) => terminal.key === key) || null;
    const constraintKey = (cell, constraint) =>
      constraint?.point
        ? domain.terminalKey(
            String(cell.id),
            `${constraint.point.x},${constraint.point.y},${constraint.dx || 0},${constraint.dy || 0}`,
          )
        : null;
    const existingPairKeys = () => {
      const result = new Set();
      for (const edge of graph.getChildEdges?.(graph.getDefaultParent()) || []) {
        const source = model.getTerminal?.(edge, true) || edge.source;
        const target = model.getTerminal?.(edge, false) || edge.target;
        if (!source || !target) continue;
        const edgeState = graph.view.getState(edge);
        if (!edgeState) continue;
        const sourceConstraint = graph.getConnectionConstraint(edgeState, source, true);
        const targetConstraint = graph.getConnectionConstraint(edgeState, target, false);
        const sourceId = constraintKey(source, sourceConstraint);
        const targetId = constraintKey(target, targetConstraint);
        if (!sourceId || !targetId) continue;
        result.add(terminalPairKey(sourceId, targetId));
      }
      return result;
    };
    const renderAllTerminals = () => {
      clearTerminals();
      if (!active() || busy) return;
      for (const cell of visibleVertices()) {
        const ports = resolvePorts({ nativeConstraints: nativeConstraintsFor(cell) });
        for (const port of ports) {
          const key = domain.terminalKey(String(cell.id), port.id);
          const button = doc.createElement("button");
          button.type = "button";
          button.className = "patent-circuit-quick-wiring-port";
          button.dataset.terminalKey = key;
          button.dataset.state = "available";
          button.setAttribute("aria-label", `连接端子 ${String(cell.id)} ${port.id}`);
          const label = String(graph.convertValueToString?.(cell) || "元件")
            .replace(/<[^>]*>/g, "")
            .trim();
          const portLabel =
            { left: "左端", right: "右端", top: "上端", bottom: "下端" }[port.id] ||
            (/^native-\d+$/.test(port.id) ? `引脚 ${Number(port.id.slice(7)) + 1}` : port.id);
          button.title = `${label} · ${portLabel}`;
          button.setAttribute("aria-description", button.title);
          button.style.position = "absolute";
          button.style.pointerEvents = "auto";
          const terminal = { key, cell, port, button };
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!active() || busy) return;
            const result = machine.selectTerminal({ cellId: String(cell.id), portId: port.id });
            if (result.kind === "selected") {
              selectedSource = terminal;
              updateTerminalStates();
              onStatus("请选择目标连接端子", "info");
              return;
            }
            if (result.kind === "same-terminal") {
              onStatus("不能将端子连接到自身。", "error");
              updateTerminalStates();
              return;
            }
            const source = terminalByKey(result.sourceKey) || selectedSource;
            if (!source || !isConnectable(source.cell) || !isConnectable(cell)) {
              machine.cancelSelection();
              selectedSource = null;
              updateTerminalStates();
              onStatus("连接端子已失效，请重新选择。", "error");
              return;
            }
            if (
              isDuplicateTerminalPair(
                existingPairKeys(),
                constraintKey(source.cell, source.port.constraint),
                constraintKey(cell, port.constraint),
              )
            ) {
              selectedSource = null;
              updateTerminalStates();
              onStatus("这两个端子已经连接。", "error");
              return;
            }
            try {
              connect(graph, source.cell, source.port, cell, port);
              selectedSource = null;
              renderAllTerminals();
              onStatus("请选择起始连接端子", "info");
            } catch (_error) {
              machine.cancelSelection();
              selectedSource = null;
              renderAllTerminals();
              onStatus("快捷连线失败，请重新选择两个连接端子。", "error");
            }
          });
          terminals.push(terminal);
          portLayer.appendChild(button);
        }
      }
      positionTerminals();
      updateTerminalStates();
    };
    const disable = () => {
      machine.disable();
      selectedSource = null;
      clearTerminals();
      nativeConnection.restore();
      onStatus("", "info");
      notifyActive();
    };
    const enable = () => {
      if (disposed || editorMode !== "circuit") return;
      machine.enable();
      selectedSource = null;
      nativeConnection.suspend();
      renderAllTerminals();
      onStatus("请选择起始连接端子", "info");
      notifyActive();
    };
    const setBusy = (nextBusy) => {
      busy = Boolean(nextBusy);
      portLayer.dataset.suspended = String(busy);
      if (!busy && active()) renderAllTerminals();
    };
    const graphPoint = (event) =>
      root.mxUtils?.convertPoint
        ? root.mxUtils.convertPoint(graph.container, event.clientX, event.clientY)
        : { x: event.clientX, y: event.clientY };
    const onPointerDown = (event) => {
      if (!active() || busy || event.target.closest?.(".patent-circuit-quick-wiring-port")) return;
      const point = graphPoint(event);
      const cell = graph.getCellAt?.(point.x, point.y);
      if (cell && model.isEdge?.(cell)) {
        portLayer.dataset.suspended = "true";
        return;
      }
      if (!cell && machine.getState().phase === "source-selected") {
        machine.cancelSelection();
        selectedSource = null;
        updateTerminalStates();
        onStatus("请选择起始连接端子", "info");
      }
    };
    const restoreAfterPointer = () => {
      if (!busy) portLayer.dataset.suspended = "false";
    };
    const onKeyDown = (event) => {
      if (!active() || event.key !== "Escape") return;
      const result = machine.escape();
      selectedSource = null;
      if (result === "disabled") {
        clearTerminals();
        nativeConnection.restore();
        onStatus("", "info");
        notifyActive();
      } else {
        updateTerminalStates();
        onStatus("请选择起始连接端子", "info");
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const resetForEditorChange = () => {
      if (active()) disable();
    };

    listenDom(graph.container, "pointerdown", onPointerDown);
    listenDom(win, "pointerup", restoreAfterPointer, true);
    listenDom(win, "pointercancel", restoreAfterPointer, true);
    listenDom(win, "keydown", onKeyDown, true);
    listenDom(win, "resize", positionTerminals);
    listenDom(graph.container, "scroll", positionTerminals, true);
    listenMx(graph.view, "scale", renderAllTerminals);
    listenMx(graph.view, "translate", renderAllTerminals);
    listenMx(model, "change", renderAllTerminals);
    listenMx(editorUi.editor, "pageSelected", resetForEditorChange);
    listenMx(editorUi.editor, "fileLoaded", resetForEditorChange);

    return Object.freeze({
      enable,
      disable,
      setBusy,
      setEditorMode: (mode) => {
        editorMode = mode;
        if (mode !== "circuit" && active()) disable();
      },
      dispose: () => {
        if (disposed) return;
        disable();
        disposed = true;
        while (cleanup.length > 0) cleanup.pop()();
        portLayer.remove();
      },
      isActive: active,
    });
  };

  root.PatentCircuitQuickWiring = Object.freeze({
    createStateMachine,
    createNativeConnectionGuard,
    terminalPairKey,
    isDuplicateTerminalPair,
    resolvePorts,
    connect,
    install,
  });
})(globalThis);
