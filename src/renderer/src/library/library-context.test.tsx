import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PatentApi } from "../../../shared/ipc/contract";
import type { LibraryDocumentSummary, LibraryPatentSummary } from "../../../shared/library/model";
import { onApplicationError } from "../shared/error-dialog";
import { LibraryProvider, useLibrary } from "./library-context";

function summary(title: string, index: number, modifiedAt: string): LibraryDocumentSummary {
  return {
    libraryDocumentId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    title,
    snippet: `${title} 摘要`,
    revision: index,
    saveState: "saved",
    createdAt: "2026-08-01T00:00:00.000Z",
    modifiedAt,
    deletedAt: null,
    quarantinedAt: null,
    recoveryState: "healthy",
    recoveryErrorCode: null,
  };
}

function patentSummary(
  name: string | null,
  index: number,
  modifiedAt: string,
): LibraryPatentSummary {
  return {
    patentId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    name,
    customer: null,
    patentType: "invention",
    revision: index,
    bookStatuses: {
      claims: "draft",
      description: "draft",
      "description-drawings": "empty",
      abstract: "empty",
      "abstract-drawing": "empty",
    },
    issueCount: 0,
    saveState: "saved",
    createdAt: "2026-08-01T00:00:00.000Z",
    modifiedAt,
    deletedAt: null,
    recoveryState: "healthy",
    recoveryErrorCode: null,
  };
}

function Harness() {
  const library = useLibrary();
  const firstDocument = library.activeDocuments[0];
  const firstPatent = library.activePatents[0];
  const firstTrashPatent = library.trashPatents[0];
  return (
    <div>
      <span data-testid="view">{library.view}</span>
      <span data-testid="active-titles">
        {library.activeDocuments.map((document) => document.title).join(",")}
      </span>
      <span data-testid="trash-count">{library.trashDocuments.length}</span>
      <span data-testid="active-patent-names">
        {library.activePatents.map((patent) => patent.name ?? "未命名专利").join(",")}
      </span>
      <span data-testid="patent-trash-count">{library.trashPatents.length}</span>
      <span data-testid="active-error">{library.activeError?.message ?? ""}</span>
      {library.view === "editor" ? <aside className="document-structure-ruler" /> : null}
      <button type="button" onClick={() => library.refreshActive()}>
        刷新专利库
      </button>
      <button type="button" onClick={() => firstDocument && library.moveToTrash(firstDocument)}>
        删除第一个
      </button>
      <button type="button" onClick={() => firstPatent && library.movePatentToTrash(firstPatent)}>
        删除第一个专利
      </button>
      <button type="button" onClick={() => firstPatent && library.recoverPatent(firstPatent)}>
        恢复隔离专利
      </button>
      <button type="button" onClick={() => library.refreshTrash()}>
        加载回收站
      </button>
      <button type="button" onClick={() => library.setView("editor")}>
        打开编辑页
      </button>
      <button type="button" onClick={() => library.setView("library")}>
        返回专利库
      </button>
      <button type="button" onClick={() => library.setView("trash")}>
        打开回收站页
      </button>
      <button
        type="button"
        onClick={() => firstTrashPatent && library.restorePatent(firstTrashPatent)}
      >
        恢复第一个专利
      </button>
      <button
        type="button"
        onClick={() => firstTrashPatent && library.permanentlyDeletePatent(firstTrashPatent)}
      >
        永久删除第一个专利
      </button>
    </div>
  );
}

test("a delayed library transition cannot hide the next tutorial document", async () => {
  window.patentApi = {
    library: { list: vi.fn(), listLegacyDrafts: vi.fn() },
    patents: { list: vi.fn(async () => ({ ok: true as const, value: [] })) },
  } as unknown as PatentApi;
  const callbacks: Array<() => void> = [];
  const original = document.startViewTransition;
  document.startViewTransition = vi.fn((update: () => void) => {
    callbacks.push(update);
    return { ready: Promise.resolve(), finished: new Promise(() => {}), skipTransition: vi.fn() };
  }) as never;
  try {
    render(
      <LibraryProvider>
        <Harness />
      </LibraryProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "打开编辑页" }));
    await act(async () => callbacks.shift()?.());
    expect(screen.getByTestId("view").textContent).toBe("editor");
    await userEvent.click(screen.getByRole("button", { name: "返回专利库" }));
    // Closing a lesson leaves no document; the next lesson opens before the old snapshot callback.
    await userEvent.click(screen.getByRole("button", { name: "打开编辑页" }));
    await act(async () => {
      for (const update of callbacks) update();
    });
    expect(screen.getByTestId("view").textContent).toBe("editor");
  } finally {
    document.startViewTransition = original;
  }
});

