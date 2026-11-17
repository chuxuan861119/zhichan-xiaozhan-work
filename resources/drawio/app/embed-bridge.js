(() => {
  const adapterOrigin = "patent-diagram://editor";
  let editorUi = null;
  let sessionStore = null;
  const createSessionStore = function createDrawioSessionStore(ui) {
  // Keep native cells/edits by identity: undo changes contain references (including
  // deleted cells and pages), which XML export cannot represent. Only the active
  // graph/view/handlers exist; parked sessions contain document data, not editors.
  const sessions = new Map();
  let active = null;
  let editing = null;
  const graph = ui.editor.graph;
  const manager = ui.editor.undoManager;
  const initialVertexStyle = { ...graph.currentVertexStyle };
  const initialEdgeStyle = { ...graph.currentEdgeStyle };
  function capture() {
    if (!active || !ui.currentPage) return;
    ui.currentPage.root = graph.model.root;
    ui.currentPage.viewState = graph.getViewState();
    sessions.set(active, {
      pages: ui.pages,
      currentPage: ui.currentPage,
      fileNode: ui.fileNode,
      fileVars: ui.fileVars,
      fileVarsStr: ui.fileVarsStr,
      history: manager.history,
      index: manager.indexOfNextAdd,
      selection: graph.getSelectionCells(),
      parent: graph.getDefaultParent(),
      prefix: graph.model.prefix,
      nextId: graph.model.nextId,
      vertexStyle: { ...graph.currentVertexStyle },
      edgeStyle: { ...graph.currentEdgeStyle },
      modified: ui.editor.modified,
      editing,
      dialogs: ui.dialogs ?? [],
    });
  }
  return {
    activate(key) {
      capture();
      // Native load/page-change can add edits BEFORE clearing its undo manager.
      // Detach the parked array first, otherwise it truncates the previous
      // patent's redo branch and appends edits from the next document.
      manager.history = [];
      manager.indexOfNextAdd = 0;
      for (const dialog of ui.dialogs ?? []) {
        dialog.container.hidden = true;
        if (dialog.bg) dialog.bg.hidden = true;
      }
      ui.dialogs = [];
      ui.dialog = null;
      const saved = sessions.get(key);
      active = key;
      editing = null;
      if (!saved) {
        graph.currentVertexStyle = { ...initialVertexStyle };
        graph.currentEdgeStyle = { ...initialEdgeStyle };
        return false;
      }
      ui.pages = saved.pages;
      ui.fileNode = saved.fileNode;
      ui.fileVars = saved.fileVars;
      ui.fileVarsStr = saved.fileVarsStr;
      // Use the native page handoff, including its SelectPage event payload.
      // Native page/format handlers depend on that payload; a bare ROOT event
      // is not a substitute and can leave the restored view half-initialized.
      ui.selectPage(saved.currentPage, true);
      graph.model.prefix = saved.prefix;
      graph.model.nextId = saved.nextId;
      graph.setDefaultParent(saved.parent);
      graph.currentVertexStyle = { ...saved.vertexStyle };
      graph.currentEdgeStyle = { ...saved.edgeStyle };
      manager.history = saved.history;
      manager.indexOfNextAdd = saved.index;
      ui.editor.modified = saved.modified;
      ui.dialogs = saved.dialogs;
      ui.dialog = saved.dialogs.at(-1) ?? null;
      for (const dialog of saved.dialogs) {
        dialog.container.hidden = false;
        if (dialog.bg) dialog.bg.hidden = false;
      }
      graph.setSelectionCells(saved.selection);
      ui.updateActionStates();
      if (saved.editing) {
        const draft = saved.editing;
        requestAnimationFrame(() => {
          if (active !== key) return;
          graph.startEditingAtCell(draft.cell);
          const textarea = graph.cellEditor?.textarea;
          if (!textarea || draft.start == null) return;
          const walker = document.createTreeWalker(textarea, NodeFilter.SHOW_TEXT);
          let offset = 0,
            start = null,
            end = null;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const length = node.textContent.length;
            if (!start && draft.start <= offset + length) start = [node, draft.start - offset];
            if (!end && draft.end <= offset + length) end = [node, draft.end - offset];
            offset += length;
          }
          if (start && end) {
            const range = document.createRange();
            range.setStart(...start);
            range.setEnd(...end);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          }
        });
      }
      return true;
    },
    preserveEditing() {
      const cell = graph.cellEditor?.editingCell;
      editing = cell ? { cell } : null;
      const textarea = graph.cellEditor?.textarea;
      const selection = typeof window !== "undefined" ? window.getSelection() : null;
      if (!editing || !textarea || !selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!textarea.contains(range.startContainer) || !textarea.contains(range.endContainer))
        return;
      const prefix = range.cloneRange();
      prefix.selectNodeContents(textarea);
      prefix.setEnd(range.startContainer, range.startOffset);
      editing.start = prefix.toString().length;
      editing.end = editing.start + range.toString().length;
    },
    drop(key) {
      const saved = sessions.get(key);
      const dialogs = active === key ? ui.dialogs : saved?.dialogs;
      for (const dialog of dialogs ?? []) {
        // Closing a patent releases dormant dialog DOM/listeners, but must not
        // invoke callbacks against the different document now in the graph.
        dialog.onDialogClose = null;
        dialog.close(true);
      }
      sessions.delete(key);
      if (active === key) {
        active = null;
        ui.dialogs = [];
        ui.dialog = null;
      }
    },
  };
}
;
  const editorModes = new Set(["flowchart", "circuit"]);
  const modeLibraries = { flowchart: "general;basic;arrows2;flowchart;er;uml", circuit: "electrical" };
  let editorMode = "flowchart";
  let quickWiring = null;
  let componentPolicy = null;
  let drawingTools = null;
  const toolbarActions = new Set(["toggle-project-menu", "save", "export-external", "export-to-description-drawing", "replace-description-drawing", "project-create", "project-import", "project-rename", "project-duplicate", "project-delete", "cycle-tab-next", "cycle-tab-previous"]);
  const projectFileActions = [["新建流程图", "project-create"], ["导入流程图", "project-import"], ["重命名当前流程图", "project-rename"], ["复制当前流程图", "project-duplicate"], ["删除当前流程图", "project-delete"]];
  const pendingToolbarActions = new Map();
  const toolbarActionRetryDelays = [250, 750, 1500];
  let toolbarActionSequence = 0;
  let toolbarState = { projectName: "流程图", activePageName: null, saveStatus: "loading", dirty: false, saveBusy: false, exportBusy: false, canUndo: false, canRedo: false, canReplaceDrawing: false };
  let toolbarElements = null;
  let tooltipTimer = null;
  let tooltipNode = null;
  let tooltipAnchor = null;
  const hideToolbarTooltip = () => {
    window.clearTimeout(tooltipTimer);
    if (tooltipAnchor) tooltipAnchor.removeAttribute("aria-describedby");
    if (tooltipNode) tooltipNode.remove();
    tooltipNode = null;
    tooltipAnchor = null;
  };
  const showToolbarTooltip = (anchor) => {
    hideToolbarTooltip();
    if (!anchor.isConnected || !anchor.dataset.tooltip) return;
    const tooltip = document.createElement("div");
    tooltip.className = "patent-toolbar-tooltip";
    tooltip.id = "patent-toolbar-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = anchor.dataset.tooltip;
    document.body.appendChild(tooltip);
    const control = anchor.getBoundingClientRect();
    const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = Math.max(8, Math.min(control.left, window.innerWidth - bounds.width - 8)) + "px";
    tooltip.style.top = Math.max(8, control.bottom + bounds.height + 8 <= window.innerHeight ? control.bottom + 6 : control.top - bounds.height - 6) + "px";
    anchor.setAttribute("aria-describedby", tooltip.id);
    tooltipNode = tooltip;
    tooltipAnchor = anchor;
  };
  const installToolbarTooltip = (element, label) => {
    element.dataset.tooltip = label;
    element.addEventListener("pointerenter", () => {
      hideToolbarTooltip();
      tooltipTimer = window.setTimeout(() => showToolbarTooltip(element), 500);
    });
    element.addEventListener("focus", () => showToolbarTooltip(element));
    for (const event of ["pointerleave", "blur", "click"]) element.addEventListener(event, hideToolbarTooltip);
    element.addEventListener("keydown", (event) => { if (event.key === "Escape") hideToolbarTooltip(); });
  };
  window.addEventListener("blur", hideToolbarTooltip);
  window.addEventListener("resize", hideToolbarTooltip);
  const setToolbarIcon = (button, paths) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries({viewBox:"0 0 24 24",width:"18",height:"18",fill:"none",stroke:"currentColor","stroke-width":"2","stroke-linecap":"round","stroke-linejoin":"round","aria-hidden":"true",focusable:"false"})) svg.setAttribute(name, value);
    for (const d of paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    button.replaceChildren(svg);
  };
  const createToolbarButton = (label, className, action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "patent-toolbar__button " + (className || "");
    button.textContent = label;
    button.setAttribute("aria-label", label);
    installToolbarTooltip(button, label);
    if (action) button.addEventListener("click", action);
    return button;
  };
  const emitToolbarAction = (action) => {
    if (!toolbarActions.has(action)) return;
    const graph = editorUi && editorUi.editor && editorUi.editor.graph;
    if (graph && typeof graph.stopEditing === "function") graph.stopEditing(false);
    toolbarActionSequence += 1;
    const actionId = "toolbar-" + Date.now().toString(36) + "-" + toolbarActionSequence.toString(36);
    const pending = { action, actionId, attempt: 0, timer: null };
    const send = () => {
      window.parent.postMessage(JSON.stringify({ event: "toolbar-action", action, actionId }), adapterOrigin);
      const delay = toolbarActionRetryDelays[pending.attempt];
      pending.attempt += 1;
      if (delay === undefined) { pendingToolbarActions.delete(actionId); return; }
      pending.timer = window.setTimeout(send, delay);
    };
    pendingToolbarActions.set(actionId, pending);
    send();
  };
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      emitToolbarAction(event.shiftKey ? "cycle-tab-previous" : "cycle-tab-next");
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    event.stopPropagation();
    emitToolbarAction("save");
  }, true);
  const renderEditorMode = () => {
    if (!toolbarElements) return;
    for (const [mode, button] of Object.entries(toolbarElements.modes)) {
      const active = mode === editorMode;
      button.dataset.active = String(active);
      button.setAttribute("aria-pressed", String(active));
      button.disabled = !editorUi || !editorUi.sidebar;
    }
    const circuitVisible = editorMode === "circuit" && Boolean(quickWiring && componentPolicy);
    for (const element of [toolbarElements.circuitDivider, toolbarElements.circuitTools]) {
      if (!element) continue;
      element.hidden = !circuitVisible;
      element.dataset.visible = String(circuitVisible);
    }
  };
  const applyEditorMode = (mode, report = true) => {
    if (!editorModes.has(mode) || !editorUi || !editorUi.sidebar || typeof editorUi.sidebar.showEntries !== "function") return false;
    const previousMode = editorMode;
    try {
      editorUi.sidebar.showEntries(modeLibraries[mode], false, true);
      editorMode = mode;
      if (quickWiring) quickWiring.setEditorMode(mode);
      if (componentPolicy) componentPolicy.setEditorMode(mode);
      if (drawingTools) drawingTools.applyMode(mode);
      renderEditorMode();
      if (report) window.parent.postMessage(JSON.stringify({ event: "editor-mode", mode }), adapterOrigin);
      return true;
    } catch {
      editorMode = previousMode;
      renderEditorMode();
      window.parent.postMessage(JSON.stringify({ event: "editor-mode-error", code: "LIBRARY_MODE_FAILED" }), adapterOrigin);
      return false;
    }
  };
  const renderToolbarState = () => {
    if (!toolbarElements) return;
    toolbarElements.projectName.textContent = toolbarState.projectName;
    toolbarElements.projectName.dataset.tooltip = toolbarState.projectName;
    toolbarElements.page.textContent = toolbarState.activePageName || "页面未就绪";
    const statusText = { loading: "编辑器加载中", saved: "已保存", dirty: "未保存", saving: "保存中", error: "保存失败" }[toolbarState.saveStatus] || "编辑器加载中";
    toolbarElements.status.textContent = statusText;
    toolbarElements.status.dataset.status = toolbarState.saveStatus;
    toolbarElements.undo.disabled = !toolbarState.canUndo;
    toolbarElements.redo.disabled = !toolbarState.canRedo;
    toolbarElements.save.disabled = !toolbarState.dirty || toolbarState.saveBusy;
    toolbarElements.external.disabled = toolbarState.exportBusy;
    toolbarElements.drawing.disabled = toolbarState.exportBusy;
    toolbarElements.replacement.disabled = toolbarState.exportBusy || !toolbarState.canReplaceDrawing;
  };
  const installPatentToolbar = (ui) => {
    const fileMenu = ui.menus && ui.menus.get("file");
    if (fileMenu && typeof fileMenu.funct === "function" && !fileMenu.patentProjectActions) {
      const originalFileMenu = fileMenu.funct;
      fileMenu.funct = function (menu, parent) {
        for (const [label, action] of projectFileActions) menu.addItem(label, null, () => emitToolbarAction(action), parent);
        menu.addSeparator(parent);
        return originalFileMenu.apply(this, arguments);
      };
      fileMenu.patentProjectActions = true;
    }
    const menubar = document.querySelector(".geMenubarContainer");
    if (!menubar || menubar.classList.contains("patent-toolbar")) return;
    const nativeMenus = Array.from(menubar.children);
    menubar.classList.add("patent-toolbar");
    menubar.setAttribute("role", "toolbar");
    menubar.setAttribute("aria-label", "流程图工具栏");
    const project = document.createElement("div"); project.className = "patent-toolbar__project";
    const list = createToolbarButton("工程列表", "patent-toolbar__icon", () => emitToolbarAction("toggle-project-menu")); list.textContent = "☰";
    const projectName = document.createElement("strong"); projectName.className = "patent-toolbar__project-name";
    installToolbarTooltip(projectName, toolbarState.projectName);
    const page = document.createElement("span"); page.className = "patent-toolbar__page";
    project.append(list, projectName, page);
    const dividerLeft = document.createElement("span"); dividerLeft.className = "patent-toolbar__divider";
    const modeSwitch = document.createElement("div"); modeSwitch.className = "patent-toolbar__mode-switch"; modeSwitch.setAttribute("role", "group"); modeSwitch.setAttribute("aria-label", "绘图模式");
    const flowchartMode = createToolbarButton("流程图", "patent-toolbar__mode", () => applyEditorMode("flowchart"));
    const circuitMode = createToolbarButton("电路图", "patent-toolbar__mode", () => applyEditorMode("circuit"));
    modeSwitch.append(flowchartMode, circuitMode);
    const dividerMode = document.createElement("span"); dividerMode.className = "patent-toolbar__divider";
    const menus = document.createElement("div"); menus.className = "patent-toolbar__menus"; menus.append(...nativeMenus);
    const editorToolbar = document.querySelector(".geToolbarContainer");
    const freehandButton = Array.from(editorToolbar ? editorToolbar.querySelectorAll("[title],[aria-label]") : []).find((element) => ((element.getAttribute("title") || element.getAttribute("aria-label") || "").startsWith("自由绘图")));
    const dividerRight = document.createElement("span"); dividerRight.className = "patent-toolbar__divider patent-toolbar__circuit-divider"; dividerRight.hidden = true; dividerRight.dataset.visible = "false";
    const circuitTools = document.createElement("div"); circuitTools.className = "patent-toolbar__circuit-tools"; circuitTools.hidden = true; circuitTools.setAttribute("role", "group"); circuitTools.setAttribute("aria-label", "电路工具");
    const circuitLabel = document.createElement("span"); circuitLabel.className = "patent-toolbar__circuit-label"; circuitLabel.textContent = "电路工具";
    const wiringStatus = document.createElement("span"); wiringStatus.className = "patent-toolbar__circuit-status"; wiringStatus.setAttribute("aria-live", "polite");
    const quickWiringButton = createToolbarButton("快捷连线", "patent-toolbar__quick-wiring", () => { if (!quickWiring) return; if (quickWiring.isActive()) quickWiring.disable(); else quickWiring.enable(); }); quickWiringButton.setAttribute("aria-pressed", "false");
    circuitTools.append(circuitLabel, quickWiringButton, wiringStatus);
    if (freehandButton) freehandButton.after(dividerRight, circuitTools);
    else if (editorToolbar) editorToolbar.append(dividerRight, circuitTools);
    const actions = document.createElement("div"); actions.className = "patent-toolbar__actions";
    const status = document.createElement("span"); status.className = "patent-toolbar__status"; status.setAttribute("aria-live", "polite");
    const undo = createToolbarButton("撤销", "patent-toolbar__icon", () => { const item = ui.actions.get("undo"); if (item && item.funct && (!item.isEnabled || item.isEnabled())) item.funct(); }); setToolbarIcon(undo, ["M9 14 4 9l5-5", "M4 9h10a6 6 0 0 1 0 12h-2"]); undo.dataset.tooltip = "撤销 (" + (typeof mxClient !== "undefined" && mxClient.IS_MAC ? "⌘Z" : "Ctrl+Z") + ")";
    const redo = createToolbarButton("重做", "patent-toolbar__icon", () => { const item = ui.actions.get("redo"); if (item && item.funct && (!item.isEnabled || item.isEnabled())) item.funct(); }); setToolbarIcon(redo, ["m15 14 5-5-5-5", "M20 9H10a6 6 0 0 0 0 12h2"]); redo.dataset.tooltip = "重做 (" + (typeof mxClient !== "undefined" && mxClient.IS_MAC ? "⌘⇧Z" : "Ctrl+Y") + ")";
    const save = createToolbarButton("保存", "patent-toolbar__save", () => emitToolbarAction("save"));
    const external = createToolbarButton("导出至电脑", "patent-toolbar__export-computer", () => emitToolbarAction("export-external"));
    const replacement = createToolbarButton("替换附图", "", () => emitToolbarAction("replace-description-drawing"));
    const drawing = createToolbarButton("插入附图", "patent-toolbar__button--primary", () => emitToolbarAction("export-to-description-drawing"));
    actions.append(status, undo, redo, save, external, replacement, drawing); menubar.append(project, dividerLeft, modeSwitch, dividerMode, menus, actions);
    toolbarElements = { projectName, page, status, undo, redo, save, external, replacement, drawing, circuitDivider: dividerRight, circuitTools, quickWiringButton, wiringStatus, modes: { flowchart: flowchartMode, circuit: circuitMode } };
    renderToolbarState();
    renderEditorMode();
  };
  const installBridge = () => {
    if (typeof EditorUi !== "function" || typeof EditorUi.prototype.init !== "function") return false;
    if (typeof EditorUi.prototype.isPageInsertTabVisible === "function") {
      EditorUi.prototype.isPageInsertTabVisible = () => false;
    }
    const originalInit = EditorUi.prototype.init;
    EditorUi.prototype.init = function () {
      const result = originalInit.apply(this, arguments);
      // Restrict user commands, not insertPage itself: loading, restoring and
      // deleting the last page also rely on the underlying page machinery.
      for (const name of ["insertPage", "duplicatePage"]) {
        const action = this.actions.get(name);
        if (action && typeof action.setEnabled === "function") {
          action.setVisible(false);
          action.setEnabled(false);
          action.isEnabled = () => false;
          action.funct = () => {};
        }
      }
      editorUi = this;
      sessionStore = createSessionStore(this);
      installPatentToolbar(this);
      if (drawingTools) drawingTools.dispose();
      drawingTools = null;
      if (quickWiring) quickWiring.dispose();
      if (componentPolicy) componentPolicy.dispose();
      quickWiring = null;
      componentPolicy = null;
      try {
        quickWiring = PatentCircuitQuickWiring.install({ editorUi: this, document, window, onStatus: (message, status) => { if (!toolbarElements) return; toolbarElements.wiringStatus.textContent = message; toolbarElements.wiringStatus.dataset.status = status; }, onActiveChange: (active) => { if (toolbarElements) toolbarElements.quickWiringButton.setAttribute("aria-pressed", String(active)); } });
        componentPolicy = PatentCircuitComponentPolicy.install({ editorUi: this });
        if (typeof PatentDrawingTools !== "undefined") drawingTools = PatentDrawingTools.install({editorUi:this,document,window});
      } catch {
        if (toolbarElements) toolbarElements.circuitTools.hidden = true;
        window.parent.postMessage(JSON.stringify({ event: "editor-mode-error", code: "LIBRARY_MODE_FAILED" }), adapterOrigin);
      }
      applyEditorMode("flowchart");
      const graph = this.editor && this.editor.graph;
      const reportHistory = () => {
        const canUndo = Boolean(graph.isEnabled() && this.canUndo());
        const canRedo = Boolean(graph.isEnabled() && this.canRedo());
        window.parent.postMessage(JSON.stringify({ event: "history-state", canUndo, canRedo }), adapterOrigin);
      };
      // Model CHANGE fires before its edit is added to the undo manager. Read
      // after the actual history mutation, including clear and redo-only changes.
      const manager = this.editor.undoManager;
      for (const event of [mxEvent.ADD, mxEvent.UNDO, mxEvent.REDO, mxEvent.CLEAR])
        manager.addListener(event, reportHistory);
      graph.addListener(mxEvent.EDITING_STARTED, reportHistory);
      graph.addListener(mxEvent.EDITING_STOPPED, reportHistory);
      if (graph && graph.getSelectionModel && graph.getSelectionCount) {
        const reportSelection = () => {
          const selectedCellIds = graph.getSelectionCells().map((cell) => String(cell.id)).filter((id) => id.length > 0 && id.length <= 500).slice(0, 50000);
          window.parent.postMessage(JSON.stringify({ event: "selection", selectionCount: selectedCellIds.length, selectedCellIds }), adapterOrigin);
        };
        graph.getSelectionModel().addListener(mxEvent.CHANGE, reportSelection);
        reportSelection();
      }
      reportHistory();
      const reportPages = () => {
        const editorPages = Array.isArray(this.pages) ? this.pages.slice(0, 100) : [];
        const reportedPages = editorPages.map((page, index) => ({
          id: String(page && page.getId ? page.getId() : "page-" + index),
          name: String((page && page.getName ? page.getName() : null) || "第" + (index + 1) + "页"),
        }));
        const activePageId = this.currentPage && this.currentPage.getId ? String(this.currentPage.getId()) : null;
        window.parent.postMessage(JSON.stringify({ event: "pages", pages: reportedPages, activePageId }), adapterOrigin);
      };
      this.editor.addListener("pageSelected", reportPages);
      this.editor.addListener("pageRenamed", reportPages);
      this.editor.addListener("pageMoved", reportPages);
      this.editor.addListener("pagesPatched", reportPages);
      this.editor.addListener("fileLoaded", reportPages);
      return result;
    };
    return true;
  };
  if (!installBridge()) window.addEventListener("load", installBridge, { once: true });
  window.addEventListener("beforeunload", () => { hideToolbarTooltip(); window.removeEventListener("blur", hideToolbarTooltip); window.removeEventListener("resize", hideToolbarTooltip); for (const pending of pendingToolbarActions.values()) window.clearTimeout(pending.timer); pendingToolbarActions.clear(); if (drawingTools) drawingTools.dispose(); if (quickWiring) quickWiring.dispose(); if (componentPolicy) componentPolicy.dispose(); drawingTools = null; quickWiring = null; componentPolicy = null; });
  const exportSelectionSource = () => {
    const graph = editorUi && editorUi.editor && editorUi.editor.graph;
    let cells = graph && graph.getSelectionCells ? graph.getSelectionCells() : [];
    const parent = window.parent;
    const sendExport = (payload) => parent.postMessage(JSON.stringify({ event: "export", format: "xml", ...payload }), adapterOrigin);
    if (!graph || cells.length === 0) { sendExport({}); return; }
    try {
      const codec = new mxCodec(mxUtils.createXmlDocument());
      codec.isObjectIgnored = (value) => value.constructor === mxCell && !graph.model.isRoot(value) && !graph.model.isLayer(value) && !graph.isCellSelected(value) && !graph.isAncestorSelected(value);
      const model = codec.encode(graph.getModel());
      model.ownerDocument.appendChild(model);
      sendExport({ xml: mxUtils.getXml(model) });
    } catch { sendExport({}); }
  };
  const removeUnsafeSvgTextContainers = (svgRoot) => {
    const warningLinks = Array.from(svgRoot.getElementsByTagName("a"));
    for (const link of warningLinks) {
      const href = link.getAttribute("href") || link.getAttribute("xlink:href");
      if (href === Graph.foreignObjectWarningLink && link.parentNode) link.parentNode.removeChild(link);
    }
    // Never silently discard labels when the engine cannot convert their rich text.
    if (svgRoot.getElementsByTagName("foreignObject").length > 0) return false;
    for (const link of Array.from(svgRoot.getElementsByTagName("a"))) {
      const replacement = svgRoot.ownerDocument.createElementNS(mxConstants.NS_SVG, "g");
      while (link.firstChild) replacement.appendChild(link.firstChild);
      link.parentNode?.replaceChild(replacement, link);
    }
    for (const choice of Array.from(svgRoot.getElementsByTagName("switch"))) {
      const replacement = svgRoot.ownerDocument.createElementNS(mxConstants.NS_SVG, "g");
      while (choice.firstChild) replacement.appendChild(choice.firstChild);
      choice.parentNode?.replaceChild(replacement, choice);
    }
    for (const element of Array.from(svgRoot.getElementsByTagName("*"))) {
      element.removeAttribute("requiredFeatures");
    }
    return svgRoot.getElementsByTagName("foreignObject").length === 0 && svgRoot.getElementsByTagName("switch").length === 0 && svgRoot.getElementsByTagName("a").length === 0;
  };
  const exportPatentSvg = async (selectionOnly, allPages = false, pageId, selectedCellIds) => {
    const graph = editorUi && editorUi.editor && editorUi.editor.graph;
    let cells = graph && graph.getSelectionCells ? graph.getSelectionCells() : [];
    const parent = window.parent;
    const sendExport = (payload) => parent.postMessage(JSON.stringify({ event: "export", format: "svg", ...payload }), adapterOrigin);
    if (!graph) { sendExport({}); return; }
    if (pageId !== undefined) {
      const pages = Array.isArray(editorUi.pages) ? editorUi.pages : [];
      let page = pages.find(candidate => candidate && candidate.getId && String(candidate.getId()) === pageId);
      if (!page && /^page-[0-9]+$/.test(pageId)) page = pages[Number(pageId.slice(5))];
      if (!page) { sendExport({}); return; }
      editorUi.selectPage(page);
    }
    if (selectedCellIds !== undefined) {
      cells = selectedCellIds.map(id => graph.getModel().getCell(id));
      if (!selectionOnly || allPages || new Set(selectedCellIds).size !== selectedCellIds.length || cells.some(cell => !cell || (!cell.vertex && !cell.edge))) { sendExport({}); return; }
      graph.setSelectionCells(cells);
    }
    if (selectionOnly && cells.length === 0) { sendExport({}); return; }
    const originalCreateSvgCanvas = graph.createSvgCanvas;
    const originalPage = editorUi.currentPage;
    const output = [];
    try {
      graph.createSvgCanvas = function () {
        const canvas = originalCreateSvgCanvas.apply(this, arguments);
        canvas.allowConvertHtmlToSvg = true;
        // mxText.configureCanvas resets this flag from each cell's style. Export must
        // retain conversion even for ordinary editable HTML labels, without editing cells.
        Object.defineProperty(canvas, "allowConvertHtmlToSvg", { get: () => true, set: () => {} });
        return canvas;
      };
      const targets = allPages && editorUi.pages && editorUi.pages.length ? editorUi.pages.slice() : [null];
      for (const target of targets) {
      if (target && target !== editorUi.currentPage) editorUi.selectPage(target);
      const background = graph.background === mxConstants.NONE ? null : graph.background;
      const svgRoot = graph.getSvg(background, 1, 0, false, true, !selectionOnly, true, null, null, graph.shadowVisible, null, "auto", selectionOnly ? "selectionOnly" : "diagram", selectionOnly ? cells : null, null, true);
      if (!removeUnsafeSvgTextContainers(svgRoot)) { sendExport({}); return; }
      const data = await new Promise(resolve => editorUi.editor.convertImages(svgRoot, convertedSvg => resolve(Editor.createSvgDataUri(mxUtils.getXml(convertedSvg)))));
      output.push(data);
      }
      sendExport({ data: allPages ? JSON.stringify(output) : output[0] });
    } catch { sendExport({}); }
    finally {
      graph.createSvgCanvas = originalCreateSvgCanvas;
      if (originalPage && editorUi.currentPage !== originalPage) editorUi.selectPage(originalPage);
      if (allPages && graph.setSelectionCells) graph.setSelectionCells(cells);
    }
  };
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== adapterOrigin || typeof event.data !== "string") return;
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message.action !== "string") return;
    if (message.action === "patent-toolbar-action-ack") {
      if (Object.keys(message).length !== 2 || typeof message.actionId !== "string") return;
      const pending = pendingToolbarActions.get(message.actionId);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      pendingToolbarActions.delete(message.actionId);
      return;
    }
    if (!editorUi) return;
    if (message.action === "patent-preserve-editing") {
      sessionStore.preserveEditing();
      return;
    }
    if (message.action === "patent-release-session") {
      if (typeof message.sessionId === "string") sessionStore.drop(message.sessionId);
      return;
    }
    if (message.action === "patent-activate-session") {
      if (typeof message.sessionId !== "string") return;
      hideToolbarTooltip();
      for (const pending of pendingToolbarActions.values()) window.clearTimeout(pending.timer);
      pendingToolbarActions.clear();
      editorUi.hideCurrentMenu();
      const graph = editorUi.editor.graph;
      graph.popupMenuHandler.hideMenu();
      graph.stopEditing(false);
      try {
        const restored = sessionStore.activate(message.sessionId);
        const manager = editorUi.editor.undoManager;
        window.parent.postMessage(JSON.stringify({
          event: "session-activated", sessionId: message.sessionId, restored,
          pages: restored ? editorUi.pages.map(page => ({ id: String(page.getId()), name: page.getName() })) : [],
          activePageId: restored ? String(editorUi.currentPage.getId()) : null,
          canUndo: restored && manager.canUndo(), canRedo: restored && manager.canRedo(),
          selectedCellIds: restored ? graph.getSelectionCells().map(cell => String(cell.id)) : [],
        }), adapterOrigin);
      } catch (error) {
        console.error("Flowchart session restore failed", error);
        window.parent.postMessage(JSON.stringify({event:"session-error",sessionId:message.sessionId}), adapterOrigin);
      }
      return;
    }
    if (message.action === "patent-finish-editing") {
      if (Object.keys(message).length !== 1) return;
      editorUi.editor.graph.stopEditing(false);
      return;
    }
    if (message.action === "patent-export-selection") {
      if (Object.keys(message).length !== 2 || message.format !== "xml") return;
      exportSelectionSource();
      return;
    }
    if (message.action === "patent-export-svg") {
      if (Object.keys(message).some(key => !["action", "selectionOnly", "allPages", "pageId", "selectedCellIds"].includes(key)) || typeof message.selectionOnly !== "boolean" || (message.allPages !== undefined && typeof message.allPages !== "boolean")) return;
      if (message.pageId !== undefined && (typeof message.pageId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(message.pageId))) return;
      if (message.selectedCellIds !== undefined && (!Array.isArray(message.selectedCellIds) || message.selectedCellIds.length < 1 || message.selectedCellIds.length > 50000 || message.selectedCellIds.some(id => typeof id !== "string" || id.length < 1 || id.length > 500))) return;
      exportPatentSvg(message.selectionOnly, message.allPages === true, message.pageId, message.selectedCellIds);
      return;
    }
    if (message.action === "patent-command") {
      if (Object.keys(message).length !== 2 || !["undo", "redo"].includes(message.command)) return;
      const action = editorUi.actions.get(message.command);
      if (action && action.funct && (!action.isEnabled || action.isEnabled())) action.funct();
      return;
    }
    if (message.action === "patent-toolbar-state" && Object.keys(message).length === 2 && message.state && typeof message.state === "object") {
      toolbarState = message.state; renderToolbarState(); return;
    }
    if (message.action === "patent-set-editor-mode") {
      if (Object.keys(message).length !== 2 || !editorModes.has(message.mode)) return;
      applyEditorMode(message.mode);
      return;
    }
    if (message.action !== "patent-set-page" || Object.keys(message).length !== 2 || typeof message.pageId !== "string") return;
    let page = Array.isArray(editorUi.pages) ? editorUi.pages.find((candidate) => candidate && candidate.getId && String(candidate.getId()) === message.pageId) : null;
    const syntheticPage = message.pageId.match(/^page-(\d+)$/);
    if (!page && syntheticPage && Array.isArray(editorUi.pages)) page = editorUi.pages[Number(syntheticPage[1])] || null;
    if (page) editorUi.selectPage(page);
  });
})();
