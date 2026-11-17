import { ActiveEditorSessionContext, EditorSessionScope } from "../shared/editor-session-scope";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  configureFormulaVirtualKeyboard,
  FormulaCollectionDialog,
  FormulaDialog,
  getFormulaKeyboardLayerId,
} from "./ui/formula-dialog";

describe("formula dialog", () => {
  test("offers separate insert and replace drawing actions", async () => {
    const replace = vi.fn();
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="block"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onInsertToDrawings={vi.fn()}
        onReplaceToDrawings={replace}
      />,
    );
    expect(screen.queryByRole("button", { name: "插入附图" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "替换附图" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("x"));
  });
  test("formula position radios remain independent across modeless document editors", () => {
    const props = {
      initialLatex: "",
      allowModeChange: true,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      displayMode: "modeless" as const,
    };
    render(
      <>
        <FormulaDialog {...props} initialMode="inline" />
        <FormulaDialog {...props} initialMode="block" />
      </>,
    );
    const [first, second] = screen.getAllByRole("dialog");
    if (!first || !second) throw new Error("Missing formula dialogs");
    fireEvent.click(within(first).getByRole("radio", { name: "独立公式" }));
    expect(
      (within(second).getByRole("radio", { name: "独立公式" }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(within(first).getByRole("radio", { name: "行内公式" }));
    expect(
      (within(first).getByRole("radio", { name: "行内公式" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(second).getByRole("radio", { name: "独立公式" }) as HTMLInputElement).checked,
    ).toBe(true);
  });
  test("rejects source exceeding the persisted formula limit and retains the draft", () => {
    const onConfirm = vi.fn();
    render(
      <FormulaDialog
        initialLatex={`x${" ".repeat(100_000)}`}
        initialMode="inline"
        allowModeChange
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("过长");
  });
  test("focuses the validation prompt and lets Escape dismiss only the prompt", async () => {
    const onCancel = vi.fn();
    render(
      <FormulaDialog
        initialLatex={String.raw`\notASupportedCommand{x}`}
        initialMode="inline"
        allowModeChange
        displayMode="modeless"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "确定" }));
    const alert = screen.getByRole("alertdialog");
    await waitFor(() => expect(alert.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "编辑数学公式" })).toBeTruthy();
  });
  test("a newly opened modeless collection receives focus and Escape closes it", async () => {
    const onCancel = vi.fn();
    render(
      <FormulaCollectionDialog
        titleId="physics-test"
        title="物理公式"
        groups={[]}
        onInsert={vi.fn()}
        onCancel={onCancel}
        displayMode="modeless"
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "物理公式" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape", isComposing: true });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
  test("a failed drawing insertion preserves input and allows retry", async () => {
    const onInsertToDrawings = vi.fn().mockRejectedValue(new Error("render failed"));
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onInsertToDrawings={onInsertToDrawings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "插入附图" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("输入内容已保留"));
    expect((screen.getByRole("button", { name: "插入附图" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(onInsertToDrawings).toHaveBeenCalledWith("x");
  });

  test("unexpected save exceptions keep the dialog usable", () => {
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="inline"
        allowModeChange
        onConfirm={() => {
          throw new Error("failed");
        }}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("alert").textContent).toContain("公式未能保存");
    expect(screen.getByRole("textbox", { name: "可视公式编辑器" })).toBeDefined();
  });

  test("refreshes content and mode when the requested formula changes", () => {
    const props = { allowModeChange: true, onConfirm: vi.fn(), onCancel: vi.fn() };
    const { rerender } = render(<FormulaDialog {...props} initialLatex="a" initialMode="inline" />);
    rerender(<FormulaDialog {...props} initialLatex="b" initialMode="block" />);
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(props.onConfirm).toHaveBeenCalledWith({ latex: "b", mode: "block" });
  });

  test("supports Ctrl Shift Z redo without restoring history buttons", () => {
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const field = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
      value: string;
      executeCommand: ReturnType<typeof vi.fn>;
    };
    field.value = "x";
    field.executeCommand = vi.fn();
    fireEvent.keyDown(field, { key: "Z", ctrlKey: true, shiftKey: true });
    expect(field.executeCommand).toHaveBeenLastCalledWith("redo");
  });

  test("Escape closes only the top formula dialog and ignores composition", () => {
    const onCancel = vi.fn();
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const field = screen.getByRole("textbox", { name: "可视公式编辑器" });
    fireEvent.keyDown(field, { key: "Escape", isComposing: true });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "矩阵" }));
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: "行数" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "插入矩阵" })).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test("blocks invalid drawing insertion and distinguishes unsupported commands", () => {
    const onInsertToDrawings = vi.fn();
    render(
      <FormulaDialog
        initialLatex={String.raw`\notASupportedCommand{x}`}
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onInsertToDrawings={onInsertToDrawings}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("不支持");
    fireEvent.click(screen.getByRole("button", { name: "插入附图" }));
    expect(onInsertToDrawings).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toContain("不支持");
  });

  test("retains the draft and reports unsuccessful confirmation", () => {
    const onConfirm = vi.fn(() => "原公式已被删除，请重新选择。");
    render(
      <FormulaDialog
        initialLatex="x+1"
        initialMode="inline"
        allowModeChange
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("alert").textContent).toContain("原公式已被删除");
    expect(screen.getByRole("dialog", { name: "编辑数学公式" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(onConfirm).toHaveBeenLastCalledWith({ latex: "x+1", mode: "inline" });
  });

  test("uses the math editor close button style for formula collection dialogs", () => {
    render(
      <FormulaCollectionDialog
        titleId="physics-formula-title"
        title="物理公式"
        groups={[]}
        onInsert={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const closeButton = screen.getByRole("button", { name: "关闭弹窗" });
    expect(closeButton.classList.contains("dialog-close-button")).toBe(true);
    expect(closeButton.getAttribute("title")).toBe("关闭弹窗（Esc）");
    expect(closeButton.querySelector("svg.dialog-close-icon")).not.toBeNull();
  });

  test("lets a selected physical formula be inserted into description drawings", async () => {
    const user = userEvent.setup();
    const onInsertToDrawings = vi.fn();
    render(
      <FormulaCollectionDialog
        titleId="physics-formula-title"
        title="物理公式"
        groups={[
          {
            heading: null,
            items: [["动能", "E=mc^2", "E=mc^2"]],
          },
        ]}
        onInsert={vi.fn()}
        onCancel={vi.fn()}
        onInsertToDrawings={onInsertToDrawings}
      />,
    );

    await user.click(screen.getByRole("button", { name: "插入附图" }));
    expect(onInsertToDrawings).toHaveBeenCalledWith("E=mc^2");
  });

  test("visually marks the selected physical formula and keeps the action footer adaptive", async () => {
    const user = userEvent.setup();
    render(
      <FormulaCollectionDialog
        titleId="physics-formula-title"
        title="物理公式"
        groups={[
          {
            heading: null,
            items: [
              ["动能", "E_k", "E_k"],
              ["动量", "p=mv", "p=mv"],
            ],
          },
        ]}
        onInsert={vi.fn()}
        onCancel={vi.fn()}
        onInsertToDrawings={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "动能" }).classList.contains("is-selected")).toBe(
      true,
    );
    expect(
      screen
        .getByRole("button", { name: "取消" })
        .closest("footer")
        ?.classList.contains("other-formula-dialog__actions"),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "动量" }));

    expect(screen.getByRole("button", { name: "动能" }).classList.contains("is-selected")).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "动量" }).classList.contains("is-selected")).toBe(
      true,
    );
  });

  test("renders its modal at the document root so page scrolling and toolbars cannot move or cover it", () => {
    render(
      <FormulaDialog
        initialLatex=""
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onInsertToDrawings={vi.fn()}
      />,
    );

    const backdrop = screen.getByRole("dialog").parentElement;
    expect(backdrop).not.toBeNull();
    expect(backdrop?.parentElement).toBe(document.body);
  });

  test("stacks modeless formula tools by opening and pointer activity", () => {
    for (const key of ["formula-modeless-test", "physics-modeless-test"]) {
      window.localStorage.setItem(
        `patent-workbench.dialog-position.${key}`,
        JSON.stringify({ left: 80, top: 90 }),
      );
    }
    render(
      <>
        <FormulaDialog
          displayMode="modeless"
          positionKey="formula-modeless-test"
          initialLatex=""
          initialMode="inline"
          allowModeChange
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
        <FormulaCollectionDialog
          displayMode="modeless"
          positionKey="physics-modeless-test"
          titleId="physics-formula-title"
          title="物理公式"
          groups={[]}
          onInsert={vi.fn()}
          onCancel={vi.fn()}
        />
      </>,
    );

    const dialog = screen.getByRole("dialog", { name: "插入数学公式" });
    const layer = dialog.parentElement;
    const physicsLayer = screen.getByRole("dialog", { name: "物理公式" }).parentElement;
    expect(dialog.style.position).toBe("");
    expect(screen.getByRole("dialog", { name: "物理公式" }).style.position).toBe("");
    const stackOrder = (element: HTMLElement | null) =>
      Number(element?.style.getPropertyValue("--modeless-dialog-stack-order"));
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    expect(layer?.classList.contains("dialog-backdrop--modeless")).toBe(true);
    expect(dialog.querySelector("header")?.classList.contains("dialog-titlebar--draggable")).toBe(
      true,
    );
    expect(stackOrder(physicsLayer)).toBeGreaterThan(stackOrder(layer));

    fireEvent.pointerDown(dialog);
    expect(stackOrder(layer)).toBeGreaterThan(stackOrder(physicsLayer));
  });

  test("does not shadow MathLive value before the custom element is registered", () => {
    render(
      <FormulaDialog
        initialLatex=""
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const mathField = screen.getByRole("textbox", { name: "可视公式编辑器" });
    expect(Object.hasOwn(mathField, "value")).toBe(false);
  });

  test("uses the mathematical-formula insertion title", () => {
    render(
      <FormulaDialog
        initialLatex=""
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "插入数学公式" })).toBeDefined();
  });

  test("retains an uninserted formula draft while the dialog is temporarily closed", async () => {
    const { rerender } = render(
      <FormulaDialog
        open
        initialLatex=""
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const mathField = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
      value: string;
    };
    mathField.value = "x^2";
    fireEvent.input(mathField);

    rerender(
      <FormulaDialog
        open={false}
        initialLatex=""
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("textbox", { name: "可视公式编辑器" })).toBeNull();
    expect(
      document.querySelector('.dialog-backdrop[data-motion="exit"]')?.hasAttribute("inert"),
    ).toBe(true);

    rerender(
      <FormulaDialog
        open
        initialLatex=""
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & { value: string })
        .value,
    ).toBe("x^2");
  });

  test("places formula library and Greek keyboard controls in the footer before cancellation", () => {
    render(
      <FormulaDialog
        initialLatex=""
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onInsertToDrawings={vi.fn()}
      />,
    );

    const footer = screen.getByRole("button", { name: "取消" }).closest("footer");
    expect(footer).not.toBeNull();
    expect(
      [...(footer?.querySelectorAll("button") ?? [])].map((button) => button.textContent),
    ).toEqual(["公式库", "希腊字母", "插入附图", "取消", "确定"]);
  });

  test("exports the current mathematical formula to description drawings", async () => {
    const user = userEvent.setup();
    const onInsertToDrawings = vi.fn().mockResolvedValue(true);
    render(
      <FormulaDialog
        initialLatex="x^2"
        initialMode="block"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onInsertToDrawings={onInsertToDrawings}
      />,
    );

    await user.click(screen.getByRole("button", { name: "插入附图" }));

    expect(onInsertToDrawings).toHaveBeenCalledWith("x^2");
  });

  test("hides document insertion in drawings-only mode", () => {
    render(
      <FormulaDialog
        initialLatex="x^2"
        initialMode="block"
        allowModeChange={false}
        drawingsOnly
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onInsertToDrawings={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "插入附图" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "确定" })).toBeNull();
  });

  test("shows a visual preview on each formula-type button", () => {
    render(
      <FormulaDialog
        initialLatex=""
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "分数" }).querySelector(".katex")).not.toBeNull();
    expect(screen.getByRole("button", { name: "平方根" }).querySelector(".katex")).not.toBeNull();
  });

  test("does not expose a LaTeX source editor", () => {
    render(
      <FormulaDialog
        initialLatex={String.raw`\frac{a_1}{\sqrt{b}}`}
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "LaTeX 源码" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "LaTeX 源码" })).toBeNull();
  });

  test("prevents inserting an incomplete formula", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="block"
        allowModeChange={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const mathField = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
      value: string;
    };
    mathField.value = String.raw`\frac{`;
    fireEvent.input(mathField);

    expect(screen.getByRole("alert").textContent).toContain("公式不完整");
    expect((screen.getByRole("button", { name: "确定" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await user.click(screen.getByRole("button", { name: "确定" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toContain("公式不完整");
    expect(screen.getByRole("alertdialog").textContent).toContain("请继续输入后再确定");
  });

  test("inserts common symbols at the MathLive caret", async () => {
    const user = userEvent.setup();
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const mathField = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
      value: string;
      executeCommand(command: unknown): void;
    };
    mathField.value = "x";
    mathField.executeCommand = vi.fn(() => {
      mathField.value = String.raw`x\frac{#0}{#?}`;
    });

    await user.click(screen.getByRole("button", { name: "分数" }));
    // The fraction button now opens a variant dialog
    const fractionDialog = await screen.findByRole("dialog", { name: "分数" });
    expect(fractionDialog).toBeDefined();
    await user.click(within(fractionDialog).getByRole("button", { name: "标准分数" }));
    expect(mathField.executeCommand).toHaveBeenCalled();
    expect(mathField.value).toContain(String.raw`\frac`);
  });

  test("adds a common-symbol keyboard and switches numeric and Greek layouts by name", async () => {
    const user = userEvent.setup();
    const originalKeyboard = window.mathVirtualKeyboard;
    const executeCommand = vi.fn();
    const show = vi.fn();
    let layouts: readonly unknown[] = [];
    const keyboard = {
      get layouts() {
        return layouts;
      },
      set layouts(value: readonly unknown[]) {
        layouts = value;
      },
      normalizedLayouts: [
        { layers: [{ id: "keyboard-numeric" }] },
        { layers: [{ id: "keyboard-common-symbols" }] },
        { layers: [{ id: "keyboard-symbols" }] },
        { layers: [{ id: "keyboard-alphabetic" }] },
        { layers: [{ id: "keyboard-greek" }] },
      ],
      executeCommand,
      show,
      visible: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as typeof window.mathVirtualKeyboard;
    Object.defineProperty(window, "mathVirtualKeyboard", {
      configurable: true,
      value: keyboard,
    });

    try {
      configureFormulaVirtualKeyboard(keyboard);
      expect(getFormulaKeyboardLayerId(keyboard, "numeric")).toBe("keyboard-numeric");
      expect(getFormulaKeyboardLayerId(keyboard, "greek")).toBe("keyboard-greek");

      render(
        <FormulaDialog
          initialLatex="x"
          initialMode="inline"
          allowModeChange
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      const mathField = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
        executeCommand(command: unknown): void;
      };
      mathField.executeCommand = vi.fn();

      expect(layouts).toHaveLength(5);
      const commonSymbolsLayout = layouts.find(
        (layout) => typeof layout === "object" && layout !== null && "id" in layout,
      ) as { id: string; layers: { rows: string[][] }[] } | undefined;
      expect(commonSymbolsLayout?.id).toBe("patent-common-symbols");
      expect(commonSymbolsLayout?.layers[0]?.rows.flat()).toEqual(
        expect.arrayContaining([
          String.raw`\ne`,
          String.raw`\in`,
          String.raw`\to`,
          String.raw`\partial`,
        ]),
      );

      await user.click(screen.getByRole("button", { name: "希腊字母" }));

      expect(executeCommand).toHaveBeenCalledWith(["switchKeyboardLayer", "keyboard-greek"]);
      expect(show).toHaveBeenCalledTimes(1);
      expect(mathField.executeCommand).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "mathVirtualKeyboard", {
        configurable: true,
        value: originalKeyboard,
      });
    }
  });

  test("removes formatting and clipboard actions from the formula context menu", () => {
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const mathField = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
      menuItems: { id?: string; type?: string }[];
    };
    mathField.menuItems = [
      { id: "insert-matrix" },
      { id: "insert" },
      { id: "variant" },
      { id: "color" },
      { id: "background-color" },
      { id: "accent" },
      { id: "decoration" },
      { id: "cut" },
      { id: "copy" },
      { id: "paste" },
      { id: "select-all" },
    ];

    fireEvent(mathField, new Event("mount"));

    expect(mathField.menuItems.map((item) => item.id)).toEqual([
      "insert-matrix",
      "insert",
      "accent",
      "decoration",
    ]);
  });

  test("lets the user choose matrix rows and columns before inserting", async () => {
    const user = userEvent.setup();
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const mathField = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
      executeCommand(command: unknown): void;
    };
    mathField.executeCommand = vi.fn();

    await user.click(screen.getByRole("button", { name: "矩阵" }));
    const matrixDialog = screen.getByRole("dialog", { name: "插入矩阵" });
    expect(mathField.executeCommand).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("spinbutton", { name: "行数" }), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "列数" }), { target: { value: "2" } });
    await user.click(within(matrixDialog).getByRole("button", { name: "插入" }));

    expect(mathField.executeCommand).toHaveBeenCalledWith([
      "insert",
      String.raw`\begin{bmatrix}#0&#?\\#?&#?\\#?&#?\end{bmatrix}`,
    ]);
  });

  test("opens the expanded formula library and inserts an advanced calculus formula", async () => {
    const user = userEvent.setup();
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const mathField = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
      executeCommand(command: unknown): void;
    };
    mathField.executeCommand = vi.fn();

    await user.click(screen.getByRole("button", { name: "公式库" }));
    const insertDialog = screen.getByRole("dialog", { name: "公式库" });
    expect(within(insertDialog).getByRole("button", { name: "绝对值" })).toBeDefined();
    expect(within(insertDialog).getByText("微积分")).toBeDefined();
    expect(within(insertDialog).getByText("复数")).toBeDefined();
    expect(within(insertDialog).getByText("关系与比较")).toBeDefined();
    expect(within(insertDialog).getByText("集合与逻辑")).toBeDefined();
    expect(within(insertDialog).getByText("箭头与映射")).toBeDefined();
    expect(within(insertDialog).getByText("高级微积分")).toBeDefined();
    expect(within(insertDialog).getByText("常用函数")).toBeDefined();
    expect(within(insertDialog).getByText("函数表示法")).toBeDefined();
    expect(within(insertDialog).getByText("数集记号")).toBeDefined();
    expect(within(insertDialog).getByText("重音与标注")).toBeDefined();
    expect(within(insertDialog).getByText("常用公式")).toBeDefined();
    expect(within(insertDialog).getByText("特殊函数")).toBeDefined();
    expect(within(insertDialog).getByText("定界符扩展")).toBeDefined();
    expect(within(insertDialog).getByRole("button", { name: "小于等于" })).toBeDefined();
    expect(within(insertDialog).getByRole("button", { name: "属于" })).toBeDefined();
    expect(within(insertDialog).getByRole("button", { name: "右箭头" })).toBeDefined();
    expect(within(insertDialog).getByRole("button", { name: "自然对数 ln" })).toBeDefined();
    await user.click(within(insertDialog).getByRole("button", { name: "偏导数" }));

    expect(mathField.executeCommand).toHaveBeenCalledWith([
      "insert",
      String.raw`\frac{\partial #?}{\partial #?}`,
    ]);
  });

  test("renders every formula library entry without KaTeX errors", async () => {
    const user = userEvent.setup();
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "公式库" }));
    const formulaLibrary = screen.getByRole("dialog", { name: "公式库" });
    const formulaButtons = within(formulaLibrary)
      .getAllByRole("button")
      .filter((button) => button.textContent !== "关闭");

    expect(formulaButtons.length).toBeGreaterThan(50);
    for (const button of formulaButtons) {
      expect(button.querySelector('[style*="color"]')).toBeNull();
    }
  });

  test("moves limits into other formulas and opens trigonometric formulas from the shortcut", async () => {
    const user = userEvent.setup();
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const mathField = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
      executeCommand(command: unknown): void;
    };
    mathField.executeCommand = vi.fn();

    expect(screen.queryByRole("button", { name: "极限" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "三角函数" }));

    const trigonometricDialog = screen.getByRole("dialog", { name: "三角函数" });
    expect(within(trigonometricDialog).getByText("基本三角函数")).toBeDefined();
    expect(within(trigonometricDialog).getByText("反三角函数")).toBeDefined();
    expect(within(trigonometricDialog).getByText("双曲函数")).toBeDefined();
    expect(within(trigonometricDialog).getByRole("button", { name: "正弦 sin" })).toBeDefined();
    expect(
      within(trigonometricDialog).getByRole("button", { name: "反正切 arctan" }),
    ).toBeDefined();
    await user.click(within(trigonometricDialog).getByRole("button", { name: "余弦 cos" }));

    expect(mathField.executeCommand).toHaveBeenCalledWith(["insert", String.raw`\cos(#?)`]);

    await user.click(screen.getByRole("button", { name: "公式库" }));
    const otherDialog = screen.getByRole("dialog", { name: "公式库" });
    await user.click(within(otherDialog).getByRole("button", { name: "极限" }));

    expect(mathField.executeCommand).toHaveBeenCalledWith(["insert", String.raw`\lim_{#0\to#?}`]);
  });

  test("renders nonstandard inverse trigonometric functions without formula errors", async () => {
    const user = userEvent.setup();
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const mathField = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
      executeCommand(command: unknown): void;
    };
    mathField.executeCommand = vi.fn();

    await user.click(screen.getByRole("button", { name: "三角函数" }));
    const trigonometricDialog = screen.getByRole("dialog", { name: "三角函数" });

    for (const name of ["反余切 arccot", "反正割 arcsec", "反余割 arccsc"]) {
      expect(
        within(trigonometricDialog).getByRole("button", { name }).querySelector('[style*="color"]'),
      ).toBeNull();
    }

    await user.click(within(trigonometricDialog).getByRole("button", { name: "反余切 arccot" }));
    expect(mathField.executeCommand).toHaveBeenCalledWith([
      "insert",
      String.raw`\operatorname{arccot}(#?)`,
    ]);
  });

  test("hides history buttons while retaining formula history shortcuts", () => {
    render(
      <FormulaDialog
        initialLatex="x+1"
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const mathField = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
      value: string;
      executeCommand(command: unknown): void;
    };
    mathField.executeCommand = vi.fn((command) => {
      mathField.value = command === "undo" ? "x" : "x+1";
    });

    expect(screen.queryByRole("button", { name: "撤回" })).toBeNull();
    fireEvent.keyDown(mathField, { key: "z", ctrlKey: true });
    expect(mathField.executeCommand).toHaveBeenLastCalledWith("undo");

    expect(screen.queryByRole("button", { name: "前进" })).toBeNull();
    fireEvent.keyDown(mathField, { key: "y", ctrlKey: true });
    expect(mathField.executeCommand).toHaveBeenLastCalledWith("redo");
  });

  test("focuses the mounted editor, restores focus after a child dialog and when reopened", async () => {
    const props = {
      initialLatex: "x",
      initialMode: "inline" as const,
      allowModeChange: true,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    const { rerender } = render(<FormulaDialog {...props} displayMode="modeless" />);
    const field = screen.getByRole("textbox", { name: "可视公式编辑器" });
    Object.assign(field, { menuItems: [] });
    field.tabIndex = 0;
    fireEvent(field, new Event("mount"));
    await waitFor(() => expect(document.activeElement).toBe(field));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "矩阵" }));
    const child = screen.getByRole("dialog", { name: "插入矩阵" });
    await user.click(within(child).getByRole("spinbutton", { name: "行数" }));
    expect(document.activeElement).not.toBe(field);
    await user.click(within(child).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(document.activeElement).toBe(field));
    rerender(<FormulaDialog {...props} displayMode="modeless" open={false} />);
    field.blur();
    rerender(<FormulaDialog {...props} displayMode="modeless" />);
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  test("returns focus after inserting a symbol without rewriting the editor on rerender", async () => {
    const getElement = vi
      .spyOn(window.customElements, "get")
      .mockReturnValue(class extends HTMLElement {});
    try {
      render(
        <FormulaDialog
          initialLatex="x"
          initialMode="inline"
          allowModeChange
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      const field = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
        value: string;
        executeCommand(command: unknown): void;
      };
      field.tabIndex = 0;
      Object.assign(field, { menuItems: [] });
      fireEvent(field, new Event("mount"));
      await waitFor(() => expect(document.activeElement).toBe(field));
      // User input already changed the mathfield; React must not write it back.
      const writeValue = vi.fn();
      Object.defineProperty(field, "value", {
        configurable: true,
        get: () => "xy",
        set: writeValue,
      });
      field.executeCommand = vi.fn();
      fireEvent.input(field);
      expect(writeValue).not.toHaveBeenCalled();
      await userEvent.setup().click(screen.getByRole("button", { name: "求和" }));
      expect(field.executeCommand).toHaveBeenCalled();
      expect(document.activeElement).toBe(field);
    } finally {
      getElement.mockRestore();
    }
  });

  test("inserts English letters from the physical keyboard", () => {
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const mathField = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
      value: string;
      executeCommand(command: unknown): void;
    };
    mathField.executeCommand = vi.fn(() => {
      mathField.value = "xa";
    });

    fireEvent.keyDown(mathField, { key: "a" });

    expect(mathField.executeCommand).toHaveBeenCalledWith([
      "typedText",
      "a",
      { simulateKeystroke: true, feedback: false, focus: true },
    ]);
  });

  test("inserts numbers and punctuation from the physical keyboard", () => {
    render(
      <FormulaDialog
        initialLatex="x"
        initialMode="inline"
        allowModeChange
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const mathField = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
      value: string;
      executeCommand(command: unknown): void;
    };
    mathField.executeCommand = vi.fn();

    fireEvent.keyDown(mathField, { key: "2" });
    fireEvent.keyDown(mathField, { key: "." });

    expect(mathField.executeCommand).toHaveBeenCalledWith([
      "typedText",
      "2",
      { simulateKeystroke: true, feedback: false, focus: true },
    ]);
    expect(mathField.executeCommand).toHaveBeenCalledWith([
      "typedText",
      ".",
      { simulateKeystroke: true, feedback: false, focus: true },
    ]);
  });
});

