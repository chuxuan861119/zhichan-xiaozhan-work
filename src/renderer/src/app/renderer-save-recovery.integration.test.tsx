import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PatentBookDocument } from "../../../shared/document/model";
import type { PatentApi, PatentApplyBookEditRequest } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { PatentProvider, usePatents } from "../patents/patent-context";
import { AppErrorBoundary } from "./app-error-boundary";
import { ApplicationCloseProvider } from "./application-close-coordinator";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function edit(document: PatentBookDocument, text: string): PatentBookDocument {
  const first = document.content.find((block) => block.type === "paragraph");
  if (!first) throw Error("fixture paragraph missing");
  return { ...document, content: [{ ...first, content: [{ type: "text", text, marks: [] }] }] };
}

for (const crash of [false, true]) {
  test(`pending latest edit reaches persistence after slow save; React boundary failure=${crash}`, async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const patent = createBlankPatent({ patentType: "invention", name: "防丢诊断夹具" });
    const opened = {
      patentId: patent.patentId,
      sessionId: "00000000-0000-4000-8000-000000000201",
      revision: patent.revision,
      patent,
      saveState: "saved",
    };
    let release!: () => void;
    const slowSave = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accepted: string[] = [];
    const applyBookEdit = vi.fn(async (request: PatentApplyBookEditRequest) => {
      if (accepted.length === 0) await slowSave;
      accepted.push(JSON.stringify(request.document));
      return {
        ok: true as const,
        value: {
          patentId: patent.patentId,
          revision: request.expectedRevision + 1,
          savedAt: new Date().toISOString(),
        },
      };
    });
    window.patentApi = {
      patents: {
        create: async () => ({ ok: true, value: opened }),
        applyBookEdit,
        flush: async () => ({
          ok: true,
          value: {
            patentId: patent.patentId,
            revision: accepted.length,
            flushedAt: new Date().toISOString(),
          },
        }),
        release: async () => ({ ok: true, value: undefined }),
      },
      application: { reportRendererFailure: async () => ({ ok: true, value: undefined }) },
    } as unknown as PatentApi;
    let controller!: ReturnType<typeof usePatents>;
    function Probe({ fail }: { fail: boolean }) {
      controller = usePatents();
      if (fail) throw Error("Injected rendering failure while save is pending");
      return <div>{JSON.stringify(controller.activeSession?.patent.books)}</div>;
    }
    const tree = (fail: boolean) => (
      <AppErrorBoundary>
        <ApplicationCloseProvider>
          <PatentProvider>
            <Probe fail={fail} />
          </PatentProvider>
        </ApplicationCloseProvider>
      </AppErrorBoundary>
    );
    const mounted = render(tree(false));
    await act(async () => {
      await controller.newPatent({ name: patent.name, patentType: "invention" });
    });
    const document = patent.books.find((book) => book.kind === "description")?.document;
    if (!document) throw new Error("Missing description fixture");
    await act(async () => {
      controller.updateBookDocument(patent.patentId, "description", edit(document, "第一版"), {});
      controller.updateBookDocument(
        patent.patentId,
        "description",
        edit(document, "第一版加第二次修改"),
        {},
      );
    });
    expect(applyBookEdit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(controller.activeSession?.patent.books)).toContain("第一版加第二次修改");
    if (crash) {
      mounted.rerender(tree(true));
      expect(screen.getByRole("heading", { name: "编辑界面发生错误" })).toBeTruthy();
    }
    await act(async () => release());
    await waitFor(() => expect(accepted.at(-1)).toContain("第一版加第二次修改"));
    expect(applyBookEdit).toHaveBeenCalledTimes(2);
  });
}
