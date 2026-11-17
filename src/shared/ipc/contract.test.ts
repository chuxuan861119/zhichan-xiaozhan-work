import { createBlankBookDocument, createBlankDocument } from "../document/defaults.js";
import { createDefaultPrintSettings } from "../printing/model.js";
import {
  AppSettingsPatchSchema,
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
  DEFAULT_PATENT_TEMPLATE_SETTINGS,
} from "../settings/model.js";
import {
  AuxiliaryDocumentExportRequestSchema,
  ChemicalPreviewRequestSchema,
  ChemicalPreviewResultSchema,
  ChemicalStructureSourceResultSchema,
  CopyImagesRequestSchema,
  DirectPrintRequestSchema,
  FlowchartCreateRequestSchema,
  FlowchartOpenedProjectResultSchema,
  FlowchartRenderPreviewRequestSchema,
  FlowchartRenderPreviewSchema,
  FlowchartSaveRequestSchema,
  FormulaDrawingRenderPreviewSchema,
  FormulaDrawingRenderRequestSchema,
  FormulaDrawingRenderResultSchema,
  ImportAssetBatchRequestSchema,
  IPC_CHANNELS,
  imageClipboardMarker,
  LibraryDocumentListResultSchema,
  LibraryEditAckResultSchema,
  LibraryExportPatdocRequestSchema,
  LibraryFlushRequestSchema,
  MAX_CHEMICAL_PREVIEW_SVG_BYTES,
  MenuCommandSchema,
  NullableExportReportResultSchema,
  OpenedLibraryDocumentResultSchema,
  OpenedPatentResultSchema,
  PatentApplyAuxiliaryDocumentEditRequestSchema,
  PatentApplyBookEditRequestSchema,
  PatentApplyFigureEditRequestSchema,
  PatentCreateAuxiliaryDocumentRequestSchema,
  PatentCreateRequestSchema,
  PatentDeleteAuxiliaryDocumentRequestSchema,
  PatentDescriptionEditorStateSchema,
  PatentDocxExportRequestSchema,
  PatentEditAckResultSchema,
  PatentFlushRequestSchema,
  PatentListResultSchema,
  PatentPurgeResultSchema,
  PatentRecoveryResultResultSchema,
  PatentRenameAuxiliaryDocumentRequestSchema,
  PatentSetDrawingBooksRequestSchema,
  PatentTemplateEditorCloseRequestSchema,
  PatentTemplateEditorOpenRequestSchema,
  PatentTemplateEditorSaveRequestSchema,
  PatentUpdateSettingsRequestSchema,
  PRELOAD_INVOKE_CHANNELS,
  PrinterDescriptorsResultSchema,
  PrintPreviewRequestSchema,
  PrintPreviewResultSchema,
  SavedDocumentResultSchema,
  SaveImageRequestSchema,
  SavePreviewPdfRequestSchema,
  SnapshotContentPreviewResultSchema,
  SnapshotCreateRequestSchema,
  SnapshotCreationResultResultSchema,
  SnapshotCreationResultSchema,
  SnapshotDeletionResultResultSchema,
  SnapshotEntryListResultSchema,
  SnapshotPreviewAssetResultSchema,
  WindowLayoutStateResultSchema,
  WindowLayoutStateSchema,
} from "./contract.js";
import { normalizeAppError } from "./result.js";

test("snapshot deletion retains post-commit cleanup warnings through IPC", () => {
  const result = { ok: true, value: { cleanupError: "稍后清理" } };
  expect(SnapshotDeletionResultResultSchema.parse(result)).toEqual(result);
  expect(
    SnapshotDeletionResultResultSchema.parse({ ok: true, value: { cleanupError: null } }).ok,
  ).toBe(true);
});

const patentId = "0a1fbf8d-52fe-4a14-98df-c18bbac5e428";

test("declares renderer recovery as a preload-only invoke channel", () => {
  expect(IPC_CHANNELS.applicationReloadRenderer).toBe("application:reload-renderer");
  expect(PRELOAD_INVOKE_CHANNELS).toContain("application:reload-renderer");
});

test("exposes strict template editor lifecycle contracts", () => {
  const sessionId = crypto.randomUUID();
  expect(PRELOAD_INVOKE_CHANNELS).toEqual(
    expect.arrayContaining([
      "patent-templates:read-summary",
      "patent-templates:read-auxiliary",
      "patent-templates:open-editor",
      "patent-templates:capture-current",
      "patent-templates:save-editor",
      "patent-templates:close-editor",
    ]),
  );
  expect(PatentTemplateEditorOpenRequestSchema.parse({ patentType: "invention" })).toEqual({
    patentType: "invention",
  });
  expect(PatentTemplateEditorCloseRequestSchema.parse({ sessionId })).toEqual({ sessionId });
  expect(
    PatentTemplateEditorSaveRequestSchema.safeParse({ sessionId, expectedRevision: 0 }).success,
  ).toBe(false);
});

