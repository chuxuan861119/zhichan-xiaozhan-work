import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, useEffect, useImperativeHandle } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cadSemanticKey } from "../../../shared/drawing-markup/cad-semantic-key";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import type { PatentApi } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { createPatentSession } from "../patents/patent-reducer";
import { renderDrawing } from "./render";
import type { CadEditingHandle, CadSelection } from "./cad-editing-panel";
import type { CadScene } from "./cadcraft-client";
import { DrawingWorkspace, type DrawingWorkspaceHandle } from "./drawing-workspace";

const calls = vi.hoisted(() => ({
  update: vi.fn(),
  request: vi.fn(),
  prepare: vi.fn(),
  polygon: vi.fn(),
  cancel: vi.fn(),
  select: vi.fn(),
}));
vi.mock("../patents/patent-context", () => ({
  usePatents: () => ({
    updatePatentFigures: calls.update,
    preparePatentSnapshot: async () => true,
  }),
}));
vi.mock("../app/application-close-coordinator", () => ({
  useApplicationCloseParticipant: () => {},
}));
vi.mock("./render", () => ({
  imageUrl: () => "data:image/png;base64,",
  pdfPreview: vi.fn(),
  renderDrawing: vi.fn(),
}));
vi.mock("./cadcraft-client", () => ({
  CadcraftClient: class {
    request = calls.request;
    close() {}
  },
  ensureCadcraftClient: (client: unknown) => client ?? { request: calls.request, close() {} },
}));
vi.mock("./cad-editing-panel", () => ({
  CadSelectionOverlay: () => null,
  CadEditingPanel: ({
    ref,
    disabled,
    onSelection,
    detailTool,
  }: {
    ref: React.Ref<CadEditingHandle>;
    disabled: boolean;
    onSelection(selection: CadSelection): void;
    detailTool?: { controls: React.ReactNode };
  }) => {
    useEffect(() => { calls.select.mockImplementation(onSelection); }, [onSelection]);
    useImperativeHandle(
      ref,
      () =>
        ({
          flush: async () => true,
          cancel: () => { calls.cancel(); onSelection(null); },
          leave() {},
          assistPoint: (p: { x: number; y: number }) => p,
          labelGlyph: async () => [],
          painted() {},
          selectPolygon: calls.polygon,
          selectHandles: () => onSelection(null),
        }) as unknown as CadEditingHandle,
    );
    return (
      <>
        {detailTool?.controls}
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onSelection({
              scene: {
                revision: 1,
                entityCount: 1,
                selection: ["100"],
                bounds: null,
                svgFrame: { origin: [0, 800], width: 1000, height: 800 },
                entities: [
                  {
                    handle: "100",
                    type: "LINE",
                    layer: "0",
                    grips: [
                      [100, 700],
                      [400, 400],
                    ],
                  },
                ],
                primitives: [
                  {
                    handle: "100",
                    kind: "line",
                    points: [
                      [100, 700],
                      [400, 400],
                    ],
                    color: [0, 0, 0],
                    aci7: true,
                    lineweight: 0.25,
                  },
                ],
              },
              handles: ["100"],
              checkpointId: "00000000-0000-4000-8000-000000000002",
            })
          }
        >
          选择线条
        </button>
        <button type="button" onClick={() => onSelection(null)}>
          清除选择
        </button>
      </>
    );
  },
}));
vi.mock("./cad-overlay-preview", () => ({ CadOverlayPreview: () => null }));
vi.mock("./vector-drawing-preview", () => ({
  VectorDrawingPreview: ({
    onPainted,
    view,
  }: {
    onPainted(view: unknown): void;
    view: unknown;
  }) => {
    useEffect(() => {
      onPainted(view);
    }, []);
    return null;
  },
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scene: CadScene = {
  revision: 1,
  entityCount: 0,
  selection: [],
  entities: [],
  primitives: [],
  bounds: null,
  svgFrame: { origin: [0, 800], width: 1000, height: 800 },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function open(withDetail = false, withFigure = false) {
  vi.clearAllMocks();
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  SVGSVGElement.prototype.getScreenCTM = vi.fn(() => ({ inverse: () => ({}) })) as never;
  SVGSVGElement.prototype.setPointerCapture = vi.fn();
  SVGSVGElement.prototype.releasePointerCapture = vi.fn();
  SVGSVGElement.prototype.hasPointerCapture = vi.fn(() => false);
  vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 800),
  );
  const project = {
    ...drawingProjectFixture(id(1)),
    sourceKind: "dxf" as const,
    detailViews: withDetail ? drawingProjectFixture(id(1)).detailViews!.slice(0, 1) : [],
    baseFragments: undefined,
    regions: [],
    cad: {
      version: 1 as const,
      engine: "cadcraft" as const,
      engineVersion: "a".repeat(40),
      assetId: id(2),
      overlayAssetId: id(3),
      unified: 1 as const,
      mapping: { originX: 0, originY: 800, scale: 1 },
      semanticKey: "",
      objects: withDetail ? [{ id: "detail-fixture", kind: "detail" as const, body: ["B00"] }] : [],
    },
  };
  project.cad.semanticKey = cadSemanticKey(project);
  window.patentApi = {
    settings: { read: async () => ({ ok: true, value: DEFAULT_APP_SETTINGS }) },
    assets: {
      readDrawingSource: async () => ({ ok: true, value: new Uint8Array([1]) }),
      prepareCad: calls.prepare,
      importMany: async () => ({ ok: true, value: [{ descriptor: { assetId: id(9) } }] }),
      getPreview: async () => ({ ok: true, value: new Uint8Array([1]) }),
      saveImage: vi.fn(async () => ({ ok: true, value: true })),
      discardImports: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  } as unknown as PatentApi;
  calls.prepare.mockResolvedValue({
    ok: true,
    value: {
      width: project.width,
      height: project.height,
      cad: { ...project.cad, assetId: id(4) },
      assets: [{ descriptor: { assetId: id(5) } }],
    },
  });
  const patent = createBlankPatent({ patentType: "invention", name: "连续标号" });
  if (withFigure) patent.figures = [{ figureId: id(20), assetId: id(1), widthMm: 90 }];
  patent.drawingProjects = [project];
  patent.assets = [
    {
      assetId: id(1),
      kind: "image",
      mediaType: "image/png",
      extension: "png",
      originalName: "a.png",
      byteLength: 1,
      sha256: "a".repeat(64),
      widthPx: 1000,
      heightPx: 800,
      previewByteLength: 1,
      previewSha256: "a".repeat(64),
    },
  ];
  const session = createPatentSession({
    patent,
    patentId: patent.patentId,
    sessionId: id(100),
    revision: 0,
    saveState: "saved",
  });
  const ref = createRef<DrawingWorkspaceHandle>();
  const mounted = render(<DrawingWorkspace ref={ref} session={session} active />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "标号" })).toHaveProperty("disabled", false),
  );
  return { ...mounted, ref, project, canvas: screen.getByRole("application", { name: "CAD标号画布" }) };
}
function click(canvas: Element, x: number, y: number) {
  fireEvent.pointerDown(canvas, { button: 0, clientX: x, clientY: y });
  fireEvent.pointerUp(canvas, { button: 0, clientX: x, clientY: y });
}
function circleSelect(canvas: Element) {
  fireEvent.click(screen.getByRole("button", { name: "圈选对象" }));
  fireEvent.pointerDown(canvas, { button: 0, clientX: 300, clientY: 300 });
  fireEvent.pointerMove(canvas, { buttons: 1, clientX: 600, clientY: 300 });
  fireEvent.pointerMove(canvas, { buttons: 1, clientX: 600, clientY: 600 });
  fireEvent.pointerMove(canvas, { buttons: 1, clientX: 300, clientY: 600 });
  fireEvent.pointerUp(canvas, { button: 0, clientX: 300, clientY: 600 });
}
test("a CAD object selection enables figure preview without a separate capture tool", async () => {
  await open();
  expect(screen.queryByRole("button", { name: "框选取图" })).toBeNull();
  expect(screen.getByRole("button", { name: "预览成图" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByText("选择线条"));
  expect(screen.getByRole("button", { name: "预览成图" })).toHaveProperty("disabled", false);
  expect(screen.getByRole("application", { name: "CAD标号画布" }).querySelector("[data-region-outline]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "取消选区" }));
  expect(screen.getByRole("button", { name: "预览成图" })).toHaveProperty("disabled", true);
});
test("preview renders selected CAD handles rather than the original full drawing", async () => {
  await open();
  calls.request.mockImplementation(async (command: string) =>
    command === "renderLabelFree"
      ? '<svg viewBox="0 0 1000 800"></svg>'
      : { scene, objects: [], bytes: new Uint8Array([2]) },
  );
  vi.mocked(renderDrawing).mockResolvedValue({
    bytes: new Uint8Array([1]),
    width: 100,
    height: 80,
    widthMm: 100,
  });
  fireEvent.click(screen.getByText("选择线条"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "预览成图" }));
  });
  await waitFor(() => expect(renderDrawing).toHaveBeenCalledOnce());
  expect(
    calls.request.mock.calls.some(
      (args) => args[0] === "renderLabelFree" && JSON.stringify(args).includes('"100"'),
    ),
  ).toBe(true);
  expect(vi.mocked(renderDrawing).mock.calls[0]?.[1].cadHandles).toEqual(["100"]);
  expect(screen.getByRole("button", { name: "预览成图" })).toHaveProperty("disabled", true);
});
test.each(["预览成图", "插入附图"])("%s rejects a CAD selection changed during rendering", async (action) => {
  await open();
  calls.request.mockImplementation(async (command: string) =>
    command === "renderLabelFree"
      ? '<svg viewBox="0 0 1000 800"></svg>'
      : { scene, objects: [], bytes: new Uint8Array([2]) },
  );
  let releaseRender!: (value: { bytes: Uint8Array; width: number; height: number; widthMm: number }) => void;
  vi.mocked(renderDrawing).mockImplementation(() => new Promise((resolve) => {
    releaseRender = resolve;
  }));
  fireEvent.click(screen.getByText("选择线条"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(renderDrawing).toHaveBeenCalledOnce());
  });
  fireEvent.click(screen.getByText("清除选择"));
  await act(async () => releaseRender({
    bytes: new Uint8Array([1]), width: 100, height: 80, widthMm: 100,
  }));
  expect(calls.update).not.toHaveBeenCalled();
  expect(screen.queryByRole("img", { name: "取图预览" })).toBeNull();
});
test("inserting a CAD selection publishes a figure link without reusing an image crop", async () => {
  await open();
  calls.request.mockImplementation(async (command: string) =>
    command === "renderLabelFree"
      ? '<svg viewBox="0 0 1000 800"></svg>'
      : { scene, objects: [], bytes: new Uint8Array([2]) },
  );
  vi.mocked(renderDrawing).mockResolvedValue({
    bytes: new Uint8Array([1]),
    width: 100,
    height: 80,
    widthMm: 100,
  });
  fireEvent.click(screen.getByText("选择线条"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "插入附图" }));
  });
  await waitFor(() => expect(calls.update).toHaveBeenCalled());
  expect(calls.update.mock.lastCall?.[1]).toHaveLength(1);
  expect(calls.update.mock.lastCall?.[5][0].regions[0]).toMatchObject({
    figureId: calls.update.mock.lastCall?.[1][0].figureId,
    cadHandles: ["100"],
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "插入附图" })).toHaveProperty("disabled", true));
});

