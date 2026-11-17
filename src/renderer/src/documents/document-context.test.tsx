import { act, fireEvent, render as renderBase, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactElement, useState } from "react";
import { createBlankDocument } from "../../../shared/document/defaults";
import type { OpenedLibraryDocument, PatentApi, SavedDocument } from "../../../shared/ipc/contract";
import type { AppResult } from "../../../shared/ipc/result";
import type { LibraryEditAck } from "../../../shared/library/model";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { ApplicationCloseProvider } from "../app/application-close-coordinator";
import { DocumentProvider, useDocuments } from "./document-context";

function render(ui: ReactElement) {
  return renderBase(<ApplicationCloseProvider>{ui}</ApplicationCloseProvider>);
}

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function openedLibraryDocument(index: number, title = `文档 ${index}`): OpenedLibraryDocument {
  const document = createBlankDocument(title);
  document.documentId = testUuid(900 + index);
  return {
    libraryDocumentId: testUuid(100 + index),
    sessionId: testUuid(200 + index),
    revision: 0,
    document,
    editorState: {},
    saveState: "saved",
  };
}

function Harness() {
  const documents = useDocuments();
  const activeSession = documents.activeSession;
  const [savedPath, setSavedPath] = useState("未导出");
  return (
    <div>
      <span data-testid="active-title">{activeSession?.model.title ?? "无活动文档"}</span>
      <span data-testid="session-count">{documents.state.sessions.length}</span>
      <span data-testid="save-state">{activeSession?.saveState ?? "none"}</span>
      <span data-testid="local-revision">{activeSession?.localRevision ?? -1}</span>
      <span data-testid="persisted-revision">{activeSession?.persistedRevision ?? -1}</span>
      <span data-testid="welcome-completed">{String(documents.settings.welcomeCompleted)}</span>
      <span data-testid="active-margin-top">{activeSession?.model.page.marginTopMm ?? "none"}</span>
      <span data-testid="active-margin-left">
        {activeSession?.model.page.marginLeftMm ?? "none"}
      </span>
      <span data-testid="settings-margin-top">
        {documents.settings.pageMargins?.marginTopMm ?? "none"}
      </span>
      <span data-testid="saved-path">{savedPath}</span>
      <button type="button" onClick={() => documents.newDocument()}>
        新建
      </button>
      <button
        type="button"
        onClick={() =>
          documents.applyPageMargins({
            marginTopMm: 30,
            marginRightMm: 20,
            marginBottomMm: 30,
            marginLeftMm: 20,
          })
        }
      >
        应用边距
      </button>
      <button type="button" onClick={() => void documents.openDocument()}>
        打开
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) return;
          documents.updateDocumentModel(activeSession.sessionId, {
            ...activeSession.model,
            title: `已修改 ${activeSession.localRevision + 1}`,
          });
        }}
      >
        修改
      </button>
      <button type="button" onClick={() => void documents.saveActiveDocument()}>
        保存
      </button>
      <button
        type="button"
        onClick={() =>
          void documents
            .saveActiveDocumentAs()
            .then((saved) => setSavedPath(saved?.path ?? "未导出"))
        }
      >
        另存为
      </button>
      <button
        type="button"
        onClick={() => void documents.updateAppSettings({ welcomeCompleted: true })}
      >
        更新设置
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) return;
          void (
            documents as unknown as {
              renameOpenDocument(libraryDocumentId: string, title: string): Promise<boolean | null>;
            }
          ).renameOpenDocument(activeSession.libraryDocumentId, "重命名后");
        }}
      >
        重命名打开文档
      </button>
      <button
        type="button"
        onClick={() => {
          if (activeSession) documents.requestClose(activeSession.sessionId);
        }}
      >
        关闭
      </button>
    </div>
  );
}

