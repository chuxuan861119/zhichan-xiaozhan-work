import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createBlankBookDocument,
  DEFAULT_PARAGRAPH_ATTRIBUTES,
} from "../../../shared/document/defaults";
import type { PatentApi } from "../../../shared/ipc/contract";
import { normalizeAppError } from "../../../shared/ipc/result";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import type { SnapshotContentPreview, SnapshotEntry } from "../../../shared/snapshot/model";
import { SnapshotManager } from "./snapshot-manager";

const patentId = "00000000-0000-4000-8000-000000000921";

beforeAll(() => {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { escape: (value: string) => value },
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

function snapshot(overrides: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    documentType: "patent",
    documentId: patentId,
    displayName: "测试专利",
    revision: 4,
    sizeBytes: 2048,
    createdAt: "2026-08-16T01:02:03.000Z",
    source: "manual-create",
    status: "healthy",
    errorMessage: null,
    deletable: true,
    contentSummary: {
      books: ["claims", "description", "description-drawings", "abstract", "abstract-drawing"].map(
        (kind, index) => ({
          kind: kind as SnapshotEntry["contentSummary"] extends infer Summary
            ? Summary extends { books: Array<infer Book> }
              ? Book extends { kind: infer Kind }
                ? Kind
                : never
              : never
            : never,
          characterCount: index === 0 ? 10 : 0,
          preview: index === 0 ? "1. 一种可调夹具。" : "",
        }),
      ),
      figureCount: 1,
      assetCount: 1,
      flowchartCount: 0,

      referenceMarkCount: 2,
    },
    ...overrides,
  };
}

test.each([
  ["initial", "初始版本"],
  ["automatic", "自动快照"],
  ["manual-save", "手动保存"],
  ["manual-create", "手动快照"],
  ["patent-close", "关闭专利"],
  ["application-close", "退出软件"],
  ["historical", "历史版本"],
] as const)("shows snapshot source %s in the history", async (source, label) => {
  renderManager({ entries: [snapshot({ source })] });
  await userEvent.setup().click(await screen.findByRole("button", { name: /测试专利/ }));
  expect(screen.getByText(label)).toBeDefined();
});

function renderManager(
  options: {
    entries?: SnapshotEntry[];
    patents?: LibraryPatentSummary[];
    prepareSnapshot?: (patentId: string) => Promise<boolean>;
    warnings?: Array<{
      documentType: "patent";
      documentId: string;
      displayName: string;
      message: string;
    }>;
    restoreWarning?: string;
    onRestored?: (documentId: string) => unknown | Promise<unknown>;
    previewResult?: Awaited<ReturnType<PatentApi["snapshot"]["preview"]>>;
    embedded?: boolean;
    onPreview?: (
      value: SnapshotContentPreview,
      documentId: string,
      resourceMissing: boolean,
    ) => void;
  } = {},
) {
  const list = vi.fn(async () => ({
    ok: true as const,
    value: { entries: options.entries ?? [snapshot()], warnings: options.warnings ?? [] },
  }));
  const create = vi.fn<PatentApi["snapshot"]["create"]>(async () => ({
    ok: true,
    value: {
      outcome: "created",
      revision: 4,
      createdAt: "2026-08-16T01:02:03.000Z",
      source: "manual-create",
    },
  }));
  const restore = vi.fn(async () => ({
    ok: true as const,
    value: {
      documentType: "patent" as const,
      documentId: "00000000-0000-4000-8000-000000000929",
      displayName: "测试专利（快照恢复 v4，2026-08-16 01:02 UTC）",
      ...(options.restoreWarning ? { warning: options.restoreWarning } : {}),
    },
  }));
  const deleteSnapshot = vi.fn(async () => ({
    ok: true as const,
    value: { cleanupError: null as string | null },
  }));
  const preview = vi.fn(
    async () => options.previewResult ?? { ok: true as const, value: snapshotPreview() },
  );
  const documentSave = vi.fn();
  const patentFlush = vi.fn();
  const status = vi.fn<PatentApi["snapshot"]["status"]>(async () => ({
    ok: true,
    value: {
      enabled: true,
      intervalMinutes: 5,
      openPatentCount: 1,
      lastCheckAt: null,
      lastAutomaticSnapshotAt: null,
      nextCheckAt: null,
      lastError: null,
    },
  }));
  window.patentApi = {
    snapshot: {
      list,
      create,
      restore,
      delete: deleteSnapshot,
      status,
      configure: vi.fn(),
      preview,
      previewAsset: vi.fn(),
    },
    documents: { save: documentSave },
    patents: {
      flush: patentFlush,
      list: vi.fn(async () => ({ ok: true, value: options.patents ?? [] })),
    },
  } as unknown as PatentApi;
  const onRestored = options.onRestored ?? vi.fn();
  const view = render(
    <SnapshotManager
      open
      onClose={vi.fn()}
      onRestored={onRestored}
      prepareSnapshot={options.prepareSnapshot ?? (async () => true)}
      {...(options.embedded === undefined ? {} : { embedded: options.embedded })}
      {...(options.onPreview === undefined ? {} : { onPreview: options.onPreview })}
    />,
  );
  return {
    view,
    status,
    create,
    deleteSnapshot,
    documentSave,
    list,
    onRestored,
    patentFlush,
    preview,
    restore,
  };
}

function snapshotPreview(): SnapshotContentPreview {
  const document = createBlankBookDocument("快照预览");
  const books = (
    ["claims", "description", "description-drawings", "abstract", "abstract-drawing"] as const
  ).map((kind) => ({ kind, document }));
  return {
    current: { revision: 4, createdAt: "2026-08-16T01:02:03.000Z", books },
    baseline: null,
    comparison: "initial",
    skippedRevisions: [],
  };
}

function snapshotPreviewWithChanges(): SnapshotContentPreview {
  const current = snapshotPreview();
  const baselineBooks = current.current.books.map((book) => ({
    ...book,
    document: { ...book.document, content: [] },
  }));
  const currentBooks = current.current.books.map((book) => ({
    ...book,
    document:
      book.kind === "description" || book.kind === "abstract"
        ? {
            ...book.document,
            content: [
              {
                id: `00000000-0000-4000-8000-0000000009${book.kind === "description" ? "31" : "32"}`,
                type: "paragraph" as const,
                attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
                content: [{ type: "text" as const, text: `${book.kind} 新增文字`, marks: [] }],
              },
            ],
          }
        : book.document,
  }));
  return {
    current: { ...current.current, books: currentBooks },
    baseline: {
      revision: 3,
      createdAt: "2026-08-16T00:02:03.000Z",
      books: baselineBooks,
    },
    comparison: "compared",
    skippedRevisions: [],
  };
}

test("shows partial history warnings without hiding readable patents", async () => {
  renderManager({
    warnings: [
      {
        documentType: "patent",
        documentId: "00000000-0000-4000-8000-000000000928",
        displayName: "损坏历史专利",
        message: "快照密文无法读取",
      },
    ],
  });

  expect(await screen.findByText("测试专利")).toBeDefined();
  expect(screen.getByRole("alert").textContent).toContain("损坏历史专利");
  expect(screen.getByRole("alert").textContent).toContain("快照密文无法读取");
});

test("waits for pending saves before manual snapshot creation", async () => {
  let finishSave!: (saved: boolean) => void;
  const prepareSnapshot = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finishSave = resolve;
      }),
  );
  const { create } = renderManager({ prepareSnapshot });
  await userEvent.click(await screen.findByRole("button", { name: /测试专利/ }));
  await userEvent.click(screen.getByRole("button", { name: "立即创建快照" }));
  expect(prepareSnapshot).toHaveBeenCalledWith(patentId);
  expect(create).not.toHaveBeenCalled();
  await act(async () => finishSave(true));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
});

