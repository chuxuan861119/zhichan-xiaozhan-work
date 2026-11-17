import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { EditorCommandBus } from "../../app/command-bus";
import { createPatentExtensions } from "../extensions";
import { EditorContextMenus } from "./editor-context-menus";

function openObjectMenu(editor: Editor) {
  const bus = new EditorCommandBus();
  bus.register("object-tools", editor);
  vi.spyOn(editor.view.dom, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 400, 200),
  ] as unknown as DOMRectList);
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
    left: 20,
    right: 30,
    top: 20,
    bottom: 40,
  });
  const view = render(
    <EditorContextMenus editor={editor} editorId="object-tools" commandBus={bus} />,
  );
  fireEvent.keyDown(editor.view.dom, { key: "ContextMenu" });
  return { bus, view, menu: within(document.body).getByRole("menu", { name: "文档右键菜单" }) };
}

test("table icon toolbar preserves the selected cells through alignment, merging and splitting", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>",
  });
  const cells: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "tableCell") cells.push(pos);
  });
  const [firstCell, secondCell, thirdCell] = cells;
  if (firstCell === undefined || secondCell === undefined || thirdCell === undefined)
    throw new Error("Missing fixture cells");
  editor.view.dispatch(
    editor.state.tr.setSelection(CellSelection.create(editor.state.doc, firstCell, secondCell)),
  );
  const { bus, view, menu } = openObjectMenu(editor);
  try {
    const tools = within(menu).getByRole("toolbar", { name: "表格工具" });
    expect(menu.firstElementChild).toBe(tools);
    for (const button of within(tools).getAllByRole("button")) {
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button.textContent).toBe("");
      expect(button.title).toBe(button.getAttribute("aria-label"));
    }
    expect(
      within(tools).getByRole("button", { name: "删除行" }).querySelector("svg")?.innerHTML,
    ).not.toBe(
      within(tools).getByRole("button", { name: "删除列" }).querySelector("svg")?.innerHTML,
    );
    fireEvent.click(within(tools).getByRole("button", { name: "单元格居中" }));
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect(bus.getTableSelection("object-tools").selectedCellCount).toBe(2);
    expect(editor.state.doc.nodeAt(firstCell)?.attrs.horizontalAlignment).toBe("center");
    expect(editor.state.doc.nodeAt(secondCell)?.attrs.horizontalAlignment).toBe("center");
    expect(editor.state.doc.nodeAt(thirdCell)?.attrs.horizontalAlignment).toBe("left");
    expect(
      within(tools).getByRole("button", { name: "单元格居中" }).getAttribute("aria-pressed"),
    ).toBe("true");
    const split = within(tools).getByRole("button", {
      name: "拆分单元格",
    }) as HTMLButtonElement;
    expect(split.disabled).toBe(true);
    fireEvent.click(within(tools).getByRole("button", { name: "合并单元格" }));
    expect(editor.state.doc.nodeAt(firstCell)?.attrs.colspan).toBe(2);
    expect(split.disabled).toBe(false);
    fireEvent.click(split);
    expect(editor.state.doc.nodeAt(firstCell)?.attrs.colspan).toBe(1);
    editor.state.doc.check();
  } finally {
    view.unmount();
    editor.destroy();
  }
});

test("table icon toolbar keeps header and last-row/column protection", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><th>标题</th></tr></table>",
  });
  editor.commands.setTextSelection(4);
  const before = editor.getJSON();
  const { view, menu } = openObjectMenu(editor);
  try {
    const tools = within(menu).getByRole("toolbar", { name: "表格工具" });
    for (const name of ["上方插入行", "删除行", "删除列", "合并单元格", "拆分单元格"]) {
      const button = within(tools).getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(editor.getJSON()).toEqual(before);
    fireEvent.click(within(tools).getByRole("button", { name: "下方插入行" }));
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.type.name).toBe("tableHeader");
  } finally {
    view.unmount();
    editor.destroy();
  }
});

