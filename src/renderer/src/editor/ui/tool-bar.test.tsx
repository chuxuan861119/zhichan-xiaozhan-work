import { act, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import type { EditorFormatState } from "../../app/command-bus";
import { capabilitiesForPatentBook } from "../../patents/patent-toolbar-capabilities";
import * as appDialogs from "../../shared/app-dialog";
import { ToolBar as ToolBarComponent } from "./tool-bar";
import { useToolbarOverflow } from "./use-toolbar-overflow";

vi.mock("./use-toolbar-overflow", () => ({ useToolbarOverflow: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.mocked(useToolbarOverflow).mockReturnValue([
    "下标",
    "上标",
    "左对齐",
    "居中",
    "右对齐",
    "两端对齐",
    "项目符号",
    "编号",
    "插入表格",
    "查找",
    "替换",
    "本地检查",
    "AI 纠错",
    "小栈AI助手",
    "插入图片",
    "插入数学公式",
    "插入化学方程式",
    "插入化学结构式",
    "插入物理公式",
    "插入流程图",
    "电路图",
  ]);
});

function ToolBar(
  props: Omit<
    ComponentProps<typeof ToolBarComponent>,
    "onInsertFlowchart" | "onInsertCircuitDiagram" | "onImportDocx"
  > & {
    onInsertFlowchart?: () => void;
    onInsertCircuitDiagram?: () => void;
    onImportDocx?: () => void;
  },
) {
  return (
    <ToolBarComponent
      onImportDocx={vi.fn()}
      onInsertFlowchart={vi.fn()}
      onInsertCircuitDiagram={vi.fn()}
      {...props}
    />
  );
}

const defaultFormatState: EditorFormatState = {
  bold: false,
  italic: false,
  underline: false,
  subscript: false,
  superscript: false,
  alignment: "left",
  bulletList: false,
  orderedList: false,
  paragraphStyle: "paragraph",
};

function paragraphStyleProps() {
  return {
    onNewDocument: vi.fn(),
    onOpenDocument: vi.fn(),
    onSaveDocument: vi.fn(),
    onExportDocx: vi.fn(),
    onExportPdf: vi.fn(),
    onPrint: vi.fn(),
    onCommand: vi.fn(),
    onParagraphStyle: vi.fn(),
    onFontFamily: vi.fn(),
    onFontSize: vi.fn(),
    onColor: vi.fn(),
    onInsertTable: vi.fn(),
    onInsertFormula: vi.fn(),
    onFind: vi.fn(),
    formatState: defaultFormatState,
  };
}

test.each([false, true])(
  "can move creation out of the toolbar in library mode %s",
  (libraryMode) => {
    render(
      <ToolBar
        {...paragraphStyleProps()}
        libraryMode={libraryMode}
        showTextEditingTools={false}
        showNewDocumentButton={false}
      />,
    );
    const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
    expect(within(toolbar).queryByRole("button", { name: "新建" })).toBeNull();
    expect(within(toolbar).getByRole("button", { name: "导入文件" })).toBeDefined();
  },
);

test("legacy document toolbar keeps its new-document action", () => {
  const props = paragraphStyleProps();
  render(<ToolBar {...props} showTextEditingTools={false} />);
  fireEvent.click(screen.getByRole("button", { name: "新建" }));
  expect(props.onNewDocument).toHaveBeenCalledOnce();
});

test("list buttons are unavailable in unsupported selection containers", () => {
  render(
    <ToolBar
      {...paragraphStyleProps()}
      formatState={{ ...defaultFormatState, listToolsAvailable: false }}
    />,
  );
  for (const label of ["项目符号", "编号"]) {
    expect(screen.getByRole("button", { name: label }).getAttribute("aria-disabled")).toBe("true");
  }
});

test("paragraph style primary choices are body, chapter heading and more styles", () => {
  render(<ToolBar {...paragraphStyleProps()} />);
  const select = screen.getByRole("combobox", { name: "段落样式" }) as HTMLSelectElement;
  expect(Array.from(select.options, (option) => [option.value, option.textContent])).toEqual([
    ["paragraph", "正文"],
    ["1", "章节标题"],
    ["more", "更多样式…"],
  ]);
});

test("secondary heading choices remain usable without applying the more entry as a style", () => {
  const props = paragraphStyleProps();
  render(<ToolBar {...props} />);
  const select = screen.getByRole("combobox", { name: "段落样式" }) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "more" } });
  expect(props.onParagraphStyle).not.toHaveBeenCalled();
  expect(select.value).toBe("paragraph");
  const menu = screen.getByRole("menu", { name: "更多段落样式" });
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "标题 2" }));
  expect(props.onParagraphStyle).toHaveBeenCalledExactlyOnceWith(2);
  expect(screen.queryByRole("menu", { name: "更多段落样式" })).toBeNull();
});

test.each([2, 3] as const)(
  "existing heading %s remains visible and selected in the secondary menu",
  (level) => {
    const props = paragraphStyleProps();
    render(<ToolBar {...props} formatState={{ ...defaultFormatState, paragraphStyle: level }} />);
    const select = screen.getByRole("combobox", { name: "段落样式" }) as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe(`标题 ${level}`);
    expect(
      Array.from(select.options).find((option) => option.value === String(level))?.hidden,
    ).toBe(true);
    fireEvent.change(select, { target: { value: "more" } });
    expect(select.value).toBe(String(level));
    const choice = screen.getByRole("menuitemradio", { name: `标题 ${level}` });
    expect(choice.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(choice);
    expect(props.onParagraphStyle).toHaveBeenCalledExactlyOnceWith(level);
  },
);

test("secondary style keyboard navigation starts at the selected style and cancels on resize", () => {
  const props = paragraphStyleProps();
  render(<ToolBar {...props} formatState={{ ...defaultFormatState, paragraphStyle: 3 }} />);
  const select = screen.getByRole("combobox", { name: "段落样式" });
  fireEvent.change(select, { target: { value: "more" } });
  const heading2 = screen.getByRole("menuitemradio", { name: "标题 2" });
  const heading3 = screen.getByRole("menuitemradio", { name: "标题 3" });
  expect(document.activeElement).toBe(heading3);
  fireEvent.keyDown(heading3, { key: "ArrowDown" });
  expect(document.activeElement).toBe(heading2);
  fireEvent.keyDown(heading2, { key: "End" });
  expect(document.activeElement).toBe(heading3);
  fireEvent.keyDown(heading3, { key: "Home" });
  expect(document.activeElement).toBe(heading2);
  fireEvent(window, new Event("resize"));
  expect(screen.queryByRole("menu", { name: "更多段落样式" })).toBeNull();
  expect(props.onParagraphStyle).not.toHaveBeenCalled();
});

test.each(["claims", "abstract", "description-drawings", "abstract-drawing"] as const)(
  "%s does not offer unsupported heading choices",
  (kind) => {
    render(<ToolBar {...paragraphStyleProps()} capabilities={capabilitiesForPatentBook(kind)} />);
    const select = screen.getByRole("combobox", { name: "段落样式" }) as HTMLSelectElement;
    expect(Array.from(select.options, (option) => option.value)).toEqual(["paragraph"]);
  },
);

test("secondary style menu cancels without editing and closes when its editor is no longer eligible", () => {
  const props = paragraphStyleProps();
  const view = render(<ToolBar {...props} />);
  const select = screen.getByRole("combobox", { name: "段落样式" });
  fireEvent.change(select, { target: { value: "more" } });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "更多段落样式" })).toBeNull();
  fireEvent.change(select, { target: { value: "more" } });
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu", { name: "更多段落样式" })).toBeNull();
  fireEvent.change(select, { target: { value: "more" } });
  view.rerender(<ToolBar {...props} capabilities={capabilitiesForPatentBook("claims")} />);
  expect(screen.queryByRole("menu", { name: "更多段落样式" })).toBeNull();
  view.rerender(<ToolBar {...props} />);
  expect(screen.queryByRole("menu", { name: "更多段落样式" })).toBeNull();
  fireEvent.change(select, { target: { value: "more" } });
  view.rerender(<ToolBar {...props} textEditingToolsDisabled />);
  expect(screen.queryByRole("menu", { name: "更多段落样式" })).toBeNull();
  expect(props.onParagraphStyle).not.toHaveBeenCalled();
});