test("single image export accepts a fixed format and retains legacy format selection", () => {
  const request = {
    sessionId: "aa38551f-a08d-449b-99b4-a37dc514e484",
    image: { assetId: "7210f009-157c-43a4-bf9f-75b9e9872400", rotationDeg: 0, label: "图1" },
  };
  expect(SaveImageRequestSchema.parse(request)).toEqual(request);
  expect(SaveImageRequestSchema.parse({ ...request, format: "jpg" })).toEqual({
    ...request,
    format: "jpg",
  });
  expect(SaveImageRequestSchema.safeParse({ ...request, format: "pdf" }).success).toBe(false);
});

test("validates a bounded ordered clipboard image batch", () => {
  const request = {
    sessionId: "aa38551f-a08d-449b-99b4-a37dc514e484",
    operationId: "ba38551f-a08d-449b-99b4-a37dc514e484",
    images: [
      {
        originalName: "first.png",
        declaredMediaType: "image/png",
        bytes: Uint8Array.from([1]),
      },
      {
        originalName: "second.jpg",
        declaredMediaType: "image/jpeg",
        bytes: Uint8Array.from([2]),
      },
    ],
  };

  expect(ImportAssetBatchRequestSchema.parse(request)).toEqual(request);
  expect(ImportAssetBatchRequestSchema.safeParse({ ...request, images: [] }).success).toBe(false);
});

test("validates a bounded mixed-content image clipboard payload", () => {
  const request = {
    sessionId: "aa38551f-a08d-449b-99b4-a37dc514e484",
    images: [
      {
        assetId: "7210f009-157c-43a4-bf9f-75b9e9872400",
        rotationDeg: 90 as const,
        layout: "inline" as const,
        widthMm: 30,
        alignment: "right" as const,
        label: "图片1",
      },
    ],
    htmlTemplate: `<p>前${imageClipboardMarker(0)}后</p>`,
    text: "前后",
  };

  expect(CopyImagesRequestSchema.parse(request)).toEqual(request);
  expect(
    CopyImagesRequestSchema.safeParse({ ...request, htmlTemplate: "x".repeat(2 * 1024 * 1024 + 1) })
      .success,
  ).toBe(false);
  expect(
    CopyImagesRequestSchema.safeParse({
      ...request,
      images: [{ ...request.images[0], widthMm: 166 }],
    }).success,
  ).toBe(false);
});

test("validates structured snapshot list results and exposes manual creation", () => {
  expect(PRELOAD_INVOKE_CHANNELS).toContain("snapshot:create");
  const result = {
    ok: true as const,
    value: {
      entries: [
        {
          documentType: "patent" as const,
          documentId: patentId,
          displayName: "快照专利",
          source: "manual-create" as const,
          revision: 3,
          sizeBytes: 1024,
          createdAt: "2026-08-16T01:02:03.000Z",
          status: "healthy" as const,
          errorMessage: null,
          deletable: false,
          contentSummary: {
            books: [
              "claims",
              "description",
              "description-drawings",
              "abstract",
              "abstract-drawing",
            ].map((kind) => ({ kind, characterCount: 0, preview: "" })),
            figureCount: 0,
            assetCount: 0,
            flowchartCount: 0,

            referenceMarkCount: 0,
          },
        },
      ],
      warnings: [
        {
          documentType: "patent" as const,
          documentId: "8a3fcde0-3cd1-48ec-883a-53f7ed0a253a",
          displayName: "无法读取的专利",
          message: "快照历史损坏",
        },
      ],
    },
  };

  expect(SnapshotEntryListResultSchema.parse(result)).toEqual(result);
});

test("restricts snapshot creation sources to explicit renderer actions", () => {
  const base = { documentType: "patent" as const, documentId: patentId };

  for (const source of [
    "manual-save",
    "manual-create",
    "patent-close",
    "application-close",
  ] as const) {
    expect(SnapshotCreateRequestSchema.safeParse({ ...base, source }).success).toBe(true);
  }
  for (const source of ["initial", "automatic", "historical"] as const) {
    expect(SnapshotCreateRequestSchema.safeParse({ ...base, source }).success).toBe(false);
  }
  expect(
    SnapshotCreationResultSchema.parse({
      outcome: "created",
      revision: 3,
      createdAt: "2026-08-16T01:02:03.000Z",
      source: "automatic",
    }),
  ).toEqual({
    outcome: "created",
    revision: 3,
    createdAt: "2026-08-16T01:02:03.000Z",
    source: "automatic",
  });
  expect(
    SnapshotCreationResultSchema.safeParse({
      outcome: "already-exists",
      revision: 3,
      createdAt: "2026-08-16T01:02:03.000Z",
      source: "manual-save",
    }).success,
  ).toBe(true);
  expect(
    SnapshotCreationResultResultSchema.parse({
      ok: true,
      value: {
        outcome: "already-exists",
        revision: 3,
        createdAt: "2026-08-16T01:02:03.000Z",
        source: "manual-save",
      },
    }),
  ).toEqual({
    ok: true,
    value: {
      outcome: "already-exists",
      revision: 3,
      createdAt: "2026-08-16T01:02:03.000Z",
      source: "manual-save",
    },
  });
});

