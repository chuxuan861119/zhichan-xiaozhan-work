import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import type { PatentApi } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { createPatentSession } from "../patents/patent-reducer";
import { DrawingWorkspace, type DrawingWorkspaceHandle } from "./drawing-workspace";

const calls = vi.hoisted(() => ({ update: vi.fn(), prepare: vi.fn() }));
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
test.each([true, false])(
  "workspace flush commits pending annotation input and reports persistence failure (saved: %s)",
  async (saved) => {
    vi.clearAllMocks();
    calls.prepare.mockResolvedValue(saved);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    window.patentApi = {
      settings: { read: async () => ({ ok: true, value: DEFAULT_APP_SETTINGS }) },
      assets: { readDrawingSource: async () => ({ ok: true, value: new Uint8Array() }) },
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
    const session = createPatentSession({
      patent,
      patentId: patent.patentId,
      sessionId: crypto.randomUUID(),
      revision: 0,
      saveState: "saved",
    });
    const ref = createRef<DrawingWorkspaceHandle>();
    const { container } = render(<DrawingWorkspace ref={ref} session={session} active />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "标号" }).hasAttribute("disabled")).toBe(false),
    );
    const text = container.querySelector("[data-annotation] text");
    if (!text) throw new Error("annotation missing");
    fireEvent.doubleClick(text);
    const input = screen.getByLabelText("直接修改标号");
    fireEvent.change(input, { target: { value: "88" } });
    await act(async () => {
      expect(await ref.current?.flush()).toBe(saved);
    });
    await waitFor(() => expect(calls.prepare).toHaveBeenCalledOnce());
    expect(calls.update.mock.lastCall?.[5][0].annotations[0].text).toBe("88");
  },
);
