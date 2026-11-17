import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import type { PatentApi } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { createPatentSession } from "../patents/patent-reducer";
import { sharedCadSvgPreviewClient } from "./cad-svg-preview-client";
import { DrawingWorkspace } from "./drawing-workspace";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  read: vi.fn(),
  prompt: vi.fn(),
  confirm: vi.fn(),
  applyPlan: vi.fn(),
}));
vi.mock("../patents/patent-context", () => ({
  usePatents: () => ({
    updatePatentFigures: mocks.update,
    applyReferenceMarkPlan: mocks.applyPlan,
  }),
}));
vi.mock("../app/application-close-coordinator", () => ({
  useApplicationCloseParticipant: () => {},
}));
vi.mock("../shared/app-dialog", () => ({
  promptAppText: mocks.prompt,
  confirmAppAction: mocks.confirm,
  showAppAlert: vi.fn(),
}));
vi.mock("./render", () => ({
  imageUrl: () => "data:image/png;base64,",
  pdfPreview: vi.fn(),
  renderDrawing: vi.fn(),
}));
vi.mock("../patents/editors/asset-preview", () => ({
  AssetPreview: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function sessionFixture(
  referenceMarks: { referenceMarkId: string; number: number; keyword: string }[] = [],
) {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const projects = [1, 2].map((n) => ({
    ...drawingProjectFixture(id(n)),
    projectId: id(n + 10),
    name: n === 1 ? "甲图" : "乙图",
  }));
  projects.forEach((project, index) => {
    const [region] = project.regions;
    if (region) project.regions[0] = { ...region, figureId: id(index + 20) };
  });
  patent.drawingProjects = projects;
  patent.figures = [2, 1].map((n) => ({ figureId: id(n + 19), assetId: id(n), widthMm: 100 }));
  patent.assets = [1, 2].map((n) => ({
    assetId: id(n),
    kind: "image",
    mediaType: "image/png",
    extension: "png",
    originalName: `${n}.png`,
    byteLength: 1,
    sha256: "a".repeat(64),
    widthPx: 1000,
    heightPx: 800,
    previewByteLength: 1,
    previewSha256: "a".repeat(64),
  }));
  patent.referenceMarks = referenceMarks;
  return createPatentSession({
    patent,
    patentId: patent.patentId,
    sessionId: id(100),
    revision: 0,
    saveState: "saved",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("patent-workbench:cad-function-rail:user-intent:v1");
  localStorage.removeItem("patent-workbench:cad-function-rail:tab:v1");
  mocks.read.mockResolvedValue({ ok: true, value: new Uint8Array() });
  mocks.applyPlan.mockReturnValue(true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // 附图标记状态检查的后台 worker 在 jsdom 下不可用；这里挂一个只收不回的假 worker，
  // 让面板稳定停在初始状态，避免异步检查结果在断言中途改写行状态。
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: null = null;
      onerror: null = null;
      postMessage() {}
      terminate() {}
    },
  );
  window.patentApi = {
    settings: { read: async () => ({ ok: true, value: DEFAULT_APP_SETTINGS }) },
    assets: { readDrawingSource: mocks.read },
  } as unknown as PatentApi;
  vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 800),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function ready(expand = true) {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "标号" }).hasAttribute("disabled")).toBe(false),
  );
  if (expand) {
    const toggle = screen.queryByRole("button", { name: "展开功能栏" });
    if (toggle) fireEvent.click(toggle);
    const pin = screen.queryByRole("button", { name: "固定" });
    if (pin) fireEvent.click(pin);
    const marks = screen.queryByRole("tab", { name: "附图标记" });
    if (marks) fireEvent.click(marks);
  }
}

test("folder requests open the exact drawing project and can reopen a different project", async () => {
  const session = sessionFixture();
  const {rerender} = render(<DrawingWorkspace session={session} active openProjectRequest={{projectId: id(12), key: 1}} />);
  await waitFor(() => expect(screen.getByRole("button", {name: "乙图"}).getAttribute("aria-pressed")).toBe("true"));
  rerender(<DrawingWorkspace session={session} active openProjectRequest={{projectId: id(11), key: 2}} />);
  await waitFor(() => expect(screen.getByRole("button", {name: "甲图"}).getAttribute("aria-pressed")).toBe("true"));
});

test("switching from an image never sends its retained bytes to the CAD decoder", async () => {
  const session = sessionFixture();
  const second = session.patent.drawingProjects[1];
  if (!second) throw new Error("Missing second project");
  second.sourceKind = "dxf";
  const png = new Uint8Array([137, 80, 78, 71]);
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  let resolveSource: (value: unknown) => void = () => {};
  const nextSource = new Promise((resolve) => {
    resolveSource = resolve;
  });
  mocks.read.mockImplementation((_session: string, assetId: string) =>
    assetId === second.baseAssetId ? nextSource : Promise.resolve({ ok: true, value: png }),
  );
  const prepare = vi.spyOn(sharedCadSvgPreviewClient, "prepare").mockResolvedValue({
    supportsScreenStrokes: false,
  });
  render(<DrawingWorkspace session={session} active />);
  await ready(false);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "乙图" })),
  );
  expect(prepare.mock.calls.some(([bytes]) => bytes === png)).toBe(false);
  await act(async () => resolveSource({ ok: true, value: svg }));
  await waitFor(() => expect(prepare).toHaveBeenCalledWith(svg, expect.anything()));
});

