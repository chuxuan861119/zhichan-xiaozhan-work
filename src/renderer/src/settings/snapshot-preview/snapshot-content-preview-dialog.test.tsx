import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createBlankBookDocument } from "../../../../shared/document/defaults";
import type { PatentBookKind } from "../../../../shared/patent/model";
import type {
  SnapshotContentPreview,
  SnapshotPreviewFigure,
} from "../../../../shared/snapshot/model";
import { SnapshotContentPreviewDialog } from "./snapshot-content-preview-dialog";

beforeAll(() => {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { escape: (value: string) => value },
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type MockChange = {
  id: string;
  kind: "insert" | "delete" | "format" | "structure";
  bookKind: PatentBookKind;
  blockId: string;
  locationLabel: string;
  summary: string;
  details: readonly string[];
  nodeType: string | null;
};

const changesByBook: Record<PatentBookKind, MockChange[]> = {
  claims: [],
  description: [
    {
      id: "description-change-1",
      kind: "format",
      bookKind: "description",
      blockId: "block-1",
      locationLabel: "[0002]",
      summary: "格式变化",
      details: ["文字颜色：黑色 → 红色"],
      nodeType: "paragraph",
    },
  ],
  "description-drawings": [],
  abstract: [
    {
      id: "abstract-change-1",
      kind: "delete",
      bookKind: "abstract",
      blockId: "block-2",
      locationLabel: "摘要后段",
      summary: "删除文字",
      details: ["删除：旧句子"],
      nodeType: "paragraph",
    },
  ],
  "abstract-drawing": [],
};

vi.mock("./snapshot-book-diff", () => ({
  buildSnapshotBookDiff: ({
    bookKind,
    current,
  }: {
    bookKind: keyof typeof changesByBook;
    current: unknown;
  }) => ({
    bookKind,
    currentDocument: current,
    previewContent: { type: "doc", content: [] },
    changes: changesByBook[bookKind],
  }),
}));

vi.mock("./snapshot-book-preview", () => ({
  SnapshotBookPreview: ({
    diff,
    onChangeSelected,
  }: {
    diff: { bookKind: string; changes: readonly { id: string; summary: string }[] };
    onChangeSelected(id: string): void;
  }) => (
    <div data-testid={`book-${diff.bookKind}`}>
      {diff.changes.map((change) => (
        <button
          type="button"
          key={change.id}
          data-snapshot-change-id={change.id}
          onClick={() => onChangeSelected(change.id)}
        >
          {change.summary}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("./snapshot-figures-preview", () => ({
  SnapshotFiguresPreview: ({
    figures,
    baselineFigures,
  }: {
    figures: readonly { figureId: string }[];
    baselineFigures: readonly { figureId: string }[];
  }) => (
    <div data-testid="snapshot-figures-preview">
      <span data-testid="figures-count">{figures.length}</span>
      <span data-testid="baseline-figures-count">{baselineFigures.length}</span>
    </div>
  ),
}));

const emptyDocument = {
  version: 1,
  page: {
    size: "A4",
    orientation: "portrait",
    marginTopMm: 25.4,
    marginRightMm: 31.7,
    marginBottomMm: 25.4,
    marginLeftMm: 31.7,
  },
  content: [],
};

const currentFigures: SnapshotPreviewFigure[] = [
  {
    figureId: "00000000-0000-4000-8000-000000000931",
    assetId: "00000000-0000-4000-8000-000000000932",
    widthMm: 80,
  },
];

function largePreview() {
  const data = preview();
  const book = data.current.books.find((item) => item.kind === "description");
  if (!book) throw new Error("fixture");
  book.document = createBlankBookDocument("长文");
  book.document.content.push({
    id: "00000000-0000-4000-8000-000000000933",
    type: "paragraph",
    attrs: {
      alignment: "left",
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "宋体",
      defaultFontSizePt: 12,
    },
    content: [{ type: "text", text: "测试文字".repeat(5000), marks: [] }],
  });
  return data;
}

class PreviewWorker {
  static instances: PreviewWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    PreviewWorker.instances.push(this);
  }
}

test("keeps long previews closable while calculating off the UI thread and cancels on unmount", async () => {
  PreviewWorker.instances = [];
  vi.stubGlobal("Worker", PreviewWorker);
  const onClose = vi.fn();
  const view = render(
    <SnapshotContentPreviewDialog preview={largePreview()} documentId="patent" onClose={onClose} />,
  );
  expect(screen.getByRole("status").textContent).toContain("正在计算内容差异");
  expect(screen.queryByRole("tab")).toBeNull();
  expect(PreviewWorker.instances).toHaveLength(1);
  expect(PreviewWorker.instances[0]?.postMessage).toHaveBeenCalledOnce();
  await userEvent.setup().click(screen.getByRole("button", { name: "关闭内容预览" }));
  expect(onClose).toHaveBeenCalledOnce();
  view.unmount();
  expect(PreviewWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
});

test("ignores old worker responses after switching snapshots and allows retry after a worker failure", async () => {
  PreviewWorker.instances = [];
  vi.stubGlobal("Worker", PreviewWorker);
  const first = largePreview();
  const second = largePreview();
  second.current.revision = 19;
  const view = render(
    <SnapshotContentPreviewDialog preview={first} documentId="patent" onClose={vi.fn()} />,
  );
  const obsolete = PreviewWorker.instances[0];
  const obsoleteHandler = obsolete?.onmessage;
  view.rerender(
    <SnapshotContentPreviewDialog preview={second} documentId="patent" onClose={vi.fn()} />,
  );
  expect(obsolete?.terminate).toHaveBeenCalledOnce();
  act(() =>
    obsoleteHandler?.({ data: { ok: true, value: { books: [], auxiliary: {} } } } as MessageEvent),
  );
  expect(screen.getByRole("status")).toBeDefined();
  act(() => PreviewWorker.instances[1]?.onerror?.());
  expect(screen.getByRole("alert").textContent).toContain("差异预览计算失败");
  await userEvent.setup().click(screen.getByRole("button", { name: "重新计算" }));
  expect(PreviewWorker.instances).toHaveLength(3);
  expect(screen.getByRole("status")).toBeDefined();
});

test("displays worker results without recomputing large documents on the UI thread", () => {
  PreviewWorker.instances = [];
  vi.stubGlobal("Worker", PreviewWorker);
  const data = largePreview();
  render(<SnapshotContentPreviewDialog preview={data} documentId="patent" onClose={vi.fn()} />);
  const books = data.current.books.map((book) => ({
    bookKind: book.kind,
    currentDocument: book.document,
    previewContent: { type: "doc", content: [] },
    changes: changesByBook[book.kind],
  }));
  act(() =>
    PreviewWorker.instances[0]?.onmessage?.({
      data: { ok: true, value: { books, auxiliary: {} } },
    } as MessageEvent),
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("tab", { name: "说明书 1 项变化" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(PreviewWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
});

function preview(
  overrides: Partial<SnapshotContentPreview> = {},
  baselineFigures?: SnapshotPreviewFigure[],
): SnapshotContentPreview {
  const books = (
    ["claims", "description", "description-drawings", "abstract", "abstract-drawing"] as const
  ).map((kind) => ({ kind, document: emptyDocument }));
  return {
    current: {
      revision: 18,
      createdAt: "2026-08-16T03:00:00.000Z",
      books,
      figures: currentFigures,
    },
    baseline: {
      revision: 15,
      createdAt: "2026-08-16T02:32:00.000Z",
      books,
      ...(baselineFigures ? { figures: baselineFigures } : {}),
    },
    comparison: "compared",
    skippedRevisions: [],
    ...overrides,
  } as SnapshotContentPreview;
}

test("shows five fixed tabs, counts and selects the first changed book", () => {
  render(
    <SnapshotContentPreviewDialog
      preview={preview()}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );

  const dialog = screen.getByRole("dialog", { name: "v18 内容预览" });
  expect(dialog.classList.contains("standard-dialog--xl")).toBe(true);
  expect(within(dialog).getAllByRole("tab")).toHaveLength(5);
  expect(
    within(dialog).getByRole("tab", { name: "说明书 1 项变化" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(within(dialog).getByRole("tab", { name: "权利要求书 0 项变化" })).toBeDefined();
  expect(screen.getByText("与 v15（2026-08-16 10:32）相比")).toBeDefined();
  expect(screen.queryByRole("button", { name: /隐藏.*格式/u })).toBeNull();
  expect(screen.getByText("文字颜色：黑色 → 红色")).toBeDefined();
});

test("lists renamed and deleted auxiliary documents alongside the five books", async () => {
  const user = userEvent.setup();
  const data = preview();
  const auxiliaryDocument = createBlankBookDocument("材料");
  const id = "00000000-0000-4000-8000-000000000922";
  const deletedId = "00000000-0000-4000-8000-000000000923";
  data.current.auxiliaryDocuments = [
    { auxiliaryDocumentId: id, title: "新名称", document: auxiliaryDocument },
  ];
  if (!data.baseline) throw new Error("baseline");
  data.baseline.auxiliaryDocuments = [
    { auxiliaryDocumentId: id, title: "旧名称", document: auxiliaryDocument },
    { auxiliaryDocumentId: deletedId, title: "被删材料", document: auxiliaryDocument },
  ];
  render(<SnapshotContentPreviewDialog preview={data} documentId={id} onClose={vi.fn()} />);
  await user.selectOptions(screen.getByLabelText("其他文档快照"), id);
  expect(screen.getByText("重命名：旧名称 → 新名称")).toBeDefined();
  await user.selectOptions(screen.getByLabelText("其他文档快照"), deletedId);
  expect(screen.getByText("此文档已删除，以下保留删除前的内容供核对。")).toBeDefined();
  await user.click(screen.getByRole("tab", { name: "权利要求书 0 项变化" }));
  expect(screen.queryByLabelText("其他文档变化")).toBeNull();
});

test("opening a different snapshot resets auxiliary selection instead of showing an empty page", async () => {
  const user = userEvent.setup();
  const data = preview();
  data.current.auxiliaryDocuments = [
    { auxiliaryDocumentId: "aux", title: "材料", document: createBlankBookDocument("材料") },
  ];
  const view = render(
    <SnapshotContentPreviewDialog preview={data} documentId="patent-a" onClose={vi.fn()} />,
  );
  await user.selectOptions(screen.getByLabelText("其他文档快照"), "aux");
  view.rerender(
    <SnapshotContentPreviewDialog preview={preview()} documentId="patent-b" onClose={vi.fn()} />,
  );
  expect(screen.getByRole("tab", { name: "说明书 1 项变化" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(screen.getByTestId("book-description")).toBeDefined();
});

test("renders snapshot figures inside the description-drawings workspace and hides them elsewhere", async () => {
  const user = userEvent.setup();
  render(
    <SnapshotContentPreviewDialog
      preview={preview()}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );

  // 默认选中说明书；附图只在说明书附图标签下显示。
  // 基线没有附图字段（旧快照），当前 1 张附图计入标题计数。
  expect(screen.queryByTestId("snapshot-figures-preview")).toBeNull();
  await user.click(screen.getByRole("tab", { name: "说明书附图 1 项变化" }));
  const figures = screen.getByTestId("snapshot-figures-preview");
  expect(figures).toBeDefined();
  expect(screen.getByTestId("figures-count").textContent).toBe("1");
  expect(screen.getByTestId("baseline-figures-count").textContent).toBe("0");

  await user.click(screen.getByRole("tab", { name: "权利要求书 0 项变化" }));
  expect(screen.queryByTestId("snapshot-figures-preview")).toBeNull();
});

test("renders embedded preview in a workspace region without a modal dialog", () => {
  const { container } = render(
    <SnapshotContentPreviewDialog
      embedded
      preview={preview()}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );

  expect(screen.getByRole("region", { name: "v18 内容预览" })).toBeDefined();
  expect(screen.queryByRole("dialog", { name: "v18 内容预览" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "v18 内容预览" })).toBeNull();
  expect(container.querySelector(".snapshot-content-preview--embedded")).not.toBeNull();
});

test("previews the selected abstract drawing and detects a removed selection", async () => {
  const user = userEvent.setup();
  const data = preview({}, currentFigures);
  const figure = currentFigures[0];
  if (!figure) throw new Error("missing fixture figure");
  data.current.abstractDrawingFigureId = figure.figureId;
  const view = render(
    <SnapshotContentPreviewDialog preview={data} documentId="patent" onClose={vi.fn()} />,
  );
  await user.click(screen.getByRole("tab", { name: "摘要附图 1 项变化" }));
  expect(screen.getByTestId("figures-count").textContent).toBe("1");
  expect(screen.getByTestId("baseline-figures-count").textContent).toBe("0");
  const removed = structuredClone(data);
  if (!removed.baseline) throw new Error("missing fixture baseline");
  removed.baseline.abstractDrawingFigureId = figure.figureId;
  removed.current.abstractDrawingFigureId = null;
  view.rerender(
    <SnapshotContentPreviewDialog preview={removed} documentId="patent" onClose={vi.fn()} />,
  );
  await user.click(screen.getByRole("tab", { name: "摘要附图 1 项变化" }));
  expect(screen.getByTestId("figures-count").textContent).toBe("0");
  expect(screen.getByTestId("baseline-figures-count").textContent).toBe("1");
});

test("navigates changes across books without wrapping and exposes location/detail text", async () => {
  const user = userEvent.setup();
  // 基线附图与当前一致，附图书册不产生变化，跨书册导航顺序保持原意。
  render(
    <SnapshotContentPreviewDialog
      preview={preview({}, currentFigures)}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );

  expect((screen.getByRole("button", { name: "上一个变化" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await user.click(screen.getByRole("button", { name: "下一个变化" }));
  expect(
    screen.getByRole("tab", { name: "说明书摘要 1 项变化" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.queryByRole("button", { name: "[0002]：格式变化" })).toBeNull();
  expect(screen.getByRole("button", { name: "摘要后段：删除文字" })).toBeDefined();
  expect(screen.getByText("删除：旧句子")).toBeDefined();
  expect((screen.getByRole("button", { name: "下一个变化" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await user.click(screen.getByRole("button", { name: "上一个变化" }));
  expect(screen.getByRole("tab", { name: "说明书 1 项变化" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(screen.getByRole("button", { name: "[0002]：格式变化" })).toBeDefined();
});

test("renders initial, unreadable-baseline and cumulative warning copy exactly", () => {
  const { rerender } = render(
    <SnapshotContentPreviewDialog
      preview={preview({ comparison: "initial", baseline: null })}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText("初始基线，无更早快照可比较。")).toBeDefined();

  rerender(
    <SnapshotContentPreviewDialog
      preview={preview({ comparison: "no-readable-baseline", baseline: null })}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText("没有可用的历史版本，无法生成差异标记。")).toBeDefined();

  rerender(
    <SnapshotContentPreviewDialog
      preview={preview({ skippedRevisions: [17, 16] })}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );
  expect(
    screen.getByText(
      "v17、v16 无法读取，当前 v18 改为与 v15 比较。差异可能包含被跳过版本期间的累计修改。",
    ),
  ).toBeDefined();
  expect(
    screen.queryByText(
      "为显示被删除内容，差异预览的临时分页可能与该快照最终分页不同；恢复内容不受影响。",
    ),
  ).toBeNull();
  const dialog = screen.getByRole("dialog", { name: "v18 内容预览" });
  expect(dialog.classList.contains("standard-dialog--xl")).toBe(true);
  expect(dialog.querySelectorAll(".dialog-resize")).toHaveLength(8);
  expect(dialog.querySelector(".dialog-titlebar--draggable")).not.toBeNull();
  expect(dialog.querySelector(".snapshot-content-preview__rail small")).toBeNull();
});

test("retains each book workspace scroll position while switching tabs", async () => {
  const user = userEvent.setup();
  const { container } = render(
    <SnapshotContentPreviewDialog
      preview={preview()}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );
  const workspace = container.querySelector<HTMLElement>(".snapshot-content-preview__workspace");
  expect(workspace).not.toBeNull();
  if (!workspace) throw new Error("内容预览工作区未渲染");
  const scrollIntoView = vi
    .spyOn(HTMLElement.prototype, "scrollIntoView")
    .mockImplementation(function scrollTargetIntoView(this: HTMLElement) {
      const parent = this.closest<HTMLElement>(".snapshot-content-preview__workspace");
      if (parent) parent.scrollTop = 999;
    });
  workspace.scrollTop = 420;
  scrollIntoView.mockClear();
  await user.click(screen.getByRole("tab", { name: "说明书摘要 1 项变化" }));
  expect(workspace.scrollTop).toBe(0);
  workspace.scrollTop = 75;
  await user.click(screen.getByRole("tab", { name: "说明书 1 项变化" }));
  expect(workspace.scrollTop).toBe(420);
  expect(scrollIntoView).not.toHaveBeenCalled();
  scrollIntoView.mockRestore();
});

test("relocates on every click of the same change", async () => {
  const user = userEvent.setup();
  render(
    <SnapshotContentPreviewDialog preview={preview()} documentId="patent" onClose={vi.fn()} />,
  );
  const target = screen
    .getByTestId("book-description")
    .querySelector<HTMLElement>("[data-snapshot-change-id]");
  if (!target) throw new Error("missing change target");
  const scroll = vi.spyOn(target, "scrollIntoView").mockClear();
  await user.click(screen.getByRole("button", { name: "[0002]：格式变化" }));
  expect(scroll).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "[0002]：格式变化" }));
  expect(scroll).toHaveBeenCalledTimes(2);
});

test("locates auxiliary changes including repeated selections", async () => {
  const user = userEvent.setup();
  const data = preview();
  data.current.auxiliaryDocuments = [
    { auxiliaryDocumentId: "aux", title: "材料", document: createBlankBookDocument("材料") },
  ];
  render(<SnapshotContentPreviewDialog preview={data} documentId="patent" onClose={vi.fn()} />);
  await user.selectOptions(screen.getByLabelText("其他文档快照"), "aux");
  const target = screen
    .getByTestId("book-description")
    .querySelector<HTMLElement>("[data-snapshot-change-id]");
  if (!target) throw new Error("missing auxiliary change target");
  const scroll = vi.spyOn(target, "scrollIntoView").mockClear();
  const rail = screen.getByRole("complementary", { name: "其他文档变化" });
  await user.click(within(rail).getByRole("button"));
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(target.classList.contains("is-snapshot-change-target")).toBe(true);
  await user.click(within(rail).getByRole("button"));
  expect(scroll).toHaveBeenCalledTimes(2);
});

test("resets navigation and scroll state when a different preview is supplied", async () => {
  const user = userEvent.setup();
  const { container, rerender } = render(
    <SnapshotContentPreviewDialog
      preview={preview()}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "下一个变化" }));
  const workspace = container.querySelector<HTMLElement>(".snapshot-content-preview__workspace");
  if (!workspace) throw new Error("内容预览工作区未渲染");
  workspace.scrollTop = 700;

  rerender(
    <SnapshotContentPreviewDialog
      preview={preview()}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole("tab", { name: "说明书 1 项变化" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  await user.click(screen.getByRole("button", { name: "下一个变化" }));
  workspace.scrollTop = 700;

  rerender(
    <SnapshotContentPreviewDialog
      preview={preview({ current: { ...preview().current, revision: 19 } })}
      documentId="00000000-0000-4000-8000-000000000922"
      onClose={vi.fn()}
    />,
  );

  expect(screen.getByRole("dialog", { name: "v19 内容预览" })).toBeDefined();
  expect(screen.getByRole("tab", { name: "说明书 1 项变化" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(screen.getByText("文字颜色：黑色 → 红色")).toBeDefined();
  expect(workspace.scrollTop).toBe(0);
});

test("keeps resource warnings inside the modal dialog", () => {
  render(
    <SnapshotContentPreviewDialog
      preview={preview()}
      documentId="00000000-0000-4000-8000-000000000921"
      resourceMissing
      onClose={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "v18 内容预览" });
  expect(
    within(dialog).getByText("该快照有资源缺失，正文仍可预览；缺失资源可能无法显示。"),
  ).toBeDefined();
});

test("navigates from unchanged books to the nearest global changes", async () => {
  const user = userEvent.setup();
  // 基线附图与当前一致：说明书附图保持 0 项变化，仍作为“未变化书册”参与导航。
  render(
    <SnapshotContentPreviewDialog
      preview={preview({}, currentFigures)}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("tab", { name: "权利要求书 0 项变化" }));
  expect((screen.getByRole("button", { name: "上一个变化" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole("button", { name: "下一个变化" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  await user.click(screen.getByRole("button", { name: "下一个变化" }));
  expect(screen.getByRole("tab", { name: "说明书 1 项变化" }).getAttribute("aria-selected")).toBe(
    "true",
  );

  await user.click(screen.getByRole("tab", { name: "说明书附图 0 项变化" }));
  expect((screen.getByRole("button", { name: "上一个变化" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect((screen.getByRole("button", { name: "下一个变化" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  await user.click(screen.getByRole("button", { name: "上一个变化" }));
  expect(screen.getByRole("tab", { name: "说明书 1 项变化" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "说明书附图 0 项变化" }));
  await user.click(screen.getByRole("button", { name: "下一个变化" }));
  expect(
    screen.getByRole("tab", { name: "说明书摘要 1 项变化" }).getAttribute("aria-selected"),
  ).toBe("true");

  await user.click(screen.getByRole("tab", { name: "摘要附图 0 项变化" }));
  expect((screen.getByRole("button", { name: "下一个变化" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole("button", { name: "上一个变化" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  await user.click(screen.getByRole("button", { name: "上一个变化" }));
  expect(
    screen.getByRole("tab", { name: "说明书摘要 1 项变化" }).getAttribute("aria-selected"),
  ).toBe("true");
});

test("counts snapshot figure changes into the 说明书附图 tab and lists them in the change rail", async () => {
  const user = userEvent.setup();
  render(
    <SnapshotContentPreviewDialog
      preview={preview()}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "v18 内容预览" });

  // 基线缺少附图字段，当前 1 张附图 → 标题计入 1 项新增变化。
  const drawingsTab = within(dialog).getByRole("tab", { name: "说明书附图 1 项变化" });
  expect(drawingsTab).toBeDefined();
  await user.click(drawingsTab);
  expect(screen.getByTestId("snapshot-figures-preview")).toBeDefined();
  expect(screen.getByRole("button", { name: "图1：新增附图" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "图1：新增附图" }));
  expect(screen.getByText("新增 · 图1")).toBeDefined();
  expect(screen.getByText("新增附图：图1")).toBeDefined();
});

test("selects 说明书附图 first when figure changes are the only changes", () => {
  const savedDescription = changesByBook.description;
  const savedAbstract = changesByBook.abstract;
  changesByBook.description = [];
  changesByBook.abstract = [];
  try {
    render(
      <SnapshotContentPreviewDialog
        preview={preview()}
        documentId="00000000-0000-4000-8000-000000000921"
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "v18 内容预览" });
    expect(
      within(dialog)
        .getByRole("tab", { name: "说明书附图 1 项变化" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  } finally {
    changesByBook.description = savedDescription;
    changesByBook.abstract = savedAbstract;
  }
});

test("keeps 说明书附图 at 0 when baseline figures match or when there is no baseline", () => {
  const { rerender } = render(
    <SnapshotContentPreviewDialog
      preview={preview({}, currentFigures)}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole("tab", { name: "说明书附图 0 项变化" })).toBeDefined();

  rerender(
    <SnapshotContentPreviewDialog
      preview={preview({ comparison: "initial", baseline: null })}
      documentId="00000000-0000-4000-8000-000000000921"
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole("tab", { name: "说明书附图 0 项变化" })).toBeDefined();
});