test("runs native transitions for library-editor and both trash directions", async () => {
  const user = userEvent.setup();
  const originalAnimate = HTMLElement.prototype.animate;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  const animationFrames: FrameRequestCallback[] = [];
  HTMLElement.prototype.animate = animate;
  globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });
  globalThis.cancelAnimationFrame = vi.fn();
  const finishTransitions: Array<() => void> = [];
  const readinessRejections: Array<ReturnType<typeof vi.spyOn>> = [];
  const startViewTransition = vi.fn((update: () => void) => {
    const finished = new Promise<void>((resolve) => finishTransitions.push(resolve));
    const ready = Promise.reject<void>(new DOMException("Transition was skipped", "AbortError"));
    readinessRejections.push(vi.spyOn(ready, "catch"));
    update();
    return { finished, ready } as ViewTransition;
  });
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: startViewTransition,
  });
  window.patentApi = {
    library: { list: vi.fn(), listLegacyDrafts: vi.fn() },
    patents: { list: vi.fn(async () => ({ ok: true as const, value: [] })) },
  } as unknown as PatentApi;

  try {
    render(
      <LibraryProvider>
        <Harness />
      </LibraryProvider>,
    );

    await user.click(screen.getByRole("button", { name: "打开编辑页" }));
    expect(screen.getByTestId("view").textContent).toBe("editor");
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(readinessRejections[0]).toHaveBeenCalledOnce();
    expect(document.documentElement.classList).toContain("library-editor-ruler-entry-pending");
    expect(animate).not.toHaveBeenCalled();
    finishTransitions.shift()?.();
    await waitFor(() => expect(animationFrames).toHaveLength(1));
    expect(document.documentElement.classList).toContain("library-editor-view-transition");
    expect(document.documentElement.classList).toContain("library-editor-ruler-entry-pending");
    expect(animate).not.toHaveBeenCalled();
    animationFrames.shift()?.(performance.now());
    await waitFor(() =>
      expect(document.documentElement.classList).toContain("library-editor-function-rail-entry"),
    );
    expect(document.documentElement.classList).not.toContain("library-editor-view-transition");
    expect(document.documentElement.classList).not.toContain("library-editor-ruler-entry-pending");
    expect(animate).toHaveBeenCalledWith(
      [
        {
          transform: "translateX(calc(100% + var(--document-structure-ruler-gap)))",
        },
        { transform: "translateX(0)" },
      ],
      { duration: 400, easing: "ease-in-out" },
    );

    await user.click(screen.getByRole("button", { name: "返回专利库" }));
    expect(screen.getByTestId("view").textContent).toBe("library");
    expect(startViewTransition).toHaveBeenCalledTimes(2);
    finishTransitions.shift()?.();
    expect(document.documentElement.classList).not.toContain("library-editor-function-rail-entry");

    await user.click(screen.getByRole("button", { name: "打开回收站页" }));
    expect(screen.getByTestId("view").textContent).toBe("trash");
    expect(startViewTransition).toHaveBeenCalledTimes(3);
    expect(document.documentElement.classList).toContain("library-trash-view-transition");
    expect(document.documentElement.classList).toContain("library-trash-view-transition-enter");
    finishTransitions.shift()?.();
    await waitFor(() =>
      expect(document.documentElement.classList).not.toContain("library-trash-view-transition"),
    );

    await user.click(screen.getByRole("button", { name: "返回专利库" }));
    expect(screen.getByTestId("view").textContent).toBe("library");
    expect(startViewTransition).toHaveBeenCalledTimes(4);
    expect(document.documentElement.classList).toContain("library-trash-view-transition");
    expect(document.documentElement.classList).toContain("library-trash-view-transition-exit");
    finishTransitions.shift()?.();
    await waitFor(() =>
      expect(document.documentElement.classList).not.toContain("library-trash-view-transition"),
    );
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test("changes views immediately when reduced motion is enabled", async () => {
  const user = userEvent.setup();
  const startViewTransition = vi.fn();
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: startViewTransition,
  });
  document.documentElement.dataset.reducedMotion = "true";
  window.patentApi = {
    library: { list: vi.fn(), listLegacyDrafts: vi.fn() },
    patents: { list: vi.fn(async () => ({ ok: true as const, value: [] })) },
  } as unknown as PatentApi;

  try {
    render(
      <LibraryProvider>
        <Harness />
      </LibraryProvider>,
    );

    await user.click(screen.getByRole("button", { name: "打开编辑页" }));
    expect(screen.getByTestId("view").textContent).toBe("editor");
    expect(startViewTransition).not.toHaveBeenCalled();
  } finally {
    delete document.documentElement.dataset.reducedMotion;
  }
});