test.each([false, true])(
  "image and CAD detail tools live in their own function rail (CAD: %s)",
  async (cad) => {
    const session = sessionFixture();
    const [project] = session.patent.drawingProjects;
    if (!project) throw new Error("测试图纸不存在");
    if (cad) {
      project.sourceKind = "dxf";
      project.cad = {
        version: 1,
        engine: "cadcraft",
        engineVersion: "a".repeat(40),
        assetId: id(1),
        mapping: { originX: 0, originY: 800, scale: 1 },
      };
    }
    const { container } = render(<DrawingWorkspace session={session} active />);
    const toolbar = screen.queryByRole("group", { name: "图纸工具" });
    if (cad) {
      expect(within(toolbar!).queryByRole("button", { name: "局部放大" })).toBeNull();
      expect(within(toolbar!).queryByRole("button", { name: /^取消$/ })).toBeNull();
      expect(within(toolbar!).getAllByRole("button")).toHaveLength(3);
    } else expect(toolbar).toBeNull();
    const label = screen.getByRole("button", { name: "标号" });
    const cancel = screen.getByRole("button", { name: /^取消$/ });
    expect(cancel.parentElement).toBe(label.parentElement);
    expect(label.nextElementSibling).toBe(cancel);
    expect(cancel.classList.contains("drawing-tool-button")).toBe(true);
    expect(cancel.querySelector("svg")?.getAttribute("width")).toBe("24");
    expect(screen.getByRole("button", { name: "新建图纸" }).querySelector("svg")).toBeNull();
    if (cad) {
      const opener = screen.queryByRole("button", { name: "展开功能栏" });
      if (opener) fireEvent.click(opener);
      const panel = await screen.findByRole("region", { name: "CAD实体编辑" });
      expect(within(panel).getByRole("button", { name: "局部放大" })).toBeTruthy();
      const modify = within(panel).getByRole("group", { name: "修改" });
      const copy = within(modify).getByRole("button", { name: "复制" });
      expect(copy.nextElementSibling).toBe(
        within(modify).getByRole("button", { name: "局部放大" }),
      );
      expect(
        within(within(panel).getByRole("group", { name: "绘图" })).queryByRole(
          "button", { name: "局部放大" },
        ),
      ).toBeNull();
      expect(container.querySelectorAll('[data-drawing-tool="detail"]')).toHaveLength(1);
    }
  },
);

test.each(["constructor", "load"])(
  "failed CAD %s releases busy state and permits explicit retry",
  async (phase) => {
    let attempts = 0;
    vi.stubGlobal(
      "Worker",
      class {
        onmessage?: (event: { data: unknown }) => void;
        onerror?: () => void;
        first = ++attempts === 1;
        constructor() {
          if (this.first && phase === "constructor") throw new Error("CAD worker unavailable");
        }
        postMessage(message: { id: number; method: string }) {
          queueMicrotask(() => {
            if (this.first && phase === "load") this.onerror?.();
            else
              this.onmessage?.({ data: { id: message.id, ok: true, value: new Uint8Array([1]) } });
          });
        }
        terminate() {}
      },
    );
    const prepare = vi
      .fn()
      .mockResolvedValue({
        ok: false,
        error: { code: "CAD_RUNTIME_UNAVAILABLE", message: "CAD native unavailable" },
      });
    window.patentApi.assets.prepareCad = prepare;
    const session = sessionFixture();
    session.patent.drawingProjects[0]!.sourceKind = "dxf";
    render(<DrawingWorkspace session={session} active />);
    const retry = await screen.findByRole("button", { name: "重试加载图纸" });
    expect(retry.hasAttribute("disabled")).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: "重试加载图纸" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "导入图纸" }).hasAttribute("disabled")).toBe(false);
  },
);

function preparePointerCanvas() {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "DOMPoint",
    class {
      constructor(
        public x: number,
        public y: number,
      ) {}
      matrixTransform() {
        return this;
      }
    },
  );
  SVGSVGElement.prototype.getScreenCTM = vi.fn(() => ({
    inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  })) as never;
  SVGSVGElement.prototype.setPointerCapture = vi.fn();
  SVGSVGElement.prototype.releasePointerCapture = vi.fn();
  SVGSVGElement.prototype.hasPointerCapture = vi.fn(() => false);
}
function historySession() {
  const session = sessionFixture([{ referenceMarkId: id(601), number: 1, keyword: "部件" }]);
  for (const project of session.patent.drawingProjects) {
    project.annotations[0]!.text = "1";
    project.detailViews = [];
    project.regions = [];
    project.baseFragments = undefined;
  }
  return session;
}
function savedProjects() {
  return mocks.update.mock.lastCall![5] as DrawingProject[];
}

