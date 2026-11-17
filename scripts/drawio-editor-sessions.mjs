export function createDrawioSessionStore(ui) {
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
