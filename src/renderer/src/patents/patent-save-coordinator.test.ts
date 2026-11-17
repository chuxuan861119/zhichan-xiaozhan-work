import { createBlankBookDocument } from "../../../shared/document/defaults";
import type { AssetDescriptor, PatentBookDocument } from "../../../shared/document/model";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import type {
  FlowchartOpenedProject,
  FlowchartSaveRequest,
  PatentApplyAuxiliaryDocumentEditRequest,
  PatentApplyBookEditRequest,
  PatentApplyFigureEditRequest,
  PatentEditAck,
  PatentFlushRequest,
  PatentFlushResult,
  PatentUpdateSettingsRequest,
} from "../../../shared/ipc/contract";
import type { AppResult } from "../../../shared/ipc/result";
import { createBlankPatent } from "../../../shared/patent/defaults";
import type { CanonicalPatent, PatentFigure } from "../../../shared/patent/model";
import {
  ContentFingerprint,
  documentEcho,
  rememberDocumentEcho,
} from "../editor/content-fingerprint";
import { PatentSaveCoordinator } from "./patent-save-coordinator";

test("verification repeats when another edit arrives during the backend flush", async () => {
  let finishFlush!: () => void;
  let finishEdit!: () => void;
  let first = true;
  const flush = vi.fn(
    async (request: PatentFlushRequest): Promise<AppResult<PatentFlushResult>> => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          finishFlush = resolve;
        });
      }
      return {
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision,
          flushedAt: "2026-10-10T00:00:00Z",
        },
      };
    },
  );
  const { coordinator } = createCoordinator({
    flush,
    applyBookEdit: async (request) => {
      await new Promise<void>((resolve) => {
        finishEdit = resolve;
      });
      return {
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-10-10T00:00:00Z",
        },
      };
    },
  });
  let done = false;
  const saving = coordinator.drainAndVerify().then((value) => {
    done = true;
    return value;
  });
  await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
  coordinator.enqueueBookEdit(
    "claims",
    withParagraph(coordinator.snapshot().patent.books[0]!.document, "验证中新增"),
  );
  finishFlush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(done).toBe(false);
  finishEdit();
  expect(await saving).toBe(true);
  expect(flush).toHaveBeenCalledTimes(2);
});

test("deleting imported canonical drawings removes their retained book nodes but preserves standalone images", async () => {
  const patent = createPatent();
  const figure = { figureId: crypto.randomUUID(), assetId: crypto.randomUUID(), widthMm: 80 };
  patent.figures = [figure];
  const book = patent.books.find((book) => book.kind === "description-drawings")!;
  book.document.content = [0, 1].map(() => ({
    id: crypto.randomUUID(),
    type: "figure",
    assetId: figure.assetId,
    widthMm: 80,
    alignment: "center",
  }));
  const standalone = book.document.content[1];
  const { coordinator } = createCoordinator({ initialPatent: patent });
  coordinator.enqueueFigureEdit({
    figures: [],
    abstractDrawingFigureId: null,
    assets: patent.assets,
  });
  await coordinator.flush();
  expect(
    coordinator.snapshot().patent.books.find((book) => book.kind === "description-drawings")
      ?.document.content,
  ).toEqual([standalone]);
  coordinator.enqueueFigureEdit({
    figures: [figure],
    abstractDrawingFigureId: null,
    assets: patent.assets,
  });
  await coordinator.flush();
  expect(
    coordinator.snapshot().patent.books.find((book) => book.kind === "description-drawings")
      ?.document.content,
  ).toEqual([standalone]);
});

test("incremental drawings isolate caller data, retain untouched drawings, and retry the exact ordered edit", async () => {
  const first = drawingProjectFixture("00000000-0000-4000-8000-000000000901");
  const second = { ...first, projectId: "00000000-0000-4000-8000-000000000802" };
  const requests: PatentApplyFigureEditRequest[] = [];
  let fail = true;
  const { coordinator } = createCoordinator({
    initialPatent: { ...createPatent(), drawingProjects: [first, second] },
    applyFigureEdit: async (request) => {
      requests.push(structuredClone(request));
      return fail
        ? { ok: false, error: { code: "INTERNAL", message: "重试" } }
        : {
            ok: true,
            value: {
              patentId: request.patentId,
              revision: request.expectedRevision + 1,
              savedAt: "2026-10-04T00:00:00Z",
            },
          };
    },
  });
  const untouched = coordinator.snapshot().patent.drawingProjects[1];
  const change = {
    ...first,
    revision: 1,
    warnings: ["CAD警告"],
    annotations: first.annotations.map((a) => ({ ...a, x: a.x + 1 })),
  };
  coordinator.enqueueFigureEdit({
    figures: [],
    abstractDrawingFigureId: null,
    assets: [],
    drawingProjectEdits: { projectIds: [second.projectId, first.projectId], projects: [change] },
  });
  change.annotations[0]!.x = 999;
  change.warnings.push("外部修改");
  expect(coordinator.snapshot().patent.drawingProjects[0]).toBe(untouched);
  expect(coordinator.snapshot().patent.drawingProjects[1]?.annotations[0]?.x).toBe(201);
  await vi.waitFor(() => expect(coordinator.snapshot().saveError).not.toBeNull());
  fail = false;
  await coordinator.retry();
  await coordinator.flush();
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[1]?.drawingProjects).toBeUndefined();
  expect(requests[1]?.drawingProjectEdits?.projects).toHaveLength(1);
  coordinator.enqueueFigureEdit({
    figures: [],
    abstractDrawingFigureId: null,
    assets: [],
    drawingProjectEdits: { projectIds: [second.projectId], projects: [] },
  });
  await coordinator.flush();
  expect(requests[2]?.expectedRevision).toBe(1);
  expect(coordinator.snapshot().patent.drawingProjects).toEqual([untouched]);
});

const patentId = "00000000-0000-4000-8000-000000000101";
const sessionId = "00000000-0000-4000-8000-000000000201";

test("figure edits during a mutation retain newly inserted figures and remote replacement metadata", async () => {
  const initial = {
    ...createPatent(),
    figures: [figure(1), figure(2)],
    assets: [asset(1), asset(2)],
  };
  const { coordinator, applyFigureEdit } = createCoordinator({ initialPatent: initial });
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const mutation = coordinator.runPersistedMutation(
    async () => {
      await gate;
      return {
        ok: true as const,
        value: {
          patent: {
            ...initial,
            revision: 1,
            figures: [{ ...figure(1), assetId: asset(4).assetId }, figure(3), figure(2)],
            assets: [asset(1), asset(2), asset(3), asset(4)],
          },
          savedAt: "2026-10-08T00:00:00Z",
        },
      };
    },
    (value) => value,
  );
  coordinator.enqueueFigureEdit({
    figures: [{ ...figure(1), widthMm: 100 }, figure(2)],
    abstractDrawingFigureId: null,
    assets: initial.assets,
  });
  complete();
  expect((await mutation).ok).toBe(true);
  await coordinator.flush();
  const figures = [{ ...figure(1), widthMm: 100, assetId: asset(4).assetId }, figure(3), figure(2)];
  expect(coordinator.snapshot().patent.figures).toEqual(figures);
  expect(applyFigureEdit).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedRevision: 1,
      figures,
      assets: expect.arrayContaining([asset(3), asset(4)]),
    }),
  );
});

