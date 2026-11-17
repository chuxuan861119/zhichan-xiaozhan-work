// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppResult } from "../../shared/ipc/result.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import type { RegisterLibraryIpcOptions } from "../library/register-library-ipc.js";
import { registerPatentFolderIpc } from "./register-patent-folder-ipc.js";

const dialogs = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("./owned-native-dialog.js", () => ({ showOwnedSaveDialog: dialogs.save }));

test("folder export validates revisions, cancels, serializes duplicates, and never writes on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "patent-folder-test-"));
  try {
    const patent = createBlankPatent({ patentType: "invention", name: "测试" });
    let handler!: (event: unknown, input?: unknown) => Promise<AppResult<string | null>>;
    const loadForExport = vi.fn(async () => patent);
    const render = vi.fn(async () => Buffer.from("single-file"));
    const requireSession = vi.fn();
    registerPatentFolderIpc(
      (_channel, operation) => {
        handler = operation;
      },
      {
        patents: { loadForExport } as unknown as RegisterLibraryIpcOptions["patents"],
        requireSession,
        render,
      },
    );
    const request = {
      patentId: patent.patentId,
      sessionId: crypto.randomUUID(),
      expectedRevision: 0,
      items: [{ key: "book:claims", format: "docx" }],
      cad: [],
    };
    dialogs.save.mockResolvedValue({ canceled: true });
    expect(await handler({}, request)).toEqual({ ok: true, value: null });
    expect(render).not.toHaveBeenCalled();
    dialogs.save.mockResolvedValue({ canceled: false, filePath: join(root, "one") });
    expect(await handler({}, request)).toEqual({ ok: true, value: join(root, "one.docx") });
    expect(await readFile(join(root, "one.docx"), "utf8")).toBe("single-file");
    expect(requireSession).toHaveBeenCalledWith(request.sessionId, patent.patentId);
    dialogs.save.mockResolvedValue({ canceled: false, filePath: join(root, "failed") });
    render.mockRejectedValueOnce(new Error("render failed"));
    expect((await handler({}, request)).ok).toBe(false);
    expect(await readdir(root)).toEqual(["one.docx"]);
    loadForExport
      .mockResolvedValueOnce(patent)
      .mockRejectedValueOnce(new Error("revision changed"));
    expect((await handler({}, request)).ok).toBe(false);
    expect(await readdir(root)).toEqual(["one.docx"]);
    dialogs.save.mockClear();
    expect(
      (await handler({}, { ...request, items: [...request.items, ...request.items] })).ok,
    ).toBe(false);
    expect(dialogs.save).not.toHaveBeenCalled();
    let resolveDialog!: (value: { canceled: boolean }) => void;
    dialogs.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDialog = resolve;
        }),
    );
    const pending = handler({}, request);
    await vi.waitFor(() => expect(resolveDialog).toBeTypeOf("function"));
    expect(await handler({}, request)).toMatchObject({
      ok: false,
      error: { code: "OPERATION_IN_PROGRESS" },
    });
    resolveDialog({ canceled: true });
    await pending;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