test("keyboard-opened object tools support arrow navigation and escape without editing", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>甲</td><td>乙</td></tr></table>",
  });
  editor.commands.setTextSelection(4);
  const before = editor.getJSON();
  const { view, menu } = openObjectMenu(editor);
  try {
    const tools = within(menu).getByRole("toolbar", { name: "表格工具" });
    const first = within(tools).getByRole("button", { name: "上方插入行" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(within(tools).getByRole("button", { name: "下方插入行" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(menu.closest(".spatial-presence")?.hasAttribute("inert")).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  } finally {
    view.unmount();
    editor.destroy();
  }
});

test("image icon toolbar keeps node selection, physical rotation size and layout attributes", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "figure",
          attrs: {
            assetId: "image-one",
            widthMm: 80,
            sourceAspectRatio: 2,
            alignment: "center",
            rotationDeg: 0,
          },
        },
      ],
    },
  });
  editor.commands.setNodeSelection(0);
  const { view, menu } = openObjectMenu(editor);
  try {
    const tools = within(menu).getByRole("toolbar", { name: "图片工具" });
    expect(menu.firstElementChild).toBe(tools);
    expect(within(menu).queryByRole("toolbar", { name: "选区格式" })).toBeNull();
    fireEvent.click(within(tools).getByRole("button", { name: "图片右对齐" }));
    fireEvent.click(within(tools).getByRole("button", { name: "向右旋转90°" }));
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.doc.nodeAt(0)?.attrs).toMatchObject({
      assetId: "image-one",
      alignment: "right",
      rotationDeg: 90,
      widthMm: 40,
    });
    fireEvent.click(within(tools).getByRole("button", { name: "放大图片" }));
    expect(editor.state.doc.nodeAt(0)?.attrs.widthMm).toBe(50);
    fireEvent.click(within(tools).getByRole("button", { name: "嵌入型" }));
    expect(editor.state.doc.nodeAt(1)?.type.name).toBe("inlineFigure");
    expect(editor.state.doc.nodeAt(1)?.attrs).toMatchObject({
      assetId: "image-one",
      alignment: "right",
      rotationDeg: 90,
      widthMm: 50,
    });
    expect(
      (within(tools).getByRole("button", { name: "图片右对齐" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(tools).getByRole("button", { name: "独立成行" }));
    expect(editor.state.doc.nodeAt(0)?.type.name).toBe("figure");
    editor.state.doc.check();
  } finally {
    view.unmount();
    editor.destroy();
  }
});

test("an image inside a cell receives image tools without allowing invalid block conversion", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "inlineFigure",
                          attrs: { assetId: "cell-image", widthMm: 10, sourceAspectRatio: 2 },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  let imagePos = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "inlineFigure") imagePos = pos;
  });
  editor.commands.setNodeSelection(imagePos);
  const before = editor.getJSON();
  const { view, menu } = openObjectMenu(editor);
  try {
    const tools = within(menu).getByRole("toolbar", { name: "图片工具" });
    expect(within(menu).queryByRole("toolbar", { name: "表格工具" })).toBeNull();
    for (const name of ["独立成行", "缩小图片", "向右旋转90°"]) {
      const button = within(tools).getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(editor.getJSON()).toEqual(before);
  } finally {
    view.unmount();
    editor.destroy();
  }
});

test("read-only object menus disable all editing tools", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>只读</td></tr></table>",
    editable: false,
  });
  editor.commands.setTextSelection(4);
  const before = editor.getJSON();
  const { view, menu } = openObjectMenu(editor);
  try {
    for (const button of within(
      within(menu).getByRole("toolbar", { name: "表格工具" }),
    ).getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(editor.getJSON()).toEqual(before);
  } finally {
    view.unmount();
    editor.destroy();
  }
});

test("selected text inside a cell retains the text toolbar instead of object tools", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><td>单元格文字</td></tr></table>",
  });
  editor.commands.setTextSelection({ from: 4, to: 6 });
  const { view, menu } = openObjectMenu(editor);
  try {
    expect(within(menu).getByRole("toolbar", { name: "选区格式" })).toBeDefined();
    expect(within(menu).queryByRole("toolbar", { name: "表格工具" })).toBeNull();
    fireEvent.click(within(menu).getByRole("button", { name: "加粗" }));
    expect(editor.getHTML()).toContain("<strong>单元</strong>");
  } finally {
    view.unmount();
    editor.destroy();
  }
});

test("outside pointer gestures do not notify idle editors", () => {
  const editor = new Editor({ extensions: createPatentExtensions(), content: "<p>测试文字</p>" });
  const bus = new EditorCommandBus();
  bus.register("idle", editor);
  const view = render(<EditorContextMenus editor={editor} editorId="idle" commandBus={bus} />);
  const transactions = vi.fn();
  editor.on("transaction", transactions);
  for (let i = 0; i < 10; i++) {
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
  }
  expect(transactions).not.toHaveBeenCalled();
  view.unmount();
  editor.destroy();
});