test.each(["cancel", "failure"] as const)(
  "a %s mutation releases later book saves without consuming a revision",
  async (outcome) => {
    const { coordinator, applyBookEdit } = createCoordinator();
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const mutation = coordinator.runPersistedMutation(
      async () => {
        await gate;
        return outcome === "cancel"
          ? { ok: true as const, value: null }
          : { ok: false as const, error: { code: "INVALID_INPUT" as const, message: "无法导入" } };
      },
      () => null,
    );
    coordinator.enqueueBookEdit(
      "claims",
      withParagraph(createBlankBookDocument("权利要求书"), "后续正文"),
    );
    expect(applyBookEdit).not.toHaveBeenCalled();
    expect(coordinator.automationStatus().pending).toBe(true);
    let drained = false;
    const drain = coordinator.flush().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    complete();
    expect((await mutation).ok).toBe(outcome === "cancel");
    await drain;
    expect(applyBookEdit).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0 }));
    expect(coordinator.snapshot()).toMatchObject({
      aggregateSaveState: "saved",
      localRevision: 1,
      persistedRevision: 1,
      saveError: null,
    });
  },
);

test.each(["delete", "reorder", "insert"] as const)(
  "rebases a queued figure %s without losing an unseen inserted figure or abstract selection",
  async (operation) => {
    const initial = {
      ...createPatent(),
      figures: [figure(1), figure(2)],
      assets: [asset(1), asset(2)],
    };
    const { coordinator } = createCoordinator({ initialPatent: initial });
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const mutation = coordinator.runPersistedMutation(
      async () => {
        await gate;
        return {
          ok: true as const,
          value: {
            patent: {
              ...initial,
              revision: 1,
              figures: [figure(1), figure(3), figure(2)],
              assets: [...initial.assets, asset(3)],
              abstractDrawingFigureId: figure(3).figureId,
            },
            savedAt: "2026-10-08T00:00:00Z",
          },
        };
      },
      (value) => value,
    );
    const requested =
      operation === "delete"
        ? [figure(2)]
        : operation === "reorder"
          ? [figure(2), figure(1)]
          : [figure(4), figure(1), figure(2)];
    coordinator.enqueueFigureEdit({
      figures: requested,
      abstractDrawingFigureId: null,
      assets: [...initial.assets, ...(operation === "insert" ? [asset(4)] : [])],
    });
    complete();
    expect((await mutation).ok).toBe(true);
    await coordinator.flush();
    expect(coordinator.snapshot().patent.figures).toEqual(
      operation === "delete"
        ? [figure(3), figure(2)]
        : operation === "reorder"
          ? [figure(3), figure(2), figure(1)]
          : [figure(4), figure(1), figure(3), figure(2)],
    );
    expect(coordinator.snapshot().patent.abstractDrawingFigureId).toBe(figure(3).figureId);
  },
);

test("serializes consecutive mutations around coalesced book edits using the confirmed revision", async () => {
  const { coordinator } = createCoordinator();
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const revisions: number[] = [];
  const first = coordinator.runPersistedMutation(
    async (expectedRevision) => {
      revisions.push(expectedRevision);
      await gate;
      return { ok: true as const, value: expectedRevision + 1 };
    },
    (revision, patent) => ({ patent: { ...patent, revision }, savedAt: "2026-10-08T00:00:00Z" }),
  );
  const book = coordinator.snapshot().patent.books[0];
  if (!book) throw new Error("Missing book fixture");
  for (let index = 1; index <= 20; index++) {
    coordinator.enqueueBookEdit("claims", withParagraph(book.document, `正文${index}`));
  }
  const second = coordinator.runPersistedMutation(
    async (expectedRevision) => {
      revisions.push(expectedRevision);
      return { ok: true as const, value: expectedRevision + 1 };
    },
    (revision, patent) => ({ patent: { ...patent, revision }, savedAt: "2026-10-08T00:00:01Z" }),
  );
  complete();
  expect((await first).ok).toBe(true);
  expect((await second).ok).toBe(true);
  await coordinator.flush();
  expect(revisions).toEqual([0, 2]);
  expect(coordinator.snapshot()).toMatchObject({
    localRevision: 3,
    persistedRevision: 3,
    aggregateSaveState: "saved",
  });
  expect(coordinator.snapshot().patent.books[0]).toMatchObject({
    localRevision: 20,
    persistedRevision: 20,
  });
  expect(JSON.stringify(coordinator.snapshot().patent.books[0]?.document)).toContain("正文20");
});

test("a queued name change does not revert a patent type changed by the mutation", async () => {
  const initial = createPatent();
  const { coordinator, updateSettings } = createCoordinator();
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const mutation = coordinator.runPersistedMutation(
    async () => {
      await gate;
      return {
        ok: true as const,
        value: {
          patent: { ...initial, revision: 1, patentType: "utility-model" as const },
          savedAt: "2026-10-08T00:00:00Z",
        },
      };
    },
    (value) => value,
  );
  coordinator.enqueueSettings({ name: "新名称", patentType: "invention" });
  complete();
  expect((await mutation).ok).toBe(true);
  await coordinator.flush();
  expect(updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({ expectedRevision: 1, name: "新名称", patentType: "utility-model" }),
  );
  expect(coordinator.snapshot().patent.patentType).toBe("utility-model");
});

test("a failed earlier book save rejects an awaiting mutation and retains the book for retry", async () => {
  let finish!: (value: AppResult<PatentEditAck>) => void;
  let failed = true;
  const { coordinator } = createCoordinator({
    applyBookEdit: (request) =>
      failed
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({
            ok: true,
            value: {
              patentId,
              revision: request.expectedRevision + 1,
              savedAt: "2026-10-08T00:00:00Z",
            },
          }),
  });
  coordinator.enqueueBookEdit(
    "claims",
    withParagraph(createBlankBookDocument("权利要求书"), "重试保留正文"),
  );
  const work = vi.fn(async () => ({ ok: true as const, value: null }));
  const mutation = coordinator.runPersistedMutation(work, () => null);
  finish({ ok: false, error: { code: "DISK_FULL", message: "磁盘空间不足" } });
  await expect(mutation).resolves.toMatchObject({ ok: false, error: { code: "DISK_FULL" } });
  expect(work).not.toHaveBeenCalled();
  failed = false;
  await coordinator.retry();
  expect(coordinator.snapshot()).toMatchObject({
    aggregateSaveState: "saved",
    localRevision: 1,
    persistedRevision: 1,
  });
  expect(JSON.stringify(coordinator.snapshot().patent.books[0]?.document)).toContain(
    "重试保留正文",
  );
});

