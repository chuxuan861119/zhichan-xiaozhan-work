import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { DocumentStructureRulerMarker } from "../../../shared/patent/document-structure-ruler";
import type { EditorCommandBus } from "../app/command-bus";
import { RulerSelectionNavigation } from "./ruler-selection-navigation";

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON() {},
});
let editor: Editor;
let workspace: HTMLElement;
let layout: HTMLElement;
let host: HTMLElement;
let hitElement: Element | null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  workspace = document.createElement("div");
  workspace.className = "editor-workspace";
  layout = document.createElement("div");
  layout.className = "patent-page-with-rail";
  host = document.createElement("aside");
  host.className = "document-structure-ruler";
  workspace.append(layout);
  layout.append(host);
  document.body.append(workspace);
  editor = new Editor({
    extensions: [StarterKit],
    content: "<p>第一段内容</p><p>第二段内容</p><p>第三段内容</p>",
  });
  layout.append(editor.view.dom);
  vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(rect(0, 0, 600, 600));
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(0, 0, 80, 2000));
  vi.spyOn(editor.view.dom, "getBoundingClientRect").mockReturnValue(rect(80, 0, 500, 2000));
  vi.spyOn(editor.view, "posAtCoords").mockImplementation(({ left }) => ({
    pos: left > 200 ? 17 : 2,
    inside: 0,
  }));
  hitElement = host;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => hitElement,
  });
  Object.defineProperty(workspace, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(workspace, "clientHeight", { configurable: true, value: 600 });
});
afterEach(() => {
  cleanup();
  editor.destroy();
  workspace.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function mount() {
  const blocks = new Map();
  const markers: DocumentStructureRulerMarker[] = [];
  editor.state.doc.forEach((_node, position, index) => {
    const element = editor.view.nodeDOM(position) as HTMLElement;
    vi.spyOn(element, "getBoundingClientRect").mockImplementation(() =>
      rect(80, index * 500 - workspace.scrollTop, 500, 30),
    );
    blocks.set(String(index), { position, element });
    markers.push({
      id: String(index),
      kind: "claim",
      label: `段落 ${index}`,
      compactLabel: String(index),
      targetBlockId: String(index),
      endBlockId: String(index),
      warning: false,
    });
  });
  const props = {
    host: { current: host },
    blocks: { current: blocks },
    markers,
    editorId: "test",
    commandBus: { getEditor: () => editor } as unknown as EditorCommandBus,
    dualColumn: false,
    mode: "wide",
  };
  return { ...render(<RulerSelectionNavigation {...props} />), props };
}
function start() {
  fireEvent.pointerDown(editor.view.dom.firstElementChild!, {
    button: 0,
    buttons: 1,
    clientX: 100,
    clientY: 100,
  });
  // jsdom has no native pointer selection default action.
  editor.commands.setTextSelection(2);
  fireEvent.pointerMove(host, { buttons: 1, clientX: 40, clientY: 100 });
}
function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}
const popup = () => document.querySelector('[data-selection-navigation="true"]');

test("requires a full second of stillness and keeps short ruler passes native", () => {
  mount();
  start();
  advance(900);
  expect(popup()).toBeNull();
  fireEvent.pointerMove(host, { buttons: 1, clientX: 40, clientY: 130 });
  advance(999);
  expect(popup()).toBeNull();
  advance(1);
  expect(popup()).not.toBeNull();
});
test.each(["pointerup", "pointercancel", "blur", "resize", "escape", "edit", "mode", "unmount"])(
  "%s releases the gesture and cancels pending activation",
  (reason) => {
    const result = mount();
    start();
    advance(500);
    act(() => {
      if (reason === "escape") fireEvent.keyDown(window, { key: "Escape" });
      else if (reason === "edit") editor.commands.insertContent("新增");
      else if (reason === "mode")
        result.rerender(<RulerSelectionNavigation {...result.props} mode="compact" />);
      else if (reason === "unmount") result.unmount();
      else fireEvent(window, new Event(reason));
    });
    advance(1500);
    expect(popup()).toBeNull();
    expect(layout.dataset.rulerSelectionPending).toBeUndefined();
  },
);
test("extends without replacing the anchor and cancels animated scrolling on release", () => {
  mount();
  start();
  advance(1000);
  hitElement = popup()!.querySelector('[data-ruler-marker-id="2"]');
  fireEvent.pointerMove(hitElement!, { buttons: 1, clientX: 40, clientY: 200 });
  advance(120);
  expect(editor.state.selection.anchor).toBe(2);
  expect(editor.state.selection.head).toBe(20);
  const before = workspace.scrollTop;
  advance(50);
  expect(workspace.scrollTop).toBeGreaterThan(before);
  fireEvent.pointerUp(window);
  const stopped = workspace.scrollTop;
  advance(500);
  expect(workspace.scrollTop).toBe(stopped);
  expect(editor.state.selection.anchor).toBe(2);
  expect(popup()).toBeNull();
});
test("reverse navigation extends to paragraph start and returning to text retains the anchor", () => {
  mount();
  fireEvent.pointerDown(editor.view.dom.lastElementChild!, {
    button: 0,
    buttons: 1,
    clientX: 300,
    clientY: 100,
  });
  editor.commands.setTextSelection(17);
  fireEvent.pointerMove(host, { buttons: 1, clientX: 40, clientY: 100 });
  advance(1000);
  hitElement = popup()!.querySelector('[data-ruler-marker-id="0"]');
  fireEvent.pointerMove(hitElement!, { buttons: 1, clientX: 40, clientY: 200 });
  advance(120);
  expect(editor.state.selection.anchor).toBe(17);
  expect(editor.state.selection.head).toBe(1);
  hitElement = editor.view.dom;
  fireEvent.pointerMove(editor.view.dom, { buttons: 1, clientX: 100, clientY: 100 });
  expect(editor.state.selection.anchor).toBe(17);
  expect(editor.state.selection.head).toBe(2);
});

test.each(["escape", "blur", "pointercancel", "resize"])(
  "active %s stops animation and cannot restart while the same button remains held",
  (reason) => {
    mount();
    start();
    advance(1000);
    hitElement = popup()!.querySelector('[data-ruler-marker-id="2"]');
    fireEvent.pointerMove(hitElement!, { buttons: 1, clientX: 40, clientY: 200 });
    advance(120);
    const selection = editor.state.selection;
    if (reason === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else fireEvent(window, new Event(reason));
    const scroll = workspace.scrollTop;
    hitElement = host;
    fireEvent.pointerMove(host, { buttons: 1, clientX: 40, clientY: 100 });
    advance(1500);
    expect(popup()).toBeNull();
    expect(workspace.scrollTop).toBe(scroll);
    expect(editor.state.selection.eq(selection)).toBe(true);
  },
);

test("ignores a different editor, image dragging, and native dragging of an existing selection", () => {
  mount();
  const image = document.createElement("img");
  layout.append(image);
  fireEvent.pointerDown(image, { button: 0, buttons: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(host, { buttons: 1, clientX: 40, clientY: 100 });
  advance(1100);
  expect(popup()).toBeNull();
  fireEvent.pointerDown(document.body, { button: 0, buttons: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(host, { buttons: 1, clientX: 40, clientY: 100 });
  advance(1100);
  expect(popup()).toBeNull();
  editor.commands.setTextSelection({ from: 1, to: 6 });
  start();
  advance(1100);
  expect(popup()).toBeNull();
});

test("losing pressed buttons cancels activation even if pointerup was missed", () => {
  mount();
  start();
  advance(500);
  fireEvent.pointerMove(host, { buttons: 0, clientX: 40, clientY: 100 });
  advance(1100);
  expect(popup()).toBeNull();
});

test("only the latest hovered target is selected, with no list recentering", () => {
  mount();
  start();
  advance(1000);
  const list = popup()!.querySelector<HTMLElement>(".ruler-navigation-popover__list")!;
  list.scrollTop = 60;
  hitElement = popup()!.querySelector('[data-ruler-marker-id="2"]');
  fireEvent.pointerMove(hitElement!, { buttons: 1, clientX: 40, clientY: 200 });
  advance(60);
  hitElement = popup()!.querySelector('[data-ruler-marker-id="1"]');
  fireEvent.pointerMove(hitElement!, { buttons: 1, clientX: 40, clientY: 170 });
  advance(110);
  expect(editor.state.selection.head).toBe(13);
  expect(list.scrollTop).toBe(60);
});

test("does not preempt the dual-column native pointerdown side handoff", () => {
  const result = mount();
  result.rerender(<RulerSelectionNavigation {...result.props} dualColumn />);
  vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(rect(0, 0, 1200, 600));
  layout.style.setProperty("--column-width", "580");
  layout.style.setProperty("--column-ruler-slot", "80");
  layout.dataset.columnHeight = "600";
  const order: string[] = [];
  layout.addEventListener("dual-column-selection-navigation", (event) => {
    if ((event as CustomEvent).detail.kind === "activate") order.push("navigation-activate");
  });
  layout.addEventListener("pointerdown", () => order.push("native-down"), { capture: true });
  fireEvent.pointerDown(editor.view.dom.firstElementChild!, {
    button: 0,
    buttons: 1,
    clientX: 100,
    clientY: 100,
  });
  expect(order).toEqual(["native-down"]);
  expect(layout.dataset.rulerSelectionPending).toBe("true");
});

test("native selection changes outside the source editor cannot replace a navigation range", () => {
  mount();
  start();
  advance(1000);
  hitElement = popup()!.querySelector('[data-ruler-marker-id="2"]');
  fireEvent.pointerMove(hitElement!, { buttons: 1, clientX: 40, clientY: 200 });
  advance(120);
  const native = window.getSelection()!;
  const text = editor.view.dom.firstElementChild!.firstChild!;
  native.setBaseAndExtent(text, 0, text, 1);
  fireEvent(document, new Event("selectionchange"));
  expect(native.toString()).toContain("第三段内容");
  fireEvent.keyDown(window, { key: "Escape" });
  native.setBaseAndExtent(text, 0, text, 1);
  fireEvent(document, new Event("selectionchange"));
  expect(native.toString()).toContain("第三段内容");
  fireEvent.pointerUp(window);
});

test("a document edit releases stale selection positions rather than restoring them", () => {
  mount();
  start();
  advance(1000);
  hitElement = popup()!.querySelector('[data-ruler-marker-id="2"]');
  fireEvent.pointerMove(hitElement!, { buttons: 1, clientX: 40, clientY: 200 });
  advance(120);
  act(() => editor.commands.insertContent("替换后的较长新文字，继续编辑文档内容"));
  const selection = editor.state.selection;
  fireEvent(document, new Event("selectionchange"));
  expect(editor.state.selection.eq(selection)).toBe(true);
  expect(layout.dataset.rulerSelectionLocked).toBeUndefined();
});

test("the navigation list scrolls at its edge and stops when the pointer returns to text", () => {
  mount();
  start();
  advance(1000);
  const list = popup()!.querySelector<HTMLElement>(".ruler-navigation-popover__list")!;
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(8, 8, 120, 400));
  hitElement = list;
  fireEvent.pointerMove(list, { buttons: 1, clientX: 40, clientY: 398 });
  advance(200);
  expect(list.scrollTop).toBeGreaterThan(20);
  hitElement = editor.view.dom;
  fireEvent.pointerMove(editor.view.dom, { buttons: 1, clientX: 100, clientY: 100 });
  const stopped = list.scrollTop;
  advance(300);
  expect(list.scrollTop).toBe(stopped);
});

test("switching away from a hidden document cannot open a delayed navigation popup", () => {
  mount();
  start();
  advance(500);
  workspace.hidden = true;
  advance(1100);
  expect(popup()).toBeNull();
  expect(layout.dataset.rulerSelectionPending).toBeUndefined();
});

test("returning to the same target resumes an interrupted navigation", () => {
  mount();
  start();
  advance(1000);
  const target = popup()!.querySelector('[data-ruler-marker-id="2"]')!;
  hitElement = target;
  fireEvent.pointerMove(target, { buttons: 1, clientX: 40, clientY: 200 });
  advance(145);
  hitElement = document.body;
  fireEvent.pointerMove(document.body, { buttons: 1, clientX: 650, clientY: 100 });
  const stopped = workspace.scrollTop;
  advance(500);
  expect(workspace.scrollTop).toBe(stopped);
  hitElement = target;
  fireEvent.pointerMove(target, { buttons: 1, clientX: 40, clientY: 200 });
  advance(600);
  expect(workspace.scrollTop).toBe(800);
});

test.each([
  { anchor: 1, head: 6 },
  { anchor: 6, head: 1 },
])("preserves the native word-selection anchor $anchor when taking over", (selection) => {
  mount();
  start();
  // The native double-click/word drag runs after pointerdown, snapping to word boundaries.
  editor.commands.setTextSelection({ from: selection.anchor, to: selection.head });
  advance(1000);
  hitElement = popup()!.querySelector('[data-ruler-marker-id="2"]');
  fireEvent.pointerMove(hitElement!, { buttons: 1, clientX: 40, clientY: 200 });
  advance(120);
  expect(editor.state.selection.anchor).toBe(selection.anchor);
  expect(editor.state.selection.head).toBe(20);
});

test("returning to a page edge keeps scrolling and extending until release", () => {
  mount();
  start();
  advance(1000);
  hitElement = popup()!.querySelector('[data-ruler-marker-id="1"]');
  fireEvent.pointerMove(hitElement!, { buttons: 1, clientX: 40, clientY: 200 });
  advance(600);
  const before = workspace.scrollTop;
  vi.spyOn(editor.view, "posAtCoords").mockImplementation(() => ({
    pos: workspace.scrollTop > before + 30 ? 20 : 13,
    inside: 0,
  }));
  hitElement = editor.view.dom;
  fireEvent.pointerMove(editor.view.dom, { buttons: 1, clientX: 300, clientY: 595 });
  advance(500);
  expect(workspace.scrollTop).toBeGreaterThan(before + 30);
  expect(editor.state.selection.anchor).toBe(2);
  expect(editor.state.selection.head).toBe(20);
  fireEvent.pointerUp(window);
  const stopped = workspace.scrollTop;
  advance(500);
  expect(workspace.scrollTop).toBe(stopped);
});

test.each(["middle", "other-pane", "popup", "escape", "blur", "resize", "pointercancel"])(
  "%s stops page-edge scrolling without changing the original anchor",
  (destination) => {
    mount();
    start();
    advance(1000);
    workspace.scrollTop = 300;
    hitElement = editor.view.dom;
    fireEvent.pointerMove(editor.view.dom, { buttons: 1, clientX: 300, clientY: 5 });
    advance(160);
    expect(workspace.scrollTop).toBeLessThan(300);
    if (destination === "middle")
      fireEvent.pointerMove(editor.view.dom, { buttons: 1, clientX: 300, clientY: 300 });
    else if (destination === "other-pane") {
      hitElement = document.body;
      fireEvent.pointerMove(document.body, { buttons: 1, clientX: 650, clientY: 5 });
    } else if (destination === "popup") {
      hitElement = host;
      fireEvent.pointerMove(host, { buttons: 1, clientX: 40, clientY: 100 });
      hitElement = popup()!;
      fireEvent.pointerMove(hitElement, { buttons: 1, clientX: 40, clientY: 300 });
    } else if (destination === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else fireEvent(window, new Event(destination));
    const stopped = workspace.scrollTop;
    advance(600);
    expect(workspace.scrollTop).toBe(stopped);
    expect(editor.state.selection.anchor).toBe(2);
  },
);