test.each(["插入说明书附图", "导出 JPG"])("preview snapshot remains usable for %s after deselection", async (action) => {
  await open();
  calls.request.mockResolvedValue('<svg viewBox="0 0 1000 800"></svg>');
  vi.mocked(renderDrawing).mockResolvedValue({ bytes: new Uint8Array([1]), width: 100, height: 80, widthMm: 100 });
  fireEvent.click(screen.getByText("选择线条"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "预览成图" })); });
  const dialog = await screen.findByRole("dialog", { name: "成图预览" });
  expect(screen.getByRole("button", { name: "预览成图" })).toHaveProperty("disabled", true);
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: action })); });
  await waitFor(() => action === "导出 JPG"
    ? expect(window.patentApi.assets.saveImage).toHaveBeenCalledOnce()
    : expect(calls.update).toHaveBeenCalledOnce());
  expect(renderDrawing).toHaveBeenCalledOnce();
});

test("failed CAD preview retains the selection for retry", async () => {
  await open();
  calls.request.mockResolvedValue('<svg viewBox="0 0 1000 800"></svg>');
  vi.mocked(renderDrawing).mockRejectedValue(new Error("测试成图失败"));
  fireEvent.click(screen.getByText("选择线条"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "预览成图" })); });
  expect(screen.getByRole("button", { name: "预览成图" })).toHaveProperty("disabled", false);
  expect(calls.update).not.toHaveBeenCalled();
});