test.each(["book", "auxiliary"])(
  "retains local echo provenance on an isolated %s save snapshot",
  async (target) => {
    const { coordinator } = createCoordinator({ initialPatent: createPatentWithAuxiliary() });
    const patent = coordinator.snapshot().patent;
    const base =
      target === "book" ? patent.books[0]?.document : patent.auxiliaryDocuments[0]?.document;
    if (!base) throw Error("fixture");
    const input = { ...withParagraph(base, "保存原文"), modifiedAt: "2030-01-01T00:00:00Z" };
    const fingerprint = new ContentFingerprint({ text: "保存原文" });
    rememberDocumentEcho(input, fingerprint);
    const snapshot =
      target === "book"
        ? coordinator.enqueueBookEdit("claims", input)
        : coordinator.enqueueAuxiliaryDocumentEdit(auxiliaryDocumentId, input);
    const copy =
      target === "book"
        ? snapshot.patent.books[0]?.document
        : snapshot.patent.auxiliaryDocuments[0]?.document;
    expect(copy).not.toBe(input);
    expect(documentEcho(copy)).toBe(fingerprint);
    input.content = [];
    expect(copy?.content).toHaveLength(1);
    await coordinator.flush();
  },
);

function createPatent() {
  return {
    ...createBlankPatent({ patentType: "invention", name: "保存协调测试" }),
    patentId,
    revision: 0,
  };
}

const auxiliaryDocumentId = "00000000-0000-4000-8000-000000000401";

function createPatentWithAuxiliary(): CanonicalPatent {
  const patent = createPatent();
  return {
    ...patent,
    auxiliaryDocuments: [
      {
        auxiliaryDocumentId,
        title: "其他文档 1",
        document: createBlankBookDocument("其他文档 1"),
        editorState: {},
        localRevision: 0,
        persistedRevision: 0,
        sourceFileName: null,
      },
    ],
  };
}

function withSecondAuxiliary(): CanonicalPatent {
  const patent = createPatentWithAuxiliary();
  const first = patent.auxiliaryDocuments[0];
  if (!first) throw new Error("Expected auxiliary fixture.");
  return {
    ...patent,
    auxiliaryDocuments: [
      ...patent.auxiliaryDocuments,
      {
        ...first,
        auxiliaryDocumentId: "00000000-0000-4000-8000-000000000402",
        title: "其他文档 2",
        document: createBlankBookDocument("其他文档 2"),
      },
    ],
  };
}

function withParagraph(document: PatentBookDocument, text: string): PatentBookDocument {
  return {
    ...document,
    content: [
      {
        id: "00000000-0000-4000-8000-000000000301",
        type: "paragraph",
        attrs: {
          alignment: "left",
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text", text, marks: [] }],
      },
    ],
  };
}

function asset(index: number): AssetDescriptor {
  return {
    assetId: `00000000-0000-4000-8001-${index.toString(16).padStart(12, "0")}`,
    kind: "image",
    originalName: `figure-${index}.png`,
    mediaType: "image/png",
    extension: "png",
    byteLength: 10 + index,
    sha256: index.toString(16).toUpperCase().padStart(64, "0"),
    widthPx: 100 + index,
    heightPx: 80 + index,
    previewByteLength: 5 + index,
    previewSha256: (100 + index).toString(16).toUpperCase().padStart(64, "0"),
  };
}

function figure(index: number, descriptor = asset(index)): PatentFigure {
  return {
    figureId: `00000000-0000-4000-8002-${index.toString(16).padStart(12, "0")}`,
    assetId: descriptor.assetId,
    widthMm: 80,
  };
}

function createCoordinator(
  overrides: {
    initialPatent?: ReturnType<typeof createPatent>;
    applyAuxiliaryDocumentEdit?: (
      request: PatentApplyAuxiliaryDocumentEditRequest,
    ) => Promise<AppResult<PatentEditAck>>;
    applyBookEdit?: (request: PatentApplyBookEditRequest) => Promise<AppResult<PatentEditAck>>;
    applyFigureEdit?: (request: PatentApplyFigureEditRequest) => Promise<AppResult<PatentEditAck>>;
    updateSettings?: (request: PatentUpdateSettingsRequest) => Promise<AppResult<PatentEditAck>>;
    flush?: (request: PatentFlushRequest) => Promise<AppResult<PatentFlushResult>>;
    saveFlowchart?: (request: FlowchartSaveRequest) => Promise<AppResult<FlowchartOpenedProject>>;
    onQueued?: (snapshot: ReturnType<PatentSaveCoordinator["snapshot"]>) => void;
    onConfirmed?: (snapshot: ReturnType<PatentSaveCoordinator["snapshot"]>) => void;
    onAutoTitlePersisted?: (snapshot: ReturnType<PatentSaveCoordinator["snapshot"]>) => void;
    onFailed?: (snapshot: ReturnType<PatentSaveCoordinator["snapshot"]>) => void;
    onRetrying?: (snapshot: ReturnType<PatentSaveCoordinator["snapshot"]>) => void;
  } = {},
) {
  const applyBookEdit =
    overrides.applyBookEdit ??
    vi.fn(
      async (request: PatentApplyBookEditRequest): Promise<AppResult<PatentEditAck>> => ({
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: `2026-08-02T00:00:0${request.expectedRevision + 1}.000Z`,
        },
      }),
    );
  const applyAuxiliaryDocumentEdit =
    overrides.applyAuxiliaryDocumentEdit ??
    vi.fn(
      async (
        request: PatentApplyAuxiliaryDocumentEditRequest,
      ): Promise<AppResult<PatentEditAck>> => ({
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: `2026-08-02T00:00:0${request.expectedRevision + 1}.000Z`,
        },
      }),
    );
  const applyFigureEdit =
    overrides.applyFigureEdit ??
    vi.fn(
      async (request: PatentApplyFigureEditRequest): Promise<AppResult<PatentEditAck>> => ({
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: `2026-08-02T00:00:0${request.expectedRevision + 1}.000Z`,
        },
      }),
    );
  const flush =
    overrides.flush ??
    vi.fn(
      async (request: PatentFlushRequest): Promise<AppResult<PatentFlushResult>> => ({
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision,
          flushedAt: "2026-08-02T00:10:00.000Z",
        },
      }),
    );
  const updateSettings =
    overrides.updateSettings ??
    vi.fn(
      async (request: PatentUpdateSettingsRequest): Promise<AppResult<PatentEditAck>> => ({
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: `2026-08-02T00:00:0${request.expectedRevision + 1}.000Z`,
        },
      }),
    );
  const coordinator = new PatentSaveCoordinator({
    patentId,
    sessionId,
    initialPatent: overrides.initialPatent ?? createPatent(),
    applyBookEdit,
    applyAuxiliaryDocumentEdit,
    applyFigureEdit,
    updateSettings,
    flush,
    ...(overrides.saveFlowchart ? { saveFlowchart: overrides.saveFlowchart } : {}),
    ...(overrides.onQueued ? { onQueued: overrides.onQueued } : {}),
    ...(overrides.onConfirmed ? { onConfirmed: overrides.onConfirmed } : {}),
    ...(overrides.onAutoTitlePersisted
      ? { onAutoTitlePersisted: overrides.onAutoTitlePersisted }
      : {}),
    ...(overrides.onFailed ? { onFailed: overrides.onFailed } : {}),
    ...(overrides.onRetrying ? { onRetrying: overrides.onRetrying } : {}),
  });

  return {
    coordinator,
    applyBookEdit,
    applyAuxiliaryDocumentEdit,
    applyFigureEdit,
    updateSettings,
    flush,
  };
}