test("CAD panel adds reference marks through the patent transaction, not a drawing rewrite", async () => {
  render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  const before = mocks.update.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "新增附图标记" }));
  const dialog = screen.getByRole("dialog", { name: "新增附图标记" });
  fireEvent.change(within(dialog).getByLabelText("关键词"), { target: { value: "壳体" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /^添加$/ }));
  expect(mocks.applyPlan).toHaveBeenCalledOnce();
  expect(mocks.update).toHaveBeenCalledTimes(before);
});
function editLabel(container: HTMLElement, value: string) {
  fireEvent.doubleClick(container.querySelector("[data-annotation] text")!);
  const input = screen.getByLabelText("直接修改标号");
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}
async function deleteGlobalNumber() {
  fireEvent.click(screen.getByRole("button", { name: "选中标号1" }));
  mocks.confirm.mockResolvedValue(true);
  const calls = mocks.update.mock.calls.length;
  fireEvent.keyDown(screen.getByLabelText("CAD标号画布"), { key: "Delete" });
  await waitFor(() => expect(mocks.update.mock.calls.length).toBe(calls + 1));
}

test("editing another drawing invalidates its shared batch redo everywhere", async () => {
  preparePointerCanvas();
  const { container } = render(<DrawingWorkspace session={historySession()} active />);
  await ready();
  await deleteGlobalNumber();
  fireEvent.keyDown(screen.getByLabelText("CAD标号画布"), { ctrlKey: true, key: "z" });
  fireEvent.click(screen.getByRole("button", { name: "乙图" }));
  await ready();
  editLabel(container, "88");
  fireEvent.click(screen.getByRole("button", { name: "甲图" }));
  await ready();
  expect(screen.getByRole("button", { name: "重做标号编辑" }).hasAttribute("disabled")).toBe(true);
  fireEvent.keyDown(screen.getByLabelText("CAD标号画布"), { ctrlKey: true, key: "y" });
  expect(savedProjects()[1]!.annotations[0]!.text).toBe("88");
});

test("undo in another drawing first restores the whole batch before older local edits", async () => {
  preparePointerCanvas();
  const { container } = render(<DrawingWorkspace session={historySession()} active />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "乙图" }));
  await ready();
  editLabel(container, "1x");
  editLabel(container, "1");
  fireEvent.click(screen.getByRole("button", { name: "甲图" }));
  await ready();
  await deleteGlobalNumber();
  fireEvent.click(screen.getByRole("button", { name: "乙图" }));
  await ready();
  fireEvent.keyDown(screen.getByLabelText("CAD标号画布"), { ctrlKey: true, key: "z" });
  expect(savedProjects().map((p) => p.annotations[0]!.text)).toEqual(["1", "1"]);
  fireEvent.keyDown(screen.getByLabelText("CAD标号画布"), { ctrlKey: true, key: "z" });
  expect(savedProjects().map((p) => p.annotations[0]!.text)).toEqual(["1", "1x"]);
});

test("shared undo protects a later edit and identifies the drawing to undo first", async () => {
  preparePointerCanvas();
  const { container } = render(<DrawingWorkspace session={historySession()} active />);
  await ready();
  await deleteGlobalNumber();
  fireEvent.click(screen.getByRole("button", { name: "乙图" }));
  await ready();
  fireEvent.click(screen.getByRole("button", { name: /^标号$/ }));
  const canvas = screen.getByLabelText("CAD标号画布");
  fireEvent.pointerDown(canvas, { clientX: 300, clientY: 300, button: 0 });
  fireEvent.pointerUp(canvas, { clientX: 300, clientY: 300, button: 0 });
  fireEvent.pointerDown(canvas, { clientX: 350, clientY: 350, button: 0 });
  fireEvent.pointerUp(canvas, { clientX: 350, clientY: 350, button: 0 });
  fireEvent.keyDown(canvas, { key: "Escape" });
  expect(savedProjects()[1]!.annotations).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "甲图" }));
  await ready();
  const calls = mocks.update.mock.calls.length;
  fireEvent.keyDown(canvas, { ctrlKey: true, key: "z" });
  expect(mocks.update).toHaveBeenCalledTimes(calls);
  expect(screen.getByText(/请先撤销.*乙图.*后续的编辑/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "乙图" }));
  await ready();
  fireEvent.keyDown(canvas, { ctrlKey: true, key: "z" });
  expect(savedProjects()[1]!.annotations).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "甲图" }));
  await ready();
  fireEvent.keyDown(canvas, { ctrlKey: true, key: "z" });
  expect(savedProjects().map((p) => p.annotations[0]!.text)).toEqual(["1", "1"]);
  expect(container.querySelectorAll("[data-annotation]")).toHaveLength(1);
});

test("rejected detail names and ratios return to the saved value and allow correction", async () => {
  preparePointerCanvas();
  const { container } = render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  const target = container.querySelector(
    '[data-detail="detail-fixture"] [data-detail-part="content"]',
  )!;
  const canvas = screen.getByLabelText("CAD标号画布");
  fireEvent.pointerDown(target, { clientX: 700, clientY: 200, button: 0 });
  fireEvent.pointerUp(canvas, { clientX: 700, clientY: 200, button: 0 });
  const label = screen.getByLabelText("局部放大字母");
  fireEvent.change(label, { target: { value: "B" } });
  fireEvent.blur(label);
  expect(screen.getByText("该字母已被使用。")).toBeTruthy();
  expect(label).toHaveProperty("value", "A");
  const ratio = screen.getByLabelText("局部放大比例");
  const original = (ratio as HTMLInputElement).value;
  fireEvent.change(ratio, { target: { value: "0:1" } });
  fireEvent.blur(ratio);
  expect(ratio).toHaveProperty("value", original);
  expect(mocks.update).not.toHaveBeenCalled();
  fireEvent.change(ratio, { target: { value: "1.25:1" } });
  fireEvent.blur(ratio);
  expect(savedProjects()[0]!.detailViews![0]!.ratio).toBe(1.25);
  expect(
    container.querySelector('[data-detail="detail-fixture"] [data-detail-part="title"]')!
      .textContent,
  ).toContain("1.3:1");
});

