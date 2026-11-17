import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import type { PatentBookDocument } from "../../../shared/document/model";
import { createBlankPatent } from "../../../shared/patent/defaults";
import type { PatentFigure } from "../../../shared/patent/model";
import type { EditorCommandBus } from "../app/command-bus";
import { DocumentStructureRuler } from "./document-structure-ruler";
import { DualColumnContext } from "./dual-column-context";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function claimsDocument(): PatentBookDocument {
  const patent = createBlankPatent({ patentType: "invention", name: "结构标尺测试" });
  const claims = patent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("claims book missing");
  return {
    ...claims.document,
    content: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        type: "paragraph",
        attrs: {
          alignment: "left",
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text", text: "1. 一种装置，包括：", marks: [] }],
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        type: "paragraph",
        attrs: {
          alignment: "left",
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text", text: "箱体和控制器。", marks: [] }],
      },
    ],
  };
}

function claimsDocumentWithNumbers(numbers: readonly number[]): PatentBookDocument {
  const base = claimsDocument();
  const attrs = base.content[0]?.type === "paragraph" ? base.content[0].attrs : undefined;
  if (!attrs) throw new Error("claim paragraph attrs missing");
  return {
    ...base,
    content: numbers.map((number, index) => ({
      id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      type: "paragraph" as const,
      attrs,
      content: [{ type: "text" as const, text: `${number}. 权利要求测试内容。`, marks: [] }],
    })),
  };
}

function longClaimsDocument(): PatentBookDocument {
  const base = claimsDocument();
  const attrs = base.content[0]?.type === "paragraph" ? base.content[0].attrs : undefined;
  if (!attrs) throw new Error("claim paragraph attrs missing");
  const paragraph = (id: string, text: string) => ({
    id,
    type: "paragraph" as const,
    attrs,
    content: [{ type: "text" as const, text, marks: [] }],
  });
  return {
    ...base,
    content: [
      paragraph("00000000-0000-4000-8000-000000000101", "1. 一种包含长段落的装置，包括："),
      paragraph("00000000-0000-4000-8000-000000000102", "这是权利要求一的后续段落。"),
      paragraph("00000000-0000-4000-8000-000000000103", "2. 一种第二装置。"),
      paragraph("00000000-0000-4000-8000-000000000104", "3. 一种第三装置。"),
    ],
  };
}

function rect(input: Partial<DOMRect>): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: (input.left ?? 0) + (input.width ?? 0),
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
    ...input,
  };
}

function drawingFigure(index: number): PatentFigure {
  return {
    figureId: `00000000-0000-4000-8002-${index.toString(16).padStart(12, "0")}`,
    assetId: `00000000-0000-4000-8001-${index.toString(16).padStart(12, "0")}`,
    widthMm: 80,
  };
}

type DrawingRulerOptions = Readonly<{
  selectedFigureId?: string | null;
  onActivateFigure?: (figureId: string) => void;
}>;