test("exposes strict snapshot content and asset preview IPC contracts", () => {
  const books = [
    "description",
    "claims",
    "abstract",
    "description-drawings",
    "abstract-drawing",
  ].map((kind) => ({
    kind,
    document: createBlankBookDocument(kind, "2026-08-16T00:00:00.000Z"),
  }));
  const result = {
    ok: true as const,
    value: {
      current: { revision: 2, createdAt: "2026-08-16T02:00:00.000Z", books },
      baseline: { revision: 1, createdAt: "2026-08-16T01:00:00.000Z", books },
      comparison: "compared" as const,
      skippedRevisions: [],
    },
  };

  expect(IPC_CHANNELS.snapshotPreview).toBe("snapshot:preview");
  expect(IPC_CHANNELS.snapshotPreviewAsset).toBe("snapshot:preview-asset");
  expect(PRELOAD_INVOKE_CHANNELS).toContain("snapshot:preview");
  expect(PRELOAD_INVOKE_CHANNELS).toContain("snapshot:preview-asset");
  expect(SnapshotContentPreviewResultSchema.safeParse(result).success).toBe(true);
  expect(SnapshotContentPreviewResultSchema.safeParse({ ...result, value: {} }).success).toBe(
    false,
  );
  expect(
    SnapshotPreviewAssetResultSchema.safeParse({ ok: true, value: new Uint8Array([1, 2]) }).success,
  ).toBe(true);
  expect(SnapshotPreviewAssetResultSchema.safeParse({ ok: true, value: [1, 2] }).success).toBe(
    false,
  );
});

test("declares the staged DOCX preview image channel as renderer-readable", () => {
  expect(IPC_CHANNELS.patentsGetDocxImportPreviewAsset).toBe(
    "patents:get-docx-import-preview-asset",
  );
  expect(PRELOAD_INVOKE_CHANNELS).toContain("patents:get-docx-import-preview-asset");
});