test("does not create or report success when pending saves fail", async () => {
  const { create } = renderManager({ prepareSnapshot: async () => false });
  await userEvent.click(await screen.findByRole("button", { name: /测试专利/ }));
  await userEvent.click(screen.getByRole("button", { name: "立即创建快照" }));
  expect((await screen.findByRole("alert")).textContent).toContain("尚未保存");
  expect(create).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
});

test("refreshes snapshots on focus without losing the selected patent", async () => {
  const { list } = renderManager();
  await userEvent.click(await screen.findByRole("button", { name: /测试专利/ }));
  list.mockResolvedValue({
    ok: true,
    value: { entries: [snapshot({ revision: 5 }), snapshot()], warnings: [] },
  });
  fireEvent(window, new Event("focus"));
  expect(await screen.findByRole("button", { name: "查看 v5 内容预览" })).toBeDefined();
  expect(screen.getByRole("button", { name: "查看 v4 内容预览" })).toBeDefined();
});

test("automatically refreshes after a background snapshot and pauses on hidden routes", async () => {
  const { list, status, view } = renderManager();
  await userEvent.click(await screen.findByRole("button", { name: /测试专利/ }));
  const automaticStatus = {
    ok: true as const,
    value: {
      enabled: true,
      intervalMinutes: 5 as const,
      openPatentCount: 1,
      lastCheckAt: "2026-09-11T00:00:00.000Z",
      lastAutomaticSnapshotAt: "2026-09-11T00:00:00.000Z",
      nextCheckAt: null,
      lastError: null,
    },
  };
  status.mockResolvedValue(automaticStatus);
  list.mockResolvedValue({
    ok: true,
    value: { entries: [snapshot({ revision: 5 }), snapshot()], warnings: [] },
  });
  vi.useFakeTimers();
  try {
    // Re-arm the effect using the fake clock.
    view.rerender(<SnapshotManager open active={false} onClose={vi.fn()} onRestored={vi.fn()} />);
    view.rerender(<SnapshotManager open onClose={vi.fn()} onRestored={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    list.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(status).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "查看 v5 内容预览" })).toBeDefined();
    view.rerender(<SnapshotManager open active={false} onClose={vi.fn()} onRestored={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(status).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("shows the real retention policy without promising protected latest versions", async () => {
  renderManager();
  await userEvent.click(await screen.findByRole("button", { name: /测试专利/ }));
  expect(screen.queryByText(/最近 3 个版本受保护/)).toBeNull();
  expect(screen.getByText(/每小时 2 个/)).toBeDefined();
});

test("allows snapshot creation for patents whose snapshots were all deleted", async () => {
  const patent: LibraryPatentSummary = {
    patentId,
    name: "无快照专利",
    customer: null,
    patentType: "invention",
    revision: 4,
    bookStatuses: {
      claims: "empty",
      description: "empty",
      "description-drawings": "empty",
      abstract: "empty",
      "abstract-drawing": "empty",
    },
    issueCount: 0,
    saveState: "saved",
    createdAt: "2026-08-16T01:02:03.000Z",
    modifiedAt: "2026-08-16T01:02:03.000Z",
    deletedAt: null,
    recoveryState: "healthy",
    recoveryErrorCode: null,
  };
  const { create } = renderManager({ entries: [], patents: [patent] });
  await userEvent.click(await screen.findByRole("button", { name: /无快照专利/ }));
  await userEvent.click(screen.getByRole("button", { name: "立即创建快照" }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
});

test("renders an embedded snapshot manager and gives preview data to the workspace route", async () => {
  const user = userEvent.setup();
  const onPreview = vi.fn();
  renderManager({ embedded: true, onPreview });

  expect(await screen.findByRole("region", { name: "快照管理器" })).toBeDefined();
  expect(screen.queryByRole("dialog", { name: "快照管理器" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "快照管理器" })).toBeNull();
  await user.click(screen.getByRole("button", { name: /测试专利/ }));
  await user.click(screen.getByRole("button", { name: "查看 v4 内容预览" }));
  await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
  expect(onPreview.mock.calls[0]?.slice(1)).toEqual([patentId, false]);
  expect(screen.queryByRole("dialog", { name: "v4 内容预览" })).toBeNull();
});

test("distinguishes a validated existing snapshot from a newly created version", async () => {
  const user = userEvent.setup();
  const { create } = renderManager();
  create.mockResolvedValue({
    ok: true,
    value: {
      outcome: "already-exists",
      revision: 4,
      createdAt: "2026-08-16T01:02:03.000Z",
      source: "automatic",
    },
  });
  await user.click(await screen.findByRole("button", { name: /测试专利/ }));
  await user.click(screen.getByRole("button", { name: "立即创建快照" }));
  expect((await screen.findByRole("status")).textContent).toContain("当前修订已有快照");
});

test("creates a manual snapshot and refreshes the selected history", async () => {
  const user = userEvent.setup();
  const { create, list } = renderManager();
  await user.click(await screen.findByRole("button", { name: /测试专利/ }));

  await user.click(screen.getByRole("button", { name: "立即创建快照" }));

  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      documentType: "patent",
      documentId: patentId,
      source: "manual-create",
    }),
  );
  expect(list).toHaveBeenCalledTimes(2);
  expect((await screen.findByRole("status")).textContent).toContain("当前版本快照已创建");
});

test("opens a loading content preview and requests the selected revision", async () => {
  const user = userEvent.setup();
  const { preview } = renderManager();
  await user.click(await screen.findByRole("button", { name: /测试专利/ }));
  const managerMain = screen.getByRole("main");
  managerMain.scrollTop = 321;
  let resolvePreview: ((result: { ok: true; value: SnapshotContentPreview }) => void) | undefined;
  preview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
  );
  const origin = screen.getByRole("button", { name: "查看 v4 内容预览" });
  await user.click(origin);

  expect(screen.getByText("正在生成五书内容预览…")).toBeDefined();
  expect(preview).toHaveBeenCalledWith({
    documentType: "patent",
    documentId: patentId,
    revision: 4,
  });
  resolvePreview?.({ ok: true, value: snapshotPreview() });
  expect(await screen.findByRole("dialog", { name: "v4 内容预览" })).toBeDefined();
  expect(screen.queryByText("1. 一种可调夹具。")).toBeNull();
  await user.click(screen.getByRole("button", { name: "关闭内容预览" }));
  expect(document.activeElement).toBe(origin);
  expect(managerMain.scrollTop).toBe(321);
});

test("keeps the manager open and displays the real preview request failure", async () => {
  const user = userEvent.setup();
  const { preview } = renderManager({
    previewResult: {
      ok: false,
      error: { code: "CORRUPT_FILE", message: "快照正文校验失败", nextAction: "请检查快照文件。" },
    },
  });
  await user.click(await screen.findByRole("button", { name: /测试专利/ }));
  const origin = screen.getByRole("button", { name: "查看 v4 内容预览" });
  await user.click(origin);
  expect((await screen.findByRole("alert")).textContent).toContain("快照正文校验失败");
  expect(screen.getByRole("dialog", { name: /测试专利/ })).toBeDefined();
  await waitFor(() => expect(document.activeElement).toBe(origin));
  expect(preview).toHaveBeenCalledOnce();
});

test("traps the loading modal, closes it with Escape and ignores a late response", async () => {
  const user = userEvent.setup();
  const { preview } = renderManager();
  await user.click(await screen.findByRole("button", { name: /测试专利/ }));
  let resolvePreview: ((result: { ok: true; value: SnapshotContentPreview }) => void) | undefined;
  preview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
  );
  const origin = screen.getByRole("button", { name: "查看 v4 内容预览" });
  await user.click(origin);
  const loadingDialog = screen.getByRole("dialog", { name: "v4 内容预览" });
  expect(within(loadingDialog).getByRole("button", { name: "取消内容预览" })).toBeDefined();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByText("正在生成五书内容预览…").closest("[inert]")).not.toBeNull();
  await waitFor(() => expect(screen.queryByText("正在生成五书内容预览…")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(origin));
  resolvePreview?.({ ok: true, value: snapshotPreview() });
  await Promise.resolve();
  expect(screen.queryByRole("dialog", { name: "v4 内容预览" })).toBeNull();
});

test.each(["inactive", "closed", "unmounted", "back", "patent"])(
  "leaving the preview context (%s) ignores an old response",
  async (change) => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    const { view, preview, onRestored } = renderManager({ embedded: true, onPreview });
    await user.click(await screen.findByRole("button", { name: /测试专利/ }));
    let resolvePreview: ((result: { ok: true; value: SnapshotContentPreview }) => void) | undefined;
    preview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "查看 v4 内容预览" }));
    if (change === "unmounted") view.unmount();
    else if (change === "back") await user.click(screen.getByRole("button", { name: "← 返回" }));
    else
      view.rerender(
        <SnapshotManager
          open={change !== "closed"}
          active={change !== "inactive"}
          {...(change === "patent" ? { patentId: "00000000-0000-4000-8000-000000000999" } : {})}
          embedded
          onClose={vi.fn()}
          onRestored={onRestored}
          onPreview={onPreview}
        />,
      );
    await act(async () => {
      resolvePreview?.({ ok: true, value: snapshotPreview() });
    });
    expect(onPreview).not.toHaveBeenCalled();
  },
);