test("detail ratio display is concise without rounding stored geometry on untouched blur", async () => {
  preparePointerCanvas();
  const session = sessionFixture();
  const precise = 8.29208896773186;
  session.patent.drawingProjects[0]!.detailViews![0]!.ratio = precise;
  const { container } = render(<DrawingWorkspace session={session} active />);
  await ready();
  const target = container.querySelector(
    '[data-detail="detail-fixture"] [data-detail-part="content"]',
  )!;
  fireEvent.pointerDown(target, { clientX: 700, clientY: 200, button: 0 });
  fireEvent.pointerUp(screen.getByLabelText("CAD标号画布"), {
    clientX: 700,
    clientY: 200,
    button: 0,
  });
  const ratio = screen.getByLabelText("局部放大比例");
  expect(ratio).toHaveProperty("value", "8.3:1");
  fireEvent.blur(ratio);
  expect(session.patent.drawingProjects[0]!.detailViews![0]!.ratio).toBe(precise);
  expect(mocks.update).not.toHaveBeenCalled();
  expect(screen.getByRole("group", { name: "局部图缩放" }).querySelectorAll("button")).toHaveLength(
    2,
  );
});

test("flushing detail name and ratio together preserves both edits", async () => {
  preparePointerCanvas();
  const { container } = render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  const target = container.querySelector(
    '[data-detail="detail-fixture"] [data-detail-part="content"]',
  )!;
  const canvas = screen.getByLabelText("CAD标号画布");
  fireEvent.pointerDown(target, { clientX: 700, clientY: 200, button: 0 });
  fireEvent.pointerUp(canvas, { clientX: 700, clientY: 200, button: 0 });
  const label = screen.getByLabelText("局部放大字母");
  const ratio = screen.getByLabelText("局部放大比例");
  fireEvent.change(label, { target: { value: "C" } });
  fireEvent.change(ratio, { target: { value: "1.25:1" } });
  act(() => {
    fireEvent.blur(label);
    fireEvent.blur(ratio);
  });
  const detail = savedProjects()[0]!.detailViews![0]!;
  expect(detail.label).toBe("C");
  expect(detail.ratio).toBe(1.25);
});

function railScope(container: HTMLElement): HTMLElement {
  const scope = container.querySelector<HTMLElement>(
    '.patent-function-rail-scope[data-function-rail-scope="drawing-markup"]',
  );
  if (!scope) throw new Error("CAD标号功能栏作用域未渲染");
  return scope;
}