test("validates strict patent aggregate IPC contracts", () => {
  const summary = {
    patentId,
    name: null,
    customer: null,
    patentType: "invention" as const,
    revision: 7,
    bookStatuses: {
      claims: "empty" as const,
      description: "draft" as const,
      "description-drawings": "empty" as const,
      abstract: "empty" as const,
      "abstract-drawing": "empty" as const,
    },
    issueCount: 0,
    saveState: "saved" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    modifiedAt: "2026-08-01T00:01:00.000Z",
    deletedAt: null,
    recoveryState: "healthy" as const,
    recoveryErrorCode: null,
  };
  const acknowledgement = {
    patentId,
    revision: 8,
    savedAt: "2026-08-01T00:02:00.000Z",
  };

  expect(PatentListResultSchema.parse({ ok: true, value: [summary] })).toEqual({
    ok: true,
    value: [summary],
  });
  expect(PatentEditAckResultSchema.parse({ ok: true, value: acknowledgement })).toEqual({
    ok: true,
    value: acknowledgement,
  });
  expect(PatentCreateRequestSchema.parse({ patentType: "utility-model", name: null })).toEqual({
    patentType: "utility-model",
    name: null,
  });
  expect(
    PatentCreateRequestSchema.safeParse({
      patentType: "invention",
      name: "名".repeat(101),
    }).success,
  ).toBe(false);
  expect(
    PatentUpdateSettingsRequestSchema.safeParse({
      patentId,
      expectedRevision: 7,
      patentType: "invention",
      customer: "客".repeat(101),
    }).success,
  ).toBe(false);
  expect(
    PatentCreateRequestSchema.parse({
      patentType: "invention",
      name: "测试专利",
      customer: "  测试客户  ",
    }),
  ).toEqual({ patentType: "invention", name: "测试专利", customer: "测试客户" });
  expect(
    PatentCreateRequestSchema.safeParse({
      name: "环保回收装置",
      patentType: "utility-model",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    }).success,
  ).toBe(false);
  expect(
    PatentUpdateSettingsRequestSchema.safeParse({
      patentId,
      expectedRevision: 7,
      name: "新名称",
      patentType: "invention",
      outputPath: "C:\\must-not-be-renderer-controlled.patdoc",
    }).success,
  ).toBe(false);
  expect(
    PatentUpdateSettingsRequestSchema.safeParse({
      patentId,
      expectedRevision: 7,
      name: "新名称",
      patentType: "invention",
      assets: [],
    }).success,
  ).toBe(true);
  const drawingBooksRequest = {
    patentId,
    sessionId: "aa38551f-a08d-449b-99b4-a37dc514e484",
    expectedRevision: 7,
    enabled: false,
  };
  expect(PatentSetDrawingBooksRequestSchema.parse(drawingBooksRequest)).toEqual(
    drawingBooksRequest,
  );
  expect(
    PatentSetDrawingBooksRequestSchema.safeParse({ ...drawingBooksRequest, enabled: "false" })
      .success,
  ).toBe(false);
  expect(
    PatentSetDrawingBooksRequestSchema.safeParse({
      ...drawingBooksRequest,
      settings: {
        name: "改为实用新型",
        customer: null,
        patentType: "utility-model",
        terminologyReplacementRequested: false,
      },
    }).success,
  ).toBe(false);
  expect(
    OpenedPatentResultSchema.safeParse({
      ok: true,
      value: {
        patentId,
        sessionId: acknowledgement.patentId,
        revision: 7,
        patent: {},
        saveState: "saved",
      },
    }).success,
  ).toBe(false);
  expect(PatentPurgeResultSchema.parse({ purgedPatentIds: [patentId] })).toEqual({
    purgedPatentIds: [patentId],
  });
  expect(
    PatentRecoveryResultResultSchema.parse({
      ok: true,
      value: { patentId, backupCreated: true },
    }),
  ).toEqual({
    ok: true,
    value: { patentId, backupCreated: true },
  });
  expect(
    PatentRecoveryResultResultSchema.safeParse({
      ok: true,
      value: { patentId, backupCreated: false },
    }).success,
  ).toBe(false);
  expect(PatentFlushRequestSchema.parse({ patentId, expectedRevision: 7 })).toEqual({
    patentId,
    expectedRevision: 7,
  });
  expect(
    PatentApplyFigureEditRequestSchema.parse({
      patentId,
      sessionId: "aa38551f-a08d-449b-99b4-a37dc514e484",
      expectedRevision: 7,
      figures: [
        {
          figureId: "961fd015-a921-4ea1-b1da-b68cbec11921",
          assetId: "7210f009-157c-43a4-bf9f-75b9e9872400",
          widthMm: 90,
        },
      ],
      abstractDrawingFigureId: "961fd015-a921-4ea1-b1da-b68cbec11921",
      assets: [
        {
          assetId: "7210f009-157c-43a4-bf9f-75b9e9872400",
          kind: "image",
          originalName: "fig.png",
          mediaType: "image/png",
          extension: "png",
          byteLength: 10,
          sha256: "A".repeat(64),
          widthPx: 100,
          heightPx: 80,
          previewByteLength: 8,
          previewSha256: "B".repeat(64),
        },
      ],
    }).figures,
  ).toHaveLength(1);
  expect(
    PatentDescriptionEditorStateSchema.parse({
      unlinkedFigureExplanations: [],
      selection: { anchor: 1 },
    }),
  ).toEqual({ unlinkedFigureExplanations: [], selection: { anchor: 1 } });
  expect(
    PatentApplyFigureEditRequestSchema.safeParse({
      patentId,
      sessionId: "aa38551f-a08d-449b-99b4-a37dc514e484",
      expectedRevision: 7,
      figures: [],
      abstractDrawingFigureId: "961fd015-a921-4ea1-b1da-b68cbec11921",
      assets: [],
    }).success,
  ).toBe(false);
  expect(
    PatentApplyFigureEditRequestSchema.safeParse({
      patentId,
      sessionId: "aa38551f-a08d-449b-99b4-a37dc514e484",
      expectedRevision: 7,
      figures: [
        {
          figureId: "961fd015-a921-4ea1-b1da-b68cbec11921",
          assetId: "7210f009-157c-43a4-bf9f-75b9e9872400",
          widthMm: 90,
        },
        {
          figureId: "961fd015-a921-4ea1-b1da-b68cbec11921",
          assetId: "7210f009-157c-43a4-bf9f-75b9e9872400",
          widthMm: 91,
        },
      ],
      abstractDrawingFigureId: null,
      assets: [],
    }).success,
  ).toBe(false);
  expect(
    PatentApplyFigureEditRequestSchema.safeParse({
      patentId,
      sessionId: "aa38551f-a08d-449b-99b4-a37dc514e484",
      expectedRevision: 7,
      figures: [],
      abstractDrawingFigureId: null,
      assets: [],
      descriptionEdit: {
        document: createBlankBookDocument("说明书", "2026-08-02T00:00:00.000Z"),
        editorState: { unlinkedFigureExplanations: [] },
      },
    }).success,
  ).toBe(false);
  expect(
    PatentDocxExportRequestSchema.safeParse({
      sessionId: "aa38551f-a08d-449b-99b4-a37dc514e484",
      patentId,
      expectedRevision: 8,
      mode: "combined",
      suggestedName: "五书合并导出",
    }).success,
  ).toBe(true);
  expect(
    PatentDocxExportRequestSchema.safeParse({
      sessionId: "aa38551f-a08d-449b-99b4-a37dc514e484",
      patent: {},
      mode: "combined",
      suggestedName: "五书合并导出",
    }).success,
  ).toBe(false);
  const auxiliaryExport = {
    sessionId: "aa38551f-a08d-449b-99b4-a37dc514e484",
    patentId,
    expectedRevision: 8,
    auxiliaryDocumentId: "961fd015-a921-4ea1-b1da-b68cbec11921",
    suggestedName: "专利-实验记录",
  };
  expect(AuxiliaryDocumentExportRequestSchema.parse(auxiliaryExport)).toEqual(auxiliaryExport);
  expect(
    AuxiliaryDocumentExportRequestSchema.safeParse({
      ...auxiliaryExport,
      document: createBlankDocument("伪造内容"),
    }).success,
  ).toBe(false);
});