test("allows resource-missing previews, omits damaged previews and never mutates during all preview navigation", async () => {
  const user = userEvent.setup();
  const { create, deleteSnapshot, documentSave, patentFlush, restore } = renderManager({
    entries: [
      snapshot({ revision: 5, status: "damaged" }),
      snapshot({ status: "resource-missing", errorMessage: "图片 A 不存在" }),
    ],
    previewResult: { ok: true, value: snapshotPreviewWithChanges() },
  });
  await user.click(await screen.findByRole("button", { name: /测试专利/ }));
  expect(screen.queryByRole("button", { name: "查看 v5 内容预览" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "查看 v4 内容预览" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "查看 v4 内容预览" }));
  const dialog = await screen.findByRole("dialog", { name: "v4 内容预览" });
  expect(
    within(dialog).getByText("该快照有资源缺失，正文仍可预览；缺失资源可能无法显示。"),
  ).toBeDefined();
  const rail = within(dialog).getByLabelText("变化位置");
  const location = rail.querySelector("button");
  if (!location) throw new Error("变化位置未渲染");
  await user.click(location);
  await user.click(within(dialog).getByRole("button", { name: "下一个变化" }));
  await user.click(within(dialog).getByRole("tab", { name: "说明书 1 项变化" }));
  expect(create).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  expect(deleteSnapshot).not.toHaveBeenCalled();
  expect(documentSave).not.toHaveBeenCalled();
  expect(patentFlush).not.toHaveBeenCalled();
});