function drawingRulerElement(figures: readonly PatentFigure[], options: DrawingRulerOptions = {}) {
  return (
    <div className="editor-workspace">
      <div className="patent-page-with-rail" data-structure-ruler="true">
        <DocumentStructureRuler
          figures={figures}
          selectedFigureId={options.selectedFigureId ?? null}
          onActivateFigure={options.onActivateFigure ?? (() => undefined)}
        />
        <main className="drawing-page">
          <div className="drawing-pairs-scroll">
            {figures.map((item, index) => (
              <article key={item.figureId} data-figure-id={item.figureId}>
                图{index + 1}
              </article>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}

async function renderMeasuredClaimsRuler(
  numbers: readonly number[] = [1, 2, 3, 4, 5],
  options: Readonly<{
    documentModel?: PatentBookDocument;
    elementRects?: readonly Partial<DOMRect>[];
    workspaceRect?: Partial<DOMRect>;
    setTextSelection?: ReturnType<typeof vi.fn>;
    focus?: ReturnType<typeof vi.fn>;
    dualColumn?: boolean;
    dualView?: boolean;
  }> = {},
) {
  const documentModel = options.documentModel ?? claimsDocumentWithNumbers(numbers);
  const defaultTops = [100, 153, 216, 256, 296];
  const elements = documentModel.content.map((_, index) => {
    const element = document.createElement("p");
    element.style.lineHeight = "30px";
    const defaultTop = defaultTops[index] ?? 336;
    const elementRect = options.elementRects?.[index];
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
      rect({ top: defaultTop, bottom: defaultTop + 30, ...elementRect }),
    );
    return element;
  });
  const chain = {
    focus: vi.fn(() => chain),
    setTextSelection: vi.fn(() => chain),
    scrollIntoView: vi.fn(() => chain),
    run: vi.fn(() => true),
  };
  const setTextSelection = options.setTextSelection ?? vi.fn(() => true);
  const focus = options.focus ?? vi.fn(() => true);
  const editor = {
    isDestroyed: false,
    commands: { setTextSelection, focus },
    state: {
      doc: {
        descendants: (visit: (node: { attrs: { nodeId: string } }, pos: number) => void) => {
          documentModel.content.forEach((block, index) => {
            visit({ attrs: { nodeId: block.id } }, index * 10);
          });
        },
      },
    },
    view: {
      dom: document.createElement("div"),
      nodeDOM: (position: number) => elements[position / 10] ?? null,
    },
    on: vi.fn(),
    off: vi.fn(),
    chain: () => chain,
  } as unknown as Editor;
  const commandBus = { getEditor: () => editor } as unknown as EditorCommandBus;
  const workspaceWheel = vi.fn();
  const content = (
    <div className="editor-workspace" onWheel={workspaceWheel}>
      <div className="patent-page-with-rail">
        <DocumentStructureRuler
          document={documentModel}
          bookKind="claims"
          editorId="claims-editor"
          commandBus={commandBus}
        />
        <div className="patent-page-zoom-frame" />
      </div>
    </div>
  );
  const rendered = render(
    options.dualColumn ? (
      <DualColumnContext.Provider value>{content}</DualColumnContext.Provider>
    ) : options.dualView ? (
      <div className="dual-document-pane" data-pane="right">
        {content}
      </div>
    ) : (
      content
    ),
  );
  const { container } = rendered;
  const workspace = container.querySelector<HTMLElement>(".editor-workspace");
  const layout = container.querySelector<HTMLElement>(".patent-page-with-rail");
  const page = container.querySelector<HTMLElement>(".patent-page-zoom-frame");
  if (!workspace || !layout || !page) throw new Error("missing ruler layout");
  workspace.scrollBy = vi.fn();
  vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(
    rect({ top: 100, bottom: 340, width: 1300, height: 240, ...options.workspaceRect }),
  );
  vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(rect({ width: 900 }));
  vi.spyOn(page, "getBoundingClientRect").mockReturnValue(
    rect({ left: 84, top: 100, bottom: 1100, width: 820, height: 1000 }),
  );
  fireEvent(window, new Event("resize"));
  const ruler = screen.getByRole("complementary", { name: "文档结构标尺" });
  await waitFor(() => expect(ruler.style.height).toBe("1000px"));
  return {
    chain,
    container,
    commandBus,
    documentModel,
    rerender: rendered.rerender,
    unmount: rendered.unmount,
    ruler,
    workspace,
    workspaceWheel,
    block: (index: number) => elements[index]!,
    blockRect: (index: number) => elements[index]!.getBoundingClientRect(),
    focus,
    marker: (label: string) => screen.getByRole("button", { name: `定位到${label}` }),
    position: (index: number) => index * 10,
    setTextSelection,
    visibleHeight: 240,
    visibleTop: 100,
  };
}

describe("DocumentStructureRuler", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        return globalThis.setTimeout(() => callback(0), 0) as unknown as number;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      })),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  test("reads each paragraph rectangle once per measurement", async () => {
    const fixture = await renderMeasuredClaimsRuler([1]);
    const read = vi.mocked(fixture.block(0).getBoundingClientRect);
    read.mockClear();
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("measures document-changing transactions, including silent external edits, but not selection-only changes", async () => {
    const fixture = await renderMeasuredClaimsRuler();
    const editor = fixture.commandBus.getEditor("claims-editor");
    if (!editor) throw new Error("Missing editor");
    const callback = vi
      .mocked(editor.on)
      .mock.calls.find(([event]) => event === "transaction")?.[1] as
      | ((event: { transaction: { docChanged: boolean } }) => void)
      | undefined;
    expect(callback).toBeDefined();
    const before = vi.mocked(requestAnimationFrame).mock.calls.length;
    act(() => callback?.({ transaction: { docChanged: false } }));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(before);
    act(() => callback?.({ transaction: { docChanged: true } }));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(before + 1);
    await waitFor(() => expect(fixture.marker("权利要求 1")).toBeTruthy());
  });

  test("remeasures painted block positions during content scroll-clamp motion and at its end", async () => {
    const fixture = await renderMeasuredClaimsRuler();
    const marker = fixture.marker("权利要求 1");
    const originalTop = Number.parseFloat(marker.style.top);
    const block = fixture.block(0);
    const originalRect = block.getBoundingClientRect();
    const layout = fixture.workspace.querySelector(".patent-page-with-rail");
    if (!layout) throw new Error("missing layout");
    for (const shift of [25, 50, 0]) {
      vi.mocked(block.getBoundingClientRect).mockReturnValue(
        rect({
          ...originalRect.toJSON(),
          top: originalRect.top + shift,
          bottom: originalRect.bottom + shift,
        }),
      );
      act(() => layout.dispatchEvent(new Event("editor-content-motion-frame", { bubbles: true })));
      await waitFor(() => expect(Number.parseFloat(marker.style.top)).toBe(originalTop + shift));
    }
  });

  test("releases stale ruler height before paint without waiting for marker measurement", async () => {
    let resize = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class extends ResizeObserverStub {
        constructor(callback: ResizeObserverCallback) {
          super();
          resize = () => callback([], this as unknown as ResizeObserver);
        }
      },
    );
    const fixture = await renderMeasuredClaimsRuler();
    const page = fixture.container.querySelector<HTMLElement>(".patent-page-zoom-frame");
    if (!page) throw new Error("missing page");
    vi.mocked(page.getBoundingClientRect).mockReturnValue(
      rect({ left: 84, top: 100, bottom: 980, width: 820, height: 880 }),
    );
    // The real marker scheduler can defer a frame on complex documents. The
    // old ruler must not hold the grid/scroll extent open during that delay.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    act(() => resize());
    expect(fixture.ruler.style.height).toBe("880px");
    expect(fixture.ruler.getAttribute("data-mode")).toBe("wide");
    fixture.unmount();
  });

  test("chooses the final ruler width before the first paint", () => {
    const commandBus = { getEditor: () => null } as unknown as EditorCommandBus;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("editor-workspace")) {
          return rect({ width: 1300, height: 800 });
        }
        if (this.classList.contains("patent-page-zoom-frame")) {
          return rect({ left: 84, width: 820, height: 1050, bottom: 1050 });
        }
        return rect({ width: 900, height: 800 });
      });

    try {
      render(
        <div className="editor-workspace">
          <div className="patent-page-with-rail">
            <DocumentStructureRuler
              document={claimsDocument()}
              bookKind="claims"
              editorId="claims-editor"
              commandBus={commandBus}
            />
            <div className="patent-page-zoom-frame" />
          </div>
        </div>,
      );

      expect(
        screen.getByRole("complementary", { name: "文档结构标尺" }).getAttribute("data-mode"),
      ).toBe("wide");
    } finally {
      rectSpy.mockRestore();
    }
  });

  test("does not jump to target zoom geometry before the page animation restores its displayed scale", async () => {
    const model = claimsDocument();
    const commandBus = { getEditor: () => null } as unknown as EditorCommandBus;
    let height = 1000;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("patent-page-zoom-frame")
          ? rect({ left: 84, width: 820, height, bottom: height })
          : rect({ width: 1300, height: 800 });
      });
    const content = (zoom: number) => (
      <div className="editor-workspace">
        <div className="patent-page-with-rail">
          <DocumentStructureRuler
            document={model}
            bookKind="claims"
            editorId="claims-editor"
            commandBus={commandBus}
            measurementKey={zoom}
          />
          <div className="patent-page-zoom-frame" />
        </div>
      </div>
    );
    try {
      const view = render(content(100));
      const ruler = screen.getByRole("complementary", { name: "文档结构标尺" });
      expect(ruler.style.height).toBe("1000px");
      height = 1500;
      view.rerender(content(150));
      expect(ruler.style.height).toBe("1000px");
      height = 1050;
      await waitFor(() => expect(ruler.style.height).toBe("1050px"));
    } finally {
      rectSpy.mockRestore();
    }
  });

  test("keeps the visible left ruler wide even when the docked rail makes the total width overflow", () => {
    const commandBus = { getEditor: () => null } as unknown as EditorCommandBus;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("editor-workspace")) {
          return rect({ width: 1170, height: 800 });
        }
        if (this.classList.contains("patent-page-zoom-frame")) {
          return rect({ left: 84, width: 836.4, height: 1071, bottom: 1071 });
        }
        if (this.classList.contains("patent-global-function-rail-slot")) {
          return rect({ width: 280, height: 400 });
        }
        return rect({ width: 1200, height: 800 });
      });

    try {
      render(
        <div className="editor-workspace">
          <div className="patent-page-with-rail">
            <DocumentStructureRuler
              document={claimsDocument()}
              bookKind="claims"
              editorId="claims-editor"
              commandBus={commandBus}
            />
            <div className="patent-page-zoom-frame" />
            <aside className="patent-global-function-rail-slot" data-layout="docked" />
          </div>
        </div>,
      );

      expect(
        screen.getByRole("complementary", { name: "文档结构标尺" }).getAttribute("data-mode"),
      ).toBe("wide");
    } finally {
      rectSpy.mockRestore();
    }
  });

  test("uses outer workspace width while aligning an accessible claim range", async () => {
    const start = document.createElement("p");
    const end = document.createElement("p");
    vi.spyOn(start, "getBoundingClientRect").mockReturnValue(rect({ top: 110, bottom: 150 }));
    vi.spyOn(end, "getBoundingClientRect").mockReturnValue(rect({ top: 180, bottom: 230 }));
    start.style.lineHeight = "30px";
    const setTextSelection = vi.fn(() => true);
    const focus = vi.fn(() => true);
    const chain = {
      focus: vi.fn(() => chain),
      setTextSelection: vi.fn(() => chain),
      scrollIntoView: vi.fn(() => chain),
      run: vi.fn(() => true),
    };
    const editor = {
      isDestroyed: false,
      commands: { setTextSelection, focus },
      state: {
        doc: {
          descendants: (visit: (node: { attrs: { nodeId: string } }, pos: number) => void) => {
            visit({ attrs: { nodeId: "00000000-0000-4000-8000-000000000001" } }, 0);
            visit({ attrs: { nodeId: "00000000-0000-4000-8000-000000000002" } }, 24);
          },
        },
      },
      view: {
        dom: document.createElement("div"),
        nodeDOM: (position: number) => (position === 0 ? start : end),
      },
      on: vi.fn(),
      off: vi.fn(),
      chain: () => chain,
    } as unknown as Editor;
    const commandBus = {
      getEditor: () => editor,
    } as unknown as EditorCommandBus;
    const { container } = render(
      <div className="editor-workspace">
        <div className="patent-page-with-rail">
          <DocumentStructureRuler
            document={claimsDocument()}
            bookKind="claims"
            editorId="claims-editor"
            commandBus={commandBus}
            measurementKey={100}
          />
          <div className="patent-page-zoom-frame" />
        </div>
      </div>,
    );
    const workspace = container.querySelector<HTMLElement>(".editor-workspace");
    const layout = container.querySelector<HTMLElement>(".patent-page-with-rail");
    const page = container.querySelector<HTMLElement>(".patent-page-zoom-frame");
    if (!workspace || !layout || !page) throw new Error("missing ruler layout");
    workspace.scrollBy = vi.fn();
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(
      rect({ top: 100, bottom: 340, width: 1300, height: 240 }),
    );
    vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(rect({ width: 900 }));
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue(
      rect({ left: 84, top: 10, bottom: 1060, width: 820, height: 1050 }),
    );
    fireEvent(window, new Event("resize"));

    const ruler = screen.getByRole("complementary", { name: "文档结构标尺" });
    await waitFor(() => expect(ruler.getAttribute("data-mode")).toBe("wide"));
    expect(ruler.style.height).toBe("1050px");
    const marker = screen.getByRole("button", { name: "定位到权利要求 1" });
    expect(marker.style.top).toBe("104px");
    expect(marker.style.height).toBe("116px");
    expect(marker.textContent).toContain("权利要求 1");
    expect(marker.textContent).toContain("权1");

    fireEvent.click(marker);
    expect(setTextSelection).toHaveBeenCalledWith(1);
    expect(focus).toHaveBeenCalledWith(undefined, { scrollIntoView: false });
    expect(workspace.scrollBy).toHaveBeenCalledWith({
      top: 110 - 100 - 240 / 3,
      behavior: "smooth",
    });
    expect(start.classList.contains("document-structure-ruler-target-flash")).toBe(true);
    expect(end.classList.contains("document-structure-ruler-target-flash")).toBe(false);
    expect(chain.scrollIntoView).not.toHaveBeenCalled();
  });

  test("groups dense structure errors and keeps real and virtual targets in navigation", async () => {
    const documentModel = claimsDocumentWithNumbers([1, 2, 2, 4]);
    const elements = documentModel.content.map((_, index) => {
      const element = document.createElement("p");
      element.style.lineHeight = "30px";
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
        rect({ top: 110 + index * 40, bottom: 140 + index * 40 }),
      );
      return element;
    });
    const setTextSelection = vi.fn(() => true);
    const focus = vi.fn(() => true);
    const chain = {
      focus: vi.fn(() => chain),
      setTextSelection: vi.fn(() => chain),
      scrollIntoView: vi.fn(() => chain),
      run: vi.fn(() => true),
    };
    const editor = {
      isDestroyed: false,
      commands: { setTextSelection, focus },
      state: {
        doc: {
          descendants: (visit: (node: { attrs: { nodeId: string } }, pos: number) => void) => {
            documentModel.content.forEach((block, index) => {
              visit({ attrs: { nodeId: block.id } }, index * 10);
            });
          },
        },
      },
      view: {
        dom: document.createElement("div"),
        nodeDOM: (position: number) => elements[position / 10] ?? null,
      },
      on: vi.fn(),
      off: vi.fn(),
      chain: () => chain,
    } as unknown as Editor;
    const commandBus = { getEditor: () => editor } as unknown as EditorCommandBus;
    const { container } = render(
      <div className="editor-workspace">
        <div className="patent-page-with-rail">
          <DocumentStructureRuler
            document={documentModel}
            bookKind="claims"
            editorId="claims-editor"
            commandBus={commandBus}
          />
          <div className="patent-page-zoom-frame" />
        </div>
      </div>,
    );
    const workspace = container.querySelector<HTMLElement>(".editor-workspace");
    const layout = container.querySelector<HTMLElement>(".patent-page-with-rail");
    const page = container.querySelector<HTMLElement>(".patent-page-zoom-frame");
    if (!workspace || !layout || !page) throw new Error("missing ruler layout");
    workspace.scrollBy = vi.fn();
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(
      rect({ width: 1300, bottom: 800, height: 800 }),
    );
    vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(rect({ width: 900 }));
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue(
      rect({ left: 84, top: 10, bottom: 1060, width: 820, height: 1050 }),
    );
    fireEvent(window, new Event("resize"));

    expect(screen.queryByRole("button", { name: "结构错误 2" })).toBeNull();
    const group = container.querySelector<HTMLButtonElement>("button[data-cluster-count]");
    expect(group).not.toBeNull();
    fireEvent.focus(group!);
    const menu = screen.getByRole("navigation", { name: "文档导航" });
    expect(within(menu).getAllByRole("button", { name: "权利要求 2 · 重复" })).toHaveLength(2);
    fireEvent.click(within(menu).getByRole("button", { name: "缺少权利要求 3" }));
    expect(setTextSelection).toHaveBeenCalledWith(31);
    expect(focus).toHaveBeenCalledWith(undefined, { scrollIntoView: false });
    expect(chain.scrollIntoView).not.toHaveBeenCalled();
  });

  test("compact ruler opens an unclipped portal and keeps it open while entering the menu", async () => {
    const fixture = await renderMeasuredClaimsRuler();
    fixture.container
      .querySelector<HTMLElement>(".patent-page-with-rail")
      ?.style.setProperty("--column-ruler-width", "20");
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(fixture.ruler.dataset.mode).toBe("compact"));
    fireEvent.pointerEnter(fixture.ruler);
    const menu = await screen.findByRole("navigation", { name: "文档导航" });
    expect(within(menu).queryByText("文档导航")).toBeNull();
    expect(menu.firstElementChild?.className).toBe("ruler-navigation-popover__list");
    expect(fixture.ruler.contains(menu)).toBe(false);
    expect(Number.parseFloat(menu.style.left)).toBe(0);
    fireEvent.pointerLeave(fixture.ruler);
    fireEvent.pointerEnter(menu);
    fireEvent.click(within(menu).getByRole("button", { name: "权利要求 2" }));
    expect(fixture.setTextSelection).toHaveBeenCalledWith(fixture.position(1) + 1);
    expect(fixture.workspace.scrollBy).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "smooth" }),
    );
    expect(screen.queryByRole("navigation", { name: "文档导航" })).toBeNull();
  });

  test("wide ruler does not open a hover popover", async () => {
    const fixture = await renderMeasuredClaimsRuler([1, 2, 3, 4, 5], {
      elementRects: Array.from({ length: 5 }, () => ({ top: 100, bottom: 130 })),
    });

    await waitFor(() => expect(fixture.ruler.dataset.mode).toBe("wide"));
    fireEvent.pointerEnter(fixture.ruler);

    expect(screen.queryByRole("navigation", { name: "文档导航" })).toBeNull();
  });

  test.each([
    { label: "compact right pane", compact: true, dualColumn: false, dualView: true },
    { label: "dual columns", compact: false, dualColumn: true, dualView: false },
    { label: "dual view", compact: false, dualColumn: false, dualView: true },
  ])("requires continuous hover and cancels a quick crossing in $label", async (options) => {
    const fixture = await renderMeasuredClaimsRuler(undefined, options);
    if (options.compact) {
      fixture.container
        .querySelector<HTMLElement>(".patent-page-with-rail")
        ?.style.setProperty("--column-ruler-width", "20");
      fireEvent(window, new Event("resize"));
      await waitFor(() => expect(fixture.ruler.dataset.mode).toBe("compact"));
    }
    if (options.dualColumn) {
      const layout = fixture.container.querySelector<HTMLElement>(".patent-page-with-rail")!;
      layout.dataset.columnHeight = "240";
      layout.dataset.activeColumn = "1";
      vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(
        rect({ top: 100, bottom: 340, width: 900 }),
      );
    }
    const active = () =>
      fixture.ruler.dataset.navigation === "true" ||
      !!screen.queryByRole("navigation", { name: "文档导航" });
    vi.useFakeTimers();
    try {
      fireEvent.pointerEnter(fixture.ruler);
      expect(active()).toBe(false);
      act(() => vi.advanceTimersByTime(100));
      fireEvent.pointerLeave(fixture.ruler);
      act(() => vi.advanceTimersByTime(600));
      expect(active()).toBe(false);
      fireEvent.pointerEnter(fixture.ruler);
      act(() => vi.advanceTimersByTime(299));
      expect(active()).toBe(false);
      act(() => vi.advanceTimersByTime(1));
      expect(active()).toBe(true);
      expect(fixture.setTextSelection).not.toHaveBeenCalled();
    } finally {
      fixture.unmount();
      vi.useRealTimers();
    }
  });

  test.each(["single compact", "left pane compact", "left pane wide", "left column"])(
    "opens immediately on %s",
    async (variant) => {
      const fixture = await renderMeasuredClaimsRuler(undefined, {
        dualView: variant.startsWith("left pane"),
        dualColumn: variant === "left column",
      });
      const layout = fixture.container.querySelector<HTMLElement>(".patent-page-with-rail");
      if (!layout) throw Error("missing ruler layout");
      if (variant.includes("compact")) {
        layout.style.setProperty("--column-ruler-width", "20");
        fireEvent(window, new Event("resize"));
        await waitFor(() => expect(fixture.ruler.dataset.mode).toBe("compact"));
      }
      const pane = fixture.ruler.closest<HTMLElement>(".dual-document-pane");
      if (pane) pane.dataset.pane = "left";
      if (variant === "left column") {
        layout.dataset.activeColumn = "0";
        layout.dataset.columnHeight = "240";
        vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(
          rect({ top: 100, bottom: 340, width: 900 }),
        );
      }
      fireEvent.pointerEnter(fixture.ruler);
      expect(
        fixture.ruler.dataset.navigation === "true" ||
          !!screen.queryByRole("navigation", { name: "文档导航" }),
      ).toBe(true);
    },
  );

  test.each(["scroll", "pointerdown", "keydown", "resize"])(
    "cancels pending dual-view hover on %s",
    async (event) => {
      const fixture = await renderMeasuredClaimsRuler(undefined, { dualView: true });
      vi.useFakeTimers();
      try {
        fireEvent.pointerEnter(fixture.ruler);
        act(() => vi.advanceTimersByTime(100));
        if (event === "keydown") fireEvent.keyDown(document, { key: "Escape" });
        else if (event === "resize") fireEvent(window, new Event("resize"));
        else fireEvent(document, new Event(event, { bubbles: true }));
        act(() => vi.advanceTimersByTime(600));
        expect(fixture.ruler.dataset.navigation).toBeUndefined();
      } finally {
        fixture.unmount();
        vi.useRealTimers();
      }
    },
  );

  test.each([
    { label: "compact right pane", compact: true, dualColumn: false, dualView: true },
    { label: "wide right pane", compact: false, dualColumn: false, dualView: true },
    { label: "compact right column", compact: true, dualColumn: true, dualView: false },
    { label: "wide right column", compact: false, dualColumn: true, dualView: false },
  ])("wheel opens pending navigation immediately in $label", async (options) => {
    const fixture = await renderMeasuredClaimsRuler(undefined, options);
    const layout = fixture.container.querySelector<HTMLElement>(".patent-page-with-rail");
    if (!layout) throw new Error("missing ruler layout");
    if (options.dualColumn) {
      layout.dataset.columnHeight = "240";
      layout.dataset.activeColumn = "1";
      vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(
        rect({ top: 100, bottom: 340, width: 900 }),
      );
    }
    if (options.compact) {
      layout.style.setProperty("--column-ruler-width", "20");
      fireEvent(window, new Event("resize"));
      await waitFor(() => expect(fixture.ruler.dataset.mode).toBe("compact"));
    }
    const active = () =>
      fixture.ruler.dataset.navigation === "true" ||
      !!screen.queryByRole("navigation", { name: "文档导航" });
    vi.useFakeTimers();
    try {
      fireEvent.pointerEnter(fixture.ruler);
      act(() => vi.advanceTimersByTime(100));
      expect(active()).toBe(false);
      const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 26 });
      fireEvent(fixture.ruler, wheel);
      expect(active()).toBe(true);
      expect(wheel.defaultPrevented).toBe(true);
      expect(fixture.workspaceWheel).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(600));
      expect(active()).toBe(true);
      if (!options.compact) {
        const panel = fixture.ruler.querySelector<HTMLElement>(".document-structure-ruler__panel");
        if (!panel) throw new Error("missing ruler panel");
        expect(panel.style.getPropertyValue("--ruler-navigation-offset")).toBe("26px");
      }
      expect(fixture.setTextSelection).not.toHaveBeenCalled();
      expect(fixture.workspace.scrollBy).not.toHaveBeenCalled();
    } finally {
      fixture.unmount();
      vi.useRealTimers();
    }
  });

  test("keeps wide navigation outside the page while locating and flashing the target", async () => {
    const fixture = await renderMeasuredClaimsRuler();
    vi.useFakeTimers();

    const panel = fixture.ruler.querySelector<HTMLElement>(".document-structure-ruler__panel");
    if (!panel) throw new Error("missing ruler panel");
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(
      rect({ top: 10, left: 98, right: 118, width: 20, height: 1050 }),
    );

    fireEvent.pointerEnter(fixture.ruler);
    fireEvent.pointerEnter(fixture.marker("权利要求 2"));
    expect(fixture.block(1).classList.contains("document-structure-ruler-target-flash")).toBe(
      false,
    );

    fireEvent.click(fixture.marker("权利要求 2"));

    expect(fixture.setTextSelection).toHaveBeenCalledWith(fixture.position(1) + 1);
    expect(fixture.focus).toHaveBeenCalledWith(undefined, { scrollIntoView: false });
    expect(fixture.workspace.scrollBy).toHaveBeenCalledWith({
      top: fixture.blockRect(1).top - fixture.visibleTop - fixture.visibleHeight / 3,
      behavior: "smooth",
    });
    expect(fixture.block(1).classList.contains("document-structure-ruler-target-flash")).toBe(true);
    expect(fixture.block(0).classList.contains("document-structure-ruler-target-flash")).toBe(
      false,
    );
    expect(fixture.ruler.dataset.navigation).toBe("true");
    expect(panel.style.position).toBe("fixed");
    expect(panel.style.top).toBe("10px");
    expect(panel.style.left).toBe("42px");
    expect(panel.style.height).toBe("330px");
    expect(fixture.chain.scrollIntoView).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(999));
    expect(fixture.block(1).classList.contains("document-structure-ruler-target-flash")).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(fixture.block(1).classList.contains("document-structure-ruler-target-flash")).toBe(
      false,
    );

    fixture.unmount();
    vi.useRealTimers();
  });

  test.each([-300, 10, 100])(
    "clips hover navigation to the visible workspace when the panel starts at %i",
    async (panelTop) => {
      const fixture = await renderMeasuredClaimsRuler();
      const panel = fixture.ruler.querySelector<HTMLElement>(".document-structure-ruler__panel");
      if (!panel) throw new Error("missing ruler panel");
      vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(
        rect({ top: panelTop, left: 42, right: 118, width: 76, height: 1000 }),
      );

      fireEvent.pointerEnter(fixture.ruler);

      expect(panel.style.clipPath).toBe(`inset(${100 - panelTop}px -100vw 0px)`);
      expect(panelTop + Number.parseFloat(panel.style.height)).toBe(340);

      fireEvent.pointerLeave(fixture.ruler);
      expect(panel.style.clipPath).toBe("");
    },
  );

  test("uses immediate scrolling when reduced motion is requested", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const fixture = await renderMeasuredClaimsRuler();

    fireEvent.click(fixture.marker("权利要求 1"));

    expect(fixture.workspace.scrollBy).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "auto" }),
    );
  });

  test("does not select text while hovering, scrolling, or leaving the ruler", async () => {
    const fixture = await renderMeasuredClaimsRuler();

    fireEvent.pointerEnter(fixture.ruler);
    fireEvent.pointerEnter(fixture.marker("权利要求 2"));
    fireEvent.wheel(fixture.ruler, { deltaY: 26 });
    fireEvent.pointerLeave(fixture.ruler);

    expect(fixture.setTextSelection).not.toHaveBeenCalled();
  });

  test("disables marker motion while the document workspace is scrolling", async () => {
    const fixture = await renderMeasuredClaimsRuler();
    vi.useFakeTimers();
    try {
      fireEvent.scroll(fixture.workspace);
      expect(fixture.ruler.dataset.scrollActive).toBe("true");

      act(() => vi.advanceTimersByTime(79));
      expect(fixture.ruler.dataset.scrollActive).toBe("true");

      act(() => vi.advanceTimersByTime(1));
      expect(fixture.ruler.dataset.scrollActive).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("opens navigation on wheel without scrolling the workspace", async () => {
    const addEventListener = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const fixture = await renderMeasuredClaimsRuler();
    const wheelEvent = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 26 });
    const preventDefault = vi.spyOn(wheelEvent, "preventDefault");

    fireEvent(fixture.ruler, wheelEvent);

    expect(addEventListener).toHaveBeenCalledWith("wheel", expect.any(Function), {
      passive: false,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(fixture.workspaceWheel).not.toHaveBeenCalled();
    addEventListener.mockRestore();
  });

  test.each(["ctrlKey", "metaKey"])(
    "lets %s wheel gestures reach page zoom instead of ruler navigation",
    async (modifier) => {
      const fixture = await renderMeasuredClaimsRuler();
      const wheelEvent = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 26,
        [modifier]: true,
      });
      fireEvent(fixture.ruler, wheelEvent);
      expect(wheelEvent.defaultPrevented).toBe(false);
      expect(fixture.workspaceWheel).toHaveBeenCalledOnce();
      expect(fixture.ruler.dataset.navigation).toBeUndefined();
    },
  );

  test.each(["ctrlKey", "metaKey"])(
    "%s wheel cancels pending hover without opening navigation",
    async (modifier) => {
      const fixture = await renderMeasuredClaimsRuler(undefined, { dualView: true });
      vi.useFakeTimers();
      try {
        fireEvent.pointerEnter(fixture.ruler);
        act(() => vi.advanceTimersByTime(100));
        const wheel = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: 26,
          [modifier]: true,
        });
        fireEvent(fixture.ruler, wheel);
        act(() => vi.advanceTimersByTime(600));
        expect(wheel.defaultPrevented).toBe(false);
        expect(fixture.workspaceWheel).toHaveBeenCalledOnce();
        expect(fixture.ruler.dataset.navigation).toBeUndefined();
        expect(screen.queryByRole("navigation", { name: "文档导航" })).toBeNull();
      } finally {
        fixture.unmount();
        vi.useRealTimers();
      }
    },
  );

  test("wheel does not take over a pending text-selection gesture", async () => {
    const fixture = await renderMeasuredClaimsRuler(undefined, { dualView: true });
    const layout = fixture.container.querySelector<HTMLElement>(".patent-page-with-rail");
    if (!layout) throw new Error("missing ruler layout");
    layout.dataset.rulerSelectionPending = "true";
    fireEvent.wheel(fixture.ruler, { deltaY: 26 });
    expect(fixture.ruler.dataset.navigation).toBeUndefined();
    expect(screen.queryByRole("navigation", { name: "文档导航" })).toBeNull();
    expect(fixture.setTextSelection).not.toHaveBeenCalled();
  });

  test("updates small-document issues immediately without a debounce", () => {
    vi.useFakeTimers();
    const commandBus = { getEditor: () => null } as unknown as EditorCommandBus;
    const renderRuler = (documentModel: PatentBookDocument) => (
      <div className="editor-workspace">
        <div className="patent-page-with-rail">
          <DocumentStructureRuler
            document={documentModel}
            bookKind="claims"
            editorId="claims-editor"
            commandBus={commandBus}
          />
          <div className="patent-page-zoom-frame" />
        </div>
      </div>
    );
    const { container, rerender } = render(renderRuler(claimsDocumentWithNumbers([1, 3])));
    const missingMarker = () =>
      container.querySelector('button[aria-label="定位到缺少权利要求 2"]');
    expect(missingMarker()).not.toBeNull();

    rerender(renderRuler(claimsDocumentWithNumbers([1, 2, 3])));
    expect(missingMarker()).toBeNull();
    vi.useRealTimers();
  });

  test("contracts markers around the nearest center marker and owns wheel scrolling", async () => {
    const { ruler, workspaceWheel } = await renderMeasuredClaimsRuler();
    const panel = ruler.querySelector<HTMLElement>(".document-structure-ruler__panel");
    const anchor = screen.getByRole("button", { name: "定位到权利要求 3" });
    const previous = screen.getByRole("button", { name: "定位到权利要求 2" });
    if (!panel) throw new Error("missing ruler panel");

    fireEvent.pointerEnter(ruler);
    expect(ruler.dataset.navigation).toBe("true");
    expect(ruler.dataset.anchorMarker).toBeTruthy();
    expect(anchor.getAttribute("data-center")).toBe("true");
    expect(anchor.style.getPropertyValue("--ruler-navigation-shift-y")).toBe("-12px");
    expect(previous.style.getPropertyValue("--ruler-navigation-shift-y")).toBe("25px");

    const wheelEvent = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 26 });
    const preventDefault = vi.spyOn(wheelEvent, "preventDefault");
    fireEvent(ruler, wheelEvent);
    expect(preventDefault).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(panel.style.getPropertyValue("--ruler-navigation-offset")).toBe("26px"),
    );
    expect(ruler.dataset.centerMarker).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "定位到权利要求 4" }).getAttribute("data-center"),
    ).toBe("true");
    expect(workspaceWheel).not.toHaveBeenCalled();
  });

  test("disperses immediately and restores the last position within one second", async () => {
    const { ruler } = await renderMeasuredClaimsRuler();
    const panel = ruler.querySelector<HTMLElement>(".document-structure-ruler__panel");
    if (!panel) throw new Error("missing ruler panel");
    fireEvent.pointerEnter(ruler);

    fireEvent.wheel(ruler, { deltaY: 1000 });
    await waitFor(() =>
      expect(panel.style.getPropertyValue("--ruler-navigation-offset")).toBe("52px"),
    );
    expect(ruler.dataset.centerMarker).toBeDefined();

    fireEvent.wheel(ruler, { deltaY: -1000 });
    await waitFor(() =>
      expect(panel.style.getPropertyValue("--ruler-navigation-offset")).toBe("-52px"),
    );

    vi.useFakeTimers();
    try {
      fireEvent.pointerLeave(ruler);
      expect(ruler.dataset.navigation).toBeUndefined();
      expect(panel.style.getPropertyValue("--ruler-navigation-offset")).toBe("-52px");
      act(() => vi.advanceTimersByTime(999));
      fireEvent.pointerEnter(ruler);
      expect(ruler.dataset.navigation).toBe("true");
      expect(panel.style.getPropertyValue("--ruler-navigation-offset")).toBe("-52px");
      fireEvent.pointerLeave(ruler);
      expect(ruler.dataset.navigation).toBeUndefined();
      act(() => vi.advanceTimersByTime(1000));
      expect(panel.style.getPropertyValue("--ruler-navigation-offset")).toBe("0px");
    } finally {
      vi.useRealTimers();
    }
  });

  test("resets navigation when the ordered marker set changes even if the anchor remains", async () => {
    const { commandBus, documentModel, rerender, ruler, workspace } =
      await renderMeasuredClaimsRuler();
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(
      rect({ top: 100, bottom: 240, width: 1300, height: 140 }),
    );
    fireEvent.pointerEnter(ruler);
    fireEvent.wheel(ruler, { deltaY: 26 });
    const panel = ruler.querySelector<HTMLElement>(".document-structure-ruler__panel");
    if (!panel) throw new Error("missing ruler panel");
    await waitFor(() =>
      expect(panel.style.getPropertyValue("--ruler-navigation-offset")).toBe("26px"),
    );
    const anchorMarker = ruler.dataset.anchorMarker;
    expect(anchorMarker).toBe("claim:2:00000000-0000-4000-8000-000000000002");

    const reorderedDocument = claimsDocumentWithNumbers([3, 2, 1, 4, 5]);
    rerender(
      <div className="editor-workspace">
        <div className="patent-page-with-rail">
          <DocumentStructureRuler
            document={reorderedDocument}
            bookKind="claims"
            editorId="claims-editor"
            commandBus={commandBus}
          />
          <div className="patent-page-zoom-frame" />
        </div>
      </div>,
    );
    await waitFor(() => expect(ruler.dataset.navigation).toBeUndefined());
    expect(panel.style.getPropertyValue("--ruler-navigation-offset")).toBe("0px");
    expect(ruler.dataset.anchorMarker).toBeUndefined();
    expect(documentModel.content).toHaveLength(5);
  });

  test("anchors by a long marker's first-line position rather than its full range center", async () => {
    const { ruler } = await renderMeasuredClaimsRuler([], {
      documentModel: longClaimsDocument(),
      elementRects: [
        { top: 100, bottom: 130 },
        { top: 200, bottom: 800 },
        { top: 812, bottom: 842 },
        { top: 900, bottom: 930 },
      ],
      workspaceRect: { top: 100, bottom: 1000, height: 900 },
    });
    fireEvent.pointerEnter(ruler);
    expect(ruler.dataset.anchorMarker).toContain("claim:2:");
    expect(
      screen.getByRole("button", { name: "定位到权利要求 2" }).getAttribute("data-center"),
    ).toBe("true");
  });

  test("reuses the shared ruler rules for drawing figure markers", async () => {
    const figures = [drawingFigure(1), drawingFigure(2)];
    const onActivateFigure = vi.fn();
    const { container } = render(drawingRulerElement(figures, { onActivateFigure }));
    const workspace = container.querySelector<HTMLElement>(".editor-workspace");
    const layout = container.querySelector<HTMLElement>(".patent-page-with-rail");
    const page = container.querySelector<HTMLElement>(".drawing-page");
    if (!workspace || !layout || !page) throw new Error("missing drawing ruler layout");
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(rect({ width: 1300 }));
    vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(rect({ width: 900 }));
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue(
      rect({ left: 84, top: 10, bottom: 1060, width: 820, height: 1050 }),
    );
    const rows = page.querySelectorAll<HTMLElement>("[data-figure-id]");
    vi.spyOn(rows[0] as HTMLElement, "getBoundingClientRect").mockReturnValue(
      rect({ top: 110, bottom: 310, height: 200 }),
    );
    vi.spyOn(rows[1] as HTMLElement, "getBoundingClientRect").mockReturnValue(
      rect({ top: 330, bottom: 570, height: 240 }),
    );

    fireEvent(window, new Event("resize"));
    const ruler = screen.getByRole("complementary", { name: "文档结构标尺" });
    await waitFor(() => expect(ruler.style.height).toBe("1050px"));
    // 与权利要求书标尺一致的收起/展开规则：空间足够时自动切换为宽标尺。
    await waitFor(() => expect(ruler.getAttribute("data-mode")).toBe("wide"));

    const first = screen.getByRole("button", { name: "定位到图1" });
    const second = screen.getByRole("button", { name: "定位到图2" });
    expect(first.style.top).toBe("189px");
    expect(first.style.height).toBe("200px");
    expect(second.style.top).toBe("429px");
    expect(within(first).getByText("图1")).toBeTruthy();
    expect(within(first).getByText("1")).toBeTruthy();

    fireEvent.click(second);
    expect(onActivateFigure).toHaveBeenCalledWith(figures[1]?.figureId);
    expect(rows[1]?.classList.contains("document-structure-ruler-target-flash")).toBe(true);
  });

  test.each([0.5, 1, 2])(
    "keeps a tall final figure hit area within the page at %s zoom",
    async (zoom) => {
      const { container } = render(drawingRulerElement([drawingFigure(1)]));
      const page = container.querySelector<HTMLElement>(".drawing-page");
      const row = page?.querySelector<HTMLElement>("[data-figure-id]");
      if (!page || !row) throw new Error("missing drawing page");
      vi.spyOn(page, "getBoundingClientRect").mockReturnValue(
        rect({ top: 10, bottom: 10 + 1050 * zoom, height: 1050 * zoom, width: 820 * zoom }),
      );
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue(
        rect({ top: 10 + 300 * zoom, bottom: 10 + 950 * zoom, height: 650 * zoom }),
      );
      fireEvent(window, new Event("resize"));
      const marker = screen.getByRole("button", { name: "定位到图1" });
      await waitFor(() => expect(marker.style.top).toBe(`${625 * zoom - 11}px`));
      expect(
        Number.parseFloat(marker.style.top) + Number.parseFloat(marker.style.height),
      ).toBeLessThanOrEqual(1050 * zoom);
    },
  );

  test("shares hover navigation and selected-figure highlighting with the book rulers", async () => {
    const figures = [drawingFigure(1), drawingFigure(2), drawingFigure(3)];
    const { container, rerender } = render(drawingRulerElement(figures));
    const workspace = container.querySelector<HTMLElement>(".editor-workspace");
    const layout = container.querySelector<HTMLElement>(".patent-page-with-rail");
    const page = container.querySelector<HTMLElement>(".drawing-page");
    if (!workspace || !layout || !page) throw new Error("missing drawing ruler layout");
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(
      rect({ top: 10, bottom: 340, width: 1300, height: 330 }),
    );
    vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(rect({ width: 900 }));
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue(
      rect({ left: 84, top: 10, bottom: 1060, width: 820, height: 1050 }),
    );
    page.querySelectorAll<HTMLElement>("[data-figure-id]").forEach((row, index) => {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue(
        rect({ top: 110 + index * 200, bottom: 310 + index * 200, height: 200 }),
      );
    });

    fireEvent(window, new Event("resize"));
    const ruler = screen.getByRole("complementary", { name: "文档结构标尺" });
    await waitFor(() => expect(ruler.style.height).toBe("1050px"));

    // 鼠标放上进入导航模式：面板固定、锚定最近标记（与书籍标尺一致）。
    const panel = ruler.querySelector<HTMLElement>(".document-structure-ruler__panel");
    if (!panel) throw new Error("missing ruler panel");
    fireEvent.pointerEnter(ruler);
    expect(ruler.dataset.navigation).toBe("true");
    expect(ruler.dataset.anchorMarker).toBe(`figure:${figures[0]?.figureId}`);
    expect(panel.style.position).toBe("fixed");

    // 选中图2 → 标尺对应标记高亮。
    rerender(drawingRulerElement(figures, { selectedFigureId: figures[1]?.figureId ?? null }));
    expect(screen.getByRole("button", { name: "定位到图2" }).getAttribute("data-active")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "定位到图1" }).getAttribute("data-active")).toBe(
      "false",
    );
  });

  test("keeps the compact rail for the drawings page when the workspace is narrow", async () => {
    const figures = [drawingFigure(1), drawingFigure(2)];
    const { container } = render(drawingRulerElement(figures));
    const workspace = container.querySelector<HTMLElement>(".editor-workspace");
    const layout = container.querySelector<HTMLElement>(".patent-page-with-rail");
    const page = container.querySelector<HTMLElement>(".drawing-page");
    if (!workspace || !layout || !page) throw new Error("missing drawing ruler layout");
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(rect({ width: 500 }));
    vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(rect({ width: 480 }));
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue(
      rect({ top: 10, bottom: 1060, width: 820, height: 1050 }),
    );
    page.querySelectorAll<HTMLElement>("[data-figure-id]").forEach((row, index) => {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue(
        rect({ top: 110 + index * 200, height: 200 }),
      );
    });

    fireEvent(window, new Event("resize"));
    const ruler = screen.getByRole("complementary", { name: "文档结构标尺" });
    await waitFor(() => expect(ruler.getAttribute("data-mode")).toBe("compact"));
  });
});