test("validates bounded strict flowchart persistence IPC contracts", () => {
  const projectId = "2e8882e7-9066-4e91-9378-4e461e722d5b";
  const source = Uint8Array.from(Buffer.from('<mxfile><diagram id="p1"/></mxfile>'));
  const create = {
    patentId,
    expectedPatentRevision: 3,
    name: "流程图工程",
    source,
    pageCount: 1,
    lastPageId: "p1",
  };
  expect(FlowchartCreateRequestSchema.parse(create)).toEqual(create);
  expect(
    FlowchartCreateRequestSchema.safeParse({ ...create, path: "C:\\secret.drawio" }).success,
  ).toBe(false);
  expect(
    FlowchartSaveRequestSchema.parse({
      patentId,
      expectedPatentRevision: 3,
      source,
      pageCount: 1,
      lastPageId: "p1",
      projectId,
      expectedProjectRevision: 2,
    }),
  ).toMatchObject({ projectId, expectedProjectRevision: 2 });
  expect(
    FlowchartOpenedProjectResultSchema.safeParse({
      ok: true,
      value: {
        project: {
          projectId,
          name: "流程图工程",
          revision: 2,
          pageCount: 1,
          lastPageId: "p1",
          sourceSha256: "A".repeat(64),
          createdAt: "2026-08-11T00:00:00.000Z",
          modifiedAt: "2026-08-11T00:00:00.000Z",
        },
        source,
        patentRevision: 4,
      },
    }).success,
  ).toBe(true);
});

test("allows a new flowchart figure preview to derive its output width from SVG bounds", () => {
  expect(
    FlowchartRenderPreviewRequestSchema.safeParse({
      patentId,
      projectId: "2e8882e7-9066-4e91-9378-4e461e722d5b",
      expectedProjectRevision: 2,
      expectedSourceSha256: "A".repeat(64),
      pageId: "p1",
      exportScope: "page",
      selectedCellIds: [],
      borderMm: 2,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60"/></svg>',
      target: { kind: "new", insertIndex: 0 },
    }).success,
  ).toBe(true);
});

test("requires the frozen physical width independently of preview pixel resolution", () => {
  const preview = {
    previewToken: "2e8882e7-9066-4e91-9378-4e461e722d5b",
    preview: new Uint8Array([137, 80, 78, 71]),
    widthPx: 422,
    heightPx: 235,
    warnings: [],
  };
  expect(FlowchartRenderPreviewSchema.safeParse(preview).success).toBe(false);
  expect(
    FlowchartRenderPreviewSchema.parse({ ...preview, outputWidthMm: 35.75 }).outputWidthMm,
  ).toBe(35.75);
  expect(FlowchartRenderPreviewSchema.safeParse({ ...preview, outputWidthMm: 166 }).success).toBe(
    false,
  );
});

test("requires a unique complete asset snapshot for chemical book edits", () => {
  const previewAssetId = "00000000-0000-4000-8000-000000000901";
  const preview = {
    assetId: previewAssetId,
    kind: "image" as const,
    originalName: "structure.png",
    mediaType: "image/png" as const,
    extension: "png" as const,
    byteLength: 10,
    sha256: "A".repeat(64),
    widthPx: 800,
    heightPx: 600,
    previewByteLength: 8,
    previewSha256: "B".repeat(64),
  };
  const document = {
    ...createBlankBookDocument("说明书", "2026-08-04T00:00:00.000Z"),
    content: [
      {
        id: "00000000-0000-4000-8000-000000000902",
        type: "chemical-structure" as const,
        ketSource: "(ket) (atom C)",
        previewAssetId,
        widthMm: 80,
        alignment: "center" as const,
      },
    ],
  };
  const request = {
    patentId,
    sessionId: "aa38551f-a08d-449b-99b4-a37dc514e484",
    bookKind: "description" as const,
    expectedRevision: 7,
    document,
    editorState: {},
    assets: [preview],
  };

  expect(PatentApplyBookEditRequestSchema.parse(request)).toEqual(request);
  expect(PatentApplyBookEditRequestSchema.safeParse({ ...request, assets: [] }).success).toBe(
    false,
  );
  expect(
    PatentApplyBookEditRequestSchema.safeParse({ ...request, assets: [preview, preview] }).success,
  ).toBe(false);
});

test("validates strict auxiliary document mutation requests", () => {
  const document = createBlankBookDocument("其他材料", "2026-08-31T00:00:00.000Z");
  const auxiliaryDocumentId = "00000000-0000-4000-8000-000000000921";
  const sessionId = "aa38551f-a08d-449b-99b4-a37dc514e484";
  const auxiliary = {
    auxiliaryDocumentId,
    title: "其他材料",
    document,
    editorState: {},
    localRevision: 0,
    persistedRevision: 0,
    sourceFileName: "其他材料.docx",
  };

  expect(
    PatentCreateAuxiliaryDocumentRequestSchema.parse({
      patentId,
      sessionId,
      expectedRevision: 0,
      document: auxiliary,
    }),
  ).toBeDefined();
  expect(
    PatentApplyAuxiliaryDocumentEditRequestSchema.safeParse({
      patentId,
      sessionId,
      auxiliaryDocumentId,
      expectedRevision: 1,
      document,
      editorState: {},
      assets: [],
      unexpected: true,
    }).success,
  ).toBe(false);
  expect(
    PatentRenameAuxiliaryDocumentRequestSchema.safeParse({
      patentId,
      sessionId,
      auxiliaryDocumentId,
      expectedRevision: 1,
      title: " ",
    }).success,
  ).toBe(false);
  expect(
    PatentDeleteAuxiliaryDocumentRequestSchema.parse({
      patentId,
      sessionId,
      auxiliaryDocumentId,
      expectedRevision: 1,
    }),
  ).toBeDefined();
});