test.each([false, true])("CAD replacement clears selection only after success (cancel=%s)", async (cancel) => {
  await open(false, true);
  calls.request.mockResolvedValue('<svg viewBox="0 0 1000 800"></svg>');
  vi.mocked(renderDrawing).mockResolvedValue({ bytes: new Uint8Array([1]), width: 100, height: 800, widthMm: 25 });
  fireEvent.click(screen.getByText("选择线条"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "替换附图" })); });
  const dialog = await screen.findByRole("dialog", { name: "替换说明书附图" });
  fireEvent.load(await within(dialog).findByRole("img", { name: /现有图/ }));
  fireEvent.load(await within(dialog).findByRole("img", { name: "当前选区成图预览" }));
  const confirm = within(dialog).getByRole("button", { name: "替换图 1" });
  await waitFor(() => expect(confirm).toHaveProperty("disabled", false));
  await act(async () => { fireEvent.click(cancel ? within(dialog).getByRole("button", { name: "取消" }) : confirm); });
  await waitFor(() => expect(screen.getByRole("button", { name: "预览成图" })).toHaveProperty("disabled", !cancel));
  expect(calls.update).toHaveBeenCalledTimes(cancel ? 0 : 1);
  if (!cancel) expect(calls.update.mock.lastCall?.[1][0].widthMm).toBe(25);
  expect(vi.mocked(renderDrawing).mock.lastCall?.[6]).toHaveProperty("fitToPage");
});
test("circling CAD objects selects handles without creating an image crop or rebuilding CAD", async () => {
  const { canvas, ref } = await open();
  circleSelect(canvas);
  await act(async () => {
    expect(await ref.current?.flush()).toBe(true);
  });
  expect(calls.request).not.toHaveBeenCalled();
  expect(calls.prepare).not.toHaveBeenCalled();
  expect(calls.polygon).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "标号" })).toHaveProperty("disabled", false);
  expect(canvas.querySelector("[data-region-outline]")).toBeNull();
});
test("a fast CAD lasso with one move still selects a finite area", async () => {
  const { canvas } = await open();
  fireEvent.click(screen.getByRole("button", { name: "圈选对象" }));
  fireEvent.pointerDown(canvas, { button: 0, clientX: 300, clientY: 300 });
  fireEvent.pointerMove(canvas, { buttons: 1, clientX: 600, clientY: 600 });
  fireEvent.pointerUp(canvas, { button: 0, clientX: 600, clientY: 600 });
  expect(calls.polygon).toHaveBeenCalledOnce();
  expect(calls.polygon.mock.calls[0]?.[0]).toHaveLength(4);
});
test("labels remain interactive during synchronization and a later object selection survives publication", async () => {
  const { canvas, ref, container } = await open();
  const releases: (() => void)[] = [];
  calls.request.mockImplementation(async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return { scene, objects: [], bytes: new Uint8Array([2]) };
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "标号" }));
  });
  click(canvas, 350, 350);
  click(canvas, 400, 300);
  await waitFor(() => expect(calls.request).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "标号" })).toHaveProperty("disabled", false);
  click(canvas, 500, 400);
  click(canvas, 550, 350);
  expect(container.querySelectorAll("[data-annotation]")).toHaveLength(3);
  fireEvent.click(screen.getByText("选择线条"));
  await act(async () => {
    releases.shift()!();
  });
  await waitFor(() => expect(calls.request).toHaveBeenCalledTimes(2));
  expect(calls.request.mock.lastCall?.[1].annotations).toHaveLength(3);
  expect(calls.request.mock.lastCall?.[1].regions).toHaveLength(0);
  await act(async () => {
    releases.shift()!();
    expect(await ref.current?.flush()).toBe(true);
  });
  expect(calls.update.mock.lastCall?.[5][0].annotations).toHaveLength(3);
  expect(container.querySelectorAll("[data-annotation]")).toHaveLength(3);
  expect(calls.polygon).not.toHaveBeenCalled();
});