test("a closing formula collection releases modal keyboard handling before paint is removed", async () => {
  const onCancel = vi.fn();
  render(
    <FormulaDialog
      initialLatex="x"
      initialMode="inline"
      allowModeChange
      onConfirm={vi.fn()}
      onCancel={onCancel}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "公式库" }));
  const child = screen.getByRole("dialog", { name: "公式库" });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(child.closest(".motion-presence")?.hasAttribute("inert")).toBe(true);
  expect(child.isConnected).toBe(true);
  const nextEscape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(nextEscape);
  expect(nextEscape.defaultPrevented).toBe(false);
  expect(onCancel).not.toHaveBeenCalled();
});

test("IME start and composition keys do not insert text through the physical keyboard fallback", () => {
  render(
    <FormulaDialog
      initialLatex=""
      initialMode="inline"
      allowModeChange
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  const field = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
    executeCommand: ReturnType<typeof vi.fn>;
  };
  field.executeCommand = vi.fn();
  fireEvent.keyDown(field, { key: "a", keyCode: 229, isComposing: false });
  fireEvent.compositionStart(field);
  fireEvent.keyDown(field, { key: "b", isComposing: false });
  fireEvent.keyDown(field, { key: "c", isComposing: true });
  expect(field.executeCommand).not.toHaveBeenCalled();
  fireEvent.compositionEnd(field, { data: "ab" });
  fireEvent.keyDown(field, { key: "d" });
  expect(field.executeCommand).toHaveBeenCalledTimes(1);
  expect(field.executeCommand).toHaveBeenCalledWith([
    "typedText",
    "d",
    { simulateKeystroke: true, feedback: false, focus: true },
  ]);
});