test("validates strict library result contracts", () => {
  const summary = {
    libraryDocumentId: "0a1fbf8d-52fe-4a14-98df-c18bbac5e428",
    title: "往复式夹具",
    snippet: "本发明涉及…",
    revision: 7,
    saveState: "saved" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    modifiedAt: "2026-08-01T00:01:00.000Z",
    deletedAt: null,
    quarantinedAt: null,
    recoveryState: "healthy" as const,
    recoveryErrorCode: null,
  };
  const acknowledgement = {
    libraryDocumentId: summary.libraryDocumentId,
    operationId: "aa38551f-a08d-449b-99b4-a37dc514e484",
    revision: 8,
    savedAt: "2026-08-01T00:02:00.000Z",
  };

  expect(LibraryDocumentListResultSchema.parse({ ok: true, value: [summary] })).toEqual({
    ok: true,
    value: [summary],
  });
  expect(LibraryEditAckResultSchema.parse({ ok: true, value: acknowledgement })).toEqual({
    ok: true,
    value: acknowledgement,
  });
  expect(
    LibraryEditAckResultSchema.safeParse({
      ok: true,
      value: { ...acknowledgement, untrusted: true },
    }).success,
  ).toBe(false);
});

test.each(["REVISION_CONFLICT", "LIBRARY_LOCKED", "READ_ONLY_RECOVERY"] as const)(
  "normalizes the %s library error",
  (code) => {
    const normalized = normalizeAppError({ code, message: "raw internal detail" });

    expect(normalized.code).toBe(code);
    expect(normalized.message).not.toContain("raw internal detail");
    expect(normalized.nextAction).toBeTruthy();
  },
);

test("removes obsolete autosave commands from the public menu contract", () => {
  expect(MenuCommandSchema.safeParse("open-drafts").success).toBe(false);
  expect(MenuCommandSchema.safeParse("autosave-settings").success).toBe(false);
});

test("allows the patent recovery IPC channel through preload", () => {
  expect(PRELOAD_INVOKE_CHANNELS).toContain("patents:recover");
});

test("validates strict chemical preview IPC contracts and preload channel", () => {
  const request = {
    sessionId: "session-1",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  };
  const descriptor = {
    assetId: "00000000-0000-4000-8000-000000000001",
    kind: "chemical-preview",
    originalName: "structure.svg",
    mediaType: "image/svg+xml",
    extension: "svg",
    byteLength: 1,
    sha256: "A".repeat(64),
    widthPx: 1,
    heightPx: 1,
    previewByteLength: 4,
    previewSha256: "B".repeat(64),
  } as const;
  const result = {
    ok: true as const,
    value: { descriptor, preview: Uint8Array.from([137, 80, 78, 71]) },
  };

  expect(ChemicalPreviewRequestSchema.parse(request)).toEqual(request);
  expect(
    ChemicalPreviewRequestSchema.safeParse({ ...request, path: "C:\\unsafe.svg" }).success,
  ).toBe(false);
  expect(
    ChemicalPreviewRequestSchema.safeParse({
      svg: " ".repeat(MAX_CHEMICAL_PREVIEW_SVG_BYTES + 1),
    }).success,
  ).toBe(false);
  expect(ChemicalPreviewRequestSchema.safeParse({ ...request, sessionId: "" }).success).toBe(false);
  expect(ChemicalPreviewResultSchema.parse(result)).toEqual(result);
  expect(
    ChemicalPreviewResultSchema.safeParse({
      ok: true,
      value: { ...result.value, url: "file:///unsafe" },
    }).success,
  ).toBe(false);
  expect(PRELOAD_INVOKE_CHANNELS).toContain("chemistry:rasterize-preview");
  expect(PRELOAD_INVOKE_CHANNELS).toContain(IPC_CHANNELS.chemistryReadStructureSource);
  const source = { ketSource: '{"root":{"nodes":[{"label":"No"}]}}', editorMode: "molecule" };
  expect(ChemicalPreviewRequestSchema.parse({ ...request, source }).source).toEqual(source);
  expect(ChemicalStructureSourceResultSchema.parse({ ok: true, value: source })).toEqual({
    ok: true,
    value: source,
  });
  expect(ChemicalStructureSourceResultSchema.parse({ ok: true, value: null })).toEqual({
    ok: true,
    value: null,
  });
  expect(
    ChemicalPreviewRequestSchema.safeParse({
      ...request,
      source: { ...source, editorMode: "unknown" },
    }).success,
  ).toBe(false);
});