describe("editor toolbar", () => {
  test("keeps the same controls and order across all five patent books", () => {
    const props = {
      onNewDocument: vi.fn(),
      onOpenDocument: vi.fn(),
      onSaveDocument: vi.fn(),
      onExportDocx: vi.fn(),
      onExportPdf: vi.fn(),
      onPrint: vi.fn(),
      onCommand: vi.fn(),
      onParagraphStyle: vi.fn(),
      onFontFamily: vi.fn(),
      onFontSize: vi.fn(),
      onColor: vi.fn(),
      onInsertTable: vi.fn(),
      onInsertFormula: vi.fn(),
      onFind: vi.fn(),
      formatState: defaultFormatState,
    };
    const view = render(<ToolBar {...props} imageInsertionAvailable />);
    const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
    view.rerender(<ToolBar {...props} tutorialMode imageInsertionAvailable />);
    for (const name of ["新建", "导入", "保存", "导出", "打印"]) {
      expect(within(toolbar).queryByRole("button", { name })).toBeNull();
    }
    expect(within(toolbar).getByRole("button", { name: "撤销" })).toBeDefined();
    view.rerender(<ToolBar {...props} imageInsertionAvailable />);
    const labels = () =>
      within(toolbar)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"));
    const originalLabels = labels();
    const originalFormula = within(toolbar).getByRole("button", { name: "插入数学公式" });
    for (const kind of [
      "claims",
      "description",
      "abstract",
      "description-drawings",
      "abstract-drawing",
    ] as const) {
      const drawing = kind === "description-drawings" || kind === "abstract-drawing";
      view.rerender(
        <ToolBar
          {...props}
          showTextEditingTools={!drawing}
          textEditingToolsDisabled={drawing}
          showDrawingInsertionTools={kind === "description-drawings"}
          imageInsertionAvailable={kind !== "abstract" && kind !== "abstract-drawing"}
          capabilities={capabilitiesForPatentBook(kind)}
        />,
      );
      expect(labels(), kind).toEqual(originalLabels);
      expect(within(toolbar).getByRole("button", { name: "插入数学公式" })).toBe(originalFormula);
      expect(
        within(toolbar).getByRole("button", { name: "插入图片" }).getAttribute("aria-disabled"),
      ).toBe(kind === "abstract" || kind === "abstract-drawing" ? "true" : "false");
    }
  });

  test("keeps unavailable image insertion greyed out in toolbar and overflow without inserting", async () => {
    const alert = vi.spyOn(appDialogs, "showAppAlert").mockImplementation(() => undefined);
    const onInsertImage = vi.fn();
    const user = userEvent.setup();
    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onInsertImage={onInsertImage}
        onFind={vi.fn()}
        formatState={defaultFormatState}
        capabilities={capabilitiesForPatentBook("abstract")}
      />,
    );
    const image = screen.getByRole("button", { name: "插入图片" });
    expect(image.getAttribute("aria-disabled")).toBe("true");
    await user.click(image);
    await user.click(screen.getByRole("button", { name: "更多工具" }));
    const menuImage = screen.getByRole("menuitem", { name: "插入图片" });
    expect(menuImage.getAttribute("aria-disabled")).toBe("true");
    await user.click(menuImage);
    expect(onInsertImage).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenLastCalledWith("当前书册不支持插入图片。");
    alert.mockRestore();
  });

  test("mixed formatting displays blank and allows choosing any existing value", async () => {
    const user = userEvent.setup();
    const onFontSize = vi.fn();
    const onFontFamily = vi.fn();
    const onParagraphStyle = vi.fn();
    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={onParagraphStyle}
        onFontFamily={onFontFamily}
        onFontSize={onFontSize}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={{
          ...defaultFormatState,
          fontSizePt: 10.5,
          mixedFontSize: true,
          mixedFontFamily: true,
          mixedParagraphStyle: true,
        }}
      />,
    );
    for (const label of ["字号", "字体", "段落样式"]) {
      const select = screen.getByRole("combobox", { name: label }) as HTMLSelectElement;
      expect(select.value).toBe("");
      expect(select.selectedOptions[0]?.textContent).toBe("");
    }
    await user.selectOptions(screen.getByRole("combobox", { name: "字号" }), "10.5");
    expect(onFontSize).toHaveBeenCalledExactlyOnceWith(10.5);
    await user.selectOptions(screen.getByRole("combobox", { name: "字体" }), "Source Han Serif CN");
    expect(onFontFamily).toHaveBeenCalledExactlyOnceWith("Source Han Serif CN");
    await user.selectOptions(screen.getByRole("combobox", { name: "段落样式" }), "paragraph");
    expect(onParagraphStyle).toHaveBeenCalledExactlyOnceWith("paragraph");
  });
  test.each([
    ["win32", "SimSun", "SimSun"],
    ["win32", "Arial", "SimSun"],
    ["win32", "KaiTi", "KaiTi"],
    ["win32", undefined, "SimSun"],
    ["darwin", "HarmonyOS Sans SC", "PingFang SC"],
    ["darwin", "SimSun", "PingFang SC"],
    ["openharmony", "PingFang SC", "HarmonyOS Sans SC"],
    ["openharmony", "SimSun", "HarmonyOS Sans SC"],
    ["darwin", "Source Han Serif CN", "Source Han Serif CN"],
  ])(
    "%s offers only its platform fonts when the document uses %s",
    (platform, fontFamily, expected) => {
      vi.stubGlobal("documentFontPlatform", platform);
      const onFontFamily = vi.fn();
      render(
        <ToolBar
          onNewDocument={vi.fn()}
          onOpenDocument={vi.fn()}
          onSaveDocument={vi.fn()}
          onExportDocx={vi.fn()}
          onExportPdf={vi.fn()}
          onPrint={vi.fn()}
          onCommand={vi.fn()}
          onParagraphStyle={vi.fn()}
          onFontFamily={onFontFamily}
          onFontSize={vi.fn()}
          onColor={vi.fn()}
          onInsertTable={vi.fn()}
          onInsertFormula={vi.fn()}
          onFind={vi.fn()}
          formatState={{ ...defaultFormatState, ...(fontFamily ? { fontFamily } : {}) }}
        />,
      );
      const select = screen.getByRole("combobox", { name: "字体" }) as HTMLSelectElement;
      expect(select.value).toBe(expected);
      expect((screen.getByRole("combobox", { name: "字号" }) as HTMLSelectElement).value).toBe(
        "14",
      );
      expect(
        Array.from(select.options, (option) => ({
          value: option.value,
          label: option.textContent,
        })),
      ).toEqual([
        ...(platform === "win32"
          ? [
              { value: "SimSun", label: "宋体" },
              { value: "FangSong", label: "仿宋" },
              { value: "KaiTi", label: "楷体" },
            ]
          : [
              {
                value: platform === "darwin" ? "PingFang SC" : "HarmonyOS Sans SC",
                label: platform === "darwin" ? "苹方（系统自带）" : "HarmonyOS Sans SC（系统自带）",
              },
            ]),
        { value: "Source Han Serif CN", label: "思源宋体" },
      ]);
      fireEvent.change(select, { target: { value: "Source Han Serif CN" } });
      expect(onFontFamily).toHaveBeenCalledExactlyOnceWith("Source Han Serif CN");
      vi.unstubAllGlobals();
    },
  );
  test("number bracket buttons require selection in both toolbar and overflow", () => {
    vi.mocked(useToolbarOverflow).mockReturnValue(["数字加括号", "数字去括号"]);
    const onCommand = vi.fn();
    const props = {
      onNewDocument: vi.fn(),
      onOpenDocument: vi.fn(),
      onSaveDocument: vi.fn(),
      onExportDocx: vi.fn(),
      onExportPdf: vi.fn(),
      onPrint: vi.fn(),
      onCommand,
      onParagraphStyle: vi.fn(),
      onFontFamily: vi.fn(),
      onFontSize: vi.fn(),
      onColor: vi.fn(),
      onInsertTable: vi.fn(),
      onInsertFormula: vi.fn(),
      onFind: vi.fn(),
      formatState: defaultFormatState,
    };
    const view = render(<ToolBar {...props} />);
    const add = screen.getByRole("button", { name: "数字加括号" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(onCommand).not.toHaveBeenCalled();
    view.rerender(
      <ToolBar {...props} formatState={{ ...defaultFormatState, hasBracketTextSelection: true }} />,
    );
    expect(add.disabled).toBe(false);
    expect(add.hasAttribute("title")).toBe(false);
    fireEvent.click(add);
    expect(onCommand).toHaveBeenLastCalledWith("add-number-brackets");
    fireEvent.click(screen.getByRole("button", { name: "更多工具" }));
    const remove = screen.getByRole("menuitem", { name: "数字去括号" });
    fireEvent.click(remove);
    expect(onCommand).toHaveBeenLastCalledWith("remove-number-brackets");
  });
  test.each([false, true])(
    "offers explicit import formats and dismisses the menu (library=%s)",
    async (libraryMode) => {
      const user = userEvent.setup();
      const onImportDocx = vi.fn();
      const onOpenDocument = vi.fn();
      render(
        <ToolBar
          libraryMode={libraryMode}
          onImportDocx={onImportDocx}
          onOpenDocument={onOpenDocument}
          onNewDocument={vi.fn()}
          onSaveDocument={vi.fn()}
          onExportDocx={vi.fn()}
          onExportPdf={vi.fn()}
          onPrint={vi.fn()}
          onCommand={vi.fn()}
          onParagraphStyle={vi.fn()}
          onFontFamily={vi.fn()}
          onFontSize={vi.fn()}
          onColor={vi.fn()}
          onInsertTable={vi.fn()}
          onInsertFormula={vi.fn()}
          onFind={vi.fn()}
          formatState={defaultFormatState}
        />,
      );
      const trigger = screen.getByRole("button", { name: "导入文件" });
      await user.click(trigger);
      expect(onOpenDocument).not.toHaveBeenCalled();
      expect(onImportDocx).not.toHaveBeenCalled();
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
        "导入 DOCX",
        "导入 PATDOC",
      ]);
      await user.click(screen.getByRole("menuitem", { name: "导入 DOCX" }));
      expect(onImportDocx).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu")).toBeNull();
      await user.click(trigger);
      await user.click(screen.getByRole("menuitem", { name: "导入 PATDOC" }));
      expect(onOpenDocument).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu")).toBeNull();
      await user.click(trigger);
      await user.keyboard("{Escape}");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      await user.click(trigger);
      await user.click(document.body);
      expect(screen.queryByRole("menu")).toBeNull();
    },
  );
  test.each([16, 18, 22.5])("displays the actual non-preset font size %s", (fontSizePt) => {
    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={{ ...defaultFormatState, fontSizePt }}
      />,
    );
    expect((screen.getByRole("combobox", { name: "字号" }) as HTMLSelectElement).value).toBe(
      String(fontSizePt),
    );
  });

  test.each(["find", "replace", null] as const)(
    "reflects find mode %s in buttons and overflow",
    (mode) => {
      render(
        <ToolBar
          onNewDocument={vi.fn()}
          onOpenDocument={vi.fn()}
          onSaveDocument={vi.fn()}
          onExportDocx={vi.fn()}
          onExportPdf={vi.fn()}
          onPrint={vi.fn()}
          onCommand={vi.fn()}
          onParagraphStyle={vi.fn()}
          onFontFamily={vi.fn()}
          onFontSize={vi.fn()}
          onColor={vi.fn()}
          onInsertTable={vi.fn()}
          onInsertFormula={vi.fn()}
          onFind={vi.fn()}
          formatState={defaultFormatState}
          findMode={mode}
        />,
      );
      expect(
        screen.getByRole("button", { name: "查找", hidden: true }).getAttribute("aria-pressed"),
      ).toBe(String(mode === "find"));
      expect(
        screen.getByRole("button", { name: "替换", hidden: true }).getAttribute("aria-pressed"),
      ).toBe(String(mode === "replace"));
      fireEvent.click(screen.getByRole("button", { name: "更多工具" }));
      expect(
        screen.getByRole("menuitemcheckbox", { name: "查找" }).getAttribute("aria-checked"),
      ).toBe(String(mode === "find"));
      expect(
        screen.getByRole("menuitemcheckbox", { name: "替换" }).getAttribute("aria-checked"),
      ).toBe(String(mode === "replace"));
    },
  );

  test("the overflow menu contains only the remaining commands in toolbar order", async () => {
    vi.mocked(useToolbarOverflow).mockReturnValue(["电路图"]);
    const circuit = vi.fn();
    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        onInsertCircuitDiagram={circuit}
        formatState={defaultFormatState}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "更多工具" }));
    const menu = screen.getByRole("menu", { name: "更多编辑工具" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["电路图"]);
    expect(within(menu).queryByRole("menuitem", { name: "查找" })).toBeNull();
    await user.click(within(menu).getByRole("menuitem", { name: "电路图" }));
    expect(circuit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu", { name: "更多编辑工具" })).toBeNull();
  });

  test("hides diagram entries in library mode", () => {
    render(
      <ToolBar
        libraryMode
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
    expect(within(toolbar).getByRole("button", { name: "新建" })).toBeDefined();
    expect(within(toolbar).getByRole("button", { name: "导入文件" })).toBeDefined();
    expect(within(toolbar).getByRole("button", { name: "导出" })).toBeDefined();
    expect(within(toolbar).queryByRole("button", { name: "插入实验图" })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: "插入流程图" })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: "电路图" })).toBeNull();
    expect(within(toolbar).getAllByRole("button")).toHaveLength(3);
    expect(within(toolbar).queryByRole("button", { name: "保存" })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: "打印" })).toBeNull();
    expect(toolbar.querySelectorAll(".tool-separator")).toHaveLength(1);
  });

  test("separates file, output, history, and formatting controls", () => {
    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
    expect(toolbar.querySelectorAll(".tool-separator")).toHaveLength(9);
  });

  test("places text polish directly after the colorful AI correction entry", async () => {
    const user = userEvent.setup();
    const onCheckProblems = vi.fn();
    const onAiCorrection = vi.fn();
    const onTextPolish = vi.fn();
    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        onReplace={vi.fn()}
        onCheckProblems={onCheckProblems}
        onAiCorrection={onAiCorrection}
        onTextPolish={onTextPolish}
        formatState={defaultFormatState}
      />,
    );

    const replace = screen.getByRole("button", { name: "替换" });
    const separator = replace.nextElementSibling;
    const quickCheckButton = screen.getByRole("button", { name: "本地检查" });
    const aiButton = screen.getByRole("button", { name: "AI 纠错" });
    const polishButton = screen.getByRole("button", { name: "小栈AI助手" });
    for (const button of [quickCheckButton, aiButton, polishButton]) {
      expect(button.hasAttribute("title")).toBe(false);
    }
    expect(separator?.classList.contains("tool-separator")).toBe(true);
    expect(separator?.nextElementSibling).toBe(quickCheckButton);
    expect(quickCheckButton.nextElementSibling).toBe(aiButton);
    expect(aiButton.nextElementSibling).toBe(polishButton);
    expect(screen.queryByRole("button", { name: /实验功能说明/ })).toBeNull();
    expect(quickCheckButton.textContent).toBe("");
    expect(quickCheckButton.querySelector("svg.quick-check-tool-icon")).not.toBeNull();
    expect(aiButton.querySelector("svg.lucide-spell-check")).not.toBeNull();
    expect(polishButton.querySelector(".xiaozhan-ai-tool-icon")?.textContent).toBe("AI");

    await user.click(quickCheckButton);
    expect(onCheckProblems).toHaveBeenCalledOnce();
    await user.click(aiButton);
    expect(onAiCorrection).toHaveBeenCalledOnce();
    await user.click(polishButton);
    expect(onTextPolish).toHaveBeenCalledOnce();
  });

  test("includes fixed shortcuts in icon-button hover text", () => {
    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        onReplace={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    expect(screen.getByRole("button", { name: "撤销" }).getAttribute("title")).toBe(
      "撤销（Ctrl+Z）",
    );
    expect(screen.getByRole("button", { name: "重做" }).getAttribute("title")).toBe(
      "重做（Ctrl+Y / Ctrl+Shift+Z）",
    );
    expect(screen.getByRole("button", { name: "粗体" }).getAttribute("title")).toBe(
      "粗体（Ctrl+B）",
    );
    expect(screen.getByRole("button", { name: "查找" }).getAttribute("title")).toBe(
      "查找（Ctrl+F）",
    );
    expect(screen.getByRole("button", { name: "替换" }).getAttribute("title")).toBe(
      "替换（Ctrl+H）",
    );
  });

  test("hides text editing tools while keeping document actions and history controls", () => {
    render(
      <ToolBar
        showTextEditingTools={false}
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
    expect(within(toolbar).getByRole("button", { name: "保存" })).toBeDefined();
    expect(within(toolbar).getByRole("button", { name: "撤销" })).toBeDefined();
    expect(within(toolbar).getByRole("button", { name: "重做" })).toBeDefined();
    expect(within(toolbar).queryByRole("combobox", { name: "段落样式" })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: "粗体" })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: "插入表格" })).toBeNull();
    expect(within(toolbar).getByRole("button", { name: "插入图片" })).toBeDefined();
    expect(within(toolbar).queryByRole("button", { name: "更多工具" })).toBeNull();
    const visibleSeparators = [...toolbar.querySelectorAll(".tool-separator")].filter(
      (separator) => !separator.closest("[hidden]"),
    );
    expect(visibleSeparators).toHaveLength(3);
  });

  test("explains why undo and redo are unavailable on the abstract drawing", async () => {
    const user = userEvent.setup();
    const alert = vi.spyOn(appDialogs, "showAppAlert").mockImplementation(() => undefined);
    render(
      <ToolBar
        showTextEditingTools={false}
        historyAvailable={false}
        historyUnavailableReason="摘要附图不支持撤销和重做。"
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    const undo = screen.getByRole("button", { name: "撤销" });
    const redo = screen.getByRole("button", { name: "重做" });
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    expect(redo.getAttribute("title")).toBe(
      "摘要附图不支持撤销和重做。\n重做（Ctrl+Y / Ctrl+Shift+Z）",
    );
    await user.click(undo);
    expect(alert).toHaveBeenCalledWith("摘要附图不支持撤销和重做。");
    alert.mockRestore();
  });

  test("disables undo and redo independently from their actual history state", () => {
    render(
      <ToolBar
        canUndo={false}
        canRedo
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    expect(screen.getByRole("button", { name: "撤销" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "重做" }).getAttribute("aria-disabled")).toBe(
      "false",
    );
  });

  test("allows drawing history without an active text editor", () => {
    const onCommand = vi.fn();
    render(
      <ToolBar
        editorAvailable={false}
        showTextEditingTools={false}
        historyAvailable
        canUndo
        canRedo
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={onCommand}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );
    for (const name of ["撤销", "重做"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("false");
      fireEvent.click(button);
    }
    expect(onCommand.mock.calls).toEqual([["undo"], ["redo"]]);
  });

  test("keeps find, replace, quick check, and AI before formula tools", () => {
    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    const numberedList = screen.getByRole("button", { name: "编号" });
    const table = screen.getByRole("button", { name: "插入表格" });
    const find = screen.getByRole("button", { name: "查找" });
    const replace = screen.getByRole("button", { name: "替换" });
    const quickCheck = screen.getByRole("button", { name: "本地检查" });
    const aiCorrection = screen.getByRole("button", { name: "AI 纠错" });
    const textPolish = screen.getByRole("button", { name: "小栈AI助手" });
    const formula = screen.getByRole("button", { name: "插入数学公式" });

    expect(numberedList.nextElementSibling?.classList.contains("tool-separator")).toBe(true);
    const image = screen.getByRole("button", { name: "插入图片" });
    expect(table.nextElementSibling).toBe(image);
    expect(image.nextElementSibling).toBe(find);
    expect(find.nextElementSibling).toBe(replace);
    expect(replace.nextElementSibling?.classList.contains("tool-separator")).toBe(true);
    expect(replace.nextElementSibling?.nextElementSibling).toBe(quickCheck);
    expect(quickCheck.nextElementSibling).toBe(aiCorrection);
    expect(aiCorrection.nextElementSibling).toBe(textPolish);
    expect(textPolish.parentElement?.nextElementSibling?.classList.contains("tool-separator")).toBe(
      true,
    );
    expect(
      textPolish.compareDocumentPosition(formula) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("lets the user choose DOCX or PDF from the toolbar export button", async () => {
    const user = userEvent.setup();
    const onExportDocx = vi.fn();
    const onExportPdf = vi.fn();

    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={onExportDocx}
        onExportPdf={onExportPdf}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    await user.click(screen.getByRole("button", { name: "导出" }));
    const menu = screen.getByRole("menu", { name: "选择导出格式" });
    expect(menu).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "导出 DOCX" })).toBeDefined();
    await user.click(screen.getByRole("menuitem", { name: "导出 PDF" }));

    expect(onExportPdf).toHaveBeenCalledOnce();
    expect(onExportDocx).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu", { name: "选择导出格式" })).toBeNull();
  });

  test("lists PATDOC as the last entry in the toolbar export menu", async () => {
    const user = userEvent.setup();
    const onExportDocx = vi.fn();
    const onExportPdf = vi.fn();
    const onExportPatdoc = vi.fn();

    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={onExportDocx}
        onExportPdf={onExportPdf}
        onExportPatdoc={onExportPatdoc}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    await user.click(screen.getByRole("button", { name: "导出" }));
    const menu = screen.getByRole("menu", { name: "选择导出格式" });
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(labels).toEqual(["导出 DOCX", "导出 PDF", "导出 PATDOC"]);

    await user.click(screen.getByRole("menuitem", { name: "导出 PATDOC" }));
    expect(onExportPatdoc).toHaveBeenCalledOnce();
    expect(onExportDocx).not.toHaveBeenCalled();
    expect(onExportPdf).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu", { name: "选择导出格式" })).toBeNull();
  });

  test("keeps the editor focus when pressing the toolbar surface", () => {
    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
    const event = createEvent.pointerDown(toolbar, { button: 0 });
    const dispatched = fireEvent(toolbar, event);

    expect(dispatched).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  test("reflects active formatting in toolbar and overflow controls", async () => {
    const user = userEvent.setup();
    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={{
          ...defaultFormatState,
          bold: true,
          superscript: true,
          alignment: "center",
          bulletList: true,
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "粗体" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "上标" }).classList.contains("is-active")).toBe(true);
    expect(screen.getByRole("button", { name: "段落对齐" }).getAttribute("title")).toBe(
      "段落对齐：居中",
    );
    await user.click(screen.getByRole("button", { name: "段落对齐" }));
    expect(screen.getByRole("menuitemradio", { name: "居中" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await user.click(screen.getByRole("button", { name: "段落对齐" }));
    expect(screen.getByRole("button", { name: "斜体" }).getAttribute("aria-pressed")).toBe("false");

    await user.click(screen.getByRole("button", { name: "更多工具" }));
    expect(
      screen.getByRole("menuitemcheckbox", { name: "上标" }).classList.contains("is-active"),
    ).toBe(true);
    expect(
      screen.getByRole("menuitemcheckbox", { name: "项目符号" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("uses a Word-style split text-color button with black as its default", async () => {
    const user = userEvent.setup();
    const onColor = vi.fn();
    render(
      <>
        <ToolBar
          onNewDocument={vi.fn()}
          onOpenDocument={vi.fn()}
          onSaveDocument={vi.fn()}
          onExportDocx={vi.fn()}
          onExportPdf={vi.fn()}
          onPrint={vi.fn()}
          onCommand={vi.fn()}
          onParagraphStyle={vi.fn()}
          onFontFamily={vi.fn()}
          onFontSize={vi.fn()}
          onColor={onColor}
          onInsertTable={vi.fn()}
          onInsertFormula={vi.fn()}
          onFind={vi.fn()}
          formatState={defaultFormatState}
        />
        <button type="button">页面空白处</button>
      </>,
    );

    await user.click(screen.getByRole("button", { name: "应用文字颜色" }));
    expect(onColor).toHaveBeenLastCalledWith("#000000");
    expect(screen.queryByRole("dialog", { name: "文字颜色" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "打开文字颜色菜单" }));
    const palette = screen.getByRole("dialog", { name: "文字颜色" });
    expect(palette).toBeDefined();
    expect(screen.getByText("主题颜色")).toBeDefined();
    expect(screen.getByText("标准色")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "页面空白处" }));
    expect(screen.queryByRole("dialog", { name: "文字颜色" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "打开文字颜色菜单" }));
    await user.click(screen.getByRole("button", { name: "主题色 深蓝" }));
    expect(onColor).toHaveBeenLastCalledWith("#17365D");
    expect(screen.queryByRole("dialog", { name: "文字颜色" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "应用文字颜色" }));
    expect(onColor).toHaveBeenLastCalledWith("#17365D");

    await user.click(screen.getByRole("button", { name: "打开文字颜色菜单" }));
    await user.click(screen.getByLabelText("其他颜色"));
    expect(screen.getByRole("dialog", { name: "其他颜色" })).toBeDefined();
  });

  test("uses a Word-style split highlight button with bright yellow as its default", async () => {
    const user = userEvent.setup();
    const onHighlightColor = vi.fn();
    render(
      <>
        <ToolBar
          onNewDocument={vi.fn()}
          onOpenDocument={vi.fn()}
          onSaveDocument={vi.fn()}
          onExportDocx={vi.fn()}
          onExportPdf={vi.fn()}
          onPrint={vi.fn()}
          onCommand={vi.fn()}
          onParagraphStyle={vi.fn()}
          onFontFamily={vi.fn()}
          onFontSize={vi.fn()}
          onColor={vi.fn()}
          onHighlightColor={onHighlightColor}
          onInsertTable={vi.fn()}
          onInsertFormula={vi.fn()}
          onFind={vi.fn()}
          formatState={defaultFormatState}
        />
        <button type="button">页面空白处</button>
      </>,
    );

    await user.click(screen.getByRole("button", { name: "应用文本突出显示颜色" }));
    expect(onHighlightColor).toHaveBeenLastCalledWith("#FFFF00");
    expect(screen.queryByRole("dialog", { name: "文本突出显示颜色" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "打开文本突出显示颜色菜单" }));
    const palette = screen.getByRole("dialog", { name: "文本突出显示颜色" });
    expect(palette).toBeDefined();
    expect(screen.getByText("突出显示颜色")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "突出显示色 #B4C7E7" }));
    expect(onHighlightColor).toHaveBeenLastCalledWith("#B4C7E7");
    expect(screen.queryByRole("dialog", { name: "文本突出显示颜色" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "应用文本突出显示颜色" }));
    expect(onHighlightColor).toHaveBeenLastCalledWith("#B4C7E7");

    await user.click(screen.getByRole("button", { name: "打开文本突出显示颜色菜单" }));
    await user.click(screen.getByRole("button", { name: "无高亮" }));
    expect(onHighlightColor).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("dialog", { name: "文本突出显示颜色" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "打开文本突出显示颜色菜单" }));
    await user.click(screen.getByLabelText("其他突出显示颜色"));
    expect(screen.getByRole("dialog", { name: "其他突出显示颜色" })).toBeDefined();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "打开文本突出显示颜色菜单" }));
    await user.click(screen.getByRole("button", { name: "页面空白处" }));
    expect(screen.queryByRole("dialog", { name: "文本突出显示颜色" })).toBeNull();
  });

  test("reflects the chosen colors on the split button icons", async () => {
    const user = userEvent.setup();
    const onColor = vi.fn();
    const onHighlightColor = vi.fn();
    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={onColor}
        onHighlightColor={onHighlightColor}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    const colorMain = screen.getByRole("button", { name: "应用文字颜色" });
    const letter = colorMain.querySelector(".color-picker-letter");
    expect(letter).not.toBeNull();
    expect((letter as HTMLElement).style.color).toBe("rgb(0, 0, 0)");
    expect(colorMain.querySelector(".color-picker-indicator")).toBeNull();

    const highlightMain = screen.getByRole("button", { name: "应用文本突出显示颜色" });
    const fillPath = highlightMain.querySelector("svg path");
    expect(fillPath?.getAttribute("fill")).toBe("#FFFF00");
    expect(highlightMain.querySelector(".color-picker-indicator")).toBeNull();

    await user.click(screen.getByRole("button", { name: "打开文字颜色菜单" }));
    await user.click(screen.getByRole("button", { name: "标准色 #C00000" }));
    expect((letter as HTMLElement).style.color).toBe("rgb(192, 0, 0)");
    expect(onColor).toHaveBeenLastCalledWith("#C00000");

    await user.click(screen.getByRole("button", { name: "打开文本突出显示颜色菜单" }));
    await user.click(screen.getByRole("button", { name: "突出显示色 #C6E0B4" }));
    expect(fillPath?.getAttribute("fill")).toBe("#C6E0B4");
    expect(onHighlightColor).toHaveBeenLastCalledWith("#C6E0B4");
  });

  test("exposes optional editor commands through the more-tools menu", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn();
    const onInsertTable = vi.fn();
    const onInsertFormula = vi.fn();
    const onOpenDocument = vi.fn();
    const onSaveDocument = vi.fn();
    const onExportDocx = vi.fn();
    const onPrint = vi.fn();
    const onFind = vi.fn();
    const onReplace = vi.fn();

    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={onOpenDocument}
        onSaveDocument={onSaveDocument}
        onExportDocx={onExportDocx}
        onExportPdf={vi.fn()}
        onPrint={onPrint}
        onCommand={onCommand}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={onInsertTable}
        onInsertFormula={onInsertFormula}
        onFind={onFind}
        onReplace={onReplace}
        formatState={defaultFormatState}
      />,
    );

    expect(screen.queryByRole("button", { name: "插入分页符" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "导入文件" }));
    await user.click(screen.getByRole("menuitem", { name: "导入 PATDOC" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("button", { name: "导出" }));
    await user.click(screen.getByRole("menuitem", { name: "导出 DOCX" }));
    await user.click(screen.getByRole("button", { name: "打印" }));
    expect(onOpenDocument).toHaveBeenCalledOnce();
    expect(onSaveDocument).toHaveBeenCalledOnce();
    expect(onExportDocx).toHaveBeenCalledOnce();
    expect(onPrint).toHaveBeenCalledOnce();

    const moreButton = screen.getByRole("button", { name: "更多工具" });
    expect(moreButton.getAttribute("aria-expanded")).toBe("false");

    await user.click(moreButton);
    expect(moreButton.getAttribute("aria-expanded")).toBe("true");

    const menu = screen.getByRole("menu", { name: "更多编辑工具" });
    expect(menu).toBeDefined();
    expect(within(menu).queryByRole("button", { name: /实验功能说明/ })).toBeNull();
    for (const label of ["查找", "替换", "本地检查", "AI 纠错", "小栈AI助手"]) {
      expect(within(menu).getByRole("menuitemcheckbox", { name: label })).toBeDefined();
    }
    expect(screen.getByRole("button", { name: "插入图片" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "插入图片" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(screen.queryByRole("menuitem", { name: "插入分页符" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "更多工具" }));

    await user.click(screen.getByRole("button", { name: "插入表格" }));
    expect(screen.getByRole("region", { name: "插入表格设置" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "插入 4 行 6 列表格" }));
    await user.click(screen.getByRole("button", { name: "插入数学公式" }));
    expect(onInsertTable).toHaveBeenCalledWith({
      rows: 4,
      columns: 6,
      headerRowCount: 0,
      layoutMode: "fit-page",
    });
    expect(onInsertFormula).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "查找" }));
    expect(onFind).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "替换" }));
    expect(onReplace).toHaveBeenCalledOnce();
    await user.click(moreButton);
    const editorInput = document.createElement("textarea");
    editorInput.addEventListener("keydown", (event) => event.stopPropagation());
    document.body.append(editorInput);
    try {
      editorInput.focus();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu", { name: "更多编辑工具" })).toBeNull();
    } finally {
      editorInput.remove();
    }
  });

  test("enables the direct image insertion action when supported", async () => {
    const user = userEvent.setup();
    const onInsertImage = vi.fn();
    render(
      <ToolBar
        imageInsertionAvailable
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onInsertImage={onInsertImage}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
    const button = within(toolbar).getByRole("button", { name: "插入图片" });
    const cad = within(toolbar).getByRole("button", { name: "CAD标号" });
    const table = within(toolbar).getByRole("button", { name: "插入表格" });
    expect(table.nextElementSibling).toBe(button);
    expect(cad.nextElementSibling).toBe(
      within(toolbar).getByRole("button", { name: "插入流程图" }),
    );
    const assistant = within(toolbar).getByRole("button", { name: "小栈AI助手" });
    expect(assistant.parentElement?.nextElementSibling?.classList.contains("tool-separator")).toBe(
      true,
    );
    expect(assistant.parentElement?.nextElementSibling?.nextElementSibling).toBe(cad.parentElement);
    await user.click(button);

    expect(onInsertImage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menuitem", { name: "插入图片" })).toBeNull();
  });

  test("explains unsupported structural tools without calling callbacks", async () => {
    const user = userEvent.setup();
    const alert = vi.spyOn(appDialogs, "showAppAlert").mockImplementation(() => undefined);
    const onCommand = vi.fn();
    const onInsertTable = vi.fn();
    const onInsertFormula = vi.fn();
    const onInsertChemistry = vi.fn();
    const onInsertChemicalStructure = vi.fn();
    const onInsertPhysicsFormula = vi.fn();
    const onParagraphStyle = vi.fn();

    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={onCommand}
        onParagraphStyle={onParagraphStyle}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={onInsertTable}
        onInsertFormula={onInsertFormula}
        onInsertChemistry={onInsertChemistry}
        onInsertChemicalStructure={onInsertChemicalStructure}
        onInsertPhysicsFormula={onInsertPhysicsFormula}
        onFind={vi.fn()}
        formatState={defaultFormatState}
        capabilities={{
          headings: false,
          lists: false,
          tables: false,
          formulas: false,
          chemistry: false,
          chemicalStructures: false,
          images: false,
          pageBreaks: false,
        }}
      />,
    );

    const style = screen.getByRole("combobox", { name: "段落样式" }) as HTMLSelectElement;
    expect(Array.from(style.options, (option) => option.value)).toEqual(["paragraph"]);
    fireEvent.change(style, {
      target: { value: "1" },
    });
    await user.click(screen.getByRole("button", { name: "项目符号" }));
    await user.click(screen.getByRole("button", { name: "插入表格" }));
    await user.click(screen.getByRole("button", { name: "插入数学公式" }));
    await user.click(screen.getByRole("button", { name: "插入化学方程式" }));
    await user.click(screen.getByRole("button", { name: "插入化学结构式" }));
    await user.click(screen.getByRole("button", { name: "插入物理公式" }));

    expect(onParagraphStyle).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalledWith("bullet-list");
    expect(onInsertTable).not.toHaveBeenCalled();
    expect(onInsertFormula).not.toHaveBeenCalled();
    expect(onInsertChemistry).not.toHaveBeenCalled();
    expect(onInsertChemicalStructure).not.toHaveBeenCalled();
    expect(onInsertPhysicsFormula).not.toHaveBeenCalled();
    expect(alert.mock.calls.map(([message]) => message)).toEqual([
      "当前书册不支持列表。",
      "当前书册不支持表格。",
      "当前书册不支持数学公式。",
      "当前书册不支持化学方程式。",
      "当前书册不支持化学结构式。",
      "当前书册不支持物理公式。",
    ]);

    await user.click(screen.getByRole("button", { name: "更多工具" }));
    expect(screen.queryByRole("menuitem", { name: "插入分页符" })).toBeNull();

    expect(onCommand).not.toHaveBeenCalledWith("page-break");
    alert.mockRestore();
  });

  test("explains editing actions on pages without a text editor", async () => {
    const user = userEvent.setup();
    const alert = vi.spyOn(appDialogs, "showAppAlert").mockImplementation(() => undefined);
    const onCommand = vi.fn();
    const onFind = vi.fn();

    render(
      <ToolBar
        editorAvailable={false}
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={onCommand}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={onFind}
        formatState={defaultFormatState}
      />,
    );

    await user.click(screen.getByRole("button", { name: "粗体" }));
    await user.click(screen.getByRole("button", { name: "查找" }));

    expect(onCommand).not.toHaveBeenCalled();
    expect(onFind).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenLastCalledWith("当前页面不是文本编辑页面，无法使用此功能。");
    alert.mockRestore();
  });

  test("keeps the chemistry entry immediately after mathematics in toolbar and overflow", async () => {
    const user = userEvent.setup();
    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onInsertChemistry={vi.fn()}
        onInsertChemicalStructure={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    const formula = screen.getByRole("button", { name: "插入数学公式" });
    const equation = screen.getByRole("button", { name: "插入化学方程式" });
    const structure = screen.getByRole("button", { name: "插入化学结构式" });
    const physics = screen.getByRole("button", { name: "插入物理公式" });
    expect(formula.compareDocumentPosition(equation) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(equation.compareDocumentPosition(structure) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(structure.compareDocumentPosition(physics) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    await user.click(screen.getByRole("button", { name: "更多工具" }));
    const labels = within(screen.getByRole("menu", { name: "更多编辑工具" }))
      .getAllByRole("menuitem")
      .map((item) => item.getAttribute("aria-label"));
    expect(labels.slice(-6, -2)).toEqual([
      "插入数学公式",
      "插入化学方程式",
      "插入化学结构式",
      "插入物理公式",
    ]);
  });

  test("closes the overflow menu on outside pointer down and keeps it open while interacting inside", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn();
    render(
      <ToolBar
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={onCommand}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    const moreButton = screen.getByRole("button", { name: "更多工具" });
    await user.click(moreButton);
    expect(screen.getByRole("menu", { name: "更多编辑工具" })).toBeDefined();

    fireEvent.pointerDown(screen.getByRole("menuitemcheckbox", { name: "下标" }));
    expect(screen.getByRole("menu", { name: "更多编辑工具" })).toBeDefined();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "更多编辑工具" })).toBeNull();

    await user.click(moreButton);
    expect(screen.getByRole("menu", { name: "更多编辑工具" })).toBeDefined();
    await user.click(screen.getByRole("menuitemcheckbox", { name: "上标" }));
    expect(onCommand).toHaveBeenCalledWith("superscript");
    expect(screen.queryByRole("menu", { name: "更多编辑工具" })).toBeNull();
  });

  test("closes the overflow menu automatically when the toolbar width changes", async () => {
    class MockResizeObserver {
      static instances: MockResizeObserver[] = [];
      readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        MockResizeObserver.instances.push(this);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const originalResizeObserver = globalThis.ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver;
    try {
      const user = userEvent.setup();
      render(
        <ToolBar
          onNewDocument={vi.fn()}
          onOpenDocument={vi.fn()}
          onSaveDocument={vi.fn()}
          onExportDocx={vi.fn()}
          onExportPdf={vi.fn()}
          onPrint={vi.fn()}
          onCommand={vi.fn()}
          onParagraphStyle={vi.fn()}
          onFontFamily={vi.fn()}
          onFontSize={vi.fn()}
          onColor={vi.fn()}
          onInsertTable={vi.fn()}
          onInsertFormula={vi.fn()}
          onFind={vi.fn()}
          formatState={defaultFormatState}
        />,
      );
      await user.click(screen.getByRole("button", { name: "更多工具" }));
      expect(screen.getByRole("menu", { name: "更多编辑工具" })).toBeDefined();

      const observer = MockResizeObserver.instances.at(-1);
      if (!observer) throw new Error("ResizeObserver 未创建。");
      const trigger = (width: number) =>
        act(() =>
          observer.callback(
            [{ contentRect: { width } }] as unknown as ResizeObserverEntry[],
            observer,
          ),
        );
      trigger(500);
      expect(screen.getByRole("menu", { name: "更多编辑工具" })).toBeDefined();
      trigger(600);
      expect(screen.queryByRole("menu", { name: "更多编辑工具" })).toBeNull();
    } finally {
      MockResizeObserver.instances = [];
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
    }
  });

  test("keeps the flowchart action visible without text tools or rich-text capabilities", () => {
    render(
      <ToolBar
        showTextEditingTools={false}
        capabilities={{
          headings: false,
          lists: false,
          tables: false,
          formulas: false,
          chemistry: false,
          images: false,
          pageBreaks: false,
        }}
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onInsertFlowchart={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    expect(screen.getByRole("button", { name: "插入流程图" }).hidden).toBe(false);
  });

  test("greys out the whole text tool set instead of hiding it on description drawings", async () => {
    const user = userEvent.setup();
    const alert = vi.spyOn(appDialogs, "showAppAlert").mockImplementation(() => undefined);
    const onCommand = vi.fn();
    const onInsertTable = vi.fn();
    const onFind = vi.fn();
    render(
      <ToolBar
        showTextEditingTools={false}
        textEditingToolsDisabled
        showDrawingInsertionTools
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={onCommand}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={onInsertTable}
        onInsertFormula={vi.fn()}
        onFind={onFind}
        formatState={defaultFormatState}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
    // 图标照样占位、只是置灰：不能再像以前一样从无障碍树里消失。
    for (const name of ["粗体", "插入表格", "更多工具"]) {
      expect(within(toolbar).queryByRole("button", { name })).not.toBeNull();
    }
    expect(within(toolbar).getByRole("combobox", { name: "段落样式" })).not.toBeNull();
    for (const name of ["粗体", "插入表格", "查找", "本地检查"]) {
      expect(within(toolbar).getByRole("button", { name }).getAttribute("aria-disabled")).toBe(
        "true",
      );
    }
    for (const name of ["段落样式", "字体", "字号"]) {
      expect(within(toolbar).getByRole("combobox", { name }).getAttribute("aria-disabled")).toBe(
        "true",
      );
    }
    // 插入公式/化学结构式的正文版被附图版取代，同名按钮全工具栏只应剩一个可用的。
    for (const name of ["插入数学公式", "插入物理公式", "插入化学方程式", "插入化学结构式"]) {
      expect(within(toolbar).getAllByRole("button", { name })).toHaveLength(1);
      expect(within(toolbar).getByRole("button", { name }).getAttribute("aria-disabled")).toBe(
        "false",
      );
    }
    await user.click(within(toolbar).getByRole("button", { name: "粗体" }));
    await user.click(within(toolbar).getByRole("button", { name: "插入表格" }));
    await user.click(within(toolbar).getByRole("button", { name: "查找" }));
    expect(onCommand).not.toHaveBeenCalled();
    expect(onInsertTable).not.toHaveBeenCalled();
    expect(onFind).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith("当前页面不是文本编辑页面，无法使用此功能。");
    alert.mockRestore();
  });

  test("keeps the drawing insertion actions usable while the text tools are greyed out", async () => {
    const user = userEvent.setup();
    const onInsertFormula = vi.fn();
    const onInsertPhysicsFormula = vi.fn();
    const onInsertChemistry = vi.fn();
    const onInsertChemicalStructure = vi.fn();
    render(
      <ToolBar
        showTextEditingTools={false}
        textEditingToolsDisabled
        showDrawingInsertionTools
        editorAvailable={false}
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={onInsertFormula}
        onInsertPhysicsFormula={onInsertPhysicsFormula}
        onInsertChemistry={onInsertChemistry}
        onInsertChemicalStructure={onInsertChemicalStructure}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
    const drawingActions = [
      ["插入数学公式", onInsertFormula],
      ["插入物理公式", onInsertPhysicsFormula],
      ["插入化学方程式", onInsertChemistry],
      ["插入化学结构式", onInsertChemicalStructure],
    ] as const;
    for (const [label, callback] of drawingActions) {
      const button = within(toolbar).getByRole("button", { name: label });
      expect(button.getAttribute("aria-disabled")).toBe("false");
      expect(button.closest(".tool-group")?.classList.contains("optional-tools")).toBe(true);
      await user.click(button);
      expect(callback).toHaveBeenCalledOnce();
    }
    for (const [label, callback] of drawingActions) {
      await user.click(within(toolbar).getByRole("button", { name: "更多工具" }));
      const entry = screen.getByRole("menuitem", { name: label });
      expect(entry.getAttribute("aria-disabled")).toBe("false");
      await user.click(entry);
      expect(callback).toHaveBeenCalledTimes(2);
    }
  });

  test("keeps the text tools hidden when the document simply has no text editing at all", () => {
    render(
      <ToolBar
        showTextEditingTools={false}
        onNewDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onPrint={vi.fn()}
        onCommand={vi.fn()}
        onParagraphStyle={vi.fn()}
        onFontFamily={vi.fn()}
        onFontSize={vi.fn()}
        onColor={vi.fn()}
        onInsertTable={vi.fn()}
        onInsertFormula={vi.fn()}
        onFind={vi.fn()}
        formatState={defaultFormatState}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "常用工具" });
    expect(within(toolbar).queryByRole("combobox", { name: "段落样式" })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: "粗体" })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: "更多工具" })).toBeNull();
  });
});

test("Harmony hides AI in toolbar and overflow", () => {
  vi.stubGlobal("documentFontPlatform", "ohos");
  render(<ToolBar {...paragraphStyleProps()} />);
  expect(screen.queryByRole("button", { name: "AI 纠错" })).toBeNull();
  expect(screen.queryByRole("button", { name: "小栈AI助手" })).toBeNull();
});
