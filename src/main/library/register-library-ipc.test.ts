import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlankDocument } from "../../shared/document/defaults.js";
import { defaultDocumentFont } from "../../shared/document/font-policy.js";
import type { DocxImportPreview } from "../../shared/ipc/contract.js";
import type { AppResult } from "../../shared/ipc/result.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import type { PatentType } from "../../shared/patent/model.js";
import type { PatentTemplateSettings } from "../../shared/patent/templates.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import type { AssetOwner, StoredAsset } from "../assets/asset-store.js";
import type { PatentPatdocPayload } from "../documents/patdoc-format.js";
import { AssetStore } from "./asset-store.js";
import type { LibraryDatabase } from "./library-database.js";
import { LibraryMigrationService } from "./library-migration-service.js";
import { LibraryService, type OpenedLibraryDocument } from "./library-service.js";
import { type OpenedPatent, PatentService } from "./patent-service.js";
import type { ResolvedPatentTemplateSource } from "./patent-template-service.js";
import {
  type RegisterLibraryIpcOptions,
  registerLibraryIpcHandlers,
} from "./register-library-ipc.js";

const electron = vi.hoisted(() => ({
  ownerWindow: {},
  sender: {},
  fromWebContents: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: electron.fromWebContents,
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
  },
}));

const libraryDocumentId = "00000000-0000-4000-8000-000000000101";
const secondLibraryDocumentId = "00000000-0000-4000-8000-000000000102";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function createHarness(
  options: {
    readOnly?: boolean;
    onPatentFigureEditCommitted?: (sessionId: string, assetIds: readonly string[]) => Promise<void>;
    onPatentFigureEditFailed?: (sessionId: string, assetIds: readonly string[]) => Promise<void>;
    readPatentTemplates?: () => Promise<typeof DEFAULT_PATENT_TEMPLATE_SETTINGS>;
    resolvePatentTemplates?: (patentType: PatentType) => ResolvedPatentTemplateSource;
    createPatentFromTemplates?: boolean;
    awaitPatentTemplatesReady?: () => Promise<void>;
    docxImports?: NonNullable<RegisterLibraryIpcOptions["docxImports"]>;
  } = {},
) {
  electron.fromWebContents.mockReturnValue(electron.ownerWindow);
  const handlers = new Map<
    string,
    (event: unknown, input?: unknown) => unknown | Promise<unknown>
  >();
  const document = createBlankDocument("导入导出文档");
  const opened = {
    libraryDocumentId,
    sessionId: "00000000-0000-4000-8000-000000000201",
    revision: 9,
    document,
    editorState: { cursor: 1 },
    saveState: "saved" as const,
  };
  let importCount = 0;
  const library = {
    list: vi.fn(async () => []),
    create: vi.fn(async () => opened),
    open: vi.fn(async () => opened),
    rename: vi.fn(),
    applyEdit: vi.fn(),
    flush: vi.fn(async (_libraryDocumentId: string, expectedRevision: number) => {
      if (expectedRevision !== 9) {
        throw Object.assign(new Error("stale"), { code: "REVISION_CONFLICT" });
      }
      return {
        libraryDocumentId,
        revision: 9,
        flushedAt: "2026-08-01T13:00:00.000Z",
      };
    }),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(async () => ({ purgedDocumentIds: [] })),
    importDocument: vi.fn(async (importedDocument: typeof document) => {
      importCount += 1;
      return {
        ...opened,
        libraryDocumentId: importCount === 1 ? libraryDocumentId : secondLibraryDocumentId,
        document: importedDocument,
      };
    }),
    replaceInitialDocument: vi.fn(
      async (_libraryDocumentId: string, importedDocument: typeof document) => ({
        ...opened,
        document: importedDocument,
      }),
    ),
    release: vi.fn(),
  };
  const outputPath = join("C:\\exports", "copy.patdoc");
  const dialog = {
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths: [join("C:\\imports", "source.patdoc")],
    })),
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: outputPath })),
  };
  const patent = createBlankPatent({ patentType: "invention", name: "IPC 专利" });
  let currentPatentRevision = patent.revision;
  const fileService = {
    openDocument: vi.fn(async () => ({
      ok: true as const,
      value: { document, settings: {}, editorState: {}, assets: [] },
    })),
    saveDocument: vi.fn(async () => ({
      ok: true as const,
      value: {
        path: outputPath,
        displayName: "copy.patdoc",
        savedAt: "2026-08-01T13:00:00.000Z",
        previousVersionRetained: false,
      },
    })),
    openPatent: vi.fn(async () => ({
      ok: true as const,
      value: { patent, assets: [] },
    })),
    savePatent: vi.fn(async () => ({
      ok: true as const,
      value: {
        path: outputPath,
        displayName: "copy.patdoc",
        savedAt: "2026-08-01T13:00:00.000Z",
        previousVersionRetained: false,
      },
    })),
  };
  const assetStore = {
    install: vi.fn(async (_owner: AssetOwner, asset: StoredAsset) => ({
      descriptor: asset.descriptor,
      preview: Uint8Array.from(asset.preview),
    })),
    readAsset: vi.fn(),
  };
  const legacyDraftMigration = {
    listCandidates: vi.fn(async () => []),
    importDraftResult: vi.fn(async () => ({ ok: true as const, value: opened })),
  };
  const openedPatent = {
    patentId: patent.patentId,
    sessionId: "00000000-0000-4000-8000-000000000401",
    revision: 0,
    patent,
    saveState: "saved" as const,
  };
  const createdPatents: (typeof openedPatent)[] = [];
  const patents = {
    inspectResources: vi.fn(async (request: { patentId: string; expectedRevision: number }) => ({
      patentId: request.patentId,
      patentRevision: request.expectedRevision,
      assets: [],
    })),
    cancelResourceInspection: vi.fn(),
    list: vi.fn(async () => []),
    getLibraryPreview: vi.fn(async () => Uint8Array.from([1, 2, 3])),
    create: vi.fn(
      async (request: {
        patentType: PatentType;
        name: string | null;
        templates: PatentTemplateSettings;
      }) => {
        if (!options.createPatentFromTemplates) return openedPatent;
        const createdPatent = createBlankPatent(request);
        const created = {
          ...openedPatent,
          patentId: createdPatent.patentId,
          patent: createdPatent,
        };
        createdPatents.push(created);
        return created;
      },
    ),
    open: vi.fn(async () => ({
      ...openedPatent,
      revision: currentPatentRevision,
      patent: { ...patent, revision: currentPatentRevision },
    })),
    updateSettings: vi.fn(async (request: { expectedRevision: number }) => {
      currentPatentRevision = request.expectedRevision + 1;
      return {
        patentId: patent.patentId,
        revision: currentPatentRevision,
        savedAt: "2026-08-01T13:00:00.000Z",
      };
    }),
    setDrawingBooksEnabled: vi.fn(async (request: { expectedRevision: number }) => {
      currentPatentRevision = request.expectedRevision + 1;
      return {
        patent: { ...patent, drawingBooksEnabled: false, revision: currentPatentRevision },
        savedAt: "2026-08-01T13:00:00.000Z",
        assetIdsForPostCommitGarbageCollection: [],
        notice: null,
      };
    }),
    applyBookEdit: vi.fn(async () => ({
      patentId: patent.patentId,
      revision: 1,
      savedAt: "2026-08-01T13:00:00.000Z",
    })),
    createAuxiliaryDocument: vi.fn(async () => ({
      patentId: patent.patentId,
      revision: 1,
      savedAt: "2026-08-01T13:00:00.000Z",
    })),
    applyAuxiliaryDocumentEdit: vi.fn(async () => ({
      patentId: patent.patentId,
      revision: 1,
      savedAt: "2026-08-01T13:00:00.000Z",
    })),
    renameAuxiliaryDocument: vi.fn(async () => ({
      patentId: patent.patentId,
      revision: 1,
      savedAt: "2026-08-01T13:00:00.000Z",
    })),
    deleteAuxiliaryDocument: vi.fn(async () => ({
      patentId: patent.patentId,
      revision: 1,
      savedAt: "2026-08-01T13:00:00.000Z",
    })),
    applyFigureEdit: vi.fn(async (request: { expectedRevision: number }) => {
      currentPatentRevision = request.expectedRevision + 1;
      return {
        patentId: patent.patentId,
        revision: currentPatentRevision,
        savedAt: "2026-08-01T13:00:00.000Z",
      };
    }),
    flush: vi.fn(async (_patentId: string, expectedRevision: number) => ({
      patentId: patent.patentId,
      revision: expectedRevision,
      flushedAt: "2026-08-01T13:00:00.000Z",
    })),
    loadForExport: vi.fn(async () => ({ ...patent, revision: currentPatentRevision })),

    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(async () => ({ purgedPatentIds: [] })),
    release: vi.fn(),
  };
  const recovery = {
    retryPatent: vi.fn(async (patentId: string) => ({ patentId, backupCreated: true as const })),
  };
  const snapshots = {
    readFlowchartArchive: vi.fn(async () => []),
    create: vi.fn(),
    pruneAll: vi.fn(),
    lastAutomaticSnapshotAt: vi.fn(() => null),
    open: vi.fn(),
    list: vi.fn(async () => []),
    delete: vi.fn(),
    preview: vi.fn(),
    previewAsset: vi.fn(),
  };

  registerLibraryIpcHandlers({
    register: (channel, handler) => handlers.set(channel, handler),
    library,
    patents,
    recovery,
    snapshots,
    fileService,
    assetStore,
    legacyDraftMigration,
    dialog,
    readOnly: options.readOnly ?? false,
    readPatentTemplates:
      options.readPatentTemplates ?? (async () => DEFAULT_PATENT_TEMPLATE_SETTINGS),
    patentTemplates: {
      resolveCreationSource:
        options.resolvePatentTemplates ??
        ((patentType) => ({
          kind: "system",
          templateId: null,
          templates: structuredClone(DEFAULT_PATENT_TEMPLATE_SETTINGS[patentType]),
          assetIds: [],
        })),
    } as unknown as NonNullable<
      Parameters<typeof registerLibraryIpcHandlers>[0]["patentTemplates"]
    >,
    ...(options.awaitPatentTemplatesReady
      ? { awaitPatentTemplatesReady: options.awaitPatentTemplatesReady }
      : {}),
    ...(options.docxImports ? { docxImports: options.docxImports } : {}),
    ...(options.onPatentFigureEditCommitted
      ? { onPatentFigureEditCommitted: options.onPatentFigureEditCommitted }
      : {}),
    ...(options.onPatentFigureEditFailed
      ? { onPatentFigureEditFailed: options.onPatentFigureEditFailed }
      : {}),
  });

  async function invoke(channel: string, input?: unknown, event: unknown = {}): Promise<unknown> {
    const handler = handlers.get(channel);
    expect(handler, `missing IPC handler: ${channel}`).toBeTypeOf("function");
    return handler?.(event, input);
  }

  return {
    invoke,
    library,
    patents,
    recovery,
    snapshots,
    fileService,
    dialog,
    outputPath,
    legacyDraftMigration,
    patent,
    createdPatents,
    assetStore,
  };
}