test("table context menu disables protected operations", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<table><tr><th>标题</th></tr></table>",
  });
  const bus = new EditorCommandBus();
  bus.register("table-menu", editor);
  vi.spyOn(editor.view.dom, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 400, 200),
  ] as unknown as DOMRectList);
  editor.commands.setTextSelection(4);
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
    left: 20,
    right: 30,
    top: 20,
    bottom: 40,
  });
  const view = render(
    <EditorContextMenus editor={editor} editorId="table-menu" commandBus={bus} />,
  );
  fireEvent.keyDown(editor.view.dom, { key: "ContextMenu" });
  fireEvent.click(within(document.body).getByRole("menuitem", { name: "表格" }));
  for (const name of ["上方插入行", "删除行", "删除列"]) {
    expect(
      (within(document.body).getByRole("menuitem", { name }) as HTMLButtonElement).disabled,
    ).toBe(true);
  }
  expect(
    (within(document.body).getByRole("menuitem", { name: "删除表格" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  view.unmount();
  editor.destroy();
});

test("opening a context menu survives layout scrolling but user scrolling dismisses it", async () => {
  const editor = new Editor({ extensions: createPatentExtensions(), content: "<p>测试文字</p>" });
  const bus = new EditorCommandBus();
  bus.register("context-scroll", editor);
  vi.spyOn(editor.view.dom, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 400, 200),
  ] as unknown as DOMRectList);
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
    left: 30,
    right: 40,
    top: 30,
    bottom: 50,
  });
  const view = render(
    <EditorContextMenus editor={editor} editorId="context-scroll" commandBus={bus} />,
  );
  fireEvent.keyDown(editor.view.dom, { key: "ContextMenu" });
  expect(document.querySelector(".editor-context-menu")).not.toBeNull();
  fireEvent.scroll(document);
  expect(document.querySelector(".editor-context-menu")).not.toBeNull();
  fireEvent.wheel(document.body, { deltaY: 100 });
  const closing = document.querySelector(".editor-context-menu")?.closest(".spatial-presence");
  expect(closing?.hasAttribute("inert")).toBe(true);
  expect(closing?.getAttribute("aria-hidden")).toBe("true");
  await waitFor(() => expect(document.querySelector(".editor-context-menu")).toBeNull());
  view.unmount();
  editor.destroy();
});

test("parent rerenders do not repeatedly update the bubble plugin", () => {
  const editor = new Editor({ extensions: createPatentExtensions(), content: "<p>测试文字</p>" });
  const bus = new EditorCommandBus();
  bus.register("menus", editor);
  const transactions = vi.fn();
  editor.on("transaction", transactions);
  const view = render(<EditorContextMenus editor={editor} editorId="menus" commandBus={bus} />);
  const initial = transactions.mock.calls.length;
  for (let i = 0; i < 20; i++)
    view.rerender(<EditorContextMenus editor={editor} editorId="menus" commandBus={bus} />);
  expect(transactions.mock.calls.length - initial).toBeLessThan(3);
  view.unmount();
  editor.destroy();
});

test("a retained editor cannot revive an unmounted selection menu after its debounce", async () => {
  vi.useFakeTimers();
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: "978fd5d4-95ac-42d2-a26d-f25019418772" },
          content: [{ type: "text", text: "保留编辑器选区" }],
        },
      ],
    },
  });
  const bus = new EditorCommandBus();
  bus.register("retained-menu", editor);
  vi.spyOn(editor.view.dom, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 400, 200),
  ] as unknown as DOMRectList);
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
    left: 20,
    right: 30,
    top: 20,
    bottom: 40,
  });
  editor.isFocused = true;
  const before = editor.getJSON();
  const menus = () =>
    document.querySelectorAll<HTMLElement>(
      '.editor-selection-menu[data-editor-menu-owner="retained-menu"]:not([data-spatial-paint])',
    );
  let view = render(
    <EditorContextMenus editor={editor} editorId="retained-menu" commandBus={bus} />,
  );
  try {
    act(() => editor.commands.setTextSelection({ from: 1, to: 3 }));
    // React removes portal children and Tiptap unregisters the plugin while the
    // same editor and its non-empty selection survive the workspace transition.
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(menus()).toHaveLength(0);
    view = render(<EditorContextMenus editor={editor} editorId="retained-menu" commandBus={bus} />);
    act(() => editor.commands.setTextSelection({ from: 2, to: 4 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(menus()).toHaveLength(1);
    expect(menus()[0]?.querySelector('[role="toolbar"]')).not.toBeNull();
    expect(editor.getJSON()).toEqual(before);
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.selection.to).toBe(4);
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(menus()).toHaveLength(0);
  } finally {
    view.unmount();
    editor.destroy();
    vi.useRealTimers();
  }
});