function documentApi(
  overrides: {
    documents?: Partial<PatentApi["documents"]>;
    library?: Partial<PatentApi["library"]>;
    settings?: Partial<PatentApi["settings"]>;
    drafts?: Partial<PatentApi["drafts"]>;
    application?: Partial<PatentApi["application"]> & {
      onPrepareClose?(listener: (token: string) => void): () => void;
      closeResult?(request: { token: string; proceed: boolean }): Promise<AppResult<void>>;
      forceClose?(): Promise<AppResult<void>>;
    };
  } = {},
): PatentApi {
  const created = openedLibraryDocument(1, "文档 1");
  return {
    documents: {
      activate: vi.fn(async () => ({ ok: true, value: undefined })),
      openDialog: vi.fn(async () => ({ ok: true, value: null })),
      openPath: vi.fn(async () => ({
        ok: false,
        error: { code: "INTERNAL", message: "未设置" },
      })),
      save: vi.fn(async () => ({ ok: false, error: { code: "INTERNAL", message: "未设置" } })),
      saveAs: vi.fn(async () => ({ ok: true, value: null })),
      release: vi.fn(async () => ({ ok: true, value: undefined })),
      ...overrides.documents,
    },
    library: {
      list: vi.fn(async () => ({ ok: true, value: [] })),
      create: vi.fn(async () => ({ ok: true, value: created })),
      open: vi.fn(async () => ({ ok: true, value: created })),
      rename: vi.fn(),
      applyEdit: vi.fn(async (batch) => ({
        ok: true,
        value: {
          libraryDocumentId: batch.libraryDocumentId,
          operationId: batch.operationId,
          revision: batch.targetRevision,
          savedAt: "2026-08-01T08:00:00.000Z",
        },
      })),
      flush: vi.fn(async (request) => ({
        ok: true,
        value: {
          libraryDocumentId: request.libraryDocumentId,
          revision: request.expectedRevision,
          flushedAt: "2026-08-01T08:00:01.000Z",
        },
      })),
      moveToTrash: vi.fn(async () => ({ ok: true, value: undefined })),
      restore: vi.fn(async () => ({ ok: true, value: undefined })),
      permanentlyDelete: vi.fn(async () => ({ ok: true, value: undefined })),
      purgeExpired: vi.fn(async () => ({ ok: true, value: { purgedDocumentIds: [] } })),
      importPatdoc: vi.fn(async () => ({ ok: true, value: null })),
      exportPatdoc: vi.fn(async () => ({ ok: true, value: null })),
      emergencyExportPatdoc: vi.fn(async () => ({ ok: true, value: null })),
      listLegacyDrafts: vi.fn(async () => ({ ok: true, value: [] })),
      release: vi.fn(async () => ({ ok: true, value: undefined })),
      ...overrides.library,
    },
    settings: {
      read: vi.fn(async () => ({
        ok: true,
        value: { ...DEFAULT_APP_SETTINGS, welcomeCompleted: false },
      })),
      update: vi.fn(),
      ...overrides.settings,
    },
    drafts: {
      list: vi.fn(async () => ({ ok: true, value: [] })),
      save: vi.fn(async () => ({
        ok: true,
        value: {
          draftId: "legacy-draft",
          documentId: "legacy-document",
          displayName: "旧草稿",
          originalPath: null,
          savedAt: "2026-08-01T00:00:00.000Z",
        },
      })),
      open: vi.fn(),
      delete: vi.fn(async () => ({ ok: true, value: undefined })),
      ...overrides.drafts,
    },
    assets: {
      chooseAndImport: vi.fn(),
      chooseAndImportMany: vi.fn(),
      importBytes: vi.fn(),
      getPreview: vi.fn(),
    },
    exports: {
      docx: vi.fn(),
      pdf: vi.fn(),
      preview: vi.fn(),
      savePreviewPdf: vi.fn(),
      discardPreview: vi.fn(),
      print: vi.fn(),
    },
    application: {
      createDesktopShortcut: vi.fn(),
      onOpenPath: vi.fn(() => vi.fn()),
      onPrepareClose: vi.fn(() => vi.fn()),
      closeResult: vi.fn(async () => ({ ok: true as const, value: undefined })),
      forceClose: vi.fn(async () => ({ ok: true as const, value: undefined })),
      ...overrides.application,
    },
    menu: {
      onCommand: vi.fn(() => vi.fn()),
    },
  } as unknown as PatentApi;
}