test("loads active patents once and keeps newest modified patents first", async () => {
  const list = vi.fn(async () => ({ ok: true as const, value: [] }));
  const patentList = vi.fn(async () => ({
    ok: true as const,
    value: [
      patentSummary("旧专利", 11, "2026-08-01T01:00:00.000Z"),
      patentSummary("新专利", 12, "2026-08-01T02:00:00.000Z"),
    ],
  }));
  window.patentApi = {
    library: {
      list,
      listLegacyDrafts: vi.fn(async () => ({ ok: true as const, value: [] })),
    },
    patents: {
      list: patentList,
      moveToTrash: vi.fn(),
    },
  } as unknown as PatentApi;

  render(
    <LibraryProvider>
      <Harness />
    </LibraryProvider>,
  );

  await waitFor(() =>
    expect(screen.getByTestId("active-patent-names").textContent).toBe("新专利,旧专利"),
  );
  expect(patentList).toHaveBeenCalledWith("active");
});

test("preserves the last successful patent list and reports refresh failures inline", async () => {
  const user = userEvent.setup();
  const patentList = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      value: [patentSummary("已保存专利", 15, "2026-08-01T04:00:00.000Z")],
    })
    .mockResolvedValueOnce({
      ok: false,
      error: { code: "INVALID_INPUT", message: "输入内容无效。" },
    });
  const globalErrorListener = vi.fn();
  const unsubscribe = onApplicationError(globalErrorListener);
  window.patentApi = {
    library: { list: vi.fn(), listLegacyDrafts: vi.fn() },
    patents: { list: patentList },
  } as unknown as PatentApi;

  render(
    <LibraryProvider>
      <Harness />
    </LibraryProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("active-patent-names").textContent).toBe("已保存专利"),
  );

  await user.click(screen.getByRole("button", { name: "刷新专利库" }));

  await waitFor(() =>
    expect(screen.getByTestId("active-error").textContent).toBe("输入内容无效。"),
  );
  expect(screen.getByTestId("active-patent-names").textContent).toBe("已保存专利");
  expect(globalErrorListener).not.toHaveBeenCalled();
  unsubscribe();
});

test("does not call legacy document or draft endpoints in patent mode", async () => {
  const documentList = vi.fn(async () => ({
    ok: false as const,
    error: { code: "INTERNAL" as const, message: "legacy document tables are unavailable" },
  }));
  const listLegacyDrafts = vi.fn(async () => ({
    ok: false as const,
    error: { code: "INTERNAL" as const, message: "legacy drafts are unsupported" },
  }));
  const patentList = vi.fn(async () => ({ ok: true as const, value: [] }));
  window.patentApi = {
    library: {
      list: documentList,
      listLegacyDrafts,
    },
    patents: {
      list: patentList,
      moveToTrash: vi.fn(),
    },
  } as unknown as PatentApi;

  render(
    <LibraryProvider>
      <Harness />
    </LibraryProvider>,
  );

  await waitFor(() => expect(patentList).toHaveBeenCalledWith("active"));
  expect(documentList).not.toHaveBeenCalled();
  expect(listLegacyDrafts).not.toHaveBeenCalled();
});

