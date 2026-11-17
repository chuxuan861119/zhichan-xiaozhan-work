import { ActiveEditorSessionContext, EditorSessionScope } from "../shared/editor-session-scope";
import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useEffect, useState } from "react";
import type { KetcherAdapter } from "../chemistry/ketcher-adapter";
import type { ChemicalMathField } from "./chemical-mathfield-adapter";
import {
  ChemistryDialog as ChemistryDialogPanel,
  type ChemistryDialogProps,
  type ChemistryDialogRequest,
} from "./chemistry-dialog";

// Simulate the existing external insertion entries by changing the public request prop.
let requestKindFromEntry: (kind: "equation" | "structure") => void;
function ChemistryDialog(props: ChemistryDialogProps) {
  const [request, setRequest] = useState(props.request);
  useEffect(() => setRequest(props.request), [props.request]);
  requestKindFromEntry = (kind) => {
    if (
      props.request.type !== "new" ||
      (kind === "structure" && props.supportsStructures === false)
    )
      return;
    setRequest({ ...props.request, initialKind: kind });
  };
  return <ChemistryDialogPanel {...props} request={request} />;
}
async function openChemistryKind(kind: "equation" | "structure") {
  await act(async () => requestKindFromEntry(kind));
}

const ket = '{"root":{"nodes":[{"$ref":"mol0"}]},"mol0":{"type":"molecule"}}';
const editorMount = vi.fn();
let nextReadyAdapter = readyAdapter();
let nextContent = { hasContent: true, dirty: false };

function chemicalPreviewValue(previewPng: Uint8Array, widthPx = 320, heightPx = 240) {
  return {
    descriptor: {
      assetId: "00000000-0000-4000-8000-000000000001",
      kind: "chemical-preview" as const,
      originalName: "structure.svg",
      mediaType: "image/svg+xml" as const,
      extension: "svg" as const,
      byteLength: 1,
      sha256: "A".repeat(64),
      widthPx,
      heightPx,
      previewByteLength: previewPng.byteLength,
      previewSha256: "B".repeat(64),
    },
    preview: previewPng,
  };
}

const editorMock = vi.fn(
  ({
    initialKet,
    initialMode,
    onError,
    onReady,
    onContentChange,
  }: {
    initialKet?: string;
    initialMode?: "molecule" | "macromolecule";
    onReady?(adapter: KetcherAdapter): void;
    onError?(): void;
    onContentChange?(state: { hasContent: boolean; dirty: boolean }): void;
  }) => {
    useEffect(() => editorMount(), []);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            onReady?.(nextReadyAdapter);
            onContentChange?.(nextContent);
          }}
        >
          准备结构式
        </button>
        <button type="button" onClick={() => onContentChange?.({ hasContent: true, dirty: true })}>
          模拟绘制结构
        </button>
        <button type="button" onClick={() => onContentChange?.({ hasContent: false, dirty: true })}>
          模拟清空结构
        </button>
        <button type="button" onClick={() => onError?.()}>
          使结构编辑失败
        </button>
        <output data-testid="ketcher-initial-ket">{initialKet ?? ""}</output>
        <output data-testid="ketcher-initial-mode">{initialMode ?? "molecule"}</output>
      </>
    );
  },
);

vi.mock("../chemistry/ketcher-editor", () => ({ KetcherEditor: editorMock }));