describe("document persistence context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("updates app settings through one reusable context method and retains state on failure", async () => {
    const user = userEvent.setup();
    const update = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: { ...DEFAULT_APP_SETTINGS, welcomeCompleted: true },
      })
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "INTERNAL", message: "无法保存设置" },
      });
    window.patentApi = documentApi({ settings: { update } });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("welcome-completed").textContent).toBe("false"));

    await user.click(screen.getByRole("button", { name: "更新设置" }));
    await waitFor(() => expect(screen.getByTestId("welcome-completed").textContent).toBe("true"));
    expect(update).toHaveBeenCalledWith({ welcomeCompleted: true });

    await user.click(screen.getByRole("button", { name: "更新设置" }));
    expect(screen.getByTestId("welcome-completed").textContent).toBe("true");
  });

  test("returns null when an app settings update fails", async () => {
    const user = userEvent.setup();
    const update = vi.fn(async () => ({
      ok: false as const,
      error: { code: "INTERNAL" as const, message: "无法保存设置" },
    }));
    let result: unknown;
    function UpdateResultHarness() {
      const documents = useDocuments();
      return (
        <button
          type="button"
          onClick={async () => {
            result = await documents.updateAppSettings({ welcomeCompleted: true });
          }}
        >
          保存失败设置
        </button>
      );
    }
    window.patentApi = documentApi({ settings: { update } });

    render(
      <DocumentProvider>
        <UpdateResultHarness />
      </DocumentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "保存失败设置" }));

    await waitFor(() => expect(result).toBeNull());
  });

  test("starts with no opened session and does not create an internal draft on mount", () => {
    const create = vi.fn(async () => ({
      ok: true as const,
      value: openedLibraryDocument(1, "库草稿"),
    }));
    window.patentApi = documentApi({ library: { create } });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );

    expect(screen.getByTestId("active-title").textContent).toBe("无活动文档");
    expect(screen.getByTestId("session-count").textContent).toBe("0");
    expect(create).not.toHaveBeenCalled();
    expect(window.patentApi.documents.activate).not.toHaveBeenCalled();
  });

  test("creates an internal document only when the user starts a new document", async () => {
    const user = userEvent.setup();
    const create = vi.fn(async () => ({
      ok: true as const,
      value: openedLibraryDocument(1, "新文档"),
    }));
    window.patentApi = documentApi({ library: { create } });
    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建" }));

    expect(screen.getByTestId("active-title").textContent).toBe("新文档");
    expect(screen.getByTestId("session-count").textContent).toBe("1");
    expect(create).toHaveBeenCalledOnce();
  });

  test("queues every edit immediately through the internal library without legacy draft timers", async () => {
    const applyEdit = vi.fn(
      async (batch): Promise<AppResult<LibraryEditAck>> => ({
        ok: true,
        value: {
          libraryDocumentId: batch.libraryDocumentId,
          operationId: batch.operationId,
          revision: batch.targetRevision,
          savedAt: "2026-08-01T08:00:00.000Z",
        },
      }),
    );
    const draftsSave = vi.fn();
    window.patentApi = documentApi({
      library: { applyEdit },
      drafts: { save: draftsSave },
    });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    await waitFor(() => expect(screen.getByTestId("active-title").textContent).toBe("文档 1"));
    fireEvent.click(screen.getByRole("button", { name: "修改" }));

    await waitFor(() => expect(applyEdit).toHaveBeenCalledOnce());
    expect(applyEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRevision: 0,
        targetRevision: 1,
        operations: [{ type: "set-title", title: "已修改 1" }],
      }),
    );
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    expect(screen.getByTestId("persisted-revision").textContent).toBe("1");
    expect(draftsSave).not.toHaveBeenCalled();
  });

  test("retries the same failed edit when the user presses Save and then flushes that revision", async () => {
    const user = userEvent.setup();
    const applyEdit = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "DISK_FULL", message: "磁盘空间不足" },
      })
      .mockImplementation(
        async (batch): Promise<AppResult<LibraryEditAck>> => ({
          ok: true,
          value: {
            libraryDocumentId: batch.libraryDocumentId,
            operationId: batch.operationId,
            revision: batch.targetRevision,
            savedAt: "2026-08-01T08:00:00.000Z",
          },
        }),
      );
    const flush = vi.fn(
      async (request): Promise<Awaited<ReturnType<PatentApi["library"]["flush"]>>> => ({
        ok: true,
        value: {
          libraryDocumentId: request.libraryDocumentId,
          revision: request.expectedRevision,
          flushedAt: "2026-08-01T08:00:01.000Z",
        },
      }),
    );
    window.patentApi = documentApi({ library: { applyEdit, flush } });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(await screen.findByRole("button", { name: "修改" }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("failed"));

    const failedOperationId = applyEdit.mock.calls[0]?.[0].operationId;
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    expect(applyEdit).toHaveBeenCalledTimes(2);
    expect(applyEdit.mock.calls[1]?.[0].operationId).toBe(failedOperationId);
    expect(flush).toHaveBeenCalledWith({
      libraryDocumentId: testUuid(101),
      expectedRevision: 1,
    });
  });

  test("close waits for the queued save and releases the internal library session", async () => {
    const user = userEvent.setup();
    const first = openedLibraryDocument(1, "第一篇");
    const second = openedLibraryDocument(2, "第二篇");
    let finishSave: (() => void) | undefined;
    const applyEdit = vi.fn(
      (batch) =>
        new Promise<AppResult<LibraryEditAck>>((resolve) => {
          finishSave = () =>
            resolve({
              ok: true,
              value: {
                libraryDocumentId: batch.libraryDocumentId,
                operationId: batch.operationId,
                revision: batch.targetRevision,
                savedAt: "2026-08-01T08:00:00.000Z",
              },
            });
        }),
    );
    const create = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, value: first })
      .mockResolvedValueOnce({ ok: true as const, value: second });
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    window.patentApi = documentApi({ library: { create, applyEdit, release } });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("button", { name: "新建" }));
    expect(screen.getByTestId("active-title").textContent).toBe("第二篇");
    await user.click(screen.getByRole("button", { name: "修改" }));
    await user.click(screen.getByRole("button", { name: "关闭" }));

    expect(screen.getByTestId("session-count").textContent).toBe("2");
    expect(release).not.toHaveBeenCalled();
    await act(async () => finishSave?.());

    await waitFor(() => expect(screen.getByTestId("session-count").textContent).toBe("1"));
    expect(release).toHaveBeenCalledWith(second.sessionId);
  });

  test("keeps the last tab open until its library lease is released", async () => {
    const user = userEvent.setup();
    let finishRelease: (() => void) | undefined;
    const release = vi.fn(
      () =>
        new Promise<AppResult<void>>((resolve) => {
          finishRelease = () => resolve({ ok: true, value: undefined });
        }),
    );
    window.patentApi = documentApi({ library: { release } });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("button", { name: "关闭" }));

    expect(screen.getByTestId("session-count").textContent).toBe("1");
    await act(async () => finishRelease?.());
    await waitFor(() => expect(screen.getByTestId("session-count").textContent).toBe("0"));
  });

  test("keeps a tab open when releasing its library lease fails", async () => {
    const user = userEvent.setup();
    const release = vi.fn(async () => ({
      ok: false as const,
      error: { code: "FILE_LOCKED" as const, message: "release failed" },
    }));
    window.patentApi = documentApi({ library: { release } });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("button", { name: "关闭" }));

    await waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(screen.getByTestId("session-count").textContent).toBe("1");
  });

  test("keeps a failed queue open when closing would lose unsaved draft content", async () => {
    const user = userEvent.setup();
    const create = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, value: openedLibraryDocument(1, "第一篇") })
      .mockResolvedValueOnce({ ok: true as const, value: openedLibraryDocument(2, "第二篇") });
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    window.patentApi = documentApi({
      library: {
        create,
        release,
        applyEdit: vi.fn(async () => ({
          ok: false as const,
          error: { code: "DISK_FULL" as const, message: "磁盘空间不足" },
        })),
      },
    });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("button", { name: "修改" }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("failed"));
    await user.click(screen.getByRole("button", { name: "关闭" }));

    expect(screen.getByTestId("session-count").textContent).toBe("2");
    expect(release).not.toHaveBeenCalled();
  });

  test("renames an open document through its ordered save queue", async () => {
    const user = userEvent.setup();
    const applyEdit = vi.fn(
      async (batch): Promise<AppResult<LibraryEditAck>> => ({
        ok: true,
        value: {
          libraryDocumentId: batch.libraryDocumentId,
          operationId: batch.operationId,
          revision: batch.targetRevision,
          savedAt: "2026-08-01T08:00:00.000Z",
        },
      }),
    );
    const flush = vi.fn(
      async (request): Promise<Awaited<ReturnType<PatentApi["library"]["flush"]>>> => ({
        ok: true,
        value: {
          libraryDocumentId: request.libraryDocumentId,
          revision: request.expectedRevision,
          flushedAt: "2026-08-01T08:00:01.000Z",
        },
      }),
    );
    window.patentApi = documentApi({ library: { applyEdit, flush } });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("button", { name: "重命名打开文档" }));

    await waitFor(() =>
      expect(applyEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          baseRevision: 0,
          targetRevision: 1,
          operations: [{ type: "set-title", title: "重命名后" }],
        }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("active-title").textContent).toBe("重命名后"));
    expect(flush).toHaveBeenCalledWith({
      libraryDocumentId: testUuid(101),
      expectedRevision: 1,
    });
  });

  test("Save As exports a patdoc copy from the exact persisted library revision", async () => {
    const user = userEvent.setup();
    const exportPatdoc = vi.fn(
      async (_request): Promise<AppResult<SavedDocument | null>> => ({
        ok: true,
        value: {
          sessionId: testUuid(201),
          path: "D:\\导出\\文档.patdoc",
          displayName: "文档.patdoc",
          savedAt: "2026-08-01T08:10:00.000Z",
        },
      }),
    );
    window.patentApi = documentApi({ library: { exportPatdoc } });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(await screen.findByRole("button", { name: "修改" }));
    await user.click(screen.getByRole("button", { name: "另存为" }));

    await waitFor(() =>
      expect(exportPatdoc).toHaveBeenCalledWith({
        libraryDocumentId: testUuid(101),
        expectedRevision: 1,
      }),
    );
    expect(screen.getByTestId("saved-path").textContent).toBe("D:\\导出\\文档.patdoc");
  });

  test("flushes queued draft saves before acknowledging application close", async () => {
    const user = userEvent.setup();
    let prepareClose: ((token: string) => void) | undefined;
    let finishSave: (() => void) | undefined;
    const applyEdit = vi.fn(
      (batch) =>
        new Promise<AppResult<LibraryEditAck>>((resolve) => {
          finishSave = () =>
            resolve({
              ok: true,
              value: {
                libraryDocumentId: batch.libraryDocumentId,
                operationId: batch.operationId,
                revision: batch.targetRevision,
                savedAt: "2026-08-01T08:00:00.000Z",
              },
            });
        }),
    );
    const flush = vi.fn(
      async (request): Promise<Awaited<ReturnType<PatentApi["library"]["flush"]>>> => ({
        ok: true,
        value: {
          libraryDocumentId: request.libraryDocumentId,
          revision: request.expectedRevision,
          flushedAt: "2026-08-01T08:00:01.000Z",
        },
      }),
    );
    const closeResult = vi.fn(async () => ({ ok: true as const, value: undefined }));
    window.patentApi = documentApi({
      library: { applyEdit, flush },
      application: {
        onPrepareClose: vi.fn((listener) => {
          prepareClose = listener;
          return vi.fn();
        }),
        closeResult,
      },
    });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(await screen.findByRole("button", { name: "修改" }));
    await waitFor(() => expect(applyEdit).toHaveBeenCalledOnce());

    await act(async () => prepareClose?.("00000000-0000-4000-8000-000000000777"));
    expect(closeResult).not.toHaveBeenCalled();
    await act(async () => finishSave?.());

    await waitFor(() =>
      expect(closeResult).toHaveBeenCalledWith({
        token: "00000000-0000-4000-8000-000000000777",
        proceed: true,
      }),
    );
    expect(flush).toHaveBeenCalledWith({
      libraryDocumentId: testUuid(101),
      expectedRevision: 1,
    });
  });

  test("imports patdoc files as new internal library documents", async () => {
    const user = userEvent.setup();
    const imported = openedLibraryDocument(3, "导入专利");
    window.patentApi = documentApi({
      library: {
        importPatdoc: vi.fn(async () => ({ ok: true as const, value: imported })),
      },
    });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "打开" }));

    expect(screen.getByTestId("active-title").textContent).toBe("导入专利");
    expect(screen.getByTestId("session-count").textContent).toBe("1");
  });

  test("inherits the current global page margins when installing a new document", async () => {
    const user = userEvent.setup();
    window.patentApi = documentApi({
      settings: {
        read: vi.fn(async () => ({
          ok: true as const,
          value: {
            ...DEFAULT_APP_SETTINGS,
            pageMargins: {
              marginTopMm: 30,
              marginRightMm: 20,
              marginBottomMm: 30,
              marginLeftMm: 20,
            },
          },
        })),
      },
    });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    // 等待设置加载完成，再新建文档使其在 install 时继承全局设置。
    await waitFor(() => expect(screen.getByTestId("settings-margin-top").textContent).toBe("30"));
    await user.click(screen.getByRole("button", { name: "新建" }));

    expect(screen.getByTestId("active-margin-top").textContent).toBe("30");
    expect(screen.getByTestId("active-margin-left").textContent).toBe("20");
  });

  test("re-lays out every opened document immediately after applyPageMargins", async () => {
    const user = userEvent.setup();
    const applyEdit = vi.fn(async (batch) => ({
      ok: true as const,
      value: {
        libraryDocumentId: batch.libraryDocumentId,
        operationId: batch.operationId,
        revision: batch.targetRevision,
        savedAt: "2026-08-01T08:00:00.000Z",
      },
    }));
    window.patentApi = documentApi({
      library: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ ok: true as const, value: openedLibraryDocument(1, "第一篇") })
          .mockResolvedValueOnce({ ok: true as const, value: openedLibraryDocument(2, "第二篇") }),
        applyEdit,
      },
    });

    render(
      <DocumentProvider>
        <Harness />
      </DocumentProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("button", { name: "新建" }));
    expect(screen.getByTestId("session-count").textContent).toBe("2");

    await user.click(screen.getByRole("button", { name: "应用边距" }));

    // PRD P0-2: 保存后所有已打开文档的渲染白页立即按新边距重排（页面投影同步）。
    await waitFor(() => expect(screen.getByTestId("active-margin-top").textContent).toBe("30"));
    expect(screen.getByTestId("active-margin-left").textContent).toBe("20");

    // 同时必须经保存队列持久化：diffCanonicalDocument 产出 set-page 操作并调用 library.applyEdit。
    await waitFor(() => expect(applyEdit).toHaveBeenCalled());
    const calls = applyEdit.mock.calls.map(([batch]) => batch);
    expect(calls.length).toBe(2);
    for (const batch of calls) {
      expect(
        batch.operations.some((operation: { type: string }) => operation.type === "set-page"),
      ).toBe(true);
      expect(
        batch.operations.find((operation: { type: string }) => operation.type === "set-page"),
      ).toMatchObject({
        page: {
          marginTopMm: 30,
          marginRightMm: 20,
          marginBottomMm: 30,
          marginLeftMm: 20,
        },
      });
    }
  });
});

test("concurrent independent document opens keep one session and release the duplicate", async () => {
  const first = openedLibraryDocument(1);
  const second = { ...first, sessionId: testUuid(998) };
  const api = documentApi({
    library: {
      open: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: first })
        .mockResolvedValueOnce({ ok: true, value: second }),
    },
  });
  window.patentApi = api;
  let context!: ReturnType<typeof useDocuments>;
  function Probe() {
    context = useDocuments();
    return <Harness />;
  }
  render(
    <DocumentProvider>
      <Probe />
    </DocumentProvider>,
  );
  await act(async () => {
    await Promise.all([
      context.openLibraryDocument(first.libraryDocumentId),
      context.openLibraryDocument(first.libraryDocumentId),
    ]);
  });
  expect(context.state.sessions).toHaveLength(1);
  expect(api.library.release).toHaveBeenCalledWith(second.sessionId);
});
