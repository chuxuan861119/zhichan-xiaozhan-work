import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import type { PatentApi } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { ShortcutProvider } from "../app/shortcut-dispatcher";
import { createPatentSession } from "../patents/patent-reducer";
import { DrawingWorkspace } from "./drawing-workspace";

const calls = vi.hoisted(() => ({
  update: vi.fn(),
  prepare: vi.fn(),
  image: vi.fn(),
  render: vi.fn(),
}));
vi.mock("../patents/patent-context", () => ({
  usePatents: () => ({
    updatePatentFigures: calls.update,
    preparePatentSnapshot: calls.prepare,
  }),
}));
vi.mock("../app/application-close-coordinator", () => ({
  useApplicationCloseParticipant: () => {},
}));
vi.mock("./render", () => ({
  imageUrl: () => "data:image/png;base64,",
  pdfPreview: vi.fn(),
  renderDrawing: calls.render,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test.each([
  "button",
  "shortcut",
  "preview",
  "double-click",
  "save-failure",
  "render-failure",
  "page-changed",
  "auto-button",
  "auto-shortcut",
  "auto-preview",
  "auto-export",
  "auto-export-cleanup-failure",
  "auto-export-cleanup-result-failure",
  "auto-toggle",
  "auto-toggle-failure",
  "replace",
  "replace-cancel",
  "replace-save-failure",
  "replace-import-failure",
  "replace-target-changed",
])("inserts selected drawing as JPEG with success feedback (%s)", async (mode) => {
  vi.clearAllMocks();
  calls.prepare.mockResolvedValue(mode !== "save-failure" && mode !== "replace-save-failure");
  calls.render.mockImplementation(async () => {
    if (mode === "render-failure") throw new Error("成图失败");
    return { bytes: new Uint8Array([1, 2, 3]), width: 100, height: 100, widthMm: 110 };
  });
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
  SVGSVGElement.prototype.getScreenCTM = vi.fn(() => ({ inverse: () => ({}) })) as never;
  SVGSVGElement.prototype.setPointerCapture = vi.fn();
  SVGSVGElement.prototype.releasePointerCapture = vi.fn();
  SVGSVGElement.prototype.hasPointerCapture = vi.fn(() => false);
  URL.createObjectURL = vi.fn(() => "blob:original");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const autoEnabled = mode.startsWith("auto-") && !mode.startsWith("auto-toggle");
  const updateSettings = vi.fn(async () =>
    mode === "auto-toggle-failure"
      ? { ok: false, error: { message: "设置保存失败" } }
      : { ok: true, value: { ...DEFAULT_APP_SETTINGS, drawingAutoAdjustLabelSize: true } },
  );
  window.patentApi = {
    settings: {
      read: async () => ({
        ok: true,
        value: { ...DEFAULT_APP_SETTINGS, drawingAutoAdjustLabelSize: autoEnabled },
      }),
      update: updateSettings,
    },
    assets: {
      getPreview: vi.fn(async () => ({ ok: true, value: new Uint8Array([1]) })),
      readDrawingSource: async () => ({ ok: true, value: new Uint8Array() }),
      importMany: calls.image,
      saveImage: vi.fn(async () => ({ ok: true, value: true })),
      discardImports: vi.fn(async () => {
        if (mode === "auto-export-cleanup-failure") throw new Error("临时资源释放失败");
        if (mode === "auto-export-cleanup-result-failure")
          return { ok: false, error: { code: "IO_ERROR", message: "临时资源释放失败" } };
        return { ok: true, value: undefined };
      }),
    },
  } as unknown as PatentApi;
  vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 800),
  );
  const patent = createBlankPatent({ patentType: "invention", name: "保存" });
  const assetId = "00000000-0000-4000-8000-000000000901";
  patent.drawingProjects = [drawingProjectFixture(assetId)];
  patent.assets = [
    {
      assetId,
      kind: "image",
      mediaType: "image/png",
      extension: "png",
      originalName: "drawing.png",
      byteLength: 1,
      sha256: "a".repeat(64),
      widthPx: 1000,
      heightPx: 800,
      previewByteLength: 1,
      previewSha256: "a".repeat(64),
    },
  ];
  if (mode.startsWith("replace")) {
    patent.figures = [
      { figureId: "00000000-0000-4000-8000-000000000903", assetId, widthMm: 80 },
      { figureId: "00000000-0000-4000-8000-000000000904", assetId, widthMm: 90, rotationDeg: 90 },
    ];
    patent.abstractDrawingFigureId = patent.figures[1]?.figureId ?? null;
  }
  const session = createPatentSession({
    patent,
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    saveState: "saved",
  });
  calls.image.mockResolvedValue({
    ok: true,
    value: [
      {
        descriptor: {
          ...patent.assets[0],
          assetId: "00000000-0000-4000-8000-000000000902",
          extension: "jpg",
          mediaType: "image/jpeg",
        },
      },
    ],
  });
  if (mode === "page-changed") {
    const imported = calls.image.getMockImplementation()!;
    calls.image.mockImplementationOnce(async (input) => {
      const book = session.patent.books.find((book) => book.kind === "description-drawings")!;
      book.document.page = { ...book.document.page, marginLeftMm: 50 };
      return imported(input);
    });
  }
  const settings = { ...DEFAULT_APP_SETTINGS.shortcuts, "insert-marked-drawing": "F8" };
  render(
    <ShortcutProvider settings={settings}>
      <DrawingWorkspace session={session} active />
    </ShortcutProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "标号" }).hasAttribute("disabled")).toBe(false),
  );
  const insert = screen.getByRole("button", { name: "插入附图" });
  expect(insert.hasAttribute("disabled")).toBe(true);
  const canvas = screen.getByLabelText("CAD标号画布");
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerMove(canvas, { clientX: 600, clientY: 600, buttons: 1 });
  fireEvent.pointerUp(canvas, { clientX: 600, clientY: 600, button: 0 });
  expect(insert.hasAttribute("disabled")).toBe(false);
  if (mode.startsWith("replace")) {
    const replace = screen.getByRole("button", { name: "替换附图" });
    expect(replace.compareDocumentPosition(insert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(replace);
    screen.getByRole("dialog", { name: "替换说明书附图" });
    fireEvent.change(screen.getByRole("combobox", { name: "选择要替换的附图" }), {
      target: { value: patent.figures[1]?.figureId },
    });
    fireEvent.load(await screen.findByRole("img", { name: "现有图 2" }));
    fireEvent.load(await screen.findByRole("img", { name: "当前选区成图预览" }));
    const confirm = screen.getByRole("button", { name: "替换图 2" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    const before = structuredClone(patent.figures);
    if (mode === "replace-cancel") {
      fireEvent.click(
        within(screen.getByRole("dialog", { name: "替换说明书附图" })).getByRole("button", {
          name: "取消",
        }),
      );
      expect(patent.figures).toEqual(before);
      expect(calls.image).not.toHaveBeenCalled();
      expect(calls.prepare).not.toHaveBeenCalled();
      return;
    }
    if (mode === "replace-import-failure")
      calls.image.mockResolvedValue({ ok: false, error: { message: "导入失败" } });
    if (mode === "replace-target-changed")
      calls.image.mockImplementationOnce(async () => {
        // Another editor changes the target while the staged import is pending.
        const previousFigure = before[1];
        if (!previousFigure) throw new Error("Missing replacement target");
        session.patent.figures[1] = { ...previousFigure, widthMm: 110 };
        return {
          ok: true,
          value: [
            {
              descriptor: { ...patent.assets[0], assetId: "00000000-0000-4000-8000-000000000902" },
            },
          ],
        };
      });
    const updateCount = calls.update.mock.calls.length;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    if (mode === "replace-import-failure" || mode === "replace-target-changed") {
      await screen.findAllByText(
        mode === "replace-import-failure" ? "导入失败" : "目标附图已发生变化，请重新选择。",
      );
      expect(calls.prepare).not.toHaveBeenCalled();
      expect(calls.update).toHaveBeenCalledTimes(updateCount);
      if (mode === "replace-target-changed")
        await waitFor(() => expect(window.patentApi.assets.discardImports).toHaveBeenCalledOnce());
    } else {
      await waitFor(() => expect(calls.prepare).toHaveBeenCalledOnce());
      const updated = calls.update.mock.lastCall;
      expect(updated?.[1]).toEqual([
        before[0],
        { ...before[1], assetId: "00000000-0000-4000-8000-000000000902", rotationDeg: 0 },
      ]);
      expect(updated?.[2]).toBe(before[1]?.figureId);
      expect(updated?.[3]).toHaveLength(2);
      expect(updated?.[4]).toEqual({
        ownerBookKind: "description-drawings",
        label: "替换图纸附图",
      });
      expect(updated?.[7]).toBe(true);
      expect(screen.queryByRole("dialog", { name: "替换说明书附图" })).toBeNull();
      if (mode === "replace-save-failure") {
        await screen.findByText("附图已替换到待保存内容，但保存失败，请重试保存。");
        expect(screen.queryByText(/^已替换附图/)).toBeNull();
      } else await screen.findByText("已替换附图（图2）");
    }
    expect(calls.render.mock.lastCall?.[4]).toBe(mode === "replace-target-changed" ? 110 : 90);
    expect(calls.image).toHaveBeenCalledOnce();
    return;
  }
  if (mode.startsWith("auto-toggle")) {
    fireEvent.click(screen.getByRole("button", { name: "导出设置" }));
    const toggle = screen.getByRole("switch", { name: "自动调整标号大小" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByText("自动调整标号大小"));
    expect(updateSettings).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ drawingAutoAdjustLabelSize: true }),
    );
    if (mode === "auto-toggle-failure") {
      await screen.findAllByText("设置保存失败");
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    } else {
      await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
      const slider = screen.getByRole("slider", { name: "自动标号大小比例" });
      fireEvent.change(slider, { target: { value: "150" } });
      expect(screen.getByText("150%")).toBeTruthy();
      fireEvent.pointerUp(slider);
      await waitFor(() =>
        expect(updateSettings).toHaveBeenCalledWith({ drawingAutoLabelScale: 1.5 }),
      );
    }
    fireEvent.keyDown(toggle, { key: "Escape" });
  }
  if (mode.endsWith("shortcut")) fireEvent.keyDown(canvas, { key: "F8", code: "F8" });
  else if (mode.endsWith("preview") || mode.startsWith("auto-export")) {
    fireEvent.click(screen.getByRole("button", { name: "预览成图" }));
    const preview = await screen.findByRole("dialog", { name: "成图预览" });
    // 双屏时 CAD 面板被绝对定位成 z-index:1 的窗格，遮罩必须挂到 body 才能盖住另一侧功能栏。
    expect(preview.parentElement?.parentElement).toBe(document.body);
    const image = within(preview).getByRole("img", { name: "取图导出预览" }) as HTMLImageElement;
    expect(image.style.width).toBe("110mm");
    const viewport = within(preview).getByTestId("flowchart-image-preview-viewport");
    Object.defineProperties(image, { naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
    Object.defineProperties(viewport, { clientWidth: { value: 240 }, clientHeight: { value: 144 } });
    fireEvent.load(image);
    expect(within(preview).getByLabelText("预览缩放比例").textContent).toBe("23.1%");
    fireEvent.click(within(preview).getByRole("button", { name: "重置预览" }));
    expect(within(preview).getByLabelText("预览缩放比例").textContent).not.toBe("100%");
    expect(image.style.width).toBe("110mm");
    fireEvent.click(within(preview).getByRole("button", { name: "实际尺寸（100%）" }));
    expect(within(preview).getByLabelText("预览缩放比例").textContent).toBe("100%");
    fireEvent.click(
      screen.getByRole("button", {
        name: mode.startsWith("auto-export") ? "导出 JPG" : "插入说明书附图",
      }),
    );
  } else {
    insert.focus();
    fireEvent.click(insert);
    if (mode === "double-click") fireEvent.click(insert);
  }
  if (mode.startsWith("auto-export")) {
    await waitFor(() => expect(window.patentApi.assets.saveImage).toHaveBeenCalledOnce());
    expect(calls.prepare).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "导出 JPG" }).hasAttribute("disabled")).toBe(false),
    );
    if (mode.includes("cleanup")) await screen.findAllByText("临时资源释放失败");
  } else if (mode === "render-failure" || mode === "page-changed") {
    await screen.findByText(
      mode === "render-failure" ? "成图失败" : "附图页面设置已变化，请重新预览或插入。",
    );
    expect(calls.prepare).not.toHaveBeenCalled();
    if (mode === "render-failure") expect(calls.image).not.toHaveBeenCalled();
    else await waitFor(() => expect(window.patentApi.assets.discardImports).toHaveBeenCalledOnce());
    expect(document.activeElement).toBe(canvas);
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(canvas.querySelector("[data-region-outline]")).toBeNull();
  } else {
    await waitFor(() => expect(calls.prepare).toHaveBeenCalledOnce());
    expect(calls.image.mock.lastCall?.[0].images[0]).toMatchObject({
      originalName: "图纸.jpg",
      declaredMediaType: "image/jpeg",
    });
    expect(calls.update.mock.lastCall?.[1]).toHaveLength(1);
    expect(calls.update.mock.lastCall?.[1][0].widthMm).toBe(110);
    expect(calls.update.mock.lastCall?.[8]).toEqual([calls.update.mock.lastCall?.[1][0].figureId]);
  }
  if (mode === "save-failure" || mode === "render-failure" || mode === "page-changed")
    expect(screen.queryByText(/^已插入附图/)).toBeNull();
  else if (!mode.startsWith("auto-export"))
    expect((await screen.findByText(/^已插入附图/)).closest("[role=status]")).not.toBeNull();
  if (!mode.startsWith("auto-export"))
    expect(screen.queryByRole("dialog", { name: "成图预览" })).toBeNull();
  expect(calls.render).toHaveBeenCalledOnce();
  expect(calls.render.mock.lastCall?.[6]).toMatchObject({
    autoAdjustLabelSize: autoEnabled || mode === "auto-toggle",
    autoLabelScale: mode === "auto-toggle" ? 1.5 : 1,
    fitToPage: patent.books.find((book) => book.kind === "description-drawings")!.document.page,
  });
});