test("routes patent aggregate IPC operations through the patent service", async () => {
  const templates = structuredClone(DEFAULT_PATENT_TEMPLATE_SETTINGS);
  const { invoke, patents, patent } = createHarness({
    resolvePatentTemplates: (patentType) => ({
      kind: "system",
      templateId: null,
      templates: templates[patentType],
      assetIds: [],
    }),
  });

  await expect(
    invoke("patents:create", {
      patentType: "invention",
      name: "IPC 专利",
      customer: "  IPC 客户  ",
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: { patentId: patent.patentId, patent: { books: expect.any(Array) } },
  });
  await expect(invoke("patents:list", "active")).resolves.toEqual({ ok: true, value: [] });
  await expect(invoke("patents:get-library-preview", patent.patentId)).resolves.toEqual({
    ok: true,
    value: Uint8Array.from([1, 2, 3]),
  });
  await expect(invoke("patents:open", patent.patentId)).resolves.toMatchObject({
    ok: true,
    value: { patentId: patent.patentId },
  });
  await expect(
    invoke("patents:update-settings", {
      patentId: patent.patentId,
      expectedRevision: 0,
      name: "新 IPC 专利",
      patentType: "utility-model",
    }),
  ).resolves.toMatchObject({ ok: true, value: { patentId: patent.patentId, revision: 1 } });
  await expect(
    invoke("patents:apply-book-edit", {
      patentId: patent.patentId,
      sessionId: "00000000-0000-4000-8000-000000000401",
      bookKind: "claims",
      expectedRevision: 0,
      document: patent.books[0]?.document,
      editorState: {},
      assets: [],
    }),
  ).resolves.toMatchObject({ ok: true, value: { patentId: patent.patentId, revision: 1 } });
  await expect(
    invoke("patents:apply-figure-edit", {
      patentId: patent.patentId,
      sessionId: "00000000-0000-4000-8000-000000000401",
      expectedRevision: 0,
      figures: [],
      abstractDrawingFigureId: null,
      assets: [],
    }),
  ).resolves.toMatchObject({ ok: true, value: { patentId: patent.patentId, revision: 1 } });
  const auxiliaryDocumentId = "00000000-0000-4000-8000-000000000951";
  const sourceBook = patent.books[0];
  if (!sourceBook) throw new Error("fixture");
  const auxiliaryDocument = {
    auxiliaryDocumentId,
    title: "其他材料",
    document: {
      ...sourceBook.document,
      documentId: "00000000-0000-4000-8000-000000000952",
      title: "其他材料",
      content: [],
    },
    editorState: {},
    localRevision: 0,
    persistedRevision: 0,
    sourceFileName: null,
  };
  await expect(
    invoke("patents:create-auxiliary-document", {
      patentId: patent.patentId,
      sessionId: "00000000-0000-4000-8000-000000000401",
      expectedRevision: 0,
      document: auxiliaryDocument,
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT", message: "其他文档功能已移除。" },
  });
  await expect(
    invoke("patents:apply-auxiliary-document-edit", {
      patentId: patent.patentId,
      sessionId: "00000000-0000-4000-8000-000000000401",
      auxiliaryDocumentId,
      expectedRevision: 0,
      document: auxiliaryDocument.document,
      editorState: {},
      assets: [],
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT", message: "其他文档功能已移除。" },
  });
  await expect(
    invoke("patents:rename-auxiliary-document", {
      patentId: patent.patentId,
      sessionId: "00000000-0000-4000-8000-000000000401",
      auxiliaryDocumentId,
      expectedRevision: 0,
      title: "补充材料",
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT", message: "其他文档功能已移除。" },
  });
  await expect(
    invoke("patents:delete-auxiliary-document", {
      patentId: patent.patentId,
      sessionId: "00000000-0000-4000-8000-000000000401",
      auxiliaryDocumentId,
      expectedRevision: 0,
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT", message: "其他文档功能已移除。" },
  });
  await expect(invoke("patents:purge")).resolves.toEqual({
    ok: true,
    value: { purgedPatentIds: [] },
  });

  const expectedTemplates = structuredClone(templates.invention);
  for (const kind of ["claims", "description", "abstract"] as const) {
    for (const node of expectedTemplates[kind].content) {
      if (node.type === "paragraph" || node.type === "heading")
        node.attrs.defaultFontFamily = defaultDocumentFont(process.platform);
    }
  }
  expect(patents.create).toHaveBeenCalledWith({
    patentType: "invention",
    name: "IPC 专利",
    customer: "IPC 客户",
    templates: {
      enabled: true,
      invention: expectedTemplates,
      "utility-model": expect.any(Object),
    },
  });
  expect(patents.updateSettings).toHaveBeenCalledOnce();
  expect(patents.applyBookEdit).toHaveBeenCalledOnce();
  expect(patents.applyFigureEdit).toHaveBeenCalledOnce();
  expect(patents.createAuxiliaryDocument).not.toHaveBeenCalled();
  expect(patents.applyAuxiliaryDocumentEdit).not.toHaveBeenCalled();
  expect(patents.renameAuxiliaryDocument).not.toHaveBeenCalled();
  expect(patents.deleteAuxiliaryDocument).not.toHaveBeenCalled();
});

test("routes the atomic drawing-book transition through the patent service", async () => {
  const { invoke, patents, patent } = createHarness();
  const request = {
    patentId: patent.patentId,
    sessionId: "00000000-0000-4000-8000-000000000401",
    expectedRevision: 0,
    enabled: false,
  };

  await expect(invoke("patents:set-drawing-books-enabled", request)).resolves.toMatchObject({
    ok: true,
    value: { patent: { drawingBooksEnabled: false } },
  });
  expect(patents.setDrawingBooksEnabled).toHaveBeenCalledWith(request);
});

test("resolves the selected catalog template for each newly created patent", async () => {
  const templatesA = structuredClone(DEFAULT_PATENT_TEMPLATE_SETTINGS);
  const templatesB = structuredClone(DEFAULT_PATENT_TEMPLATE_SETTINGS);
  const firstClaim = templatesA.invention.claims.content[0];
  const secondClaim = templatesB.invention.claims.content[0];
  if (
    firstClaim?.type !== "paragraph" ||
    firstClaim.content[0]?.type !== "text" ||
    secondClaim?.type !== "paragraph" ||
    secondClaim.content[0]?.type !== "text"
  ) {
    throw new Error("fixture");
  }
  firstClaim.content[0].text = "设置 A：{{patentName}}";
  secondClaim.content[0].text = "设置 B：{{patentName}}";
  let savedTemplates = templatesA;
  const { invoke, patents, createdPatents } = createHarness({
    createPatentFromTemplates: true,
    resolvePatentTemplates: (patentType) => ({
      kind: "custom",
      templateId: "00000000-0000-4000-8000-000000000903",
      templates: savedTemplates[patentType],
      assetIds: [],
    }),
  });

  const first = await invoke("patents:create", { patentType: "invention", name: "第一件" });
  savedTemplates = templatesB;
  const second = await invoke("patents:create", { patentType: "invention", name: "第二件" });

  expect(first).toMatchObject({ ok: true });
  expect(second).toMatchObject({ ok: true });

  const firstPatent = (first as { value: { patent: (typeof createdPatents)[number]["patent"] } })
    .value.patent;
  const secondPatent = (second as { value: { patent: (typeof createdPatents)[number]["patent"] } })
    .value.patent;
  const firstCreatedClaim = firstPatent.books.find((book) => book.kind === "claims")?.document
    .content[0];
  const secondCreatedClaim = secondPatent.books.find((book) => book.kind === "claims")?.document
    .content[0];
  if (firstCreatedClaim?.type !== "paragraph" || secondCreatedClaim?.type !== "paragraph") {
    throw new Error("created claim fixture");
  }
  expect(firstCreatedClaim.content.slice(0, 2)).toMatchObject([
    { text: "设置 A：" },
    { text: "第一件" },
  ]);
  expect(secondCreatedClaim.content.slice(0, 2)).toMatchObject([
    { text: "设置 B：" },
    { text: "第二件" },
  ]);
  expect(patents.create).toHaveBeenNthCalledWith(1, {
    patentType: "invention",
    name: "第一件",
    templates: {
      enabled: true,
      invention: templatesA.invention,
      "utility-model": expect.any(Object),
    },
  });
  expect(patents.create).toHaveBeenNthCalledWith(2, {
    patentType: "invention",
    name: "第二件",
    templates: {
      enabled: true,
      invention: templatesB.invention,
      "utility-model": expect.any(Object),
    },
  });
});

test("creates patents from the selected catalog source instead of legacy settings", async () => {
  const selected = structuredClone(DEFAULT_PATENT_TEMPLATE_SETTINGS.invention);
  const firstClaim = selected.claims.content[0];
  if (firstClaim?.type !== "paragraph" || firstClaim.content[0]?.type !== "text") {
    throw new Error("fixture");
  }
  firstClaim.content[0].text = "所选模板：{{patentName}}";
  const readPatentTemplates = vi.fn(async () => DEFAULT_PATENT_TEMPLATE_SETTINGS);
  const resolvePatentTemplates = vi.fn(
    (_patentType: PatentType): ResolvedPatentTemplateSource => ({
      kind: "custom",
      templateId: "00000000-0000-4000-8000-000000000901",
      templates: selected,
      assetIds: [],
    }),
  );
  const { invoke, patents } = createHarness({
    readPatentTemplates,
    resolvePatentTemplates,
  });

  const result = await invoke("patents:create", {
    patentType: "invention",
    name: "目录模板专利",
  });

  expect(result).toMatchObject({ ok: true });
  expect(resolvePatentTemplates).toHaveBeenCalledWith("invention");
  expect(readPatentTemplates).not.toHaveBeenCalled();
  expect(patents.create).toHaveBeenCalledWith({
    patentType: "invention",
    name: "目录模板专利",
    templates: {
      enabled: true,
      invention: selected,
      "utility-model": expect.any(Object),
    },
  });
});

test("waits for template initialization before resolving a new patent source", async () => {
  let releaseInitialization: (() => void) | undefined;
  const initialization = new Promise<void>((resolve) => {
    releaseInitialization = resolve;
  });
  const resolvePatentTemplates = vi.fn(
    (patentType: PatentType): ResolvedPatentTemplateSource => ({
      kind: "system",
      templateId: null,
      templates: structuredClone(DEFAULT_PATENT_TEMPLATE_SETTINGS[patentType]),
      assetIds: [],
    }),
  );
  const { invoke, patents } = createHarness({
    resolvePatentTemplates,
    awaitPatentTemplatesReady: () => initialization,
  });

  const creation = invoke("patents:create", {
    patentType: "invention",
    name: "等待初始化",
  });
  await Promise.resolve();
  expect(resolvePatentTemplates).not.toHaveBeenCalled();
  expect(patents.create).not.toHaveBeenCalled();

  releaseInitialization?.();
  await expect(creation).resolves.toMatchObject({ ok: true });
  expect(resolvePatentTemplates).toHaveBeenCalledWith("invention");
});

test("imports and exports a complete patent patdoc through patent IPC", async () => {
  const { invoke, patents, snapshots, fileService, dialog, patent, outputPath } = createHarness();
  patent.customer = "测试客户";
  patent.referenceMarks = [
    {
      referenceMarkId: "00000000-0000-4000-8000-000000009901",
      number: 1,
      keyword: "箱体",
    },
  ];
  patent.referenceMarkSettings = { synchronizedEditingEnabled: true };

  await expect(invoke("patents:import-patdoc")).resolves.toMatchObject({
    ok: true,
    value: { patentId: patent.patentId, revision: 1 },
  });
  expect(fileService.openPatent).toHaveBeenCalledOnce();
  expect(patents.updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({
      patentId: patent.patentId,
      expectedRevision: 0,
      customer: "测试客户",
      referenceMarks: patent.referenceMarks,
      referenceMarkSettings: { synchronizedEditingEnabled: true },
      bookEdits: expect.arrayContaining([expect.objectContaining({ bookKind: "description" })]),
    }),
  );
  expect(patents.applyFigureEdit).not.toHaveBeenCalled();
  snapshots.create.mockClear();

  await expect(
    invoke("patents:export-patdoc", {
      patentId: patent.patentId,
      expectedRevision: 1,
      suggestedName: "自定义专利副本",
    }),
  ).resolves.toMatchObject({ ok: true, value: { path: outputPath } });
  expect(patents.flush).toHaveBeenCalledWith(patent.patentId, 1);
  expect(dialog.showSaveDialog).toHaveBeenCalledWith(
    electron.ownerWindow,
    expect.objectContaining({ defaultPath: "自定义专利副本.patdoc" }),
  );
  expect(snapshots.create).not.toHaveBeenCalled();
  expect(fileService.savePatent).toHaveBeenCalledWith(
    outputPath,
    expect.objectContaining({
      patent: expect.objectContaining({ patentId: patent.patentId }),
    }),
  );
});

test("imports a patent with drawing books disabled without losing aggregate metadata", async () => {
  const { invoke, patent, patents } = createHarness();
  patent.customer = "无附图客户";
  patent.drawingBooksEnabled = false;
  patent.referenceMarks = [];

  await expect(invoke("patents:import-patdoc")).resolves.toMatchObject({
    ok: true,
    value: { revision: 2, patent: { drawingBooksEnabled: false } },
  });
  expect(patents.updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({ customer: "无附图客户" }),
  );
  expect(patents.setDrawingBooksEnabled).toHaveBeenCalledWith(
    expect.objectContaining({ enabled: false, expectedRevision: 0 }),
  );
});

test("retains the patent shell in trash after a patdoc asset import failure", async () => {
  const { assetStore, fileService, invoke, patent, patents } = createHarness();
  const source = createBlankPatent({ patentType: "invention", name: "失败导入" });
  const original = Uint8Array.from([11, 12, 13]);
  const preview = Uint8Array.from([14, 15]);
  const first: StoredAsset = {
    descriptor: {
      assetId: "00000000-0000-4000-8000-000000000971",
      kind: "image",
      originalName: "first.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: original.byteLength,
      sha256: sha256(original),
      widthPx: 10,
      heightPx: 10,
      previewByteLength: preview.byteLength,
      previewSha256: sha256(preview),
    },
    original,
    preview,
  };
  const second: StoredAsset = {
    ...first,
    descriptor: { ...first.descriptor, assetId: "00000000-0000-4000-8000-000000000972" },
  };
  source.assets = [first.descriptor, second.descriptor];
  const description = source.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  description.document.content = [first, second].map((asset, index) => ({
    id: `00000000-0000-4000-8000-${(980 + index).toString().padStart(12, "0")}`,
    type: "chemical-structure" as const,
    ketSource: "(ket) (atom C)",
    previewAssetId: asset.descriptor.assetId,
    widthMm: 80,
    alignment: "center" as const,
  }));
  fileService.openPatent.mockResolvedValueOnce({
    ok: true,
    value: { patent: source, assets: [first, second] },
  } as never);
  assetStore.install.mockResolvedValueOnce({ descriptor: first.descriptor, preview });
  assetStore.install.mockRejectedValueOnce(new Error("second asset failed"));

  await expect(invoke("patents:import-patdoc")).resolves.toMatchObject({ ok: false });

  expect(assetStore.install).toHaveBeenCalledTimes(2);
  expect(patents.release).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000401");
  expect(patents.moveToTrash).toHaveBeenCalledWith(patent.patentId);
  expect(patents.permanentlyDelete).not.toHaveBeenCalled();
});

test("remaps an ordinary patdoc chemical preview to a content-hash reused asset id", async () => {
  const { assetStore, fileService, invoke, library } = createHarness();
  const original = Uint8Array.from([7, 8, 9]);
  const preview = Uint8Array.from([4, 5, 6]);
  const archivedAsset: StoredAsset = {
    descriptor: {
      assetId: "00000000-0000-4000-8000-000000000971",
      kind: "image",
      originalName: "chemical-structure.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: original.byteLength,
      sha256: sha256(original),
      widthPx: 100,
      heightPx: 60,
      previewByteLength: preview.byteLength,
      previewSha256: sha256(preview),
    },
    original,
    preview,
  };
  const reusedDescriptor = {
    ...archivedAsset.descriptor,
    assetId: "00000000-0000-4000-8000-000000000970",
  };
  const duplicateArchivedAsset: StoredAsset = {
    ...archivedAsset,
    descriptor: {
      ...archivedAsset.descriptor,
      assetId: "00000000-0000-4000-8000-000000000973",
    },
  };
  const document = createBlankDocument("普通结构式导入");
  document.assets = [archivedAsset.descriptor, duplicateArchivedAsset.descriptor];
  document.content = [
    {
      id: "00000000-0000-4000-8000-000000000972",
      type: "chemical-structure",
      ketSource: "(ket) (atom O)",
      previewAssetId: archivedAsset.descriptor.assetId,
      widthMm: 80,
      alignment: "center",
    },
    {
      id: "00000000-0000-4000-8000-000000000974",
      type: "chemical-structure",
      ketSource: "(ket) (atom O)",
      previewAssetId: duplicateArchivedAsset.descriptor.assetId,
      widthMm: 80,
      alignment: "center",
    },
  ];
  fileService.openDocument.mockResolvedValueOnce({
    ok: true,
    value: {
      document,
      settings: {},
      editorState: {},
      assets: [archivedAsset, duplicateArchivedAsset],
    },
  } as never);
  assetStore.install
    .mockResolvedValueOnce({ descriptor: reusedDescriptor, preview })
    .mockResolvedValueOnce({ descriptor: reusedDescriptor, preview });

  await expect(invoke("library:import-patdoc")).resolves.toMatchObject({ ok: true });

  expect(library.replaceInitialDocument).toHaveBeenCalledWith(
    libraryDocumentId,
    expect.objectContaining({ assets: [reusedDescriptor] }),
    {},
  );
  const imported = library.replaceInitialDocument.mock.calls[0]?.[1];
  expect(imported?.content).toEqual([
    expect.objectContaining({
      type: "chemical-structure",
      previewAssetId: reusedDescriptor.assetId,
    }),
    expect.objectContaining({
      type: "chemical-structure",
      previewAssetId: reusedDescriptor.assetId,
    }),
  ]);
});

test("persists and reopens every independent ordinary chemical patdoc resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "library-patdoc-chemical-"));
  let database: LibraryDatabase | undefined;
  try {
    const prepared = await new LibraryMigrationService(root).prepare();
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("fixture");
    database = prepared.database;
    const _key = Buffer.alloc(32, 14);
    const library = new LibraryService({ database });
    const assetStore = new AssetStore({ root, database });
    const patents = new PatentService({ database, assetStore });
    const patent = await patents.create({
      patentType: "invention",
      name: "同库专利",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
    const original = Uint8Array.from([10, 11, 12]);
    const preview = Uint8Array.from([6, 7, 8]);
    const firstAsset: StoredAsset = {
      descriptor: {
        assetId: "00000000-0000-4000-8000-000000000961",
        kind: "image",
        originalName: "chemical-structure.png",
        mediaType: "image/png",
        extension: "png",
        byteLength: original.byteLength,
        sha256: sha256(original),
        widthPx: 100,
        heightPx: 60,
        previewByteLength: preview.byteLength,
        previewSha256: sha256(preview),
      },
      original,
      preview,
    };
    const secondAsset: StoredAsset = {
      ...firstAsset,
      descriptor: {
        ...firstAsset.descriptor,
        assetId: "00000000-0000-4000-8000-000000000962",
      },
    };
    const authoritativeDescriptor = firstAsset.descriptor;
    const document = createBlankDocument("持久化结构式导入");
    document.assets = [firstAsset.descriptor, secondAsset.descriptor];
    document.content = [
      {
        id: "00000000-0000-4000-8000-000000000963",
        type: "chemical-structure",
        ketSource: "(ket) (atom N)",
        previewAssetId: firstAsset.descriptor.assetId,
        widthMm: 80,
        alignment: "center",
      },
      {
        id: "00000000-0000-4000-8000-000000000964",
        type: "chemical-structure",
        ketSource: "(ket) (atom N)",
        previewAssetId: secondAsset.descriptor.assetId,
        widthMm: 80,
        alignment: "center",
      },
    ];
    const handlers = new Map<
      string,
      (event: unknown, input?: unknown) => unknown | Promise<unknown>
    >();
    registerLibraryIpcHandlers({
      register: (channel, handler) => handlers.set(channel, handler),
      library,
      patents,
      fileService: {
        openDocument: vi.fn(async () => ({
          ok: true as const,
          value: {
            document,
            settings: {},
            editorState: {},
            assets: [firstAsset, secondAsset],
          },
        })),
        saveDocument: vi.fn(),
        openPatent: vi.fn(),
        savePatent: vi.fn(),
      },
      assetStore,
      readPatentTemplates: async () => DEFAULT_PATENT_TEMPLATE_SETTINGS,
      dialog: {
        showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["C:\\import.patdoc"] })),
        showSaveDialog: vi.fn(),
      },
    });
    const handler = handlers.get("library:import-patdoc");
    if (!handler) throw new Error("handler missing");

    const imported = (await handler(
      { sender: electron.sender },
      undefined,
    )) as AppResult<OpenedLibraryDocument | null>;

    expect(imported).toMatchObject({ ok: true });
    if (!imported.ok || imported.value === null) throw new Error("fixture");
    const libraryDocumentId = imported.value.libraryDocumentId;
    const reopened = await library.open(libraryDocumentId);
    expect(reopened.document.assets).toEqual([authoritativeDescriptor, secondAsset.descriptor]);
    expect(reopened.document.content).toEqual([
      expect.objectContaining({
        type: "chemical-structure",
        ketSource: "(ket) (atom N)",
        previewAssetId: authoritativeDescriptor.assetId,
      }),
      expect.objectContaining({
        type: "chemical-structure",
        ketSource: "(ket) (atom N)",
        previewAssetId: secondAsset.descriptor.assetId,
      }),
    ]);
    expect(
      database.read((raw) =>
        raw
          .prepare("SELECT asset_id FROM document_assets WHERE library_document_id = ?")
          .all(libraryDocumentId),
      ),
    ).toEqual([
      { asset_id: authoritativeDescriptor.assetId },
      { asset_id: secondAsset.descriptor.assetId },
    ]);
    await expect(assetStore.readAsset(authoritativeDescriptor.assetId)).resolves.toMatchObject({
      descriptor: authoritativeDescriptor,
    });
    const patentOriginal = Uint8Array.from([21, 22, 23]);
    const patentPreview = Uint8Array.from([24, 25]);
    const patentAsset: StoredAsset = {
      descriptor: {
        ...firstAsset.descriptor,
        assetId: "00000000-0000-4000-8000-000000000965",
        byteLength: patentOriginal.byteLength,
        sha256: sha256(patentOriginal),
        previewByteLength: patentPreview.byteLength,
        previewSha256: sha256(patentPreview),
      },
      original: patentOriginal,
      preview: patentPreview,
    };
    const installedPatentAsset = await assetStore.install(
      { kind: "patent", patentId: patent.patentId },
      patentAsset,
    );
    await assetStore.release({
      kind: "library-document",
      libraryDocumentId,
    });
    await assetStore.collectUnreferenced({ kind: "library-document", libraryDocumentId });
    await expect(
      assetStore.readAsset(installedPatentAsset.descriptor.assetId),
    ).resolves.toMatchObject({ descriptor: installedPatentAsset.descriptor });
    await library.release(reopened.sessionId);
    await patents.release(patent.sessionId);
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("imports and reopens a chemical patent patdoc without creating figures", async () => {
  const root = await mkdtemp(join(tmpdir(), "patent-patdoc-chemical-"));
  let database: LibraryDatabase | undefined;
  try {
    const prepared = await new LibraryMigrationService(root).prepare();
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("fixture");
    database = prepared.database;
    const _key = Buffer.alloc(32, 13);
    const assetStore = new AssetStore({ root, database });
    const patents = new PatentService({ database, assetStore });
    const source = createBlankPatent({ patentType: "invention", name: "结构式 Patdoc" });
    const original = Uint8Array.from([5, 6, 7, 8]);
    const preview = Uint8Array.from([1, 2, 3]);
    const asset: StoredAsset = {
      descriptor: {
        assetId: "00000000-0000-4000-8000-000000000981",
        kind: "image",
        originalName: "chemical-structure.png",
        mediaType: "image/png",
        extension: "png",
        byteLength: original.byteLength,
        sha256: sha256(original),
        widthPx: 120,
        heightPx: 80,
        previewByteLength: preview.byteLength,
        previewSha256: sha256(preview),
      },
      original,
      preview,
    };
    const existing = await patents.create({
      patentType: "invention",
      name: "复用预览资源",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
    const reusedAsset: StoredAsset = {
      ...asset,
      descriptor: {
        ...asset.descriptor,
        assetId: "00000000-0000-4000-8000-000000000980",
      },
    };
    const installedReuse = await assetStore.install(
      { kind: "patent", patentId: existing.patentId },
      reusedAsset,
    );
    await patents.release(existing.sessionId);
    const duplicateAsset: StoredAsset = {
      ...asset,
      descriptor: {
        ...asset.descriptor,
        assetId: "00000000-0000-4000-8000-000000000983",
      },
    };
    const description = source.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const payload: PatentPatdocPayload = {
      patent: {
        ...source,
        assets: [asset.descriptor, duplicateAsset.descriptor],
        figures: [],
        abstractDrawingFigureId: null,
        books: source.books.map((book) =>
          book.kind === "description"
            ? {
                ...book,
                document: {
                  ...description.document,
                  content: [
                    {
                      id: "00000000-0000-4000-8000-000000000982",
                      type: "chemical-structure",
                      ketSource: "(ket) (atom C)",
                      previewAssetId: asset.descriptor.assetId,
                      widthMm: 80,
                      alignment: "center",
                    },
                    {
                      id: "00000000-0000-4000-8000-000000000984",
                      type: "chemical-structure",
                      ketSource: "(ket) (atom C)",
                      previewAssetId: duplicateAsset.descriptor.assetId,
                      widthMm: 80,
                      alignment: "center",
                    },
                  ],
                },
              }
            : book,
        ),
      },
      assets: [asset, duplicateAsset],
    };
    const handlers = new Map<
      string,
      (event: unknown, input?: unknown) => unknown | Promise<unknown>
    >();
    registerLibraryIpcHandlers({
      register: (channel, handler) => handlers.set(channel, handler),
      library: {} as never,
      patents,
      fileService: {
        openDocument: vi.fn(),
        saveDocument: vi.fn(),
        openPatent: vi.fn(async () => ({ ok: true as const, value: payload })),
        savePatent: vi.fn(),
      },
      assetStore,
      readPatentTemplates: async () => DEFAULT_PATENT_TEMPLATE_SETTINGS,
      dialog: {
        showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["C:\\import.patdoc"] })),
        showSaveDialog: vi.fn(),
      },
    });
    const handler = handlers.get("patents:import-patdoc");
    if (!handler) throw new Error("handler missing");

    const imported = (await handler(
      { sender: electron.sender },
      undefined,
    )) as AppResult<OpenedPatent | null>;

    expect(imported).toMatchObject({ ok: true });
    if (!imported.ok || imported.value === null) throw new Error("fixture");
    const reopened = await patents.open(imported.value.patentId);
    expect(reopened.patent).toMatchObject({
      figures: [],
      abstractDrawingFigureId: null,
      assets: [asset.descriptor, duplicateAsset.descriptor],
    });
    expect(
      reopened.patent.books.find((book) => book.kind === "description")?.document.content,
    ).toEqual([
      expect.objectContaining({
        type: "chemical-structure",
        ketSource: "(ket) (atom C)",
        previewAssetId: asset.descriptor.assetId,
      }),
      expect.objectContaining({
        type: "chemical-structure",
        ketSource: "(ket) (atom C)",
        previewAssetId: duplicateAsset.descriptor.assetId,
      }),
    ]);
    await expect(assetStore.readAsset(installedReuse.descriptor.assetId)).resolves.toMatchObject({
      descriptor: installedReuse.descriptor,
    });
    await patents.release(reopened.sessionId);
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("commits staged image leases only after the figure revision succeeds", async () => {
  const committed = vi.fn(async () => undefined);
  const { invoke, patent } = createHarness({ onPatentFigureEditCommitted: committed });
  const sessionId = "00000000-0000-4000-8000-000000000401";

  await expect(
    invoke("patents:apply-figure-edit", {
      patentId: patent.patentId,
      sessionId,
      expectedRevision: 0,
      figures: [],
      abstractDrawingFigureId: null,
      assets: [],
    }),
  ).resolves.toMatchObject({ ok: true });

  expect(committed).toHaveBeenCalledWith(sessionId, []);
});

test("routes patent recovery through the recovery boundary", async () => {
  const { invoke, recovery, patent } = createHarness();

  await expect(invoke("patents:recover", patent.patentId)).resolves.toEqual({
    ok: true,
    value: { patentId: patent.patentId, backupCreated: true },
  });
  expect(recovery.retryPatent).toHaveBeenCalledWith(patent.patentId);
});

test("exports a saved patent and verifies its revision while recovery is read-only", async () => {
  const { invoke, patents, patent, fileService, snapshots, outputPath } = createHarness({
    readOnly: true,
  });
  await expect(
    invoke("patents:flush", { patentId: patent.patentId, expectedRevision: 0 }),
  ).resolves.toMatchObject({ ok: true });
  await expect(
    invoke("patents:export-patdoc", { patentId: patent.patentId, expectedRevision: 0 }),
  ).resolves.toMatchObject({ ok: true, value: { path: outputPath } });
  expect(fileService.savePatent).toHaveBeenCalledWith(
    outputPath,
    expect.objectContaining({ patent }),
  );
  expect(snapshots.create).not.toHaveBeenCalled();
  expect(patents.applyBookEdit).not.toHaveBeenCalled();
  expect(patents.applyFigureEdit).not.toHaveBeenCalled();
  expect(patents.release).toHaveBeenCalled();
});

test("rejects patent recovery while recovery mode is read-only", async () => {
  const { invoke, recovery, patent } = createHarness({ readOnly: true });

  await expect(invoke("patents:recover", patent.patentId)).resolves.toMatchObject({
    ok: false,
    error: { code: "READ_ONLY_RECOVERY" },
  });
  expect(recovery.retryPatent).not.toHaveBeenCalled();
});

test("keeps staged image leases available when the figure revision needs a retry", async () => {
  const committed = vi.fn(async () => undefined);
  const { invoke, patents, patent } = createHarness({ onPatentFigureEditCommitted: committed });
  patents.applyFigureEdit.mockRejectedValueOnce(
    Object.assign(new Error("stale"), { code: "REVISION_CONFLICT" }),
  );
  const sessionId = "00000000-0000-4000-8000-000000000401";

  await expect(
    invoke("patents:apply-figure-edit", {
      patentId: patent.patentId,
      sessionId,
      expectedRevision: 0,
      figures: [],
      abstractDrawingFigureId: null,
      assets: [],
    }),
  ).resolves.toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });

  expect(committed).not.toHaveBeenCalled();
});

test("flushes the selected revision before exporting a patdoc copy", async () => {
  const { invoke, library, fileService, outputPath } = createHarness();

  const result = await invoke("library:export-patdoc", { libraryDocumentId, expectedRevision: 9 });
  expect(result).toMatchObject({ ok: true, value: { path: outputPath } });

  expect(library.flush).toHaveBeenCalledWith(libraryDocumentId, 9);
  expect(fileService.saveDocument).toHaveBeenCalledWith(
    outputPath,
    expect.objectContaining({
      document: expect.objectContaining({ title: "导入导出文档" }),
      editorState: { cursor: 1 },
      assets: [],
    }),
  );
});

test("rejects renderer-supplied export paths and stale revisions before opening a save dialog", async () => {
  const { invoke, dialog } = createHarness();

  await expect(
    invoke("library:export-patdoc", {
      libraryDocumentId,
      expectedRevision: 9,
      outputPath: "C:\\should-not-be-accepted\\secret.patdoc",
    }),
  ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  await expect(
    invoke("library:export-patdoc", { libraryDocumentId, expectedRevision: 8 }),
  ).resolves.toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
  expect(dialog.showSaveDialog).not.toHaveBeenCalled();
});

test("imports the same patdoc path as separate internal documents", async () => {
  const { invoke, library, fileService } = createHarness();

  const first = await invoke("library:import-patdoc");
  const second = await invoke("library:import-patdoc");

  expect(first).toMatchObject({ ok: true, value: { libraryDocumentId } });
  expect(second).toMatchObject({ ok: true, value: { libraryDocumentId: secondLibraryDocumentId } });
  expect(fileService.openDocument).toHaveBeenCalledTimes(2);
  expect(library.importDocument).toHaveBeenCalledTimes(2);
});

test("rejects mutating library routes while recovery is read-only", async () => {
  const { invoke } = createHarness({ readOnly: true });

  await expect(invoke("library:create")).resolves.toMatchObject({
    ok: false,
    error: { code: "READ_ONLY_RECOVERY" },
  });
  await expect(
    invoke("library:apply-edit", {
      libraryDocumentId,
      sessionId: "00000000-0000-4000-8000-000000000201",
      operationId: "00000000-0000-4000-8000-000000000301",
      baseRevision: 0,
      targetRevision: 1,
      modelVersion: 1,
      operations: [{ type: "set-title", title: "只读中" }],
      editorState: {},
    }),
  ).resolves.toMatchObject({ ok: false, error: { code: "READ_ONLY_RECOVERY" } });
});

test("releases an opened library session without treating recovery read-only as a write", async () => {
  const { invoke, library } = createHarness({ readOnly: true });

  await expect(invoke("library:release", "00000000-0000-4000-8000-000000000201")).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  expect(library.release).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000201");
});

test("lists and imports legacy drafts through the library migration boundary", async () => {
  const { invoke, legacyDraftMigration } = createHarness();

  await expect(invoke("library:legacy-drafts")).resolves.toEqual({ ok: true, value: [] });
  await expect(invoke("library:import-legacy-draft", "legacy-draft")).resolves.toMatchObject({
    ok: true,
    value: { libraryDocumentId },
  });

  expect(legacyDraftMigration.listCandidates).toHaveBeenCalledOnce();
  expect(legacyDraftMigration.importDraftResult).toHaveBeenCalledWith("legacy-draft");
});

test("routes DOCX import sessions with the renderer owner identity", async () => {
  const importedPatent = createBlankPatent({ patentType: "invention", name: "DOCX 导入" });
  const claims = importedPatent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("claims fixture missing");
  const importSessionId = "00000000-0000-4000-8000-000000000811";
  const unitId = "00000000-0000-4000-8000-000000000812";
  const preview = {
    sessionId: importSessionId,
    sourceFileNames: ["权利要求.docx"],
    duplicateOfficialTargets: [],
    warnings: [],
    units: [
      {
        unitId,
        sourceFileName: "权利要求.docx",
        title: "权利要求书",
        target: { kind: "official-book" as const, bookKind: "claims" as const },
        confidence: "high" as const,
        evidence: ["标题"],
        document: claims.document,
        imageCount: 0,
      },
    ],
  } satisfies DocxImportPreview;
  const docxImports = {
    prepare: vi.fn(async () => preview),
    previewAsset: vi.fn(async () => Uint8Array.from([137, 80, 78, 71])),
    update: vi.fn(async () => preview),
    commit: vi.fn(async () => ({
      patentId: importedPatent.patentId,
      sessionId: "00000000-0000-4000-8000-000000000813",
      revision: 0,
      patent: importedPatent,
      saveState: "saved" as const,
    })),
    cancel: vi.fn(async () => undefined),
  };
  const { invoke } = createHarness({ docxImports });
  const event = { sender: { id: 7 } };

  await expect(invoke("patents:prepare-docx-import", undefined, event)).resolves.toEqual({
    ok: true,
    value: preview,
  });
  await expect(
    invoke(
      "patents:get-docx-import-preview-asset",
      {
        sessionId: importSessionId,
        assetId: "00000000-0000-4000-8000-000000000814",
      },
      event,
    ),
  ).resolves.toEqual({ ok: true, value: Uint8Array.from([137, 80, 78, 71]) });
  await expect(
    invoke(
      "patents:update-docx-import",
      {
        sessionId: importSessionId,
        unitId,
        title: "权利要求书",
        target: { kind: "official-book", bookKind: "claims" },
      },
      event,
    ),
  ).resolves.toMatchObject({ ok: true });
  await expect(
    invoke(
      "patents:commit-docx-import",
      {
        sessionId: importSessionId,
        patentType: "invention",
        name: "DOCX 导入",
        customer: null,
        assignments: [
          {
            unitId,
            title: "权利要求书",
            target: { kind: "official-book", bookKind: "claims" },
          },
        ],
        acknowledgedWarningIds: [],
      },
      event,
    ),
  ).resolves.toMatchObject({ ok: true, value: { patentId: importedPatent.patentId } });
  await expect(
    invoke("patents:cancel-docx-import", { sessionId: importSessionId }, event),
  ).resolves.toEqual({ ok: true, value: undefined });

  expect(docxImports.prepare).toHaveBeenCalledWith("7", {});
  const appendTo = {
    patentId: importedPatent.patentId,
    sessionId: "00000000-0000-4000-8000-000000000813",
  };
  await invoke("patents:prepare-docx-import", { appendTo }, event);
  expect(docxImports.prepare).toHaveBeenLastCalledWith("7", { appendTo });
  expect(docxImports.previewAsset).toHaveBeenCalledWith(
    "7",
    importSessionId,
    "00000000-0000-4000-8000-000000000814",
  );
  expect(docxImports.commit).toHaveBeenCalledWith(
    "7",
    expect.objectContaining({ sessionId: importSessionId }),
  );
});

test("routes read-only resource verification and cancellation, rejecting arbitrary paths", async () => {
  const { invoke, patents, patent } = createHarness({ readOnly: true });
  const request = {
    patentId: patent.patentId,
    sessionId: "00000000-0000-4000-8000-000000000401",
    operationId: "00000000-0000-4000-8000-000000000499",
    expectedRevision: 0,
  };
  expect(await invoke("patents:inspect-resources", request)).toEqual({
    ok: true,
    value: { patentId: patent.patentId, patentRevision: 0, assets: [] },
  });
  expect(patents.inspectResources).toHaveBeenCalledWith(request);
  expect(
    await invoke("patents:inspect-resources", { ...request, path: "/private/unrelated" }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(patents.inspectResources).toHaveBeenCalledTimes(1);
  expect(
    await invoke("patents:cancel-resource-inspection", {
      sessionId: request.sessionId,
      operationId: request.operationId,
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(patents.cancelResourceInspection).toHaveBeenCalledWith({
    sessionId: request.sessionId,
    operationId: request.operationId,
  });
});