test("keeps long version histories scrollable without clipping wide actions", async () => {
  const user = userEvent.setup();
  renderManager({
    entries: Array.from({ length: 40 }, (_, index) =>
      snapshot({
        revision: index + 1,
        createdAt: `2026-08-15T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
      }),
    ),
  });

  await user.click(await screen.findByRole("button", { name: /测试专利/ }));

  expect(screen.getByText("v1")).toBeDefined();
  const latestVersion = screen.getByText("v40");
  expect(latestVersion).toBeDefined();
  expect(latestVersion.closest("article")?.style.overflowX).toBe("auto");
});

test("shows damaged and protected reasons inline with visibly disabled actions", async () => {
  const user = userEvent.setup();
  renderManager({
    entries: [
      snapshot({ status: "resource-missing", errorMessage: "图片 A 不存在", deletable: false }),
    ],
  });
  await user.click(await screen.findByRole("button", { name: /测试专利/ }));

  expect(screen.getByText("图片 A 不存在")).toBeDefined();
  expect(screen.getByText(/最后一个可恢复到当前内容的有效快照/)).toBeDefined();
  expect((screen.getByRole("button", { name: "恢复 v4" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole("button", { name: "删除 v4" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test("uses an in-app deletion confirmation instead of window.confirm", async () => {
  const user = userEvent.setup();
  const confirmSpy = vi.spyOn(window, "confirm");
  const { deleteSnapshot } = renderManager();
  await user.click(await screen.findByRole("button", { name: /测试专利/ }));
  await user.click(screen.getByRole("button", { name: "删除 v4" }));

  expect(
    screen
      .getByRole("alertdialog", { name: "永久删除快照" })
      .classList.contains("standard-dialog--s"),
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(deleteSnapshot).toHaveBeenCalledOnce());
  expect(confirmSpy).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

test("keeps embedded delete confirmation within the manager and preserves its list when cancelled", async () => {
  const user = userEvent.setup();
  const { deleteSnapshot, list } = renderManager({ embedded: true });
  const manager = await screen.findByRole("region", { name: "快照管理器" });
  await user.click(within(manager).getByRole("button", { name: /测试专利/ }));
  await user.click(within(manager).getByRole("button", { name: "删除 v4" }));

  expect(
    within(manager)
      .getByRole("alertdialog", { name: "永久删除快照" })
      .classList.contains("standard-dialog--s"),
  ).toBe(true);
  await user.click(within(manager).getByRole("button", { name: "取消" }));
  expect(deleteSnapshot).not.toHaveBeenCalled();
  expect(list).toHaveBeenCalledOnce();
  expect(within(manager).getByText("v4")).toBeDefined();
});

test("refreshes after committed deletion and reports deferred cleanup separately", async () => {
  const user = userEvent.setup();
  const { deleteSnapshot, list } = renderManager();
  deleteSnapshot.mockResolvedValueOnce({ ok: true, value: { cleanupError: "磁盘暂不可写" } });
  await user.click(await screen.findByRole("button", { name: /测试专利/ }));
  await user.click(screen.getByRole("button", { name: "删除 v4" }));
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  expect(await screen.findByText("快照 v4 已永久删除。")).toBeDefined();
  expect(await screen.findByText(/未使用资源尚未清理.*磁盘暂不可写/)).toBeDefined();
  expect(list).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alertdialog", { name: "永久删除快照" })).toBeNull();
});

test("restores an embedded snapshot through the existing document callback", async () => {
  const user = userEvent.setup();
  const onRestored = vi.fn(async (_documentId: string) => undefined);
  const { restore } = renderManager({ embedded: true, onRestored });
  const manager = await screen.findByRole("region", { name: "快照管理器" });
  await user.click(within(manager).getByRole("button", { name: /测试专利/ }));
  await user.click(within(manager).getByRole("button", { name: "恢复 v4" }));

  expect(
    within(manager)
      .getByRole("alertdialog", { name: "恢复快照" })
      .classList.contains("standard-dialog--s"),
  ).toBe(true);
  await user.click(within(manager).getByRole("button", { name: "确认恢复" }));
  await waitFor(() => expect(restore).toHaveBeenCalledOnce());
  expect(onRestored).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000929");
});

test("hands the restored clone to the application without offering a manual open action", async () => {
  const user = userEvent.setup();
  const onRestored = vi.fn(async (_documentId: string) => undefined);
  const { restore } = renderManager({ onRestored });
  await user.click(await screen.findByRole("button", { name: /测试专利/ }));
  await user.click(screen.getByRole("button", { name: "恢复 v4" }));
  await user.click(screen.getByRole("button", { name: "确认恢复" }));

  await waitFor(() => expect(restore).toHaveBeenCalledOnce());
  expect(onRestored).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000929");
  expect(screen.queryByRole("button", { name: "打开恢复副本" })).toBeNull();
});

test("keeps the manager open and reports when the restored clone cannot be refreshed", async () => {
  const user = userEvent.setup();
  const onRestored = vi.fn(async () => {
    throw new Error("专利库刷新失败");
  });
  renderManager({ onRestored });
  await user.click(await screen.findByRole("button", { name: /测试专利/ }));
  await user.click(screen.getByRole("button", { name: "恢复 v4" }));
  await user.click(screen.getByRole("button", { name: "确认恢复" }));

  expect(await screen.findByRole("dialog", { name: /测试专利/ })).toBeDefined();
  expect(screen.getByRole("alert").textContent).toContain("恢复副本已创建，但专利库刷新失败");
});

test("reports structured IPC failures with the prescribed next action", async () => {
  window.patentApi = {
    snapshot: {
      list: vi.fn(async () => ({
        ok: false as const,
        error: normalizeAppError({ code: "CORRUPT_FILE", message: "损坏" }),
      })),
    },
  } as unknown as PatentApi;
  render(<SnapshotManager open onClose={vi.fn()} onRestored={vi.fn()} />);

  expect((await screen.findByRole("alert")).textContent).toContain("请尝试恢复备份");
});