test("color controls use toolbar icons with their selected colors", () => {
  const editor = new Editor({ extensions: createPatentExtensions(), content: "<p>测试文字</p>" });
  const bus = new EditorCommandBus();
  bus.register("color-icons", editor);
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 0, right: 10, top: 0, bottom: 20 });
  editor.commands.setTextSelection({ from: 1, to: 3 });
  bus.setColor("color-icons", "#C00000", true);
  bus.setHighlightColor("color-icons", "#00FF00", true);
  const view = render(
    <EditorContextMenus editor={editor} editorId="color-icons" commandBus={bus} />,
  );
  act(() => editor.view.dispatch(editor.state.tr.setMeta("selection-menu-color-icons", "show")));
  const color = document.querySelector('button[aria-label="应用文字颜色"]');
  const highlight = document.querySelector('button[aria-label="应用文本突出显示颜色"]');
  const rows = document.querySelectorAll(".editor-selection-menu .editor-mini-row");
  expect(rows[0]?.querySelector('[aria-label="加粗"]')).not.toBeNull();
  expect(rows[1]?.querySelector('button[aria-label="打开文字颜色菜单"]')).not.toBeNull();
  expect((color?.querySelector(".color-picker-letter") as HTMLElement)?.style.color).toBe(
    "rgb(192, 0, 0)",
  );
  expect(highlight?.querySelector("svg path")?.getAttribute("fill")).toBe("#00FF00");
  expect(document.querySelector('input[aria-label="文字颜色"]')).toBeNull();
  vi.spyOn(editor.view.dom, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 400, 200),
  ] as unknown as DOMRectList);
  fireEvent.click(color as Element);
  expect(editor.getAttributes("textStyle").color).toBe("#C00000");
  expect(document.querySelector('[role="dialog"][aria-label="文字颜色"]')).toBeNull();
  fireEvent.click(document.querySelector('button[aria-label="打开文字颜色菜单"]') as Element);
  const palette = document.querySelector(
    '.editor-selection-menu [role="dialog"][aria-label="文字颜色"]',
  ) as HTMLElement;
  expect(within(palette).getByText("主题颜色")).toBeDefined();
  expect(within(palette).getByText("标准色")).toBeDefined();
  expect(within(palette).getByLabelText("其他颜色")).toBeDefined();
  fireEvent.click(within(palette).getByLabelText("标准色 #FF0000"));
  expect(editor.getAttributes("textStyle").color).toBe("#FF0000");
  expect(editor.state.selection.from).toBe(1);
  expect(editor.state.selection.to).toBe(3);
  fireEvent.click(highlight as Element);
  expect(editor.getAttributes("textStyle").backgroundColor).toBe("#00FF00");
  fireEvent.click(
    document.querySelector('button[aria-label="打开文本突出显示颜色菜单"]') as Element,
  );
  const highlightPalette = document.querySelector(
    '[role="dialog"][aria-label="文本突出显示颜色"]',
  ) as HTMLElement;
  fireEvent.click(within(highlightPalette).getByLabelText("突出显示色 #FFE699"));
  expect(editor.getAttributes("textStyle").backgroundColor).toBe("#FFE699");
  fireEvent.click(
    document.querySelector('button[aria-label="打开文本突出显示颜色菜单"]') as Element,
  );
  fireEvent.click(
    within(
      document.querySelector('[role="dialog"][aria-label="文本突出显示颜色"]') as HTMLElement,
    ).getByText("无高亮"),
  );
  expect(editor.getAttributes("textStyle").backgroundColor).toBeNull();
  expect(editor.state.selection.from).toBe(1);
  expect(editor.state.selection.to).toBe(3);
  view.unmount();
  editor.destroy();
});

