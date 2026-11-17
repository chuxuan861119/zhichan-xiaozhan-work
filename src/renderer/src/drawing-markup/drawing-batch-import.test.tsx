import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { DrawingImportProgressEvent } from "../../../shared/drawing-markup/import-progress";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import type { PatentApi } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { createPatentSession } from "../patents/patent-reducer";
import { DrawingWorkspace, type DrawingWorkspaceHandle } from "./drawing-workspace";

const calls = vi.hoisted(() => ({ update: vi.fn(), prepare: vi.fn(), import: vi.fn() }));
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
  renderDrawing: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test.each(["success", "failure", "cancel", "cancel-cleanup-failure"])(
  "batch import retains earlier projects and assets and stops after failure (success: %s)",
  async (mode) => {
    const saved = mode === "success";
    vi.clearAllMocks();
    calls.prepare.mockResolvedValue(true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    let progressListener: ((event: DrawingImportProgressEvent) => void) | undefined;
    window.patentApi = {
      settings: { read: async () => ({ ok: true, value: DEFAULT_APP_SETTINGS }) },
      assets: {
        onDrawingImportProgress: (listener: (event: DrawingImportProgressEvent) => void) => {
          progressListener = listener;
          return () => {
            progressListener = undefined;
          };
        },
        readDrawingSource: async () => ({ ok: true, value: new Uint8Array() }),
        importDrawing: calls.import,
        cancelDrawingImport: async () => ({ ok: true }),
        discardImports: async () => {
          if (mode === "cancel-cleanup-failure") throw new Error("临时资源释放失败");
          return { ok: true };
        },
      },
    } as unknown as PatentApi;
    vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 1000, 800),
    );
    const patent = createBlankPatent({ patentType: "invention", name: "保存" });
    const assetId = "00000000-0000-4000-8000-000000000901";
    patent.drawingProjects = [{ ...drawingProjectFixture(assetId), regions: [] }];
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
    const session = createPatentSession({
      patent,
      patentId: patent.patentId,
      sessionId: crypto.randomUUID(),
      revision: 0,
      saveState: "saved",
    });
    const ref = createRef<DrawingWorkspaceHandle>();
    render(<DrawingWorkspace ref={ref} session={session} active />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "标号" }).hasAttribute("disabled")).toBe(false),
    );

    let finishImport: (() => void) | undefined;
    calls.import.mockImplementation(async ({ originalName }: { originalName: string }) => {
      if (mode.startsWith("cancel"))
        await new Promise<void>((resolve) => {
          finishImport = resolve;
        });
      if (!saved && originalName === "second.png")
        return { ok: false, error: { message: "转换失败" } };
      const suffix = originalName === "first.png" ? "902" : "903";
      return {
        ok: true,
        value: {
          assets: [
            {
              descriptor: {
                ...patent.assets[0],
                assetId: `00000000-0000-4000-8000-000000000${suffix}`,
              },
            },
          ],
          sourceKind: "image",
          warnings: [],
        },
      };
    });
    const files = ["first.png", "second.png", "third.png"].slice(0, saved ? 2 : 3).map(
      (name) =>
        ({
          name,
          type: "image/png",
          size: 6,
          arrayBuffer: async () => new TextEncoder().encode("AC1032").buffer,
        }) as File,
    );
    if (mode.startsWith("cancel")) {
      let pending: Promise<void> | undefined;
      await act(async () => {
        pending = ref.current?.importFiles(files);
      });
      await waitFor(() => expect(finishImport).toBeDefined());
      // 导入挂起期间盖着等待窗口，取消（导入结束）后必须自行消失。
      const overlay = document.querySelector<HTMLElement>("[data-drawing-import-progress]");
      expect(overlay?.textContent).toContain("正在导入图纸");
      expect(overlay?.textContent).toContain("first.png");
      const operationId = calls.import.mock.calls.at(-1)![0].operationId;
      const event: DrawingImportProgressEvent = {
        sessionId: session.sessionId,
        operationId,
        stage: { phase: "draw", completed: 500, total: 1000 },
        elapsedMs: 80000,
        overallPercent: 60,
        estimatedRemainingMs: [40000, 70000],
        takingLonger: false,
      };
      act(() =>
        progressListener?.({ ...event, operationId: crypto.randomUUID(), overallPercent: 90 }),
      );
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
      act(() => progressListener?.(event));
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("60");
      fireEvent.click(screen.getByRole("button", { name: "取消导入" }));
      act(() => progressListener?.({ ...event, overallPercent: 90 }));
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("60");
      await act(async () => {
        finishImport?.();
        await pending;
      });
      await waitFor(() =>
        expect(document.querySelector("[data-drawing-import-progress]")).toBeNull(),
      );
      expect(calls.import).toHaveBeenCalledOnce();
      expect(calls.update).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "标号" }).hasAttribute("disabled")).toBe(false);
      if (mode === "cancel-cleanup-failure")
        expect(screen.getByText("临时资源释放失败")).toBeDefined();
      return;
    }
    await act(async () => {
      await ref.current?.importFiles(files);
    });
    expect(calls.import).toHaveBeenCalledTimes(2);
    const finalEdit = calls.update.mock.lastCall;
    expect(finalEdit?.[5]).toHaveLength(saved ? 3 : 2);
    expect(finalEdit?.[3]).toHaveLength(saved ? 3 : 2);
    expect(finalEdit?.[5][0]).toEqual(patent.drawingProjects[0]);
    if (!saved) expect((await screen.findByRole("alert")).textContent).toContain("转换失败");
  },
);
