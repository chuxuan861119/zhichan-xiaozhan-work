// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import {
  DRAWIO_CIRCUIT_TOOLBAR_CSS,
  DRAWIO_EMBED_BRIDGE_SOURCE,
  DRAWIO_POPUP_SURFACE_CSS,
} from "./vendor-drawio.mjs";

afterEach(() => vi.useRealTimers());
const historyEvents = { CHANGE: "change", ADD: "add", UNDO: "undo", REDO: "redo", CLEAR: "clear", EDITING_STARTED: "editingStarted", EDITING_STOPPED: "editingStopped" };

describe("generated draw.io patent toolbar", () => {
  test("blocks manual page creation actions while retaining imported page operations", () => {
    const names = ["insertPage", "duplicatePage", "removePage", "renamePage", "movePage", "undo", "redo"];
    const actions = new Map(names.map((name) => [name, {
      funct: vi.fn(),
      setEnabled: vi.fn(),
      setVisible: vi.fn(),
      isEnabled: () => true,
    }]));
    const originalActions = new Map([...actions].map(([name, action]) => [name, action.funct]));
    class EditorUi {
      actions = { get: (name: string) => actions.get(name) };
      canUndo = () => false;
      canRedo = () => false;
      pages = [{ id: "imported-1" }, { id: "imported-2" }];
      currentPage = this.pages[0];
      insertPage = vi.fn();
      selectPage(page: { id: string }) { this.currentPage = page; }
      editor = {
        undoManager: { addListener: vi.fn() },
        addListener: vi.fn(),
        graph: { isEnabled: () => true, addListener: vi.fn(), stopEditing: vi.fn() },
      };
      init() {}
    }
    Object.assign(window, { EditorUi, mxEvent: historyEvents });
    // biome-ignore lint/security/noGlobalEval: executes the local generated integration policy.
    window.eval(DRAWIO_EMBED_BRIDGE_SOURCE);
    const ui = new EditorUi();
    ui.init();
    for (const name of ["insertPage", "duplicatePage"]) {
      const action = actions.get(name)!;
      expect(action.setVisible).toHaveBeenCalledWith(false);
      expect(action.setEnabled).toHaveBeenCalledWith(false);
      expect(action.isEnabled()).toBe(false);
      action.funct();
      expect(originalActions.get(name)).not.toHaveBeenCalled();
      expect(ui.pages).toHaveLength(2);
    }
    for (const name of ["removePage", "renamePage", "movePage", "undo", "redo"]) {
      expect(actions.get(name)!.isEnabled()).toBe(true);
      expect(actions.get(name)!.setVisible).not.toHaveBeenCalled();
    }
    ui.selectPage(ui.pages[1]);
    expect(ui.currentPage.id).toBe("imported-2");
    ui.insertPage();
    expect(ui.insertPage).toHaveBeenCalledOnce();
    expect(EditorUi.prototype).not.toHaveProperty("insertPage");
    window.dispatchEvent(new Event("beforeunload"));
  });

  test("hides only the page-insert tab used by the bundled draw.io page strip", () => {
    const drawio = readFileSync("resources/drawio/app/js/app.min.js", "utf8");
    expect(drawio).toContain("this.isPageInsertTabVisible()&&");
    expect(drawio).toContain("EditorUi.prototype.isPageInsertTabVisible=function(){");
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).toContain(
      "EditorUi.prototype.isPageInsertTabVisible = () => false;",
    );
  });

  test("ships the generated bridge without dropping source-only or bundle-only fixes", () => {
    expect(
      readFileSync("resources/drawio/app/embed-bridge.js", "utf8").replaceAll("\r\n", "\n"),
    ).toBe(DRAWIO_EMBED_BRIDGE_SOURCE.replaceAll("\r\n", "\n"));
  });
  test("keeps native menus and uses bounded tooltips with font-independent history icons", () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<div class="geMenubarContainer"><button>文件</button><button>编辑</button><button>查看</button><button>排列</button><button>其它</button></div>';
    const action = { funct: vi.fn(), isEnabled: () => true };
    const stopEditing = vi.fn();
    let canUndo = false;
    const historyListeners = new Map<string, () => void>();
    const post = vi.spyOn(window.parent, "postMessage");
    class EditorUi {
      canUndo = () => canUndo;
      canRedo = () => false;
      actions = { get: () => action };
      pages = [];
      currentPage = null;
      bottomControls: string[] = [];
      isPageInsertTabVisible() {
        return true;
      }
      editor = {
        undoManager: { addListener: (event: string, callback: () => void) => historyListeners.set(event, callback) },
        addListener: vi.fn(),
        graph: {
          isEnabled: () => true,
          addListener: vi.fn(),
          stopEditing,
          getSelectionCount: () => 0,
          getSelectionCells: () => [],
          getSelectionModel: () => ({ addListener: vi.fn() }),
          getModel: () => ({ addListener: vi.fn() }),
        },
      };
      init() {
        this.bottomControls = [
          ...(this.isPageInsertTabVisible() ? ["add-page"] : []),
          "page-menu",
          "page-tabs",
        ];
      }
    }
    Object.assign(window, { EditorUi, mxEvent: historyEvents });

    // biome-ignore lint/security/noGlobalEval: executes only the deterministic generated bridge in jsdom.
    window.eval(DRAWIO_EMBED_BRIDGE_SOURCE);
    const ui = new EditorUi();
    ui.init();
    expect(ui.isPageInsertTabVisible()).toBe(false);
    expect(ui.bottomControls).toEqual(["page-menu", "page-tabs"]);
    expect(ui.actions.get("insertPage").funct).toBe(action.funct);
    canUndo = true;
    historyListeners.get("add")?.();
    expect(post).toHaveBeenLastCalledWith(JSON.stringify({event:"history-state",canUndo:true,canRedo:false}), "patent-diagram://editor");
    canUndo = false;
    historyListeners.get("clear")?.();
    expect(post).toHaveBeenLastCalledWith(JSON.stringify({event:"history-state",canUndo:false,canRedo:false}), "patent-diagram://editor");
    post.mockRestore();

    const toolbar = document.querySelector(".geMenubarContainer.patent-toolbar");
    expect(toolbar?.children[0]?.className).toBe("patent-toolbar__project");
    expect(toolbar?.children[4]?.className).toBe("patent-toolbar__menus");
    expect(toolbar?.children[5]?.className).toBe("patent-toolbar__actions");
    expect(toolbar?.querySelectorAll(".patent-toolbar__menus > button")).toHaveLength(5);
    const projectButton = toolbar?.querySelector<HTMLButtonElement>('[aria-label="工程列表"]');
    expect(projectButton?.hasAttribute("title")).toBe(false);
    projectButton?.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(600);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("工程列表");
    projectButton?.dispatchEvent(new Event("pointerleave"));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    projectButton?.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(600);
    projectButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    for (const label of ["撤销", "重做"]) {
      const button = toolbar?.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
      expect(button?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      expect(button?.textContent).toBe("");
      expect(button?.hasAttribute("title")).toBe(false);
    }
    toolbar?.querySelector<HTMLButtonElement>('[aria-label="导出至电脑"]')?.click();
    expect(stopEditing).toHaveBeenCalledWith(false);
    stopEditing.mockClear();
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "patent-diagram://editor",
        source: window.parent,
        data: JSON.stringify({ action: "patent-finish-editing" }),
      }),
    );
    expect(stopEditing).toHaveBeenCalledExactlyOnceWith(false);
    window.dispatchEvent(new Event("beforeunload"));
    vi.useRealTimers();
  });

  test("matches draw.io popup-menu shadows to the workbench floating surface", () => {
    const expected =
      "box-shadow: var(--workbench-menu-shadow) !important;";
    expect(DRAWIO_POPUP_SURFACE_CSS).toContain(
      "html body.geEditor div.mxPopupMenu",
    );
    expect(DRAWIO_POPUP_SURFACE_CSS).toContain(expected);
    expect(DRAWIO_POPUP_SURFACE_CSS).toContain("html body.geEditor table.mxPopupMenu");
    expect(DRAWIO_POPUP_SURFACE_CSS).toContain("box-shadow: none !important;");
    expect(readFileSync("resources/drawio/app/patent-toolbar.css", "utf8")).toContain(expected);
  });

  test("shows quick wiring only in circuit mode and reflects controller activity", () => {
    document.body.innerHTML =
      '<div class="geMenubarContainer"><button>文件</button><button>编辑</button><button>查看</button><button>排列</button><button>其它</button></div><div class="geToolbarContainer"><button title="自由绘图">自由绘图</button></div>';
    const setEditorMode = vi.fn();
    const enable = vi.fn();
    const disable = vi.fn();
    let onActiveChange: (active: boolean) => void = () => undefined;
    const install = vi.fn((options: { onActiveChange(active: boolean): void }) => {
      onActiveChange = options.onActiveChange;
      return { setEditorMode, enable, disable, dispose: vi.fn(), isActive: () => false };
    });
    const installComponentPolicy = vi.fn(() => ({ setEditorMode: vi.fn(), dispose: vi.fn() }));
    const action = { funct: vi.fn(), isEnabled: () => true };
    class EditorUi {
      canUndo = () => false;
      canRedo = () => false;
      actions = { get: () => action };
      pages = [];
      currentPage = null;
      sidebar = { showEntries: vi.fn() };
      editor = {
        undoManager: { addListener: vi.fn() },
        addListener: vi.fn(),
        graph: {
          isEnabled: () => true,
          addListener: vi.fn(),
          container: document.createElement("div"),
          getSelectionCount: () => 0,
          getSelectionCells: () => [],
          getSelectionModel: () => ({ addListener: vi.fn() }),
          getModel: () => ({ addListener: vi.fn() }),
        },
      };
      init() {}
    }
    Object.assign(window, {
      EditorUi,
      mxEvent: historyEvents,
      PatentCircuitQuickWiring: { install },
      PatentCircuitComponentPolicy: { install: installComponentPolicy },
    });

    // biome-ignore lint/security/noGlobalEval: executes only the deterministic generated bridge in jsdom.
    window.eval(DRAWIO_EMBED_BRIDGE_SOURCE);
    new EditorUi().init();

    const toolbar = document.querySelector(".patent-toolbar");
    const lowerToolbar = document.querySelector(".geToolbarContainer");
    const group = lowerToolbar?.querySelector<HTMLElement>(".patent-toolbar__circuit-tools");
    const divider = lowerToolbar?.querySelector<HTMLElement>(".patent-toolbar__circuit-divider");
    const lowerGroup = lowerToolbar?.querySelector<HTMLElement>(".patent-toolbar__circuit-tools");
    const button = group?.querySelector<HTMLButtonElement>("button");
    expect(toolbar?.children[4]?.className).toBe("patent-toolbar__menus");
    expect(toolbar?.lastElementChild?.className).toBe("patent-toolbar__actions");
    expect(lowerGroup).toBe(group);
    expect(divider?.previousElementSibling?.getAttribute("title")).toBe("自由绘图");
    expect(group?.hidden).toBe(true);
    expect(divider?.hidden).toBe(true);
    expect(group?.dataset.visible).toBe("false");
    expect(divider?.dataset.visible).toBe("false");
    expect(button?.dataset.tooltip).toBe("快捷连线");
    expect(button?.hasAttribute("title")).toBe(false);
    expect(button?.getAttribute("aria-label")).toBe("快捷连线");
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    expect(group?.querySelector(".patent-toolbar__organize-wiring")).toBeNull();
    expect(group?.querySelector(".patent-toolbar__organize-components")).toBeNull();
    expect(DRAWIO_EMBED_BRIDGE_SOURCE).not.toContain("PatentCircuitAutoLayout");
    expect(DRAWIO_CIRCUIT_TOOLBAR_CSS).toContain(
      ".geToolbarContainer .patent-toolbar__circuit-divider",
    );
    expect(DRAWIO_CIRCUIT_TOOLBAR_CSS).toContain(
      ".patent-toolbar__button.patent-toolbar__quick-wiring{height:24px",
    );
    expect(DRAWIO_CIRCUIT_TOOLBAR_CSS).toContain("font-weight:700");

    toolbar?.querySelector<HTMLButtonElement>('[aria-label="电路图"]')?.click();
    expect(group?.hidden).toBe(false);
    expect(divider?.hidden).toBe(false);
    expect(group?.dataset.visible).toBe("true");
    expect(divider?.dataset.visible).toBe("true");
    expect(setEditorMode).toHaveBeenLastCalledWith("circuit");
    button?.click();
    expect(enable).toHaveBeenCalledOnce();
    onActiveChange(true);
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    toolbar?.querySelector<HTMLButtonElement>('[aria-label="流程图"]')?.click();
    expect(setEditorMode).toHaveBeenLastCalledWith("flowchart");
    expect(group?.hidden).toBe(true);
    expect(divider?.hidden).toBe(true);
  });

  test("hides quick wiring when its runtime cannot install and disposes an installed controller", () => {
    document.body.innerHTML =
      '<div class="geMenubarContainer"><button>其它</button></div><div class="geToolbarContainer"><button title="自由绘图">自由绘图</button></div>';
    const dispose = vi.fn();
    const install = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("runtime unavailable");
      })
      .mockReturnValue({
        setEditorMode: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        dispose,
        isActive: () => false,
      });
    class EditorUi {
      canUndo = () => false;
      canRedo = () => false;
      actions = { get: () => ({ funct: vi.fn(), isEnabled: () => true }) };
      pages = [];
      currentPage = null;
      sidebar = { showEntries: vi.fn() };
      editor = {
        undoManager: { addListener: vi.fn() },
        addListener: vi.fn(),
        graph: {
          isEnabled: () => true,
          addListener: vi.fn(),
          container: document.createElement("div"),
          getSelectionCount: () => 0,
          getSelectionCells: () => [],
          getSelectionModel: () => ({ addListener: vi.fn() }),
          getModel: () => ({ addListener: vi.fn() }),
        },
      };
      init() {}
    }
    Object.assign(window, {
      EditorUi,
      mxEvent: historyEvents,
      PatentCircuitQuickWiring: { install },
    });
    // biome-ignore lint/security/noGlobalEval: executes only the deterministic generated bridge in jsdom.
    window.eval(DRAWIO_EMBED_BRIDGE_SOURCE);
    new EditorUi().init();
    expect(document.querySelector<HTMLElement>(".patent-toolbar__circuit-tools")?.hidden).toBe(
      true,
    );

    document.body.innerHTML =
      '<div class="geMenubarContainer"><button>其它</button></div><div class="geToolbarContainer"><button title="自由绘图">自由绘图</button></div>';
    new EditorUi().init();
    window.dispatchEvent(new Event("beforeunload"));
    expect(dispose).toHaveBeenCalledOnce();
  });
});