test("failed background synchronization retains visible labels and prevents closing until retry succeeds", async () => {
  const { canvas, ref, container } = await open();
  calls.request.mockRejectedValue(new Error("测试同步失败"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "标号" }));
  });
  click(canvas, 350, 350);
  click(canvas, 400, 300);
  await screen.findByRole("button", { name: "重试后台保存" });
  await act(async () => {
    expect(await ref.current?.requestClose()).toBe(false);
  });
  expect(container.querySelectorAll("[data-annotation]")).toHaveLength(2);
  expect(calls.prepare).not.toHaveBeenCalled();
  calls.request.mockResolvedValue({ scene, objects: [], bytes: new Uint8Array([2]) });
  await act(async () => {
    expect(await ref.current?.requestClose()).toBe(true);
  });
  expect(calls.update.mock.lastCall?.[5][0].annotations).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "重试后台保存" })).toBeNull();
});

test("toolbar cancel uses the same native cancellation as Escape", async () => {
  const {canvas} = await open();
  calls.cancel.mockClear();
  fireEvent.click(screen.getByRole("button", {name: "取消"}));
  expect(calls.cancel).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(canvas, {key: "Escape"});
  expect(calls.cancel).toHaveBeenCalledTimes(2);
});

test("publishing a detail scale edit retires the temporary scene so later geometry is displayed", async () => {
  const { ref, container, project } = await open(true);
  const original: CadScene = {
    ...scene,
    entityCount: 1,
    entities: [{ handle: "B00", type: "Line", layer: "0" }],
    primitives: [{ handle: "B00", kind: "line", points: [[690, 600], [710, 600]], color: [0, 0, 0], aci7: true, lineweight: 0.25 }],
  };
  const compiled: CadScene = {
    ...original,
    revision: 2,
    primitives: [{ ...original.primitives[0]!, points: [[680, 600], [720, 600]] }],
  };
  let finish!: () => void;
  calls.request.mockImplementation(() => new Promise(resolve => {
    finish = () => resolve({ scene: compiled, objects: project.cad.objects, bytes: new Uint8Array([2]) });
  }));
  act(() => calls.select({ scene: original, handles: ["B00"], checkpointId: project.cad.assetId, objects: project.cad.objects }));
  fireEvent.click(screen.getByRole("button", { name: "放大局部图" }));
  const body = () => container.querySelector('[data-cad-detail-live-body="detail-fixture"]');
  expect(body()?.querySelector("path")?.getAttribute("d")).toBe("M690 600L710 600");
  await waitFor(() => expect(calls.request).toHaveBeenCalledOnce());
  await act(async () => {
    finish();
    expect(await ref.current?.flush()).toBe(true);
  });
  expect(body()?.querySelector("path")?.getAttribute("d")).toBe("M680 600L720 600");
});