test("preview layout stays the same when formula position changes", () => {
  render(
    <FormulaDialog
      initialLatex="\\frac{a}{b}"
      initialMode="inline"
      allowModeChange
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  const preview = screen.getByRole("region", { name: "公式预览" });
  const before = preview.innerHTML;
  fireEvent.click(screen.getByRole("radio", { name: "独立公式" }));
  expect(preview.innerHTML).toBe(before);
  fireEvent.click(screen.getByRole("radio", { name: "行内公式" }));
  expect(preview.innerHTML).toBe(before);
});
test("patent-scoped formula portals hide immediately and restore the same draft field", () => {
  const tree = (active: string) => (
    <ActiveEditorSessionContext.Provider value={active}>
      {["a", "b"].map((owner) => (
        <EditorSessionScope sessionId={owner} key={owner}>
          <FormulaDialog
            initialLatex={owner}
            initialMode="block"
            allowModeChange
            onConfirm={vi.fn()}
            onCancel={vi.fn()}
            displayMode="modeless"
          />
        </EditorSessionScope>
      ))}
    </ActiveEditorSessionContext.Provider>
  );
  const view = render(tree("a"));
  const first = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
    value: string;
  };
  first.value = "a^2";
  fireEvent.input(first);
  view.rerender(tree("b"));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "可视公式编辑器" })).not.toBe(first);
  expect(first.closest("[hidden]")).not.toBeNull();
  view.rerender(tree("a"));
  expect(screen.getByRole("textbox", { name: "可视公式编辑器" })).toBe(first);
  expect(first.value).toBe("a^2");
});