function readyAdapter(
  readDraft = vi.fn().mockResolvedValue({ ok: true, value: { ket, svg: "<svg/>" } }),
) {
  return { readDraft } as unknown as KetcherAdapter;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function renderDialog(
  request: ChemistryDialogRequest = { type: "new" },
  onConfirm = vi.fn(),
  supportsStructures = true,
  saveState: "saved" | "saving" | "failed" = "saved",
  onRetrySave = vi.fn(),
) {
  const onCancel = vi.fn();
  render(
    <ChemistryDialog
      sessionId="session-1"
      request={request}
      onConfirm={onConfirm}
      onCancel={onCancel}
      supportsStructures={supportsStructures}
      saveState={saveState}
      onRetrySave={onRetrySave}
    />,
  );
  return { onCancel, onConfirm, onRetrySave };
}

async function renderDialogWithReadyMathlive(
  request: ChemistryDialogRequest = { type: "new" },
): Promise<ChemicalMathField> {
  render(
    <ChemistryDialog
      sessionId="session-1"
      request={request}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      loadMathlive={vi.fn().mockResolvedValue({})}
    />,
  );
  const field = screen.getByRole("textbox", {
    name: "化学方程式编辑器",
  }) as ChemicalMathField;
  await waitFor(() => expect(field.style.pointerEvents).toBe(""));
  return field;
}

test("does not insert a condition arrow when Enter is committing Chinese composition", async () => {
  await renderDialogWithReadyMathlive();
  const field = configureChemicalField("H", 1);
  fireEvent.input(field);
  fireEvent.click(screen.getByRole("button", { name: "反应条件" }));
  const input = screen.getByLabelText("箭头上方（催化剂优先）");
  fireEvent.change(input, { target: { value: "加热" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
  expect(field.value).toBe("H");
  expect(screen.queryByRole("dialog", { name: "反应条件" })).not.toBeNull();
  fireEvent.keyDown(input, { key: "Enter", isComposing: false });
  expect(field.value).toContain("xrightarrow");
});

test("condition presets produce one undo step under StrictMode", async () => {
  render(
    <StrictMode>
      <ChemistryDialog
        sessionId="strict-condition"
        request={{ type: "new" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loadMathlive={vi.fn().mockResolvedValue({})}
      />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: "化学方程式编辑器" }) as HTMLElement).style
        .pointerEvents,
    ).toBe(""),
  );
  fireEvent.input(configureChemicalField("H", 1));
  fireEvent.click(screen.getByRole("button", { name: "反应条件" }));
  fireEvent.click(screen.getByRole("button", { name: "MnO₂" }));
  expect((screen.getByLabelText("箭头上方（催化剂优先）") as HTMLInputElement).value).toBe(
    "MnO_{2}",
  );
  fireEvent.click(screen.getByTitle("撤销"));
  expect((screen.getByLabelText("箭头上方（催化剂优先）") as HTMLInputElement).value).toBe("");
  expect((screen.getByTitle("撤销") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTitle("重做"));
  expect((screen.getByLabelText("箭头上方（催化剂优先）") as HTMLInputElement).value).toBe(
    "MnO_{2}",
  );
  fireEvent.click(screen.getByRole("button", { name: "＋ 添加箭头下方条件" }));
  fireEvent.click(screen.getByRole("button", { name: "Δ 加热" }));
  fireEvent.click(screen.getByTitle("撤销"));
  expect((screen.getByLabelText("箭头下方（辅助条件）") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("箭头上方（催化剂优先）") as HTMLInputElement).value).toBe(
    "MnO_{2}",
  );
});

function configureChemicalField(value: string, position: number) {
  const field = screen.getByRole("textbox", {
    name: "化学方程式编辑器",
  }) as ChemicalMathField & { executeCommand: ReturnType<typeof vi.fn> };
  field.value = value;
  field.position = position;
  field.selectionIsCollapsed = true;
  field.selection = { ranges: [[position, position]], direction: "forward" };
  field.getValue = vi.fn((range?: unknown) => {
    const normalizedRange = Array.isArray(range)
      ? (range as [number, number])
      : ((range as { ranges?: Array<[number, number]> } | undefined)?.ranges?.[0] ?? null);
    if (!normalizedRange) return field.value;
    return field.value.slice(normalizedRange[0], normalizedRange[1]);
  });
  field.executeCommand = vi.fn((command: unknown) => {
    if (Array.isArray(command) && command[0] === "insert") {
      const [start, end] = field.selection?.ranges[0] ?? [field.position ?? 0, field.position ?? 0];
      const inserted = String(command[1]);
      field.value = `${field.value.slice(0, start)}${inserted}${field.value.slice(end)}`;
      field.position = start + inserted.length;
      field.selectionIsCollapsed = true;
      field.selection = { ranges: [[field.position, field.position]], direction: "forward" };
    }
    return true;
  });
  return field;
}

describe("ChemistryDialog", () => {
  test("expanding elements hides the preview and retains input, caret and position", async () => {
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("H_{2}O", 3);
    fireEvent.input(field);
    fireEvent.click(screen.getByRole("radio", { name: "独立方程式" }));
    expect(screen.getByRole("radio", { name: "独立方程式" }).closest("header")).not.toBeNull();
    expect(
      screen.getByRole("region", { name: "化学方程式预览" }).querySelector(".katex"),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开元素面板" }));
    expect(screen.queryByRole("region", { name: "化学方程式预览" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "化学方程式编辑器" })).toBe(field);
    expect(field.position).toBe(3);
    for (const label of [
      "加号",
      "生成",
      "可逆",
      "平衡",
      "沉淀",
      "气体",
      "反应条件",
      "上标",
      "下标",
      "电荷",
      "括号",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    }
    field.value = "NaCl";
    fireEvent.input(field);
    fireEvent.click(screen.getByRole("button", { name: "收起元素面板", expanded: true }));
    expect(
      screen.getByRole("region", { name: "化学方程式预览" }).querySelector(".katex")?.textContent,
    ).toContain("NaCl");
    expect((screen.getByRole("radio", { name: "独立方程式" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(field.value).toBe("NaCl");
    fireEvent.click(screen.getByRole("button", { name: "展开元素面板" }));
    fireEvent.click(screen.getByRole("button", { name: "收起元素面板", expanded: true }));
    fireEvent.click(screen.getByRole("button", { name: "展开元素面板" }));
    expect(screen.queryByRole("region", { name: "化学方程式预览" })).toBeNull();
    expect(field.value).toBe("NaCl");
  });

  test("keeps the title and position capsule outside the scrolling content without type tabs", async () => {
    await renderDialogWithReadyMathlive();
    const dialog = screen.getByRole("dialog", { name: "插入化学方程式" });
    const fixedTop = dialog.querySelector(".chemistry-dialog-fixed-top");
    const scrollBody = dialog.querySelector(".chemistry-dialog-scroll-body");
    expect(fixedTop?.querySelector("header")).not.toBeNull();
    expect(fixedTop?.querySelector(".formula-position-switch")).not.toBeNull();
    expect(dialog.querySelector('[role="tablist"][aria-label="化学公式类型"]')).toBeNull();
    expect(scrollBody?.querySelector("header")).toBeNull();
    expect(scrollBody?.querySelector('[role="tablist"][aria-label="化学公式类型"]')).toBeNull();
  });

  test("opens the element panel in a dedicated non-scrolling tray", async () => {
    await renderDialogWithReadyMathlive();
    fireEvent.click(screen.getByRole("button", { name: "展开元素面板" }));
    const panel = document.querySelector(".chemical-periodic-panel");
    const tray = panel?.parentElement;
    expect(tray?.classList.contains("chemistry-periodic-tray")).toBe(true);
    expect(tray?.classList.contains("is-open")).toBe(true);
    expect(
      tray
        ?.closest(".chemistry-periodic-collapse")
        ?.parentElement?.classList.contains("chemistry-dialog"),
    ).toBe(true);
    expect(document.querySelector(".chemistry-dialog-scroll-body")?.contains(panel ?? null)).toBe(
      false,
    );
  });

  test("supports a modeless chemistry tool without a blocking backdrop", () => {
    window.localStorage.setItem(
      "patent-workbench.dialog-position.chemistry-modeless-test",
      JSON.stringify({ left: 80, top: 90 }),
    );
    render(
      <ChemistryDialog
        displayMode="modeless"
        positionKey="chemistry-modeless-test"
        sessionId="session-1"
        request={{ type: "new" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loadMathlive={vi.fn().mockResolvedValue({})}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "插入化学方程式" });
    expect(dialog.style.position).toBe("");
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    expect(dialog.parentElement?.classList.contains("dialog-backdrop--modeless")).toBe(true);
    expect(dialog.parentElement?.style.getPropertyValue("--modeless-dialog-stack-order")).not.toBe(
      "",
    );
  });

  test.each([false, true])(
    "inserts a condition arrow at the saved caret (reversible=%s)",
    async (reversible) => {
      await renderDialogWithReadyMathlive();
      const field = configureChemicalField("H_{2} O_{2}", 5);
      fireEvent.input(field);
      fireEvent.click(screen.getByRole("button", { name: "反应条件" }));
      field.selection = { ranges: [[0, 0]], direction: "forward" };
      fireEvent.change(screen.getByLabelText("箭头上方（催化剂优先）"), {
        target: { value: "Pt" },
      });
      if (reversible) fireEvent.click(screen.getByTitle("当前为单向箭头，点击切换为双向箭头"));
      fireEvent.click(screen.getByRole("button", { name: "插入条件箭头" }));
      expect(field.value).toBe(
        `H_{2}\\${reversible ? "xrightleftharpoons" : "xrightarrow"}{Pt}  O_{2}`,
      );
    },
  );

  test("refills a selected condition arrow and replaces only that arrow", async () => {
    await renderDialogWithReadyMathlive();
    const arrow = String.raw`\xrightleftharpoons[加热]{MnO_{2}}`;
    const field = configureChemicalField(`A ${arrow} B`, 2);
    field.selectionIsCollapsed = false;
    field.selection = { ranges: [[2, 2 + arrow.length]], direction: "forward" };
    fireEvent.input(field);
    fireEvent.click(screen.getByRole("button", { name: "反应条件" }));
    expect((screen.getByLabelText("箭头上方（催化剂优先）") as HTMLInputElement).value).toBe(
      "MnO_{2}",
    );
    expect((screen.getByLabelText("箭头下方（辅助条件）") as HTMLInputElement).value).toBe("加热");
    fireEvent.change(screen.getByLabelText("箭头上方（催化剂优先）"), { target: { value: "Pt" } });
    fireEvent.click(screen.getByRole("button", { name: "保存条件" }));
    expect(field.value).toBe(String.raw`A \xrightleftharpoons[加热]{Pt} B`);
  });

  test("cancels condition editing without changing the selected arrow", async () => {
    await renderDialogWithReadyMathlive();
    const arrow = String.raw`\xrightarrow{Pt}`;
    const source = `A ${arrow} B`;
    const field = configureChemicalField(source, 2);
    field.selection = { ranges: [[2, 2 + arrow.length]] };
    fireEvent.input(field);
    fireEvent.click(screen.getByRole("button", { name: "反应条件" }));
    fireEvent.change(screen.getByLabelText("箭头上方（催化剂优先）"), { target: { value: "Ni" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭反应条件弹窗" }));
    expect(field.value).toBe(source);
    expect(field.executeCommand).not.toHaveBeenCalled();
    expect(field.selection?.ranges).toEqual([[2, 2 + arrow.length]]);
  });

  test("keeps invalid condition input open without changing the formula", async () => {
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("AB", 1);
    fireEvent.input(field);
    fireEvent.click(screen.getByRole("button", { name: "反应条件" }));
    fireEvent.change(screen.getByLabelText("箭头上方（催化剂优先）"), {
      target: { value: "MnO_{2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "插入条件箭头" }));
    expect(screen.getByText("条件格式不正确，请检查括号和公式内容。")).toBeDefined();
    expect(field.value).toBe("AB");
    expect(field.executeCommand).not.toHaveBeenCalled();
  });

  test("rejects mixed arrow selection with a clear instruction", async () => {
    await renderDialogWithReadyMathlive();
    const source = String.raw`A\xrightarrow{Pt}B`;
    const field = configureChemicalField(source, 0);
    field.selection = { ranges: [[0, source.length]] };
    fireEvent.input(field);
    fireEvent.click(screen.getByRole("button", { name: "反应条件" }));
    expect(
      screen.getByText("请只选中一个完整的条件箭头，或取消选择后在光标处插入。"),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "保存条件" })).toBeNull();
    expect(field.value).toBe(source);
  });

  test("keeps the lower condition when its input is collapsed", async () => {
    await renderDialogWithReadyMathlive();
    configureChemicalField("H_{2}", 5);
    fireEvent.click(screen.getByRole("button", { name: "反应条件" }));
    fireEvent.click(screen.getByRole("button", { name: "＋ 添加箭头下方条件" }));
    fireEvent.change(screen.getByLabelText("箭头下方（辅助条件）"), { target: { value: "加热" } });
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    fireEvent.click(screen.getByRole("button", { name: "＋ 添加箭头下方条件" }));
    expect((screen.getByLabelText("箭头下方（辅助条件）") as HTMLInputElement).value).toBe("加热");
  });

  test.each(["关闭弹窗", "关闭", "external-hide"])(
    "discards pending drawing generation after %s",
    async (closeAction) => {
      const draft = deferred<{ ok: true; value: { ket: string; svg: string } }>();
      nextReadyAdapter = readyAdapter(vi.fn().mockReturnValue(draft.promise));
      const rasterizePreview = vi
        .fn()
        .mockResolvedValue({ ok: true, value: chemicalPreviewValue(new Uint8Array([1])) });
      Object.defineProperty(window, "patentApi", {
        configurable: true,
        value: { chemistry: { rasterizePreview } },
      });
      const onInsertStructureToDrawings = vi.fn();
      const props = {
        sessionId: "session-1",
        request: { type: "new", initialKind: "structure" } as const,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
        onInsertStructureToDrawings,
      };
      const view = render(<ChemistryDialog {...props} />);
      fireEvent.click(await screen.findByRole("button", { name: "准备结构式" }));
      fireEvent.click(screen.getByRole("button", { name: "插入附图" }));
      if (closeAction !== "external-hide")
        fireEvent.click(screen.getByRole("button", { name: closeAction }));
      else view.rerender(<ChemistryDialog {...props} open={false} />);
      await act(async () => {
        draft.resolve({ ok: true, value: { ket, svg: "<svg/>" } });
        await draft.promise;
      });
      expect(rasterizePreview).not.toHaveBeenCalled();
      expect(onInsertStructureToDrawings).not.toHaveBeenCalled();
    },
  );

  test("shows an insert-to-drawing action for both chemistry editors", async () => {
    render(
      <ChemistryDialog
        sessionId="session-1"
        request={{ type: "new" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onInsertEquationToDrawings={vi.fn()}
        onInsertStructureToDrawings={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "插入附图" })).toBeDefined();
    await openChemistryKind("structure");
    expect(screen.getByRole("button", { name: "插入附图" })).toBeDefined();
  });

  test("replacement reuses chemistry rendering and never calls insertion", async () => {
    const onReplaceEquationToDrawings = vi.fn();
    const onReplaceStructureToDrawings = vi.fn();
    const onInsertEquationToDrawings = vi.fn();
    const onInsertStructureToDrawings = vi.fn();
    const rasterizePreview = vi
      .fn()
      .mockResolvedValue({ ok: true, value: chemicalPreviewValue(new Uint8Array([1])) });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { chemistry: { rasterizePreview } },
    });
    render(
      <ChemistryDialog
        sessionId="session-1"
        request={{ type: "new" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loadMathlive={vi.fn().mockResolvedValue({})}
        onReplaceEquationToDrawings={onReplaceEquationToDrawings}
        onReplaceStructureToDrawings={onReplaceStructureToDrawings}
        onInsertEquationToDrawings={onInsertEquationToDrawings}
        onInsertStructureToDrawings={onInsertStructureToDrawings}
      />,
    );
    const field = screen.getByRole("textbox", { name: "化学方程式编辑器" }) as ChemicalMathField;
    await waitFor(() => expect(field.style.pointerEvents).toBe(""));
    field.value = "H_{2}+O_{2}";
    fireEvent.input(field);
    fireEvent.click(screen.getByRole("button", { name: "替换附图" }));
    expect(onReplaceEquationToDrawings).toHaveBeenCalledWith(String.raw`\ce{H_{2}+O_{2}}`);
    expect(onInsertEquationToDrawings).not.toHaveBeenCalled();
    await openChemistryKind("structure");
    fireEvent.click(await screen.findByRole("button", { name: "准备结构式" }));
    fireEvent.click(screen.getByRole("button", { name: "替换附图" }));
    await waitFor(() => expect(onReplaceStructureToDrawings).toHaveBeenCalledOnce());
    expect(rasterizePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        source: expect.objectContaining({ ketSource: ket }),
      }),
    );
    expect(onInsertStructureToDrawings).not.toHaveBeenCalled();
  });

  test("hides document insertion in drawings-only mode", () => {
    render(
      <ChemistryDialog
        sessionId="session-1"
        request={{ type: "new" }}
        drawingsOnly
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onInsertEquationToDrawings={vi.fn()}
        onInsertStructureToDrawings={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "插入附图" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "插入" })).toBeNull();
  });

  test("retains an uninserted equation draft while the dialog is temporarily closed", async () => {
    const loadMathlive = vi.fn().mockResolvedValue({});
    const { rerender } = render(
      <ChemistryDialog
        open
        sessionId="session-1"
        request={{ type: "new" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loadMathlive={loadMathlive}
      />,
    );
    const field = screen.getByRole("textbox", {
      name: "化学方程式编辑器",
    }) as HTMLElement & { value: string };
    await waitFor(() => expect(field.style.pointerEvents).toBe(""));
    field.value = "H₂ + O₂ → H₂O";
    fireEvent.input(field);

    rerender(
      <ChemistryDialog
        open={false}
        sessionId="session-1"
        request={{ type: "new" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loadMathlive={loadMathlive}
      />,
    );
    expect(screen.queryByRole("textbox", { name: "化学方程式编辑器" })).toBeNull();
    expect(
      document.querySelector('.dialog-backdrop[data-motion="exit"]')?.hasAttribute("inert"),
    ).toBe(true);

    rerender(
      <ChemistryDialog
        open
        sessionId="session-1"
        request={{ type: "new" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loadMathlive={loadMathlive}
      />,
    );
    expect(
      (screen.getByRole("textbox", { name: "化学方程式编辑器" }) as HTMLElement & { value: string })
        .value,
    ).toBe("H₂ + O₂ → H₂O");
  });

  test("switches between new chemistry kinds without losing the equation draft", async () => {
    const loadMathlive = vi.fn().mockResolvedValue({});
    const view = render(
      <ChemistryDialog
        open
        sessionId="session-1"
        request={{ type: "new", initialKind: "equation" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loadMathlive={loadMathlive}
      />,
    );
    const field = screen.getByRole("textbox", {
      name: "化学方程式编辑器",
    }) as HTMLElement & { value: string };
    await waitFor(() => expect(field.style.pointerEvents).toBe(""));
    field.value = "H_{2}O";
    fireEvent.input(field);

    view.rerender(
      <ChemistryDialog
        open
        sessionId="session-1"
        request={{ type: "new", initialKind: "structure" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loadMathlive={loadMathlive}
      />,
    );
    expect(screen.getByRole("tabpanel", { name: "化学结构式" })).toBeDefined();

    view.rerender(
      <ChemistryDialog
        open
        sessionId="session-1"
        request={{ type: "new", initialKind: "equation" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loadMathlive={loadMathlive}
      />,
    );
    expect(screen.getByRole("tabpanel", { name: "化学方程式" })).toBeDefined();
    expect(
      (
        screen.getByRole("textbox", { name: "化学方程式编辑器" }) as HTMLElement & {
          value: string;
        }
      ).value,
    ).toBe("H_{2}O");
  });

  test("exports a validated chemical equation to description drawings", async () => {
    const user = userEvent.setup();
    const onInsertEquationToDrawings = vi.fn();
    render(
      <ChemistryDialog
        sessionId="session-1"
        request={{ type: "new" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onInsertEquationToDrawings={onInsertEquationToDrawings}
      />,
    );

    const field = screen.getByRole("textbox", { name: "化学方程式编辑器" }) as HTMLElement & {
      value: string;
    };
    field.value = "H_{2}O";
    fireEvent.input(field);
    await user.click(screen.getByRole("button", { name: "插入附图" }));

    expect(onInsertEquationToDrawings).toHaveBeenCalledWith(String.raw`\ce{H_{2}O}`);
  });

  test("rasterizes a chemical structure before sending it to description drawings", async () => {
    const user = userEvent.setup();
    const previewPng = Uint8Array.from([137, 80, 78, 71]);
    const preview = chemicalPreviewValue(previewPng);
    const onInsertStructureToDrawings = vi.fn();
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        chemistry: {
          rasterizePreview: vi.fn().mockResolvedValue({ ok: true, value: preview }),
        },
      },
    });
    render(
      <ChemistryDialog
        sessionId="session-1"
        request={{ type: "new" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onInsertStructureToDrawings={onInsertStructureToDrawings}
      />,
    );

    await openChemistryKind("structure");
    await user.click(await screen.findByRole("button", { name: "准备结构式" }));
    await user.click(screen.getByRole("button", { name: "插入附图" }));

    await waitFor(() =>
      expect(onInsertStructureToDrawings).toHaveBeenCalledWith({
        descriptor: preview.descriptor,
        png: previewPng,
        svg: "<svg/>",
        source: {
          ketSource: '{"root":{"nodes":[{"$ref":"mol0"}]},"mol0":{"type":"molecule"}}',
          editorMode: undefined,
        },
      }),
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    nextReadyAdapter = readyAdapter();
    nextContent = { hasContent: true, dirty: false };
  });

  test("disables empty canvas submission and clears stale errors on a subsequent edit", async () => {
    nextContent = { hasContent: false, dirty: false };
    const { onConfirm } = renderDialog({ type: "new", initialKind: "structure" });
    fireEvent.click(await screen.findByRole("button", { name: "准备结构式" }));
    expect((screen.getByRole("button", { name: "插入" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "插入" }));
    expect(nextReadyAdapter.readDraft).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "模拟绘制结构" }));
    expect((screen.getByRole("button", { name: "插入" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "模拟清空结构" }));
    expect((screen.getByRole("button", { name: "插入" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("clearly distinguishes retaining a draft from explicitly discarding changes", async () => {
    const initialKet = `${ket} `;
    const { onCancel, onConfirm } = renderDialog({
      type: "edit",
      kind: "structure",
      ketSource: initialKet,
    });
    fireEvent.click(await screen.findByRole("button", { name: "准备结构式" }));
    fireEvent.click(screen.getByRole("button", { name: "模拟绘制结构" }));
    expect(screen.getByText("未保存")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃并关闭" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("ketcher-initial-ket").textContent).toBe(initialKet);
  });

  test("renders its modal at the document root so page scrolling and zoom cannot move it", () => {
    renderDialog();

    const backdrop = screen.getByRole("dialog").parentElement;
    expect(backdrop).not.toBeNull();
    expect(backdrop?.parentElement).toBe(document.body);
  });

  test("external entries open separate chemistry panels and retain each draft", async () => {
    renderDialog();

    expect(screen.getByRole("tabpanel", { name: "化学方程式" })).toBeDefined();
    const field = screen.getByRole("textbox", { name: "化学方程式编辑器" }) as HTMLElement & {
      value: string;
    };
    field.value = "H2 + O2 -> H2O";
    fireEvent.input(field);

    await openChemistryKind("structure");
    await screen.findByRole("button", { name: "准备结构式" });
    await openChemistryKind("equation");
    await openChemistryKind("structure");
    await openChemistryKind("equation");

    expect(
      (screen.getByRole("textbox", { name: "化学方程式编辑器" }) as HTMLElement & { value: string })
        .value,
    ).toBe("H2 + O2 -> H2O");
    expect(editorMount).toHaveBeenCalledOnce();
  });

  test("shows a balanced water formation example with its ignition condition", () => {
    renderDialog();

    const field = screen.getByRole("textbox", { name: "化学方程式编辑器" });
    expect(field.getAttribute("placeholder")).toBe(
      String.raw`2H_{2} + O_{2} \xrightarrow{\mathrm{点燃}} 2H_{2}O`,
    );
  });

  test("hides the periodic panel toggle while editing a chemical structure", async () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "展开元素面板" })).toBeDefined();
    await openChemistryKind("structure");
    await screen.findByRole("button", { name: "准备结构式" });

    expect(screen.queryByRole("button", { name: "展开元素面板" })).toBeNull();
    expect(screen.queryByRole("button", { name: "收起元素面板" })).toBeNull();
  });

  test("keeps cancel beside the submit action on equation and structure tabs", async () => {
    renderDialog();

    const equationCancel = screen.getByRole("button", { name: "取消" });
    expect(equationCancel.parentElement?.className).toBe("formula-dialog-footer-actions");
    expect(equationCancel.nextElementSibling?.textContent).toBe("插入");
    expect(screen.getByRole("button", { name: "展开元素面板" }).parentElement?.className).toBe(
      "formula-dialog-footer-tools",
    );

    await openChemistryKind("structure");
    await screen.findByRole("button", { name: "准备结构式" });

    const structureCancel = screen.getByRole("button", { name: "关闭" });
    expect(structureCancel.parentElement?.className).toBe("formula-dialog-footer-actions");
    expect(structureCancel.nextElementSibling?.textContent).toBe("插入");
  });

  test("disables chemical structures with a Chinese explanation when assets are unavailable", async () => {
    renderDialog({ type: "new" }, vi.fn(), false);

    expect(screen.queryByRole("tab", { name: "化学结构式" })).toBeNull();
    expect(screen.getByText("当前书册暂不支持化学结构式。")).toBeDefined();

    await openChemistryKind("structure");
    expect(editorMount).not.toHaveBeenCalled();
  });

  test("warns before inserting a chemical structure while its patent book has failed to save", async () => {
    const user = userEvent.setup();
    const { onRetrySave } = renderDialog(
      { type: "new", initialKind: "structure" },
      vi.fn(),
      true,
      "failed",
    );

    expect(
      await screen.findByText("当前专利保存失败，结构式插入后尚未安全写入专利文件。"),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重试保存" }));
    expect(onRetrySave).toHaveBeenCalledOnce();
  });

  test("editing an existing structure locks the dialog to its structure tab", () => {
    renderDialog({ type: "edit", kind: "structure", ketSource: ket });

    expect(screen.getByRole("tabpanel", { name: "化学结构式" })).toBeDefined();
    expect(screen.queryByRole("tab", { name: "化学方程式" })).toBeNull();
  });

  test("passes a persisted macromolecule mode into Ketcher", async () => {
    renderDialog({ type: "edit", kind: "structure", ketSource: ket, editorMode: "macromolecule" });

    await waitFor(() =>
      expect(screen.getByTestId("ketcher-initial-mode").textContent).toBe("macromolecule"),
    );
  });

  test("shows an unavailable error instead of mounting a structure editor without assets", () => {
    renderDialog({ type: "edit", kind: "structure", ketSource: ket }, vi.fn(), false);

    expect(screen.getByRole("alert").textContent).toBe("当前书册暂不支持化学结构式。");
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    expect(editorMount).not.toHaveBeenCalled();
  });

  test("editing an existing equation unlocks the dialog to its equation tab with source unwrapped", () => {
    renderDialog({ type: "edit", kind: "equation", mode: "block", source: String.raw`\ce{H2O}` });

    expect(screen.getByRole("tabpanel", { name: "化学方程式" })).toBeDefined();
    expect(screen.queryByRole("tab", { name: "化学结构式" })).toBeNull();
    // inline/block mode selection is now visible during editing
    expect(screen.getByRole("radio", { name: "独立方程式" })).toBeDefined();
    // Source is unwrapped: \ce{H2O} → H2O visible in MathLive
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("H2O");
  });

  test("switching to another structure request remounts Ketcher with that request KET", async () => {
    const firstKet = `${ket}-first`;
    const secondKet = `${ket}-second`;
    const view = render(
      <ChemistryDialog
        sessionId="session-1"
        request={{ type: "edit", kind: "structure", ketSource: firstKet }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByTestId("ketcher-initial-ket");

    view.rerender(
      <ChemistryDialog
        sessionId="session-1"
        request={{ type: "edit", kind: "structure", ketSource: secondKet }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("ketcher-initial-ket").textContent).toBe(secondKet),
    );
    expect(editorMount).toHaveBeenCalledTimes(2);
  });

  test("validates chemical equation, supports mode and common chemistry inserts", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    const field = screen.getByRole("textbox", { name: "化学方程式编辑器" }) as HTMLElement & {
      value: string;
      executeCommand(command: unknown): void;
    };
    field.value = "H2";
    fireEvent.input(field);

    await user.click(screen.getByRole("button", { name: "生成" }));
    // 预设按钮已迁移到周期表面板，直接设置编辑区值模拟插入
    field.value = "H2\\rightarrow H_{2}O";
    fireEvent.input(field);
    await user.click(screen.getByRole("radio", { name: "独立方程式" }));
    await user.click(screen.getByRole("button", { name: "插入" }));

    expect(onConfirm).toHaveBeenCalledWith({
      kind: "equation",
      mode: "block",
      source: String.raw`\ce{H2\rightarrow H_{2}O}`,
    });
  });

  test("inserts common formulas, ions, and visible reaction symbols with matching preview syntax", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    // 反应符号按钮仍保留在对话框中
    expect(screen.getByRole("button", { name: "生成" })).toBeDefined();
    expect(screen.getByRole("button", { name: "沉淀" })).toBeDefined();
    expect(screen.getByRole("button", { name: "气体" })).toBeDefined();

    const field = screen.getByRole("textbox", { name: "化学方程式编辑器" }) as HTMLElement & {
      value: string;
    };
    field.value = "H_{2}";
    fireEvent.input(field);
    await user.click(screen.getByRole("button", { name: "生成" }));
    field.value = "H_{2} \\rightarrow H^{+}";
    fireEvent.input(field);

    // MathLive renders LaTeX syntax: H₂ → H⁺
    expect(field.value).toContain("H_{2}");
    expect(field.value).toContain("\\rightarrow");
    expect(field.value).toContain("H^{+}");
    expect(screen.getByRole("heading", { name: "预览" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "插入" }));
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "equation",
      mode: "inline",
      source: String.raw`\ce{H_{2} \rightarrow H^{+}}`,
    });
  });

  test("collects condition text before inserting a reaction arrow", async () => {
    const user = userEvent.setup();
    await renderDialogWithReadyMathlive();

    const conditionButton = screen.getByRole("button", { name: "反应条件" });
    expect(conditionButton.querySelector(".chemistry-preset-formula .katex")).not.toBeNull();
    expect(conditionButton.textContent).toContain("条件");

    const field = configureChemicalField("H_{2}", 5);
    fireEvent.input(field);
    await user.click(conditionButton);
    // 预设展示 Unicode 下标，但写入编辑源时必须是 LaTeX 下标。
    const upperInput = screen.getByPlaceholderText(/MnO₂/);
    expect(screen.getByText("切换").closest("button")?.textContent).toContain("⇌");
    await user.click(screen.getByRole("button", { name: "MnO₂" }));
    expect((upperInput as HTMLInputElement).value).toBe("MnO_{2}");
    await user.type(upperInput, "、加热");
    await user.click(screen.getByRole("button", { name: "插入条件箭头" }));

    expect(field.value).toBe(String.raw`H_{2}\xrightarrow{MnO_{2}、加热} `);
    expect((screen.getByRole("button", { name: "插入" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("keeps KaTeX scripts visible and preset chemistry formulas black", () => {
    const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");

    expect(css).toContain(".chemistry-preset-formula .katex {");
    expect(css).toContain("color: #000;");
  });

  test("keeps the equation input in sync with quick inserts before MathLive finishes loading", async () => {
    const user = userEvent.setup();
    const { promise, resolve } = deferred<void>();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ChemistryDialog
        sessionId="session-1"
        request={{ type: "new" }}
        onConfirm={onConfirm}
        onCancel={onCancel}
        loadMathlive={() => promise}
      />,
    );

    const field = screen.getByRole("textbox", {
      name: "化学方程式编辑器",
    }) as HTMLElement & { value: string };

    // 模拟插入水分子式：MathLive 未就绪时走 appendChemicalToken 拼接路径
    field.value = "H_{2}O";
    fireEvent.input(field);
    expect(field.value).toBe("H_{2}O");
    expect(screen.getByRole("heading", { name: "预览" })).toBeDefined();

    resolve();
    await waitFor(() => expect(field.value).toBe("H_{2}O"));

    await user.click(screen.getByRole("button", { name: "插入" }));
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "equation",
      mode: "inline",
      source: String.raw`\ce{H_{2}O}`,
    });
  });

  test("does not alter a selection when MathLive cannot expose its source", async () => {
    const user = userEvent.setup();
    const field = await renderDialogWithReadyMathlive();
    const executeCommand = vi.fn();
    field.executeCommand = executeCommand;
    field.value = "H";
    fireEvent.input(field);
    await waitFor(() => expect(field.value).toBe("H"));
    Object.defineProperty(field, "getValue", { configurable: true, value: undefined });
    field.selectionIsCollapsed = false;
    await user.click(screen.getByRole("button", { name: "上标" }));

    expect(executeCommand).not.toHaveBeenCalled();
    expect(screen.getByText("未能读取选区，原内容未改变")).toBeDefined();
  });

  test("wraps selected content in superscript when clicking superscript button", async () => {
    const user = userEvent.setup();
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("2+", 2);
    field.selectionIsCollapsed = false;
    field.selection = { ranges: [[0, 2]], direction: "forward" };

    await user.click(screen.getByRole("button", { name: "上标" }));

    expect(field.executeCommand).toHaveBeenCalledWith([
      "insert",
      "^{2+}",
      { insertionMode: "replaceSelection", selectionMode: "after" },
    ]);
    expect(field.value).toBe("^{2+}");
  });

  test("enters a subscript slot and exposes its active state", async () => {
    const user = userEvent.setup();
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("H", 1);
    const subscript = screen.getByRole("button", { name: "下标" });

    await user.click(subscript);

    expect(field.executeCommand).toHaveBeenCalledWith(["moveToSubscript"]);
    expect(subscript.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/正在输入下标/)).toBeDefined();
  });

  test("updates a non-blocking candidate while H2 becomes H2O", async () => {
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("H2", 2);
    fireEvent.input(field);
    expect(await screen.findByRole("option", { name: "使用候选 H₂" })).toBeDefined();

    field.value = "H2O";
    field.position = 3;
    field.selection = { ranges: [[3, 3]], direction: "forward" };
    fireEvent.input(field);
    expect(await screen.findByRole("option", { name: "使用候选 H₂O" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "使用候选 H₂" })).toBeNull();
  });

  test("inserts uppercase English letters from physical keys while an IME is composing", async () => {
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("", 0);

    expect(fireEvent.keyDown(field, { key: "Process", code: "KeyH", isComposing: true })).toBe(
      false,
    );

    expect(field.value).toBe("H");
    expect(field.executeCommand).toHaveBeenCalledWith([
      "insert",
      "H",
      { insertionMode: "replaceSelection", selectionMode: "after" },
    ]);
  });

  test("blocks the IME composition commit after inserting a physical-key letter", async () => {
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("", 0);
    const keyboardSink = document.createElement("span");
    field.append(keyboardSink);
    const mathliveCompositionHandler = vi.fn((event: CompositionEvent) => {
      if (event.type === "compositionend") field.value += event.data;
    });
    keyboardSink.addEventListener("compositionstart", mathliveCompositionHandler);
    keyboardSink.addEventListener("compositionupdate", mathliveCompositionHandler);
    keyboardSink.addEventListener("compositionend", mathliveCompositionHandler);

    fireEvent.compositionStart(keyboardSink);
    fireEvent.keyDown(keyboardSink, { key: "Process", code: "KeyH", isComposing: true });
    fireEvent.compositionUpdate(keyboardSink, { data: "中" });
    fireEvent.compositionEnd(keyboardSink, { data: "中" });

    expect(field.value).toBe("H");
    expect(mathliveCompositionHandler).not.toHaveBeenCalled();
  });

  test("canonicalizes unambiguous element symbols during physical keyboard input", async () => {
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("", 0);

    for (const code of ["KeyN", "KeyA", "KeyC", "KeyL"]) {
      fireEvent.keyDown(field, { key: "Process", code, isComposing: true });
    }

    expect(field.value).toBe("NaCl");
  });

  test("offers the alternate element spelling after ambiguous uppercase input", async () => {
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("C", 1);

    fireEvent.keyDown(field, { key: "Process", code: "KeyO", isComposing: true });

    expect(field.value).toBe("CO");
    expect(await screen.findByRole("option", { name: "使用候选 Co" })).toBeDefined();
  });

  test("does not intercept shortcuts or raw LaTeX mode", async () => {
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("", 0);

    expect(fireEvent.keyDown(field, { key: "a", code: "KeyA", ctrlKey: true })).toBe(true);
    field.mode = "latex";
    expect(fireEvent.keyDown(field, { key: "h", code: "KeyH" })).toBe(true);

    expect(field.value).toBe("");
    expect(field.executeCommand).not.toHaveBeenCalled();
  });

  test("accepts with Tab, hides with Escape, and recomputes after more input", async () => {
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("H2", 2);
    fireEvent.input(field);
    await screen.findByRole("option", { name: "使用候选 H₂" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "化学式格式候选" })).toBeNull();

    field.value = "H2O";
    field.position = 3;
    field.selection = { ranges: [[3, 3]], direction: "forward" };
    fireEvent.input(field);
    await screen.findByRole("option", { name: "使用候选 H₂O" });
    fireEvent.keyDown(field, { key: "Tab" });
    expect(field.value).toBe("H_{2}O");
  });

  test("switches ambiguous candidates with arrow keys", async () => {
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("SO42-", 5);
    fireEvent.input(field);
    await screen.findByRole("option", { name: "使用候选 SO₄²⁻" });

    fireEvent.keyDown(field, { key: "ArrowDown" });

    expect(
      screen.getByRole("option", { name: "使用候选 SO₄₂⁻" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("uses the same suggestion rules for pasted text", async () => {
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("Ca(OH)2", 7);

    fireEvent.input(field, { inputType: "insertFromPaste" });

    expect(await screen.findByRole("option", { name: "使用候选 Ca(OH)₂" })).toBeDefined();
  });

  test("does not suggest from the initial edit request before user input", async () => {
    await renderDialogWithReadyMathlive({
      type: "edit",
      kind: "equation",
      mode: "inline",
      source: String.raw`\ce{H2O}`,
    });

    await new Promise((resolve) => window.setTimeout(resolve, 120));
    expect(screen.queryByRole("listbox", { name: "化学式格式候选" })).toBeNull();
  });

  test("keeps the source when applying a suggestion fails", async () => {
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("H2O", 3);
    field.executeCommand.mockReturnValue(false);
    fireEvent.input(field);
    await screen.findByRole("option", { name: "使用候选 H₂O" });

    fireEvent.keyDown(field, { key: "Tab" });

    expect(field.value).toBe("H2O");
    expect(screen.getByRole("alert").textContent).toContain("原内容未改变");
  });

  test("leaves script input by repeated click, ArrowRight, or Space", async () => {
    const user = userEvent.setup();
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("H", 1);
    const subscript = screen.getByRole("button", { name: "下标" });

    await user.click(subscript);
    await user.click(subscript);
    await user.click(subscript);
    fireEvent.keyDown(field, { key: "ArrowRight" });
    await user.click(subscript);
    fireEvent.keyDown(field, { key: " " });

    expect(
      field.executeCommand.mock.calls.filter(([command]) => command[0] === "moveAfterParent"),
    ).toHaveLength(3);
    expect(subscript.getAttribute("aria-pressed")).toBe("false");
  });

  test("keeps superscript and subscript available on the same base", async () => {
    const user = userEvent.setup();
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("H", 1);

    await user.click(screen.getByRole("button", { name: "上标" }));
    await user.click(screen.getByRole("button", { name: "下标" }));

    expect(field.executeCommand).toHaveBeenCalledWith(["moveToSuperscript"]);
    expect(field.executeCommand).toHaveBeenCalledWith(["moveToSubscript"]);
  });

  test("rejects destructive conversion for a complex selected expression", async () => {
    const user = userEvent.setup();
    await renderDialogWithReadyMathlive();
    const source = "H_{2}+O^{2-}";
    const field = configureChemicalField(source, source.length);
    fireEvent.input(field);
    await waitFor(() => expect(field.value).toBe(source));
    field.selectionIsCollapsed = false;
    field.selection = { ranges: [[0, source.length]], direction: "forward" };

    await user.click(screen.getByRole("button", { name: "上标" }));

    expect(field.value).toBe(source);
    expect(screen.getByRole("alert").textContent).toContain("请缩小选区");
  });

  test("drops a candidate after the caret changes to a selection", async () => {
    await renderDialogWithReadyMathlive();
    const field = configureChemicalField("H2O", 3);
    fireEvent.input(field);
    await screen.findByRole("option", { name: "使用候选 H₂O" });
    field.selectionIsCollapsed = false;
    field.selection = { ranges: [[0, 2]], direction: "forward" };

    fireEvent.pointerUp(field);

    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "化学式格式候选" })).toBeNull();
    });
  });

  test("opens the requested structure workflow directly", async () => {
    const loadMathlive = vi.fn().mockResolvedValue(undefined);
    render(
      <ChemistryDialog
        sessionId="session-1"
        request={{ type: "new", initialKind: "structure" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loadMathlive={loadMathlive}
      />,
    );

    expect(screen.getByRole("dialog", { name: "插入化学结构式" })).toBeDefined();
    expect(screen.getByRole("tabpanel", { name: "化学结构式" })).toBeDefined();
    expect(await screen.findByRole("button", { name: "准备结构式" })).toBeDefined();
    expect(loadMathlive).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "化学方程式编辑器" })).toBeNull();
  });

  test("shows a Chinese error and disables confirmation for invalid equation syntax", () => {
    renderDialog();
    const field = screen.getByRole("textbox", { name: "化学方程式编辑器" }) as HTMLElement & {
      value: string;
    };
    field.value = String.raw`\ce{`;
    fireEvent.input(field);

    expect(screen.getByRole("alert").textContent).toContain("化学方程式语法有误");
    expect((screen.getByRole("button", { name: "插入" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("cancel never confirms or rasterizes a preview", async () => {
    const user = userEvent.setup();
    const rasterizePreview = vi.fn();
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { chemistry: { rasterizePreview } },
    });
    const { onCancel, onConfirm } = renderDialog();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(rasterizePreview).not.toHaveBeenCalled();
  });

  test("does not mount Ketcher until the external structure entry is opened", async () => {
    renderDialog();
    expect(editorMock).not.toHaveBeenCalled();

    await openChemistryKind("structure");
    await screen.findByRole("button", { name: "准备结构式" });
    expect(editorMount).toHaveBeenCalledOnce();
  });

  test("does not confirm an empty structure", async () => {
    const { onConfirm } = renderDialog();
    await openChemistryKind("structure");
    await screen.findByRole("button", { name: "准备结构式" });

    expect((screen.getByRole("button", { name: "插入" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("a structure editor failure does not prevent equation confirmation", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await openChemistryKind("structure");
    await user.click(await screen.findByRole("button", { name: "使结构编辑失败" }));
    expect(screen.getByRole("alert").textContent).toContain("结构编辑器加载失败");

    await openChemistryKind("equation");
    const field = screen.getByRole("textbox", { name: "化学方程式编辑器" }) as HTMLElement & {
      value: string;
    };
    field.value = "H2O";
    fireEvent.input(field);
    await user.click(screen.getByRole("button", { name: "插入" }));

    expect(onConfirm).toHaveBeenCalledWith({
      kind: "equation",
      mode: "inline",
      source: String.raw`\ce{H2O}`,
    });
  });

  test("confirms a staged structure preview without importing a document resource", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const previewPng = new Uint8Array([137, 80, 78, 71]);
    const value = chemicalPreviewValue(previewPng);
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        chemistry: {
          rasterizePreview: vi.fn().mockResolvedValue({ ok: true, value }),
        },
      },
    });
    renderDialog({ type: "new" }, onConfirm);
    await openChemistryKind("structure");
    await user.click(await screen.findByRole("button", { name: "准备结构式" }));
    await user.click(screen.getByRole("button", { name: "插入" }));

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        kind: "structure",
        ketSource: ket,
        editorMode: undefined,
        previewAssetId: value.descriptor.assetId,
        previewDescriptor: value.descriptor,
      }),
    );
  });

  test("waits for an async structure confirmation and allows retry after rejection", async () => {
    const user = userEvent.setup();
    const confirmation = deferred<void>();
    const onConfirm = vi
      .fn()
      .mockReturnValueOnce(confirmation.promise)
      .mockRejectedValueOnce(new Error("import failed"));
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        chemistry: {
          rasterizePreview: vi.fn().mockResolvedValue({
            ok: true,
            value: chemicalPreviewValue(Uint8Array.from([137, 80, 78, 71])),
          }),
        },
      },
    });
    renderDialog({ type: "new" }, onConfirm);
    await openChemistryKind("structure");
    await user.click(await screen.findByRole("button", { name: "准备结构式" }));

    const submit = screen.getByRole("button", { name: "插入" });
    await user.click(submit);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "关闭" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await user.click(submit);
    expect(onConfirm).toHaveBeenCalledOnce();

    confirmation.resolve();
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    await user.click(submit);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert").textContent).toContain("保存结构式失败");
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  test("does not confirm after unmounting while a structure preview is generating", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const rasterization = deferred<{
      ok: true;
      value: ReturnType<typeof chemicalPreviewValue>;
    }>();
    const rasterizePreview = vi.fn().mockReturnValue(rasterization.promise);
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { chemistry: { rasterizePreview } },
    });
    const view = render(
      <ChemistryDialog
        sessionId="session-1"
        request={{ type: "new" }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    await openChemistryKind("structure");
    await user.click(await screen.findByRole("button", { name: "准备结构式" }));
    fireEvent.click(screen.getByRole("button", { name: "插入" }));
    await waitFor(() => expect(rasterizePreview).toHaveBeenCalledOnce());
    view.unmount();
    rasterization.resolve({
      ok: true,
      value: chemicalPreviewValue(new Uint8Array([1]), 1, 1),
    });
    await Promise.resolve();

    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("releases the insert button after a preview timeout and never inserts its late response", async () => {
    const user = userEvent.setup();
    const rasterization = deferred<{ ok: true; value: ReturnType<typeof chemicalPreviewValue> }>();
    const rasterizePreview = vi.fn().mockReturnValue(rasterization.promise);
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { chemistry: { rasterizePreview } },
    });
    const { onConfirm } = renderDialog();
    await openChemistryKind("structure");
    await user.click(await screen.findByRole("button", { name: "准备结构式" }));
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "插入" }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_001);
      });
      expect(screen.getByRole("alert").textContent).toContain("超时");
      expect((screen.getByRole("button", { name: "插入" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      await act(async () => {
        rasterization.resolve({ ok: true, value: chemicalPreviewValue(new Uint8Array([1])) });
      });
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("shows a recoverable Chinese error when MathLive fails to load", async () => {
    const user = userEvent.setup();
    const loadMathlive = vi
      .fn()
      .mockRejectedValueOnce(new Error("chunk missing"))
      .mockResolvedValue({});
    render(
      <ChemistryDialog
        sessionId="session-1"
        request={{ type: "new" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loadMathlive={loadMathlive}
      />,
    );

    expect((await screen.findByText("公式编辑器加载失败，请重试。")).textContent).toContain(
      "公式编辑器加载失败",
    );
    await user.click(screen.getByRole("button", { name: "重试加载公式编辑器" }));
    await waitFor(() => expect(loadMathlive).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "重试加载公式编辑器" })).toBeNull();
  });

  test("rasterizes a ready structure once and keeps the dialog open after a failure", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const rasterization = deferred<{ ok: false; error: { code: string; message: string } }>();
    const rasterizePreview = vi.fn().mockReturnValue(rasterization.promise);
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { chemistry: { rasterizePreview } },
    });
    renderDialog({ type: "new" }, onConfirm);
    await openChemistryKind("structure");
    await user.click(await screen.findByRole("button", { name: "准备结构式" }));

    const submit = screen.getByRole("button", { name: "插入" });
    fireEvent.click(submit);
    await waitFor(() => expect(rasterizePreview).toHaveBeenCalledOnce());
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "关闭" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(submit);
    rasterization.resolve({ ok: false, error: { code: "INTERNAL", message: "hidden" } });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("生成结构式预览失败"),
    );
    expect(rasterizePreview).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("生成结构式预览失败");
  });

  test("does not rasterize or confirm when Ketcher cannot read the structure draft", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const rasterizePreview = vi.fn();
    nextReadyAdapter = readyAdapter(
      vi.fn().mockResolvedValue({ ok: false, error: { code: "KETCHER_READ_FAILED" } }),
    );
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { chemistry: { rasterizePreview } },
    });
    renderDialog({ type: "new" }, onConfirm);

    await openChemistryKind("structure");
    await user.click(await screen.findByRole("button", { name: "准备结构式" }));
    await user.click(screen.getByRole("button", { name: "插入" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("无法读取当前化学结构"),
    );
    expect(rasterizePreview).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

test("chemical preview stays identical between inline and block positions", async () => {
  await renderDialogWithReadyMathlive();
  const field = configureChemicalField("H_{2}O", 3);
  fireEvent.input(field);
  const preview = screen.getByRole("region", { name: "化学方程式预览" });
  const before = preview.innerHTML;
  fireEvent.click(screen.getByRole("radio", { name: "独立方程式" }));
  expect(preview.innerHTML).toBe(before);
  fireEvent.click(screen.getByRole("radio", { name: "行内方程式" }));
  expect(preview.innerHTML).toBe(before);
});
test.each(["equation", "structure"] as const)(
  "patent-scoped %s windows retain their mounted editor without leaking into another patent",
  async (kind) => {
    const request = { type: "new" as const, initialKind: kind };
    const tree = (active: string) => (
      <ActiveEditorSessionContext.Provider value={active}>
        {["a", "b"].map((owner) => (
          <EditorSessionScope sessionId={owner} key={owner}>
            <ChemistryDialogPanel
              sessionId={owner}
              request={request}
              displayMode="modeless"
              onConfirm={vi.fn()}
              onCancel={vi.fn()}
            />
          </EditorSessionScope>
        ))}
      </ActiveEditorSessionContext.Provider>
    );
    const view = render(tree("a"));
    const first = screen.getByRole("dialog");
    const field =
      kind === "equation"
        ? (screen.getByRole("textbox", { name: "化学方程式编辑器" }) as ChemicalMathField)
        : null;
    if (field) {
      field.value = "H_2O";
      fireEvent.input(field);
    }
    view.rerender(tree("b"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog")).not.toBe(first);
    expect(first.closest("[hidden]")).not.toBeNull();
    view.rerender(tree("a"));
    expect(screen.getByRole("dialog")).toBe(first);
    if (field) {
      expect(screen.getByRole("textbox", { name: "化学方程式编辑器" })).toBe(field);
      expect(field.value).toBe("H_2O");
    }
  },
);