describe("patent save coordinator", () => {
  test("coalesces rapid pending edits to one auxiliary document", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const applyAuxiliaryDocumentEdit = vi.fn(
      async (request: PatentApplyAuxiliaryDocumentEditRequest) => {
        if (request.expectedRevision === 0) await firstPending;
        return {
          ok: true as const,
          value: {
            patentId: request.patentId,
            revision: request.expectedRevision + 1,
            savedAt: "2026-08-31T00:00:00.000Z",
          },
        };
      },
    );
    const { coordinator } = createCoordinator({
      initialPatent: createPatentWithAuxiliary(),
      applyAuxiliaryDocumentEdit,
    });
    const document = createBlankBookDocument("其他文档 1");

    coordinator.enqueueAuxiliaryDocumentEdit(
      auxiliaryDocumentId,
      withParagraph(document, "第一次"),
    );
    await Promise.resolve();
    coordinator.enqueueAuxiliaryDocumentEdit(
      auxiliaryDocumentId,
      withParagraph(document, "第二次"),
    );
    coordinator.enqueueAuxiliaryDocumentEdit(
      auxiliaryDocumentId,
      withParagraph(document, "最终内容"),
    );
    releaseFirst?.();
    await coordinator.flush();

    expect(applyAuxiliaryDocumentEdit).toHaveBeenCalledTimes(2);
    expect(applyAuxiliaryDocumentEdit.mock.calls[1]?.[0]).toMatchObject({
      auxiliaryDocumentId,
      expectedRevision: 1,
      document: { content: [{ content: [{ text: "最终内容" }] }] },
    });
    expect(coordinator.snapshot().patent.revision).toBe(2);
    expect(coordinator.snapshot().auxiliarySaveStates?.[auxiliaryDocumentId]).toBe("saved");
  });

  test("serializes edits to different auxiliary documents by patent revision", async () => {
    const applyAuxiliaryDocumentEdit = vi.fn(
      async (request: PatentApplyAuxiliaryDocumentEditRequest) => ({
        ok: true as const,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-08-31T00:00:00.000Z",
        },
      }),
    );
    const { coordinator } = createCoordinator({
      initialPatent: withSecondAuxiliary(),
      applyAuxiliaryDocumentEdit,
    });

    for (const [id, title] of [
      [auxiliaryDocumentId, "其他文档 1"],
      ["00000000-0000-4000-8000-000000000402", "其他文档 2"],
    ] as const) {
      coordinator.enqueueAuxiliaryDocumentEdit(
        id,
        withParagraph(createBlankBookDocument(title), title),
      );
    }
    await coordinator.flush();

    expect(
      applyAuxiliaryDocumentEdit.mock.calls.map(([request]) => request.expectedRevision),
    ).toEqual([0, 1]);
    expect(coordinator.snapshot()).toMatchObject({
      localRevision: 2,
      persistedRevision: 2,
      aggregateSaveState: "saved",
    });
  });

  test("retains an unsaved auxiliary edit after persistence fails", async () => {
    const { coordinator } = createCoordinator({
      initialPatent: createPatentWithAuxiliary(),
      applyAuxiliaryDocumentEdit: vi.fn(async () => ({
        ok: false as const,
        error: { code: "DISK_FULL" as const, message: "磁盘写入失败。" },
      })),
    });
    const document = withParagraph(createBlankBookDocument("其他文档 1"), "未保存内容");

    coordinator.enqueueAuxiliaryDocumentEdit(auxiliaryDocumentId, document);
    await expect(coordinator.flush()).rejects.toMatchObject({ code: "DISK_FULL" });

    const snapshot = coordinator.snapshot();
    expect(snapshot.auxiliarySaveStates?.[auxiliaryDocumentId]).toBe("failed");
    expect(snapshot.patent.auxiliaryDocuments[0]).toMatchObject({
      document: { content: [{ content: [{ text: "未保存内容" }] }] },
      localRevision: 1,
      persistedRevision: 0,
    });
  });

  test("serializes book, flowchart source, and figure edits through one expected revision", async () => {
    const calls: string[] = [];
    const projectId = "00000000-0000-4000-8000-000000000501";
    const saveFlowchart = vi.fn(async (request: FlowchartSaveRequest) => {
      calls.push(`flowchart:${request.expectedPatentRevision}`);
      return {
        ok: true as const,
        value: {
          project: {
            projectId,
            name: "工程",
            revision: 1,
            pageCount: 1,
            lastPageId: "p1",
            sourceSha256: "A".repeat(64),
            createdAt: "2026-08-11T00:00:00.000Z",
            modifiedAt: "2026-08-11T00:00:01.000Z",
          },
          source: request.source,
          patentRevision: request.expectedPatentRevision + 1,
        },
      };
    });
    const { coordinator } = createCoordinator({
      saveFlowchart,
      applyBookEdit: vi.fn(async (request) => {
        calls.push(`book:${request.expectedRevision}`);
        return {
          ok: true as const,
          value: {
            patentId,
            revision: request.expectedRevision + 1,
            savedAt: "2026-08-11T00:00:01.000Z",
          },
        };
      }),
      applyFigureEdit: vi.fn(async (request) => {
        calls.push(`figure:${request.expectedRevision}`);
        return {
          ok: true as const,
          value: {
            patentId,
            revision: request.expectedRevision + 1,
            savedAt: "2026-08-11T00:00:03.000Z",
          },
        };
      }),
    });
    const patent = coordinator.snapshot().patent;
    const claims = patent.books[0];
    if (!claims) throw new Error("fixture");
    coordinator.enqueueBookEdit("claims", withParagraph(claims.document, "先保存文本"));
    coordinator.enqueueFlowchartSource({
      projectId,
      expectedProjectRevision: 0,
      source: Uint8Array.from(Buffer.from('<mxfile><diagram id="p1">x</diagram></mxfile>')),
      pageCount: 1,
      lastPageId: "p1",
    });
    const image = asset(1);
    coordinator.enqueueFigureEdit({
      figures: [figure(1, image)],
      abstractDrawingFigureId: null,
      assets: [image],
    });
    await coordinator.flush();
    expect(calls).toEqual(["book:0", "flowchart:1", "figure:2"]);
    expect(coordinator.snapshot()).toMatchObject({ persistedRevision: 3, patent: { revision: 3 } });
  });

  test("settles a flowchart source save when the source is unchanged", async () => {
    const projectId = "00000000-0000-4000-8000-000000000511";
    const saveFlowchart = vi.fn(async (request: FlowchartSaveRequest) => ({
      ok: true as const,
      value: {
        project: {
          projectId,
          name: "未变更工程",
          revision: request.expectedProjectRevision,
          pageCount: request.pageCount,
          lastPageId: request.lastPageId,
          sourceSha256: "B".repeat(64),
          createdAt: "2026-08-11T00:00:00.000Z",
          modifiedAt: "2026-08-11T00:00:01.000Z",
        },
        source: request.source,
        patentRevision: request.expectedPatentRevision,
      },
    }));
    const { coordinator } = createCoordinator({ saveFlowchart });

    coordinator.enqueueFlowchartSource({
      projectId,
      expectedProjectRevision: 1,
      source: Uint8Array.from(Buffer.from('<mxfile><diagram id="p1">same</diagram></mxfile>')),
      pageCount: 1,
      lastPageId: "p1",
    });
    await coordinator.flush();

    expect(coordinator.snapshot()).toMatchObject({
      aggregateSaveState: "saved",
      localRevision: 0,
      persistedRevision: 0,
      patent: { revision: 0 },
    });
  });

  test("rebases a later figure edit after an unchanged flowchart save", async () => {
    const projectId = "00000000-0000-4000-8000-000000000512";
    const saveFlowchart = vi.fn(async (request: FlowchartSaveRequest) => ({
      ok: true as const,
      value: {
        project: {
          projectId,
          name: "未变更工程",
          revision: request.expectedProjectRevision,
          pageCount: request.pageCount,
          lastPageId: request.lastPageId,
          sourceSha256: "C".repeat(64),
          createdAt: "2026-08-11T00:00:00.000Z",
          modifiedAt: "2026-08-11T00:00:01.000Z",
        },
        source: request.source,
        patentRevision: request.expectedPatentRevision,
      },
    }));
    const { coordinator, applyFigureEdit } = createCoordinator({ saveFlowchart });
    const image = asset(12);

    coordinator.enqueueFlowchartSource({
      projectId,
      expectedProjectRevision: 1,
      source: Uint8Array.from(Buffer.from('<mxfile><diagram id="p1">same</diagram></mxfile>')),
      pageCount: 1,
      lastPageId: "p1",
    });
    coordinator.enqueueFigureEdit({
      figures: [figure(12, image)],
      abstractDrawingFigureId: null,
      assets: [image],
    });
    await coordinator.flush();

    expect(applyFigureEdit).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0 }));
    expect(coordinator.snapshot()).toMatchObject({
      aggregateSaveState: "saved",
      localRevision: 1,
      persistedRevision: 1,
      patent: { revision: 1 },
    });
  });

  test("saves reference marks and multiple books in one settings revision", async () => {
    const updateSettings = vi.fn(async (request: PatentUpdateSettingsRequest) => ({
      ok: true as const,
      value: {
        patentId: request.patentId,
        revision: request.expectedRevision + 1,
        savedAt: "2026-08-07T00:00:00.000Z",
      },
    }));
    const { coordinator } = createCoordinator({ updateSettings });
    const patent = coordinator.snapshot().patent;
    const bookEdits = patent.books
      .filter((book) => ["claims", "description", "abstract"].includes(book.kind))
      .map((book) => ({
        bookKind: book.kind,
        document: withParagraph(book.document, book.kind === "claims" ? "箱体(1)" : "箱体1和箱体"),
        editorState: book.editorState,
      }));
    coordinator.enqueueReferenceMarkTransaction({
      referenceMarks: [
        { referenceMarkId: "00000000-0000-4000-8000-000000009999", number: 1, keyword: "箱体" },
      ],
      referenceMarkSettings: { synchronizedEditingEnabled: false },
      bookEdits,
    });
    await coordinator.flush();
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ referenceMarks: expect.any(Array), bookEdits }),
    );
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().patent.revision).toBe(1);
    for (const edit of bookEdits) {
      expect(
        coordinator.snapshot().patent.books.find((book) => book.kind === edit.bookKind)?.document,
      ).toEqual(edit.document);
    }
  });

  test("notifies after an automatically recognized title is persisted", async () => {
    const titlePersisted = vi.fn();
    const { coordinator } = createCoordinator({ onAutoTitlePersisted: titlePersisted });

    coordinator.enqueueSettings({
      name: "自动识别的题目",
      patentType: "invention",
      autoTitleRecognition: true,
    });

    expect(titlePersisted).not.toHaveBeenCalled();
    await coordinator.flush();

    expect(titlePersisted).toHaveBeenCalledOnce();
    expect(titlePersisted).toHaveBeenCalledWith(
      expect.objectContaining({
        patent: expect.objectContaining({ name: "自动识别的题目" }),
        aggregateSaveState: "saved",
      }),
    );
  });
  test("sends an immutable aggregate asset snapshot with a book edit", async () => {
    const { coordinator, applyBookEdit } = createCoordinator();
    const description = coordinator
      .snapshot()
      .patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const preview = asset(91);
    const chemicalDocument: PatentBookDocument = {
      ...description.document,
      content: [
        {
          id: "00000000-0000-4000-8000-000000000391",
          type: "chemical-structure",
          ketSource: "(ket) (atom C)",
          previewAssetId: preview.assetId,
          widthMm: 80,
          alignment: "center",
        },
      ],
    };

    coordinator.enqueueBookEdit("description", chemicalDocument, {}, [preview]);
    preview.originalName = "mutated-after-enqueue.png";
    await coordinator.flush();

    expect(applyBookEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        bookKind: "description",
        document: chemicalDocument,
        assets: [expect.objectContaining({ originalName: "figure-91.png" })],
      }),
    );
  });

  test("keeps a chemical book asset snapshot through a revision-conflict retry", async () => {
    const applyBookEdit = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "REVISION_CONFLICT", message: "revision changed" },
      })
      .mockImplementation(async (request: PatentApplyBookEditRequest) => ({
        ok: true as const,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-08-04T00:00:00.000Z",
        },
      }));
    const { coordinator } = createCoordinator({ applyBookEdit });
    const description = coordinator
      .snapshot()
      .patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const preview = asset(92);
    const document: PatentBookDocument = {
      ...description.document,
      content: [
        {
          id: "00000000-0000-4000-8000-000000000392",
          type: "chemical-structure",
          ketSource: "(ket) (atom N)",
          previewAssetId: preview.assetId,
          widthMm: 80,
          alignment: "center",
        },
      ],
    };

    coordinator.enqueueBookEdit("description", document, {}, [preview]);
    await expect(coordinator.flush()).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await coordinator.retry();

    expect(applyBookEdit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(applyBookEdit).mock.calls.map(([request]) => request)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ document, assets: [preview] }),
        expect.objectContaining({ document, assets: [preview] }),
      ]),
    );
  });

  test("does not serialize whole documents to detect an edit when their timestamps already differ", async () => {
    const { coordinator } = createCoordinator();
    const book = coordinator.snapshot().patent.books.find((book) => book.kind === "description");
    if (!book) throw new Error("Missing description fixture");
    const input = {
      ...withParagraph(book.document, "新内容"),
      modifiedAt: "2030-01-01T00:00:00.000Z",
    };
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      coordinator.enqueueBookEdit("description", input);
      expect(
        stringify.mock.calls.some(
          ([value]) => value && typeof value === "object" && "content" in value,
        ),
      ).toBe(false);
    } finally {
      stringify.mockRestore();
    }
    await coordinator.flush();
    expect(
      coordinator.snapshot().patent.books.find((book) => book.kind === "description")?.document,
    ).toEqual(input);
  });

  test("coalesces 300 consecutive pending book edits without losing the latest local revision", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applyBookEdit = vi.fn(async (request: PatentApplyBookEditRequest) => {
      await blocked;
      return {
        ok: true as const,
        value: {
          patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-09-11T00:00:00.000Z",
        },
      };
    });
    const { coordinator, flush } = createCoordinator({ applyBookEdit });
    const book = coordinator.snapshot().patent.books.find((book) => book.kind === "description");
    if (!book) throw new Error("Missing description fixture");
    for (let i = 1; i <= 300; i++)
      coordinator.enqueueBookEdit("description", withParagraph(book.document, `内容${i}`));
    expect(applyBookEdit).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().localRevision).toBe(2);
    let drained = false;
    const draining = coordinator.drainAndVerify().then((ok) => {
      drained = true;
      return ok;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await expect(draining).resolves.toBe(true);
    expect(applyBookEdit).toHaveBeenCalledTimes(2);
    expect(applyBookEdit.mock.calls.map(([request]) => request.expectedRevision)).toEqual([0, 1]);
    expect(applyBookEdit.mock.calls[1]?.[0].document).toEqual(
      withParagraph(book.document, "内容300"),
    );
    expect(coordinator.snapshot()).toMatchObject({
      localRevision: 2,
      persistedRevision: 2,
      aggregateSaveState: "saved",
    });
    expect(
      coordinator.snapshot().patent.books.find((book) => book.kind === "description"),
    ).toMatchObject({
      localRevision: book.localRevision + 300,
      persistedRevision: book.localRevision + 300,
    });
    expect(flush).toHaveBeenCalledWith({ patentId, expectedRevision: 2 });
  });

  test("edits arriving while a merged save is in flight keep flush waiting for the newest state", async () => {
    const releases: Array<() => void> = [];
    const applyBookEdit = vi.fn(async (request: PatentApplyBookEditRequest) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return {
        ok: true as const,
        value: {
          patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-09-11T00:00:00.000Z",
        },
      };
    });
    const { coordinator } = createCoordinator({ applyBookEdit });
    const book = coordinator.snapshot().patent.books.find((book) => book.kind === "description");
    if (!book) throw new Error("Missing description fixture");
    const write = (text: string) =>
      coordinator.enqueueBookEdit(
        "description",
        withParagraph(book.document, text),
        { selection: text },
        [asset(1)],
      );
    write("一");
    write("二");
    write("三");
    let drained = false;
    const draining = coordinator.drainAndVerify().then((ok) => {
      drained = true;
      return ok;
    });
    releases[0]?.();
    await vi.waitFor(() => expect(applyBookEdit).toHaveBeenCalledTimes(2));
    write("四");
    write("五");
    expect(applyBookEdit.mock.calls[1]?.[0].document).toEqual(withParagraph(book.document, "三"));
    releases[1]?.();
    await vi.waitFor(() => expect(applyBookEdit).toHaveBeenCalledTimes(3));
    expect(drained).toBe(false);
    expect(coordinator.snapshot().aggregateSaveState).toBe("saving");
    expect(applyBookEdit.mock.calls[2]?.[0]).toMatchObject({
      document: withParagraph(book.document, "五"),
      editorState: { selection: "五" },
      assets: [asset(1)],
      expectedRevision: 2,
    });
    releases[2]?.();
    await expect(draining).resolves.toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      localRevision: 3,
      persistedRevision: 3,
      aggregateSaveState: "saved",
    });
  });

  test("a settings transaction after coalesced edits preserves monotonic book revisions and later acknowledgements", async () => {
    const { coordinator } = createCoordinator();
    const book = coordinator.snapshot().patent.books.find((book) => book.kind === "description");
    if (!book) throw new Error("Missing description fixture");
    for (let i = 1; i <= 20; i++)
      coordinator.enqueueBookEdit("description", withParagraph(book.document, `正文${i}`));
    coordinator.enqueueSettings({
      patentType: "utility-model",
      bookEdits: [
        {
          bookKind: "description",
          document: withParagraph(book.document, "本实用新型"),
          editorState: {},
        },
      ],
    });
    expect(
      coordinator.snapshot().patent.books.find((book) => book.kind === "description")
        ?.localRevision,
    ).toBe(book.localRevision + 21);
    coordinator.enqueueBookEdit("description", withParagraph(book.document, "本实用新型后续输入"));
    await coordinator.flush();
    expect(
      coordinator.snapshot().patent.books.find((book) => book.kind === "description"),
    ).toMatchObject({
      localRevision: book.localRevision + 22,
      persistedRevision: book.localRevision + 22,
    });
    expect(coordinator.snapshot()).toMatchObject({
      localRevision: 4,
      persistedRevision: 4,
      aggregateSaveState: "saved",
    });
  });

  test("queued snapshots retain their content after caller mutations, later edits and acknowledgements", async () => {
    const { coordinator } = createCoordinator();
    const book = coordinator.snapshot().patent.books.find((book) => book.kind === "description");
    if (!book) throw new Error("Missing description fixture");
    const input = withParagraph(book.document, "第一版");
    const first = coordinator.enqueueBookEdit("description", input);
    const captured = structuredClone(first.patent);
    input.content = [];
    coordinator.enqueueBookEdit("description", withParagraph(book.document, "第二版"));
    coordinator.enqueueBookEdit("description", withParagraph(book.document, "第三版"));
    await coordinator.flush();
    expect(first.patent).toEqual(captured);
    expect(coordinator.snapshot().patent.books.find((book) => book.kind === "claims")).toBe(
      first.patent.books.find((book) => book.kind === "claims"),
    );
    expect(coordinator.snapshot().aggregateSaveState).toBe("saved");
  });

  test("never replaces a failed sent book edit and retries it before the latest pending edit", async () => {
    const requests: PatentApplyBookEditRequest[] = [];
    let fail = true;
    const { coordinator } = createCoordinator({
      applyBookEdit: async (request) => {
        requests.push(request);
        if (fail) return { ok: false, error: { code: "DISK_FULL", message: "full" } };
        return {
          ok: true,
          value: {
            patentId,
            revision: request.expectedRevision + 1,
            savedAt: "2026-09-11T00:00:00.000Z",
          },
        };
      },
    });
    const book = coordinator.snapshot().patent.books.find((book) => book.kind === "description");
    if (!book) throw new Error("Missing description fixture");
    coordinator.enqueueBookEdit("description", withParagraph(book.document, "失败版本"));
    await expect(coordinator.drainAndVerify()).resolves.toBe(false);
    coordinator.enqueueBookEdit("description", withParagraph(book.document, "后续版本"));
    coordinator.enqueueBookEdit("description", withParagraph(book.document, "最终版本"));
    fail = false;
    await coordinator.retry();
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]?.document).toEqual(withParagraph(book.document, "最终版本"));
    expect(coordinator.snapshot()).toMatchObject({
      localRevision: 2,
      persistedRevision: 2,
      aggregateSaveState: "saved",
    });
  });

  test("book coalescing respects other books, settings, figures and explicit transaction boundaries", async () => {
    const { coordinator, applyBookEdit, applyFigureEdit, updateSettings } = createCoordinator();
    const book = coordinator.snapshot().patent.books.find((book) => book.kind === "description");
    if (!book) throw new Error("Missing description fixture");
    const write = (text: string) =>
      coordinator.enqueueBookEdit("description", withParagraph(book.document, text));
    write("在途");
    write("边界前");
    coordinator.enqueueBookEdit("claims", withParagraph(book.document, "另一本书"));
    write("设置前");
    coordinator.enqueueSettings({ patentType: "utility-model" });
    write("附图前");
    coordinator.enqueueFigureEdit({
      figures: [figure(1)],
      abstractDrawingFigureId: null,
      assets: [asset(1)],
    });
    coordinator.enqueueTransaction([
      { bookKind: "description", document: withParagraph(book.document, "事务"), editorState: {} },
    ]);
    write("可替换");
    write("最终");
    await coordinator.flush();
    expect(applyBookEdit).toHaveBeenCalledTimes(7);
    expect(applyFigureEdit).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applyBookEdit).mock.calls.map(([r]) => r.expectedRevision)).toEqual([
      0, 1, 2, 3, 5, 7, 8,
    ]);
    expect(coordinator.snapshot()).toMatchObject({
      localRevision: 9,
      persistedRevision: 9,
      aggregateSaveState: "saved",
    });
  });

  test("queues normal typing only for the active book and advances aggregate revisions in order", async () => {
    const { coordinator, applyBookEdit } = createCoordinator();
    const claims = coordinator.snapshot().patent.books.find((book) => book.kind === "claims");
    const description = coordinator
      .snapshot()
      .patent.books.find((book) => book.kind === "description");
    expect(claims).toBeDefined();
    expect(description).toBeDefined();
    if (!claims || !description) return;

    coordinator.enqueueBookEdit("claims", withParagraph(claims.document, "1. 一种夹具。"), {
      selection: "claims",
    });
    coordinator.enqueueBookEdit(
      "description",
      withParagraph(description.document, "本发明涉及夹具。"),
      { selection: "description" },
    );

    expect(coordinator.snapshot()).toMatchObject({
      aggregateSaveState: "saving",
      localRevision: 2,
      persistedRevision: 0,
    });
    expect(coordinator.snapshot().bookSaveStates).toMatchObject({
      claims: "saving",
      description: "saving",
    });

    await coordinator.flush();

    expect(applyBookEdit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(applyBookEdit).mock.calls.map(([request]) => request.bookKind)).toEqual([
      "claims",
      "description",
    ]);
    expect(
      vi.mocked(applyBookEdit).mock.calls.map(([request]) => request.expectedRevision),
    ).toEqual([0, 1]);
    expect(coordinator.snapshot()).toMatchObject({
      aggregateSaveState: "saved",
      localRevision: 2,
      persistedRevision: 2,
    });
  });

  test("applies cross-book transactions as one queued burst before reporting the patent saved", async () => {
    const confirmed: Array<ReturnType<PatentSaveCoordinator["snapshot"]>> = [];
    const { coordinator, applyBookEdit } = createCoordinator({
      onConfirmed: (snapshot) => confirmed.push(snapshot),
    });
    const snapshot = coordinator.snapshot();
    const claims = snapshot.patent.books.find((book) => book.kind === "claims");
    const abstract = snapshot.patent.books.find((book) => book.kind === "abstract");
    expect(claims).toBeDefined();
    expect(abstract).toBeDefined();
    if (!claims || !abstract) return;

    coordinator.enqueueTransaction([
      {
        bookKind: "claims",
        document: withParagraph(claims.document, "1. 一种夹具。"),
        editorState: {},
      },
      {
        bookKind: "abstract",
        document: withParagraph(abstract.document, "本摘要记载夹具。"),
        editorState: {},
      },
    ]);

    await coordinator.flush();

    expect(applyBookEdit).toHaveBeenCalledTimes(2);
    expect(confirmed.at(-1)).toMatchObject({
      aggregateSaveState: "saved",
      persistedRevision: 2,
    });
  });

  test("queues patent figure state and persists it as an aggregate revision", async () => {
    const descriptor = asset(1);
    const drawing = figure(1, descriptor);
    const { coordinator, applyFigureEdit } = createCoordinator();

    coordinator.enqueueFigureEdit({
      figures: [drawing],
      abstractDrawingFigureId: drawing.figureId,
      assets: [descriptor],
    });

    expect(coordinator.snapshot()).toMatchObject({
      aggregateSaveState: "saving",
      localRevision: 1,
      patent: {
        figures: [drawing],
        abstractDrawingFigureId: drawing.figureId,
        assets: [descriptor],
      },
    });

    await coordinator.flush();

    expect(applyFigureEdit).toHaveBeenCalledWith({
      patentId,
      sessionId,
      expectedRevision: 0,
      figures: [drawing],
      abstractDrawingFigureId: drawing.figureId,
      assets: [descriptor],
    });
    expect(coordinator.snapshot()).toMatchObject({
      aggregateSaveState: "saved",
      persistedRevision: 1,
    });
  });

  test("ignores legacy linked-description data on a figure edit", async () => {
    const descriptor = asset(1);
    const drawing = figure(1, descriptor);
    const { coordinator, applyFigureEdit } = createCoordinator();
    const description = coordinator
      .snapshot()
      .patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const changedDescription = withParagraph(description.document, "图1为整体结构示意图。");

    const originalDescription = structuredClone(description);
    coordinator.enqueueFigureEdit({
      figures: [drawing],
      abstractDrawingFigureId: drawing.figureId,
      assets: [descriptor],
      descriptionEdit: {
        document: changedDescription,
        editorState: { unlinkedFigureExplanations: [] },
      },
    } as unknown as Parameters<typeof coordinator.enqueueFigureEdit>[0]);

    expect(coordinator.snapshot()).toMatchObject({
      aggregateSaveState: "saving",
      localRevision: 1,
      patent: {
        figures: [drawing],
      },
    });
    expect(coordinator.snapshot().patent.books.find((book) => book.kind === "description")).toEqual(
      originalDescription,
    );

    await coordinator.flush();

    expect(applyFigureEdit).toHaveBeenCalledWith({
      patentId,
      sessionId,
      expectedRevision: 0,
      figures: [drawing],
      abstractDrawingFigureId: drawing.figureId,
      assets: [descriptor],
    });
    expect(coordinator.snapshot()).toMatchObject({
      aggregateSaveState: "saved",
      persistedRevision: 1,
      bookSaveStates: { description: "saved" },
    });
  });

  test("serializes settings between pending and later book edits with current revisions", async () => {
    const order: string[] = [];
    const { coordinator, applyBookEdit, updateSettings } = createCoordinator({
      applyBookEdit: vi.fn(async (request: PatentApplyBookEditRequest) => {
        order.push(`book:${request.expectedRevision}`);
        return {
          ok: true as const,
          value: {
            patentId: request.patentId,
            revision: request.expectedRevision + 1,
            savedAt: "2026-08-02T00:00:01.000Z",
          },
        };
      }),
      updateSettings: vi.fn(async (request: PatentUpdateSettingsRequest) => {
        order.push(`settings:${request.expectedRevision}`);
        return {
          ok: true as const,
          value: {
            patentId: request.patentId,
            revision: request.expectedRevision + 1,
            savedAt: "2026-08-02T00:00:02.000Z",
          },
        };
      }),
    });
    const claims = coordinator.snapshot().patent.books.find((book) => book.kind === "claims");
    const abstract = coordinator.snapshot().patent.books.find((book) => book.kind === "abstract");
    if (!claims || !abstract) throw new Error("fixture");

    coordinator.enqueueBookEdit("claims", withParagraph(claims.document, "1. 一种夹具。"));
    coordinator.enqueueSettings({ name: "新名称", patentType: "utility-model" });
    coordinator.enqueueBookEdit("abstract", withParagraph(abstract.document, "夹具摘要。"));
    await coordinator.flush();

    expect(order).toEqual(["book:0", "settings:1", "book:2"]);
    expect(applyBookEdit).toHaveBeenCalledTimes(2);
    expect(updateSettings).toHaveBeenCalledWith({
      patentId,
      expectedRevision: 1,
      name: "新名称",
      patentType: "utility-model",
    });
    expect(coordinator.snapshot()).toMatchObject({
      localRevision: 3,
      persistedRevision: 3,
      aggregateSaveState: "saved",
      patent: { name: "新名称", patentType: "utility-model" },
    });
  });

  test("persists terminology book edits with metadata as one settings revision", async () => {
    const { coordinator, updateSettings } = createCoordinator();
    const description = coordinator
      .snapshot()
      .patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const changedDescription = withParagraph(description.document, "本实用新型涉及夹具。");

    coordinator.enqueueSettings({
      name: "替换后的专利",
      patentType: "utility-model",
      bookEdits: [
        {
          bookKind: "description",
          document: changedDescription,
          editorState: description.editorState,
        },
      ],
    });
    expect(coordinator.snapshot().bookSaveStates.description).toBe("saving");
    await coordinator.flush();

    expect(updateSettings).toHaveBeenCalledWith({
      patentId,
      expectedRevision: 0,
      name: "替换后的专利",
      patentType: "utility-model",
      bookEdits: [
        {
          bookKind: "description",
          document: changedDescription,
          editorState: description.editorState,
        },
      ],
    });
    expect(coordinator.snapshot()).toMatchObject({
      persistedRevision: 1,
      aggregateSaveState: "saved",
      bookSaveStates: { description: "saved" },
    });
  });

  test("keeps failed edits queued and retries them before persistence drain verification", async () => {
    const applyBookEdit = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "DISK_FULL", message: "磁盘空间不足" },
      })
      .mockImplementation(async (request: PatentApplyBookEditRequest) => ({
        ok: true as const,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-08-02T00:00:01.000Z",
        },
      }));
    const { coordinator, flush } = createCoordinator({ applyBookEdit });
    const description = coordinator
      .snapshot()
      .patent.books.find((book) => book.kind === "description");
    expect(description).toBeDefined();
    if (!description) return;

    coordinator.enqueueBookEdit(
      "description",
      withParagraph(description.document, "失败后重试。"),
      {},
    );
    await expect(coordinator.drainAndVerify()).resolves.toBe(false);
    expect(flush).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({
      aggregateSaveState: "failed",
      persistedRevision: 0,
    });

    await coordinator.retry();
    await expect(coordinator.drainAndVerify()).resolves.toBe(true);

    expect(applyBookEdit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(applyBookEdit).mock.calls[1]?.[0]).toMatchObject({
      bookKind: "description",
      expectedRevision: 0,
    });
    expect(flush).toHaveBeenCalledWith({ patentId, expectedRevision: 1 });
  });

  test("returns to saved after retrying a failed persistence verification with no queued edit", async () => {
    const flush = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "INTERNAL", message: "暂时无法核验保存状态" },
      })
      .mockResolvedValue({
        ok: true as const,
        value: {
          patentId,
          revision: 0,
          flushedAt: "2026-08-02T00:10:00.000Z",
        },
      });
    const { coordinator } = createCoordinator({ flush });

    await expect(coordinator.drainAndVerify()).resolves.toBe(false);
    expect(coordinator.snapshot().aggregateSaveState).toBe("failed");

    await coordinator.retry();
    await expect(coordinator.drainAndVerify()).resolves.toBe(true);

    expect(coordinator.snapshot()).toMatchObject({
      aggregateSaveState: "saved",
      localRevision: 0,
      persistedRevision: 0,
    });
  });
});

