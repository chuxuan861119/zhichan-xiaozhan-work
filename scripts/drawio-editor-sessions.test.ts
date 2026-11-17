import { createDrawioSessionStore } from "./drawio-editor-sessions.mjs";

test("parks native objects and both history branches, without creating a second graph", () => {
  const graph = {
    model: {
      root: {},
      prefix: "a",
      nextId: 4,
      rootChanged(root) {
        this.root = root;
      },
    },
    view: { clear: vi.fn() },
    getSelectionCells: () => [cell],
    clearSelection: vi.fn(),
    setSelectionCells: vi.fn(),
    getViewState: () => ({ scale: 2, scrollLeft: 33 }),
    setViewState: vi.fn(),
    reset: vi.fn(),
    fireEvent: vi.fn(),
    getDefaultParent: () => null,
    setDefaultParent: vi.fn(),
    currentVertexStyle: { rounded: 1 },
    currentEdgeStyle: { curved: 1 },
  };
  const cell = { id: "a-cell" };
  const undo = { changes: [cell] };
  const redo = { changes: [{ id: "deleted-cell" }] };
  const page = { root: graph.model.root, viewState: null };
  const ui = {
    editor: { graph, undoManager: { history: [undo, redo], indexOfNextAdd: 1 }, modified: true },
    pages: [page],
    currentPage: page,
    fileNode: {},
    fileVars: { a: 1 },
    fileVarsStr: "a",
    updateActionStates: vi.fn(),
    fireEvent: vi.fn(),
    selectPage(next) {
      this.currentPage = next;
      graph.model.rootChanged(next.root);
      graph.setViewState(next.viewState);
    },
  };
  const store = createDrawioSessionStore(ui);
  expect(store.activate("a")).toBe(false);
  ui.editor.undoManager.history = [undo, redo];
  ui.editor.undoManager.indexOfNextAdd = 1;
  graph.currentVertexStyle.rounded = 0;
  expect(store.activate("b")).toBe(false);
  expect(graph.currentVertexStyle.rounded).toBe(1);
  // Native load mutates the currently attached history before clear().
  ui.editor.undoManager.history.splice(0, Infinity, { changes: [] });
  ui.pages = [];
  ui.editor.undoManager.history = [];
  ui.editor.undoManager.indexOfNextAdd = 0;
  graph.model.root = {};
  expect(store.activate("a")).toBe(true);
  expect(ui.pages[0]).toBe(page);
  expect(graph.model.root).toBe(page.root);
  expect(ui.editor.undoManager.history).toEqual([undo, redo]);
  expect(ui.editor.undoManager.history[0]).toBe(undo);
  expect(ui.editor.undoManager.indexOfNextAdd).toBe(1);
  expect(graph.currentVertexStyle.rounded).toBe(0);
  expect(graph.setSelectionCells).toHaveBeenLastCalledWith([cell]);
  expect(graph.setViewState).toHaveBeenLastCalledWith({ scale: 2, scrollLeft: 33 });
  store.drop("a");
  expect(store.activate("a")).toBe(false);
});

test("parks native dialogs without closing drafts, and releases only the closed session", () => {
  const dialog = {
    container: { hidden: false },
    bg: { hidden: false },
    close: vi.fn(),
    onDialogClose: vi.fn(),
  };
  const graph = {
    model: { root: {} },
    getViewState: () => ({}),
    getSelectionCells: () => [],
    getDefaultParent: () => null,
    setDefaultParent: vi.fn(),
    setSelectionCells: vi.fn(),
  };
  const page = { root: graph.model.root };
  const ui = {
    editor: { graph, undoManager: { history: [], indexOfNextAdd: 0 } },
    currentPage: page,
    pages: [page],
    dialogs: [],
    dialog: null,
    selectPage: vi.fn(),
    updateActionStates: vi.fn(),
  };
  const store = createDrawioSessionStore(ui);
  store.activate("a");
  ui.dialogs = [dialog];
  ui.dialog = dialog;
  store.activate("b");
  expect(dialog.container.hidden).toBe(true);
  expect(ui.dialogs).toEqual([]);
  expect(dialog.close).not.toHaveBeenCalled();
  store.activate("a");
  expect(ui.dialog).toBe(dialog);
  expect(dialog.container.hidden).toBe(false);
  store.activate("b");
  store.drop("a");
  expect(dialog.close).toHaveBeenCalledWith(true);
  expect(dialog.onDialogClose).toBeNull();
  expect(ui.dialogs).toEqual([]);
});
