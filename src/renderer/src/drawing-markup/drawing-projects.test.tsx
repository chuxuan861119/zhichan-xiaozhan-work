import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import type { PatentApi } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { createPatentSession } from "../patents/patent-reducer";
import { DrawingWorkspace } from "./drawing-workspace";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  read: vi.fn(),
  prompt: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("../patents/patent-context", () => ({
  usePatents: () => ({ updatePatentFigures: mocks.update }),
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
function sessionFixture() {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const projects = [1, 2].map((n) => ({
    ...drawingProjectFixture(id(n)),
    projectId: id(n + 10),
    name: n === 1 ? "甲图" : "乙图",
  }));
  projects.forEach((project, index) => {
    project.regions[0] = { ...project.regions[0]!, figureId: id(index + 20) };
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
  mocks.read.mockResolvedValue({ ok: true, value: new Uint8Array() });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
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

async function ready() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "标号" }).hasAttribute("disabled")).toBe(false),
  );
}
async function action(name: string, label: string) {
  fireEvent.click(screen.getByRole("button", { name: `${name}的更多操作` }));
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}

test("keeps every drawing's figures in the sidebar and locates across source changes", async () => {
  const session = sessionFixture();
  const { container } = render(<DrawingWorkspace session={session} active />);
  await ready();
  expect(screen.queryByText("工作稿信息")).toBeNull();
  expect(screen.getAllByRole("button", { name: /^定位图/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "定位图1" }));
  await ready();
  expect(screen.getByRole("button", { name: "乙图" }).getAttribute("aria-pressed")).toBe("true");
  expect(mocks.read).toHaveBeenLastCalledWith(session.sessionId, id(2));
  expect(container.querySelector("[data-published-location]")).not.toBeNull();
  expect(screen.getAllByRole("button", { name: /^定位图/ })).toHaveLength(2);
  const canvas = screen.getByRole("application", { name: "CAD标号画布" });
  const initialWidth = Number(canvas.getAttribute("viewBox")!.split(" ")[2]);
  fireEvent.click(screen.getByRole("button", { name: "放大图纸" }));
  fireEvent.click(screen.getByRole("button", { name: "放大图纸" }));
  await waitFor(() =>
    expect(Number(canvas.getAttribute("viewBox")!.split(" ")[2])).toBeCloseTo(initialWidth / 1.44),
  );
  const zoomed = canvas.getAttribute("viewBox")!.split(" ").map(Number);
  fireEvent.click(screen.getByRole("button", { name: "甲图" }));
  await ready();
  expect(container.querySelector("[data-published-location]")).toBeNull();
  expect(screen.getAllByRole("button", { name: /^定位图/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "定位图1" }));
  await ready();
  const located = canvas.getAttribute("viewBox")!.split(" ").map(Number);
  expect(located.slice(2)).toEqual(zoomed.slice(2));
  expect(located[0]! + located[2]! / 2).toBe(250);
  expect(located[1]! + located[3]! / 2).toBe(250);
  fireEvent.click(screen.getByRole("button", { name: "乙图的更多操作" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(container.querySelector("[data-published-location]")).not.toBeNull();
  expect(mocks.update).not.toHaveBeenCalled();
});

test("image drawings expose image tools and never create a CAD checkpoint on opening", async () => {
  const prepareCad = vi.fn();
  window.patentApi.assets.prepareCad = prepareCad;
  vi.stubGlobal("Worker", class { postMessage() {} terminate() {} });
  render(<DrawingWorkspace session={sessionFixture()} active />);
  await ready();
  expect(screen.getByRole("tab", { name: "图片工具" })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "CAD工具" })).toBeNull();
  expect(screen.queryByRole("button", { name: "直线" })).toBeNull();
  expect(prepareCad).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: "图片工具" }));
  expect(screen.getByRole("button", { name: "局部放大" })).toBeTruthy();
});