test("CAD标号首次默认展开并钉住", async () => {
  const { container } = render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready(false);
  const scope = railScope(container);
  const slot = scope.querySelector<HTMLElement>(".patent-global-function-rail-slot");
  expect(slot).not.toBeNull();
  expect(slot?.getAttribute("data-layout")).toBe("overlay");
  expect(slot?.getAttribute("data-expanded")).toBe("true");
  expect(slot?.getAttribute("data-reason")).toBe("pinned");
  expect(screen.getByRole("button", { name: "取消固定" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

test("功能栏可以收起，收起后仍可从侧边重新展开", async () => {
  const { container } = render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  const scope = railScope(container);
  const slot = scope.querySelector<HTMLElement>(".patent-global-function-rail-slot");
  fireEvent.click(screen.getByRole("button", { name: "收起功能栏" }));
  await waitFor(() => expect(slot?.getAttribute("data-expanded")).toBe("false"));
  expect(slot?.getAttribute("data-reason")).toBe("manual-collapse");
  expect(screen.queryByRole("button", { name: "取消固定" })).toBeNull();
  const reopen = screen.getByRole("button", { name: "展开功能栏" });
  fireEvent.pointerEnter(reopen);
  await waitFor(() => expect(slot?.getAttribute("data-expanded")).toBe("true"));
  expect(slot?.getAttribute("data-reason")).toBe("hover");
});

test("CAD 附图标记采用其他书册相同的工具容器并显示登记编号", async () => {
  const { container } = render(<DrawingWorkspace session={sessionFixture(threeMarks())} active />);
  await ready();
  const panel = railScope(container).querySelector('section[aria-label="附图标记"]');
  if (!panel) throw new Error("附图标记面板未渲染");
  expect(panel?.closest(".patent-book-tools")).not.toBeNull();
  expect(
    [...panel.querySelectorAll(".reference-mark-panel__row-number")].map((row) => row.textContent),
  ).toEqual(["1", "2"]);
});

test("取消钉住会回到自动收起，再钉住恢复常驻", async () => {
  const { container } = render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  const scope = railScope(container);
  const slot = scope.querySelector<HTMLElement>(".patent-global-function-rail-slot");
  fireEvent.click(screen.getByRole("button", { name: "取消固定" }));
  expect(slot?.getAttribute("data-expanded")).toBe("false");
  expect(slot?.getAttribute("data-reason")).toBe("auto");
  fireEvent.click(screen.getByRole("button", { name: "展开功能栏" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "固定" })).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "固定" }));
  await waitFor(() => expect(slot?.getAttribute("data-reason")).toBe("pinned"));
  expect(slot?.getAttribute("data-expanded")).toBe("true");
});

test("钉住的 CAD 功能栏可拖动，取消固定立即收起，重开回默认位置", async () => {
  preparePointerCanvas();
  const { container } = render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  const scope = railScope(container);
  const rail = screen.getByRole("complementary", { name: "图纸工具全局功能栏" });
  const header = rail.querySelector("header")!;
  vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(new DOMRect(600, 180, 280, 300));
  fireEvent.pointerDown(header, { button: 0, clientX: 640, clientY: 195, pointerId: 1 });
  fireEvent.pointerMove(window, { buttons: 1, clientX: 240, clientY: 255, pointerId: 1 });
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(rail.style.position).toBe("fixed");
  expect(rail.style.left).toBe("200px");
  expect(rail.style.top).toBe("240px");
  fireEvent.pointerEnter(rail);
  fireEvent.focus(screen.getByRole("button", { name: "取消固定" }));
  fireEvent.click(screen.getByRole("button", { name: "取消固定" }));
  expect(
    scope.querySelector(".patent-global-function-rail-slot")?.getAttribute("data-expanded"),
  ).toBe("false");
  expect(rail.hasAttribute("inert")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "展开功能栏" }));
  expect(rail.style.left).toBe("");
  expect(rail.style.top).toBe("");
  expect(rail.style.position).toBe("");
  fireEvent.pointerDown(header, { button: 0, clientX: 640, clientY: 195, pointerId: 2 });
  fireEvent.pointerMove(window, { buttons: 1, clientX: 240, clientY: 255, pointerId: 2 });
  fireEvent.pointerUp(window, { pointerId: 2 });
  expect(rail.style.position).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "固定" }));
  expect(rail.style.left).toBe("");
  expect(
    localStorage.getItem("patent-workbench.dialog-position.function-rail:drawing-markup"),
  ).toBeNull();
  expect(
    sessionStorage.getItem("patent-workbench.dialog-position.function-rail:drawing-markup"),
  ).toBeNull();
});

test("CAD 拖动不会触发画布编辑，关闭后立即重开也不记住拖动位置", async () => {
  preparePointerCanvas();
  render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  const rail = screen.getByRole("complementary", { name: "图纸工具全局功能栏" });
  vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(new DOMRect(600, 180, 280, 300));
  fireEvent.pointerDown(rail.querySelector("header")!, { button: 0, clientX: 640, clientY: 195 });
  fireEvent.pointerMove(window, { buttons: 1, clientX: 240, clientY: 255 });
  fireEvent.pointerUp(window);
  expect(rail.style.left).toBe("200px");
  fireEvent.click(screen.getByRole("button", { name: "收起功能栏" }));
  fireEvent.click(screen.getByRole("button", { name: "展开功能栏" }));
  expect(rail.style.position).toBe("");
  expect(mocks.update).not.toHaveBeenCalled();
});

test("CAD 功能栏不能拖入工具栏，高度变化时同步收紧上边界", async () => {
  preparePointerCanvas();
  let notifyToolbarResize = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.matches(".drawing-toolbar")) {
          notifyToolbarResize = () => this.callback([], this as unknown as ResizeObserver);
        }
      }
      disconnect() {}
    },
  );
  const { container } = render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  const toolbar = container.querySelector<HTMLElement>(".drawing-toolbar");
  const rail = screen.getByRole("complementary", { name: "图纸工具全局功能栏" });
  const header = rail.querySelector("header");
  if (!toolbar || !header) throw new Error("CAD 工具栏或功能栏标题未渲染");
  const toolbarBounds = vi
    .spyOn(toolbar, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(218, 124, 800, 56));
  fireEvent.resize(window);
  vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(new DOMRect(600, 200, 280, 300));
  fireEvent.pointerDown(header, { button: 0, clientX: 640, clientY: 215, pointerId: 1 });
  fireEvent.pointerMove(window, { buttons: 1, clientX: 240, clientY: -300, pointerId: 1 });
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(rail.style.top).toBe("180px");
  expect(rail.style.left).toBe("200px");
  toolbarBounds.mockReturnValue(new DOMRect(218, 124, 800, 106));
  act(() => notifyToolbarResize());
  expect(rail.style.top).toBe("230px");
  fireEvent.click(screen.getByRole("button", { name: "取消固定" }));
  fireEvent.click(screen.getByRole("button", { name: "展开功能栏" }));
  expect(rail.style.top).toBe("");
});