test.each(["Escape", "clear selection"])("%s removes a detail highlight while its live ratio preview remains pending", async (cancel) => {
  const { canvas, container, project } = await open(true);
  calls.request.mockImplementation(() => new Promise(() => {}));
  const selection: CadSelection = {
    handles: ["B00"],
    checkpointId: project.cad.assetId,
    objects: project.cad.objects,
    scene: {
      ...scene,
      selection: ["B00"],
      entities: [{ handle: "B00", type: "Line", layer: "0" }],
      primitives: [{ handle: "B00", kind: "line", points: [[690, 600], [710, 600]], color: [0, 0, 0], aci7: true, lineweight: 0.25 }],
    },
  };
  act(() => { calls.select(selection); });
  fireEvent.click(screen.getByRole("button", { name: "放大局部图" }));
  const body = () => container.querySelector('[data-cad-detail-live-body="detail-fixture"]');
  expect(body()?.querySelector('path[stroke="#007aff"]')).not.toBeNull();
  const transform = body()?.getAttribute("transform");
  if (cancel === "Escape") fireEvent.keyDown(canvas, { key: "Escape" });
  else fireEvent.click(screen.getByText("清除选择"));
  expect(body()).not.toBeNull();
  expect(body()?.getAttribute("transform")).toBe(transform);
  expect(body()?.querySelector('path[stroke="#007aff"]')).toBeNull();
  expect(body()?.querySelector('path[stroke="black"]')).not.toBeNull();
  // Re-selecting a live detail restores only the interactive highlight.
  act(() => { calls.select(selection); });
  expect(body()?.querySelector('path[stroke="#007aff"]')).not.toBeNull();
  expect(body()?.getAttribute("transform")).toBe(transform);
});