test("validates formula drawing renders without exposing a filesystem path", () => {
  const request = { sessionId: "session-1", latex: "E=mc^2" };
  const result = {
    ok: true as const,
    value: { png: Uint8Array.from([137, 80, 78, 71]), widthPx: 320, heightPx: 180 },
  };

  expect(FormulaDrawingRenderRequestSchema.parse(request)).toEqual(request);
  expect(
    FormulaDrawingRenderRequestSchema.parse({ ...request, outputWidthMm: 87 }).outputWidthMm,
  ).toBe(87);
  for (const outputWidthMm of [0, 9, 166, Infinity, NaN]) {
    expect(FormulaDrawingRenderRequestSchema.safeParse({ ...request, outputWidthMm }).success).toBe(
      false,
    );
    expect(
      ChemicalPreviewRequestSchema.safeParse({
        sessionId: "session-1",
        svg: "<svg/>",
        outputWidthMm,
      }).success,
    ).toBe(false);
  }
  expect(
    ChemicalPreviewRequestSchema.parse({ sessionId: "session-1", svg: "<svg/>", outputWidthMm: 87 })
      .outputWidthMm,
  ).toBe(87);
  expect(FormulaDrawingRenderPreviewSchema.parse(result.value)).toEqual(result.value);
  expect(FormulaDrawingRenderResultSchema.parse(result)).toEqual(result);
  expect(
    FormulaDrawingRenderRequestSchema.safeParse({ ...request, filePath: "C:\\unsafe.png" }).success,
  ).toBe(false);
  expect(
    FormulaDrawingRenderPreviewSchema.safeParse({ ...result.value, widthPx: 4097 }).success,
  ).toBe(false);
  expect(PRELOAD_INVOKE_CHANNELS).toContain(IPC_CHANNELS.formulaDrawingsRender);
});

test("accepts only complete patent template settings patches", () => {
  expect(AppSettingsSchema.parse(DEFAULT_APP_SETTINGS).patentTemplates).toEqual(
    DEFAULT_PATENT_TEMPLATE_SETTINGS,
  );
  expect(AppSettingsSchema.parse(DEFAULT_APP_SETTINGS).printPreferences.paperSize).toBe("A4");
  expect(
    AppSettingsPatchSchema.safeParse({ patentTemplates: DEFAULT_PATENT_TEMPLATE_SETTINGS }).success,
  ).toBe(true);
  expect(
    AppSettingsPatchSchema.safeParse({
      patentTemplates: { invention: DEFAULT_PATENT_TEMPLATE_SETTINGS.invention },
    }).success,
  ).toBe(false);
  expect(AppSettingsPatchSchema.safeParse({ patentTemplates: undefined }).success).toBe(false);
  expect(AppSettingsPatchSchema.safeParse({ zoomPercent: undefined }).success).toBe(false);
  expect(AppSettingsPatchSchema.safeParse({}).success).toBe(true);
});

test("preserves the retained-previous-version notice in save results", () => {
  const result = {
    ok: true as const,
    value: {
      sessionId: "session-1",
      path: "C:\\documents\\draft.patdoc",
      displayName: "draft.patdoc",
      savedAt: "2026-08-01T00:00:00.000Z",
      previousVersionRetained: true,
    },
  };

  expect(SavedDocumentResultSchema.parse(result)).toEqual(result);
});

test("validates strict library preload request contracts", () => {
  const libraryDocumentId = "0a1fbf8d-52fe-4a14-98df-c18bbac5e428";

  expect(LibraryFlushRequestSchema.parse({ libraryDocumentId, expectedRevision: 7 })).toEqual({
    libraryDocumentId,
    expectedRevision: 7,
  });
  expect(
    LibraryExportPatdocRequestSchema.safeParse({
      libraryDocumentId,
      expectedRevision: 7,
      outputPath: "C:\\secret\\must-not-be-renderer-controlled.patdoc",
    }).success,
  ).toBe(false);
  expect(
    OpenedLibraryDocumentResultSchema.safeParse({
      ok: true,
      value: {
        libraryDocumentId,
        sessionId: "aa38551f-a08d-449b-99b4-a37dc514e484",
        revision: 7,
        document: { malformed: true },
        editorState: {},
        saveState: "saved",
      },
    }).success,
  ).toBe(false);
});

test("preserves structured DOCX failure details through the preload result schema", () => {
  const issues = Array.from({ length: 12 }, (_, index) => ({
    severity: "error" as const,
    code: "MISSING_ASSET" as const,
    nodeId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    message: `附图资源不存在：missing-asset-${index}`,
  }));
  const result = {
    ok: false as const,
    error: {
      code: "EXPORT_FAILED" as const,
      message: "DOCX 导出失败。",
      outputPath: "C:\\exports\\broken.docx",
      issues,
    },
  };

  expect(NullableExportReportResultSchema.parse(result)).toEqual(result);
});

test("accepts successful PATDOC export reports", () => {
  const result = {
    ok: true as const,
    value: {
      format: "patdoc" as const,
      outputPath: "C:\\exports\\reference.patdoc",
      issues: [],
    },
  };

  expect(NullableExportReportResultSchema.parse(result)).toEqual(result);
});

test("validates opaque preview results and rejects renderer-supplied PDF bytes on save", () => {
  const preview = {
    ok: true as const,
    value: {
      previewId: "5d5c49f1-5f4c-4e70-9326-dd7e17d68a41",
      bytes: Uint8Array.from([37, 80, 68, 70, 45]),
    },
  };

  expect(PrintPreviewResultSchema.parse(preview)).toEqual(preview);
  expect(
    SavePreviewPdfRequestSchema.parse({
      previewId: preview.value.previewId,
      suggestedName: "打印参考文档",
    }),
  ).toEqual({ previewId: preview.value.previewId, suggestedName: "打印参考文档" });
  expect(
    SavePreviewPdfRequestSchema.safeParse({
      previewId: preview.value.previewId,
      suggestedName: "打印参考文档",
      bytes: preview.value.bytes,
    }).success,
  ).toBe(false);
  expect(
    SavePreviewPdfRequestSchema.safeParse({
      previewId: preview.value.previewId,
      suggestedName: "..\\unsafe",
    }).success,
  ).toBe(false);
});