test("取消钉住后重开另一专利仍不钉住，再次钉住也会记住", async () => {
  const first = render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "取消固定" }));
  expect(localStorage.getItem("patent-workbench:cad-function-rail:user-intent:v1")).toBe("auto");
  first.unmount();
  const second = render(<DrawingWorkspace session={sessionFixture(threeMarks())} active />);
  await ready(false);
  const slot = railScope(second.container).querySelector(".patent-global-function-rail-slot");
  expect(slot?.getAttribute("data-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "展开功能栏" }));
  fireEvent.click(screen.getByRole("button", { name: "固定" }));
  second.unmount();
  const third = render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready(false);
  expect(
    railScope(third.container)
      .querySelector(".patent-global-function-rail-slot")
      ?.getAttribute("data-expanded"),
  ).toBe("true");
  expect(screen.getByRole("button", { name: "取消固定" })).toBeTruthy();
});

test("显式收起也会记住，损坏的本地状态回退默认钉住", async () => {
  const first = render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "收起功能栏" }));
  first.unmount();
  const second = render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready(false);
  expect(
    railScope(second.container)
      .querySelector(".patent-global-function-rail-slot")
      ?.getAttribute("data-reason"),
  ).toBe("manual-collapse");
  second.unmount();
  localStorage.setItem("patent-workbench:cad-function-rail:user-intent:v1", "invalid");
  render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready(false);
  expect(screen.getByRole("button", { name: "取消固定" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

test("点击关键词和状态点同样选中标号，编号不再使用独立按钮", async () => {
  const session = sessionFixture(threeMarks());
  const project = session.patent.drawingProjects[0];
  const annotation = project?.annotations[0];
  if (!project || !annotation) throw new Error("测试标号不存在");
  project.annotations = [{ ...annotation, text: "1" }];
  const { container } = render(<DrawingWorkspace session={session} active />);
  await ready();
  fireEvent.click(screen.getByText("箱体", { exact: true }));
  expect(container.querySelectorAll('[data-annotation][data-selected="true"]')).toHaveLength(1);
  expect(container.querySelector("button.reference-mark-panel__row-number")).toBeNull();
  fireEvent.keyDown(screen.getByLabelText("CAD标号画布"), { key: "Escape" });
  fireEvent.click(screen.getByRole("img", { name: "标号1：已存在" }));
  expect(container.querySelectorAll('[data-annotation][data-selected="true"]')).toHaveLength(1);
});

test("本地存储被禁用时仍能打开CAD并取消钉住", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const { container } = render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "取消固定" }));
  expect(
    railScope(container)
      .querySelector(".patent-global-function-rail-slot")
      ?.getAttribute("data-reason"),
  ).toBe("auto");
});

test("拖动复制关键词文字时不触发跨图纸选中", async () => {
  render(<DrawingWorkspace session={sessionFixture(threeMarks())} active />);
  await ready();
  const keyword = screen.getByText("箱体", { exact: true });
  const range = document.createRange();
  range.selectNodeContents(keyword);
  const selection = window.getSelection();
  if (!selection) throw new Error("浏览器选区不存在");
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.click(keyword, { detail: 1 });
  expect(screen.queryByRole("button", { name: "删除选中标号" })).toBeNull();
  expect(selection.toString()).toBe("箱体");
  selection.removeAllRanges();
});

const threeMarks = () => [
  { referenceMarkId: id(200), number: 1, keyword: "箱体" },
  { referenceMarkId: id(201), number: 2, keyword: "丝杆" },
];

test("选中编号和引出线使用亮蓝色，取消选中恢复原色且不改数据", async () => {
  const { container } = render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  const canvas = screen.getByLabelText("CAD标号画布");
  const mark = container.querySelector('[data-annotation="a1"]');
  if (!mark) throw new Error("测试标号未渲染");
  const original = mark.querySelector("text")?.getAttribute("fill");
  fireEvent.keyDown(canvas, { ctrlKey: true, key: "a" });
  expect(mark.querySelector("text")?.getAttribute("fill")).toBe("#007AFF");
  expect(mark.querySelector('polyline:not([stroke="transparent"])')?.getAttribute("stroke")).toBe(
    "#007AFF",
  );
  fireEvent.keyDown(canvas, { key: "Escape" });
  expect(mark.querySelector("text")?.getAttribute("fill")).toBe(original);
  expect(mocks.update).not.toHaveBeenCalled();
});