test("moves a patent to trash and refreshes active and trash patent lists", async () => {
  const user = userEvent.setup();
  const deleted = {
    ...patentSummary("旧专利", 11, "2026-08-01T01:00:00.000Z"),
    deletedAt: "2026-08-01T03:00:00.000Z",
  };
  const list = vi.fn(async () => ({ ok: true as const, value: [] }));
  const patentList = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      value: [patentSummary("旧专利", 11, "2026-08-01T01:00:00.000Z")],
    })
    .mockResolvedValueOnce({ ok: true, value: [] })
    .mockResolvedValueOnce({ ok: true, value: [deleted] });
  const moveToTrash = vi.fn(async () => ({ ok: true as const, value: undefined }));
  window.patentApi = {
    library: {
      list,
      listLegacyDrafts: vi.fn(async () => ({ ok: true as const, value: [] })),
    },
    patents: {
      list: patentList,
      moveToTrash,
    },
  } as unknown as PatentApi;

  render(
    <LibraryProvider>
      <Harness />
    </LibraryProvider>,
  );

  await waitFor(() => expect(screen.getByTestId("active-patent-names").textContent).toBe("旧专利"));
  await user.click(screen.getByRole("button", { name: "删除第一个专利" }));

  await waitFor(() => expect(screen.getByTestId("active-patent-names").textContent).toBe(""));
  expect(moveToTrash).toHaveBeenCalledWith("00000000-0000-4000-8000-00000000000b");
  expect(screen.getByTestId("patent-trash-count").textContent).toBe("1");
});

test("recovers a quarantined patent and refreshes the active patent list", async () => {
  const user = userEvent.setup();
  const quarantined = {
    ...patentSummary("待恢复专利", 16, "2026-08-01T05:00:00.000Z"),
    recoveryState: "quarantined" as const,
    recoveryErrorCode: "CORRUPT_FILE",
  };
  const recovered = {
    ...quarantined,
    recoveryState: "healthy" as const,
    recoveryErrorCode: null,
  };
  let recoveredNow = false;
  const recover = vi.fn(async () => {
    recoveredNow = true;
    return { ok: true as const, value: { patentId: quarantined.patentId, backupCreated: true } };
  });
  const patentList = vi.fn(async () => ({
    ok: true as const,
    value: [recoveredNow ? recovered : quarantined],
  }));
  window.patentApi = {
    library: { list: vi.fn(), listLegacyDrafts: vi.fn() },
    patents: {
      list: patentList,
      recover,
    },
  } as unknown as PatentApi;

  render(
    <LibraryProvider>
      <Harness />
    </LibraryProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("active-patent-names").textContent).toBe("待恢复专利"),
  );
  await user.click(screen.getByRole("button", { name: "恢复隔离专利" }));

  await waitFor(() => expect(recover).toHaveBeenCalledWith(quarantined.patentId));
  expect(patentList).toHaveBeenCalledTimes(2);
});

test("restores a trashed patent and refreshes both patent lists", async () => {
  const user = userEvent.setup();
  const deleted = {
    ...patentSummary("待恢复专利", 13, "2026-08-01T03:00:00.000Z"),
    deletedAt: "2026-08-01T04:00:00.000Z",
  };
  let restored = false;
  const restore = vi.fn(async () => {
    restored = true;
    return { ok: true as const, value: undefined };
  });
  window.patentApi = {
    library: { list: vi.fn(), listLegacyDrafts: vi.fn() },
    patents: {
      list: vi.fn(async (scope: "active" | "trash") => ({
        ok: true as const,
        value:
          scope === "active"
            ? restored
              ? [{ ...deleted, deletedAt: null }]
              : []
            : restored
              ? []
              : [deleted],
      })),
      restore,
    },
  } as unknown as PatentApi;

  render(
    <LibraryProvider>
      <Harness />
    </LibraryProvider>,
  );
  await user.click(screen.getByRole("button", { name: "加载回收站" }));
  await waitFor(() => expect(screen.getByTestId("patent-trash-count").textContent).toBe("1"));
  await user.click(screen.getByRole("button", { name: "恢复第一个专利" }));

  await waitFor(() => expect(screen.getByTestId("patent-trash-count").textContent).toBe("0"));
  expect(restore).toHaveBeenCalledWith(deleted.patentId);
  expect(screen.getByTestId("active-patent-names").textContent).toBe("待恢复专利");
});