test("requires layout for preview requests and keeps direct print bound to a preview", () => {
  const document = createBlankDocument("打印合同");
  const settings = createDefaultPrintSettings(document.page);
  const previewRequest = {
    sessionId: "preview-session",
    targetId: "preview-target",
    document,
    suggestedName: "打印合同",
    layout: settings.layout,
  };
  const directPrintRequest = {
    sessionId: "preview-session",
    previewId: "5d5c49f1-5f4c-4e70-9326-dd7e17d68a41",
    output: settings.output,
  };

  expect(PrintPreviewRequestSchema.parse(previewRequest)).toEqual(previewRequest);
  expect(
    PrintPreviewRequestSchema.safeParse({
      sessionId: previewRequest.sessionId,
      targetId: previewRequest.targetId,
      document,
      suggestedName: previewRequest.suggestedName,
    }).success,
  ).toBe(false);
  expect(
    PrintPreviewRequestSchema.safeParse({ ...previewRequest, targetId: undefined }).success,
  ).toBe(false);
  expect(DirectPrintRequestSchema.parse(directPrintRequest)).toEqual(directPrintRequest);
  expect(
    DirectPrintRequestSchema.safeParse({
      ...directPrintRequest,
      document,
    }).success,
  ).toBe(false);
  expect(
    DirectPrintRequestSchema.safeParse({
      ...directPrintRequest,
      output: { ...settings.output, pageRanges: [{ from: 2, to: 1 }] },
    }).success,
  ).toBe(false);
  expect(
    DirectPrintRequestSchema.safeParse({
      ...directPrintRequest,
      output: { ...settings.output, pageRanges: [{ from: -1, to: 1 }] },
    }).success,
  ).toBe(false);
});

test("exposes only sanitized printer descriptors in IPC results", () => {
  const result = {
    ok: true as const,
    value: [
      {
        deviceName: "printer-1",
        displayName: "Office Printer",
        description: null,
        duplex: "unknown" as const,
        color: "unknown" as const,
        paperSize: "unknown" as const,
      },
    ],
  };

  expect(PrinterDescriptorsResultSchema.parse(result)).toEqual(result);
  expect(
    PrinterDescriptorsResultSchema.safeParse({
      ok: true,
      value: [
        {
          ...result.value[0],
          options: { rawDriverField: true },
        },
      ],
    }).success,
  ).toBe(false);
});

test("exposes strict window layout contracts through invoke-only channels", () => {
  const layout = {
    isMaximized: true,
    contentWidth: 1920,
    contentHeight: 1080,
  };

  expect(WindowLayoutStateSchema.parse(layout)).toEqual(layout);
  expect(WindowLayoutStateSchema.parse({ ...layout, displayWidthMm: 326.571 }).displayWidthMm).toBe(
    326.571,
  );
  expect(
    WindowLayoutStateSchema.parse({ ...layout, displayWidthMm: null }).displayWidthMm,
  ).toBeNull();
  expect(WindowLayoutStateSchema.safeParse({ ...layout, displayWidthMm: NaN }).success).toBe(false);
  expect(WindowLayoutStateResultSchema.parse({ ok: true, value: layout })).toEqual({
    ok: true,
    value: layout,
  });
  expect(WindowLayoutStateSchema.safeParse({ ...layout, contentWidth: -1 }).success).toBe(false);
  expect(WindowLayoutStateSchema.safeParse({ ...layout, unexpected: true }).success).toBe(false);
  expect(PRELOAD_INVOKE_CHANNELS).toContain(IPC_CHANNELS.applicationGetWindowLayoutState);
  expect(PRELOAD_INVOKE_CHANNELS).toContain(IPC_CHANNELS.applicationMaximizeWindow);
  expect(PRELOAD_INVOKE_CHANNELS).not.toContain(IPC_CHANNELS.applicationWindowLayoutChanged);
});

test("drawing edit transport rejects conflicting formats and malformed patch projects", () => {
  const request = {
    patentId: "00000000-0000-4000-8000-000000000101",
    sessionId: "00000000-0000-4000-8000-000000000201",
    expectedRevision: 0,
    figures: [],
    abstractDrawingFigureId: null,
    assets: [],
  };
  const patch = { projectIds: [], projects: [] };
  expect(
    PatentApplyFigureEditRequestSchema.safeParse({ ...request, drawingProjectEdits: patch })
      .success,
  ).toBe(true);
  expect(
    PatentApplyFigureEditRequestSchema.safeParse({
      ...request,
      drawingProjects: [],
      drawingProjectEdits: patch,
    }).success,
  ).toBe(false);
  expect(
    PatentApplyFigureEditRequestSchema.safeParse({
      ...request,
      drawingProjectEdits: { projectIds: [request.patentId, request.patentId], projects: [] },
    }).success,
  ).toBe(false);
  expect(
    PatentApplyFigureEditRequestSchema.safeParse({
      ...request,
      drawingProjectEdits: { projectIds: [], projects: [{ unknown: true }] },
    }).success,
  ).toBe(false);
});