test("CAD 附图标记只允许查看和选中画布标号，不提供正文编辑或列表修改入口", async () => {
  const session = sessionFixture(threeMarks());
  render(<DrawingWorkspace session={session} active />);
  await ready();
  for (const name of ["填入说明书", "复制", "调整箱体位置", "编辑箱体", "定位问题"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  fireEvent.doubleClick(screen.getByText("箱体", { exact: true }));
  expect(screen.queryByRole("textbox", { name: "箱体关键词" })).toBeNull();
  expect(mocks.applyPlan).not.toHaveBeenCalled();
});

test("编号状态统计全部图纸，重复编号及非精确匹配不会干扰统计", async () => {
  const session = sessionFixture(threeMarks());
  const first = session.patent.drawingProjects[0];
  const second = session.patent.drawingProjects[1];
  if (!first || !second) throw new Error("测试图纸不存在");
  const annotation = first.annotations[0];
  if (!annotation) throw new Error("测试标号不存在");
  first.annotations = [{ ...annotation, text: "10" }];
  second.annotations = [{ ...annotation, text: "1" }];
  render(<DrawingWorkspace session={session} active />);
  await ready();
  expect(screen.getByRole("img", { name: "标号1：已存在" }).getAttribute("data-status")).toBe(
    "present",
  );
  expect(screen.getByRole("img", { name: "标号2：尚未标注" }).getAttribute("data-status")).toBe(
    "missing",
  );
  fireEvent.click(screen.getByRole("button", { name: "乙图" }));
  await ready();
  expect(screen.getByRole("img", { name: "标号1：已存在" }).getAttribute("data-status")).toBe(
    "present",
  );
});

test("点击编号跨图纸选中同号标注，切换保留选区，缺失编号清除选区", async () => {
  const session = sessionFixture(threeMarks());
  const project = session.patent.drawingProjects[0];
  const annotation = project?.annotations[0];
  if (!project || !annotation) throw new Error("测试标号不存在");
  project.annotations = [
    { ...annotation, id: "one-a", text: "1" },
    { ...annotation, id: "one-b", text: "1", x: 250 },
    { ...annotation, id: "other", text: "10", x: 300 },
  ];
  const second = session.patent.drawingProjects[1];
  if (!second) throw new Error("测试图纸不存在");
  second.annotations = [{ ...annotation, id: "one-a", text: "1" }];
  const { container } = render(<DrawingWorkspace session={session} active />);
  await ready();
  const canvas = screen.getByLabelText("CAD标号画布");
  fireEvent.keyDown(canvas, { ctrlKey: true, key: "a" });
  expect(container.querySelectorAll('[data-annotation][data-selected="true"]')).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "选中标号1" }));
  expect(
    [...container.querySelectorAll('[data-annotation][data-selected="true"]')].map((element) =>
      element.getAttribute("data-annotation"),
    ),
  ).toEqual(["one-a", "one-b"]);
  fireEvent.click(screen.getByRole("button", { name: "乙图" }));
  await ready();
  expect(container.querySelectorAll('[data-annotation][data-selected="true"]')).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "甲图" }));
  await ready();
  expect(container.querySelectorAll('[data-annotation][data-selected="true"]')).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "选中标号2" }));
  expect(container.querySelectorAll('[data-annotation][data-selected="true"]')).toHaveLength(0);
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.applyPlan).not.toHaveBeenCalled();
});

test("跨图纸剪切不会误删其他图纸标号", async () => {
  const session = sessionFixture(threeMarks());
  for (const project of session.patent.drawingProjects) {
    project.annotations = project.annotations.map((annotation) => ({ ...annotation, text: "1" }));
  }
  const { container } = render(<DrawingWorkspace session={session} active />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "选中标号1" }));
  const before = container.querySelectorAll("[data-annotation]").length;
  fireEvent.keyDown(screen.getByLabelText("CAD标号画布"), { metaKey: true, key: "x" });
  expect(screen.getByText("跨图纸标号请在单张图纸中剪切。")).toBeTruthy();
  expect(container.querySelectorAll("[data-annotation]")).toHaveLength(before);
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
});

test("跨图纸删除先确认，取消不修改，确认后可整体撤销重做且更新状态点", async () => {
  const session = sessionFixture(threeMarks());
  for (const project of session.patent.drawingProjects) {
    const annotation = project.annotations[0];
    if (!annotation) throw new Error("测试标号不存在");
    project.annotations = [{ ...annotation, text: "1" }];
  }
  const { container } = render(<DrawingWorkspace session={session} active />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "选中标号1" }));
  const canvas = () => screen.getByLabelText("CAD标号画布");
  mocks.confirm.mockResolvedValueOnce(false);
  fireEvent.keyDown(canvas(), { key: "Delete" });
  await waitFor(() =>
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining("2 张图纸中的 2 个")),
  );
  expect(mocks.update).not.toHaveBeenCalled();
  expect(container.querySelectorAll('[data-annotation][data-selected="true"]')).toHaveLength(1);
  mocks.confirm.mockResolvedValueOnce(true);
  fireEvent.keyDown(canvas(), { key: "Delete" });
  await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
  const saved = mocks.update.mock.calls[0]?.[5];
  expect(saved.map((project: { annotations: unknown[] }) => project.annotations.length)).toEqual([
    0, 0,
  ]);
  expect(screen.getByRole("img", { name: "标号1：尚未标注" })).toBeTruthy();
  fireEvent.keyDown(canvas(), { ctrlKey: true, key: "z" });
  expect(screen.getByRole("img", { name: "标号1：已存在" })).toBeTruthy();
  fireEvent.keyDown(canvas(), { ctrlKey: true, key: "y" });
  expect(screen.getByRole("img", { name: "标号1：尚未标注" })).toBeTruthy();
});

test("只读关键词的复制、删除和撤销按键不会操作 CAD 画布", async () => {
  const { container } = render(<DrawingWorkspace session={sessionFixture(threeMarks())} active />);
  await ready();
  fireEvent.keyDown(screen.getByLabelText("CAD标号画布"), { ctrlKey: true, key: "a" });
  const before = container.querySelectorAll('[data-annotation][data-selected="true"]').length;
  const keyword = screen.getByText("箱体", { exact: true });
  for (const event of [
    { key: "Delete" },
    { ctrlKey: true, key: "c" },
    { ctrlKey: true, key: "z" },
  ]) {
    expect(fireEvent.keyDown(keyword, event)).toBe(true);
  }
  expect(container.querySelectorAll('[data-annotation][data-selected="true"]')).toHaveLength(
    before,
  );
  expect(mocks.update).not.toHaveBeenCalled();
});