test("permanently deletes a trashed patent and refreshes the patent trash list", async () => {
  const user = userEvent.setup();
  const deleted = {
    ...patentSummary("待永久删除专利", 14, "2026-08-01T03:00:00.000Z"),
    deletedAt: "2026-08-01T04:00:00.000Z",
  };
  let deletedPermanently = false;
  const permanentlyDelete = vi.fn(async () => {
    deletedPermanently = true;
    return { ok: true as const, value: undefined };
  });
  window.patentApi = {
    library: { list: vi.fn(), listLegacyDrafts: vi.fn() },
    patents: {
      list: vi.fn(async (scope: "active" | "trash") => ({
        ok: true as const,
        value: scope === "trash" && !deletedPermanently ? [deleted] : [],
      })),
      permanentlyDelete,
    },
  } as unknown as PatentApi;

  render(
    <LibraryProvider>
      <Harness />
    </LibraryProvider>,
  );
  await user.click(screen.getByRole("button", { name: "加载回收站" }));
  await waitFor(() => expect(screen.getByTestId("patent-trash-count").textContent).toBe("1"));
  await user.click(screen.getByRole("button", { name: "永久删除第一个专利" }));

  await waitFor(() => expect(screen.getByTestId("patent-trash-count").textContent).toBe("0"));
  expect(permanentlyDelete).toHaveBeenCalledWith(deleted.patentId);
});

test("loads active documents once and keeps newest modified documents first", async () => {
  const list = vi.fn(async () => ({
    ok: true as const,
    value: [
      summary("旧文档", 1, "2026-08-01T01:00:00.000Z"),
      summary("新文档", 2, "2026-08-01T02:00:00.000Z"),
    ],
  }));
  window.patentApi = {
    library: {
      list,
      moveToTrash: vi.fn(),
    },
  } as unknown as PatentApi;

  render(
    <LibraryProvider>
      <Harness />
    </LibraryProvider>,
  );

  await waitFor(() =>
    expect(screen.getByTestId("active-titles").textContent).toBe("新文档,旧文档"),
  );
  expect(list).toHaveBeenCalledWith("active");
});

test("moves a document to trash and refreshes active and trash lists", async () => {
  const user = userEvent.setup();
  const deleted = {
    ...summary("旧文档", 1, "2026-08-01T01:00:00.000Z"),
    deletedAt: "2026-08-01T03:00:00.000Z",
  };
  const list = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, value: [summary("旧文档", 1, "2026-08-01T01:00:00.000Z")] })
    .mockResolvedValueOnce({ ok: true, value: [] })
    .mockResolvedValueOnce({ ok: true, value: [deleted] });
  const moveToTrash = vi.fn(async () => ({ ok: true as const, value: undefined }));
  window.patentApi = {
    library: {
      list,
      moveToTrash,
    },
  } as unknown as PatentApi;

  render(
    <LibraryProvider>
      <Harness />
    </LibraryProvider>,
  );

  await waitFor(() => expect(screen.getByTestId("active-titles").textContent).toBe("旧文档"));
  await user.click(screen.getByRole("button", { name: "删除第一个" }));

  await waitFor(() => expect(screen.getByTestId("active-titles").textContent).toBe(""));
  expect(moveToTrash).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
  expect(screen.getByTestId("trash-count").textContent).toBe("1");
});

test("CLI commits refresh active and trash lists without navigation", async () => {
  let listener!: (event: import("../../../shared/automation/protocol").AutomationEvent) => void;
  let active: LibraryPatentSummary[] = [];
  let trash: LibraryPatentSummary[] = [];
  window.patentApi = {
    patents: {
      list: vi.fn(async (kind: string) => ({
        ok: true,
        value: kind === "active" ? active : trash,
      })),
    },
    drafts: { list: vi.fn(async () => ({ ok: true, value: [] })) },
    automation: {
      onEvent: (fn: typeof listener) => {
        listener = fn;
        return () => {};
      },
    },
  } as unknown as PatentApi;
  render(
    <LibraryProvider>
      <Harness />
    </LibraryProvider>,
  );
  await waitFor(() => expect(window.patentApi.patents.list).toHaveBeenCalled());
  active = [patentSummary("Agent新建专利", 99, "2026-10-04T00:00:00Z")];
  act(() => listener({ type: "libraryChanged", patentIds: [active[0]!.patentId] }));
  await waitFor(() =>
    expect(screen.getByTestId("active-patent-names").textContent).toBe("Agent新建专利"),
  );
  trash = active;
  active = [];
  act(() => listener({ type: "libraryChanged", patentIds: [trash[0]!.patentId] }));
  await waitFor(() => expect(screen.getByTestId("active-patent-names").textContent).toBe(""));
  await waitFor(() => expect(screen.getByTestId("patent-trash-count").textContent).toBe("1"));
});