describe("automation save barrier", () => {
  test("freeze rejects new edits while pending saves still drain and stale release is ignored", async () => {
    let finish!: (result: AppResult<PatentEditAck>) => void;
    const { coordinator } = createCoordinator({
      applyBookEdit: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const document = withParagraph(createBlankBookDocument("测试"), "用户修改");
    coordinator.enqueueBookEdit("claims", document);
    expect(coordinator.freeze("owner")).toBe(true);
    expect(coordinator.automationStatus().dirty).toBe(true);
    expect(coordinator.freeze("other")).toBe(false);
    expect(() =>
      coordinator.enqueueSettings({ patentType: "invention", name: "不应写入" }),
    ).toThrow();
    expect(coordinator.releaseFreeze("stale")).toBe(false);
    const draining = coordinator.drainAndVerify();
    finish({ ok: true, value: { patentId, revision: 1, savedAt: "2026-10-02T00:00:00.000Z" } });
    expect(await draining).toBe(true);
    expect(coordinator.automationStatus()).toEqual({ frozen: true, pending: false, dirty: false });
    expect(coordinator.snapshot().patent.name).toBe("保存协调测试");
    const persisted = { ...coordinator.snapshot().patent, revision: 2, name: "agent修改" };
    expect(
      coordinator.adoptPersistedPatent(persisted, persisted.modifiedAt).persistedRevision,
    ).toBe(2);
    expect(coordinator.releaseFreeze("owner")).toBe(true);
    coordinator.enqueueSettings({ patentType: "invention", name: "用户继续编辑" });
    expect(coordinator.snapshot().patent.name).toBe("用户继续编辑");
  });
  test("cannot adopt over pending edits", () => {
    const { coordinator } = createCoordinator({ applyBookEdit: () => new Promise(() => {}) });
    coordinator.enqueueBookEdit("claims", withParagraph(createBlankBookDocument("测试"), "未保存"));
    coordinator.freeze("owner");
    expect(() =>
      coordinator.adoptPersistedPatent(
        { ...createPatent(), revision: 2 },
        new Date().toISOString(),
      ),
    ).toThrow("pending");
  });
});