test("floating format controls leave mixed fonts and sizes blank and apply five to the range", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<p><span style="font-size: 10.5pt; font-family: SimSun">甲</span><span style="font-size: 14pt; font-family: Source Han Serif CN">乙</span></p>',
  });
  const bus = new EditorCommandBus();
  bus.register("mixed-mini", editor);
  vi.spyOn(editor.view.dom, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 400, 200),
  ] as unknown as DOMRectList);
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 0, right: 10, top: 0, bottom: 20 });
  editor.commands.setTextSelection({ from: 1, to: 3 });
  const view = render(
    <EditorContextMenus editor={editor} editorId="mixed-mini" commandBus={bus} />,
  );
  act(() => editor.view.dispatch(editor.state.tr.setMeta("selection-menu-mixed-mini", "show")));
  const toolbar = document.querySelector('.editor-selection-menu [role="toolbar"]') as HTMLElement;
  const size = toolbar.querySelector('select[aria-label="字号"]') as HTMLSelectElement;
  const font = toolbar.querySelector('select[aria-label="字体"]') as HTMLSelectElement;
  expect(size.value).toBe("");
  expect(font.value).toBe("");
  fireEvent.change(size, { target: { value: "10.5" } });
  expect(bus.getFormatState("mixed-mini").fontSizePt).toBe(10.5);
  expect(editor.state.selection.from).toBe(1);
  expect(editor.state.selection.to).toBe(3);
  view.unmount();
  editor.destroy();
});

test("menu colors retain the range and explicit callers can still collapse it", () => {
  const editor = new Editor({ extensions: createPatentExtensions(), content: "<p>测试文字</p>" });
  const bus = new EditorCommandBus();
  bus.register("menus", editor);
  act(() => {
    editor.commands.setTextSelection({ from: 1, to: 3 });
    bus.setColor("menus", "#ff0000", true);
    bus.setHighlightColor("menus", "#ffff00", true);
  });
  expect(editor.state.selection.from).toBe(1);
  expect(editor.state.selection.to).toBe(3);
  bus.setColor("menus", "#000000", false);
  expect(editor.state.selection.empty).toBe(true);
  editor.destroy();
});

test("a new visible session waits for coordinates instead of exposing the previous position", () => {
  const editor = new Editor({ extensions: createPatentExtensions(), content: "<p>测试文字</p>" });
  const bus = new EditorCommandBus();
  bus.register("first-position", editor);
  const view = render(
    <EditorContextMenus editor={editor} editorId="first-position" commandBus={bus} />,
  );
  act(() => editor.view.dispatch(editor.state.tr.setMeta("selection-menu-first-position", "show")));
  const menu = document.querySelector<HTMLElement>(".editor-selection-menu");
  expect(menu).not.toBeNull();
  expect(menu?.style.opacity).toBe("0");
  expect(menu?.style.visibility).toBe("hidden");
  view.unmount();
  editor.destroy();
});

test("continuous scrolling hides menus once instead of dispatching a transaction per event", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<p>滚动不修改正文</p>",
  });
  const bus = new EditorCommandBus();
  bus.register("scroll-cost", editor);
  const view = render(
    <EditorContextMenus editor={editor} editorId="scroll-cost" commandBus={bus} />,
  );
  const transactions = vi.fn();
  editor.on("transaction", transactions);
  const before = editor.getJSON();
  for (let i = 0; i < 60; i++) {
    fireEvent.wheel(document.body, { deltaY: 8 });
    fireEvent.scroll(document.body);
  }
  expect(transactions.mock.calls.length).toBeLessThanOrEqual(1);
  expect(editor.getJSON()).toEqual(before);
  view.unmount();
  editor.destroy();
});

test("Mac context menu displays native redo and replace bindings", () => {
  vi.stubGlobal("documentFontPlatform", "darwin");
  const editor = new Editor({ extensions: createPatentExtensions(), content: "<p>测试文字</p>" });
  const bus = new EditorCommandBus();
  bus.register("mac-context", editor);
  vi.spyOn(editor.view.dom, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 400, 200),
  ] as unknown as DOMRectList);
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
    left: 30,
    right: 40,
    top: 30,
    bottom: 50,
  });
  const view = render(
    <EditorContextMenus
      editor={editor}
      editorId="mac-context"
      commandBus={bus}
      onFind={() => undefined}
    />,
  );
  try {
    fireEvent.keyDown(editor.view.dom, { key: "ContextMenu" });
    expect(within(document.body).getByRole("menuitem", { name: "重做" }).textContent).toContain(
      "⌘+⇧+Z",
    );
    expect(within(document.body).getByRole("menuitem", { name: "替换" }).textContent).toContain(
      "⌘+⌥+F",
    );
  } finally {
    view.unmount();
    editor.destroy();
    vi.unstubAllGlobals();
  }
});