test("当前图纸无同号标注时仍可删除跨图纸选区，重复删除不会弹出两个确认框", async () => {
  const session = sessionFixture(threeMarks());
  const second = session.patent.drawingProjects[1];
  const annotation = second?.annotations[0];
  if (!second || !annotation) throw new Error("测试标号不存在");
  second.annotations = [{ ...annotation, text: "1" }];
  render(<DrawingWorkspace session={session} active />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "选中标号1" }));
  let finish: (value: boolean) => void = () => {};
  mocks.confirm.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const canvas = screen.getByLabelText("CAD标号画布");
  fireEvent.keyDown(canvas, { key: "Delete" });
  fireEvent.keyDown(canvas, { key: "Delete" });
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(mocks.update).not.toHaveBeenCalled();
  finish(true);
  await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
  const saved = mocks.update.mock.calls[0]?.[5];
  expect(saved[0].annotations[0].text).toBe("12");
  expect(saved[1].annotations).toHaveLength(0);
});

test("在画布改选后不再删除之前的跨图纸选区", async () => {
  const session = sessionFixture(threeMarks());
  for (const project of session.patent.drawingProjects) {
    const annotation = project.annotations[0];
    if (!annotation) throw new Error("测试标号不存在");
    project.annotations = [{ ...annotation, text: "1" }];
  }
  render(<DrawingWorkspace session={session} active />);
  await ready();
  const canvas = screen.getByLabelText("CAD标号画布");
  fireEvent.click(screen.getByRole("button", { name: "选中标号1" }));
  fireEvent.keyDown(canvas, { ctrlKey: true, key: "a" });
  fireEvent.keyDown(canvas, { key: "Delete" });
  expect(mocks.confirm).not.toHaveBeenCalled();
  const saved = mocks.update.mock.calls[0]?.[5];
  expect(saved.map((project: { annotations: unknown[] }) => project.annotations.length)).toEqual([
    0, 1,
  ]);
});

test("Command+X cuts CAD marks into the internal clipboard with undo available", async () => {
  render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  const canvas = screen.getByLabelText("CAD标号画布");
  fireEvent.keyDown(canvas, { metaKey: true, key: "a" });
  fireEvent.keyDown(canvas, { metaKey: true, key: "x" });
  await waitFor(() =>
    expect(screen.getByLabelText("CAD标号画布").querySelectorAll("[data-annotation]")).toHaveLength(
      0,
    ),
  );
  fireEvent.keyDown(canvas, { metaKey: true, key: "z" });
  expect(
    screen.getByLabelText("CAD标号画布").querySelectorAll("[data-annotation]").length,
  ).toBeGreaterThan(0);
});

test.each(["openharmony", "ohos", "darwin", "win32"])("%s ordinary vertical wheel zooms CAD instead of scrolling the canvas", async (platform) => {
  vi.stubGlobal("documentFontPlatform", platform);
  render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready(false);
  const canvas = screen.getByLabelText("CAD标号画布") as unknown as SVGSVGElement;
  Object.defineProperty(canvas, "getScreenCTM", {
    value: () => ({ inverse: () => ({ a: 1, b: 0, c: 0, d: 1 }) }),
  });
  vi.stubGlobal(
    "DOMPoint",
    class {
      constructor(
        public x: number,
        public y: number,
      ) {}
      matrixTransform() {
        return this;
      }
    },
  );
  const before = (canvas.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
  fireEvent.wheel(canvas, { deltaX: 0, deltaY: -120, clientX: 300, clientY: 200 });
  await waitFor(() => {
    const after = (canvas.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
    expect(after[2]).toBeCloseTo((before[2] ?? NaN) * Math.exp(-120 * 0.0014));
    expect(after[3]).toBeCloseTo((before[3] ?? NaN) * Math.exp(-120 * 0.0014));
  });
  fireEvent.wheel(canvas, { deltaX: 0, deltaY: 120, clientX: 300, clientY: 200 });
  await waitFor(() => {
    const after = (canvas.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
    expect(after[2]).toBeCloseTo(before[2] ?? NaN);
    expect(after[3]).toBeCloseTo(before[3] ?? NaN);
  });
});

test.each(["openharmony", "ohos", "darwin"])(
  "%s CAD two-axis scroll moves the view without zooming",
  async (platform) => {
    vi.stubGlobal("documentFontPlatform", platform);
    render(<DrawingWorkspace session={sessionFixture()} active />);
    await ready(false);
    const canvas = screen.getByLabelText("CAD标号画布") as unknown as SVGSVGElement;
    Object.defineProperty(canvas, "getScreenCTM", {
      value: () => ({ inverse: () => ({ a: 1, b: 0, c: 0, d: 1 }) }),
    });
    const before = (canvas.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
    fireEvent.wheel(canvas, { deltaX: 12, deltaY: 24 });
    await waitFor(() => {
      const after = (canvas.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
      expect(after[0]).toBeCloseTo((before[0] ?? NaN) + 12);
      expect(after[1]).toBeCloseTo((before[1] ?? NaN) + 24);
      expect(after.slice(2)).toEqual(before.slice(2));
    });
  },
);