test("suspended legacy image workspaces do not start CAD reconciliation until activated", async () => {
  const workers: string[] = [];
  vi.stubGlobal("Worker", class {
    constructor(url: URL) { workers.push(String(url)); }
    postMessage() {}
    terminate() {}
  });
  const session = sessionFixture();
  session.patent.drawingProjects[0]!.cad = {
    version: 1, engine: "cadcraft", engineVersion: "a".repeat(40),
    assetId: id(3), overlayAssetId: id(4),
    mapping: { originX: 0, originY: 800, scale: 1 },
    backgroundSize: [1000, 800],
  };
  const view = render(<DrawingWorkspace session={session} active={false} runtimeEnabled={false} />);
  await act(async () => {});
  expect(mocks.read).toHaveBeenCalledWith(session.sessionId, id(1));
  expect(workers.filter(url => url.includes("cadcraft-worker"))).toEqual([]);
  expect(mocks.update).not.toHaveBeenCalled();
  view.rerender(<DrawingWorkspace session={session} active runtimeEnabled />);
  await waitFor(() => expect(workers.some(url => url.includes("cadcraft-worker"))).toBe(true));
});

test("renames an inactive drawing through its menu and retains the saved name after reopening", async () => {
  const session = sessionFixture();
  const mounted = render(<DrawingWorkspace session={session} active />);
  await ready();
  mocks.prompt.mockResolvedValueOnce(null);
  await action("乙图", "重命名");
  await waitFor(() => expect(mocks.prompt).toHaveBeenCalled());
  expect(mocks.update).not.toHaveBeenCalled();
  mocks.prompt.mockResolvedValueOnce("  第二张图  ");
  await action("乙图", "重命名");
  await waitFor(() => expect(screen.queryByRole("button", { name: "第二张图" })).not.toBeNull());
  expect(screen.getByRole("button", { name: "甲图" }).getAttribute("aria-pressed")).toBe("true");
  session.patent.drawingProjects = mocks.update.mock.lastCall![5];
  expect(session.patent.drawingProjects[1]?.name).toBe("第二张图");
  mounted.unmount();
  render(<DrawingWorkspace session={session} active />);
  await ready();
  expect(screen.getByRole("button", { name: "第二张图" })).not.toBeNull();
});

test("closes import warnings and keeps them dismissed after reopening", async () => {
  const session = sessionFixture();
  session.patent.drawingProjects[0]!.warnings = ["请核对字体、剖面线和特殊对象。"];
  const mounted = render(<DrawingWorkspace session={session} active />);
  await ready();
  expect(screen.getByRole("complementary", { name: "导入检查提示" })).not.toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "关闭导入检查提示" }));

  await waitFor(() =>
    expect(screen.queryByRole("complementary", { name: "导入检查提示" })).toBeNull(),
  );
  const savedProjects = mocks.update.mock.lastCall![5];
  expect(savedProjects[0].warnings).toEqual([]);
  session.patent.drawingProjects = savedProjects;
  mounted.unmount();
  render(<DrawingWorkspace session={session} active />);
  await ready();
  expect(screen.queryByRole("complementary", { name: "导入检查提示" })).toBeNull();
});

test("cancels deletion, then removes only the source drawing and retains published images", async () => {
  const session = sessionFixture();
  render(<DrawingWorkspace session={session} active />);
  await ready();
  mocks.confirm.mockResolvedValueOnce(false);
  await action("甲图", "删除");
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
  expect(mocks.update).not.toHaveBeenCalled();
  mocks.confirm.mockResolvedValueOnce(true);
  await action("甲图", "删除");
  await waitFor(() => expect(screen.queryByRole("button", { name: "甲图" })).toBeNull());
  await ready();
  expect(screen.getByRole("button", { name: "乙图" }).getAttribute("aria-pressed")).toBe("true");
  expect(mocks.update.mock.lastCall![1]).toEqual(session.patent.figures);
  expect(mocks.update.mock.lastCall![3]).toEqual(session.patent.assets);
  expect(mocks.update.mock.lastCall![5]).toHaveLength(1);
  mocks.confirm.mockResolvedValueOnce(true);
  await action("乙图", "删除");
  await waitFor(() => expect(screen.queryByRole("button", { name: "乙图" })).toBeNull());
  expect(mocks.update.mock.lastCall![5]).toEqual([]);
  expect(mocks.update.mock.lastCall![1]).toEqual(session.patent.figures);
});
