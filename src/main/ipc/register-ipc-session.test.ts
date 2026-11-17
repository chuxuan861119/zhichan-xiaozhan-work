vi.mock("../../shared/document/fonts/SourceHanSerifCN-Regular.otf?asset", () => ({
  default: "src/shared/document/fonts/SourceHanSerifCN-Regular.otf",
}));
vi.mock("../../shared/document/fonts/SourceHanSerifCN-SemiBold.otf?asset", () => ({
  default: "src/shared/document/fonts/SourceHanSerifCN-SemiBold.otf",
}));

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { BackupEntrySchema } from "../../shared/backup/model.js";
import { createBlankDocument } from "../../shared/document/defaults.js";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import type {
  PatentTemplateAuxiliaryCatalog,
  PatentTemplateCatalog,
} from "../../shared/patent/template-catalog.js";
import { createLegacyFactoryPatentTemplatesV1 } from "../../shared/patent/templates.js";
import { createDefaultPrintSettings } from "../../shared/printing/model.js";
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_PATENT_TEMPLATE_SETTINGS,
} from "../../shared/settings/model.js";
import { type AssetOwner, AssetStore, type StoredAsset } from "../assets/asset-store.js";
import { FileService } from "../documents/file-service.js";
import { writePatdoc } from "../documents/patdoc-writer.js";
import { OpenPathAuthorization } from "../open-path-authorization.js";
import { SettingsService } from "../settings/settings-service.js";
import { SoftwareUpdateService } from "../updates/update-service.js";

const electron = vi.hoisted(() => {
  type OpenDialogResult = { canceled: boolean; filePaths: string[] };
  const handlers = new Map<
    string,
    (event: unknown, input?: unknown) => unknown | Promise<unknown>
  >();
  return {
    handlers,
    ownerWindow: {},
    sender: {},
    fromWebContents: vi.fn(),
    showOpenDialog: vi.fn(
      async (): Promise<OpenDialogResult> => ({ canceled: true, filePaths: [] }),
    ),
    showSaveDialog: vi.fn(
      async (): Promise<{ canceled: boolean; filePath: string | undefined }> => ({
        canceled: true,
        filePath: undefined,
      }),
    ),
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
    clipboardWrite: vi.fn(),
    writeShortcutLink: vi.fn(() => true),
  };
});

const testDataDirectory = join(tmpdir(), "patent-workbench-session-lifecycle-test");

vi.mock("electron", () => ({
  app: { getPath: () => testDataDirectory },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: class {
    static fromWebContents = electron.fromWebContents;
    static getAllWindows = () => [];
    readonly listeners = new Map<string, (...args: unknown[]) => void>();
    readonly webContents = {
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        this.listeners.set(event, listener);
      }),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn().mockResolvedValue(true),
      printToPDF: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.7\npatent")),
      print: vi.fn(),
    };
    readonly loadURL = vi.fn(async () => {
      this.listeners.get("did-finish-load")?.();
    });
    readonly destroy = vi.fn();
  },
  dialog: {
    showOpenDialog: electron.showOpenDialog,
    showSaveDialog: electron.showSaveDialog,
    showMessageBox: electron.showMessageBox,
  },
  clipboard: {
    readText: vi.fn(() => ""),
    writeText: vi.fn(),
    write: electron.clipboardWrite,
  },
  ipcMain: {
    removeHandler: (channel: string) => electron.handlers.delete(channel),
    handle: (
      channel: string,
      handler: (event: unknown, input?: unknown) => unknown | Promise<unknown>,
    ) => electron.handlers.set(channel, handler),
  },
  nativeImage: {
    createFromBitmap: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })),
    createFromBuffer: vi.fn(() => ({ isEmpty: () => false })),
  },
  shell: {
    writeShortcutLink: electron.writeShortcutLink,
  },
}));

import { registerIpcHandlers as registerIpcHandlersBase } from "./register-ipc.js";

// This suite exercises IPC/session routing. The built font worker and PDF font
// rendering are covered by the worker tests and the Electron print runtime test.
vi.mock("../exports/print-font-jobs.js", () => ({
  preparePrintFonts: async (html: string) => html,
}));

const activeIpcDisposers = new Set<() => Promise<void>>();

function registerIpcHandlers(
  ...args: Parameters<typeof registerIpcHandlersBase>
): ReturnType<typeof registerIpcHandlersBase> {
  const disposeRegisteredHandlers = registerIpcHandlersBase(...args);
  const dispose = async () => {
    if (!activeIpcDisposers.delete(dispose)) return;
    await disposeRegisteredHandlers();
  };
  activeIpcDisposers.add(dispose);
  return dispose;
}

async function invoke(
  channel: string,
  input?: unknown,
  event: unknown = { sender: electron.sender },
): Promise<unknown> {
  const handler = electron.handlers.get(channel);
  expect(handler, `missing IPC handler: ${channel}`).toBeTypeOf("function");
  return handler?.(event, input);
}

function snapshotSchedulerStubs() {
  return {
    create: vi.fn(),
    pruneAll: vi.fn(async () => ({ deletedCount: 0, cleanupError: null })),
    lastAutomaticSnapshotAt: vi.fn(() => null as string | null),
  };
}

function templateCatalogFixture(): {
  catalog: PatentTemplateCatalog;
  auxiliary: PatentTemplateAuxiliaryCatalog;
} {
  const createdAt = "2026-08-28T12:00:00.000Z";
  const slots = (patentType: "invention" | "utility-model", offset: number) =>
    ([1, 2, 3] as const).map((slotIndex) => ({
      templateId: `00000000-0000-4000-8000-${(offset + slotIndex).toString().padStart(12, "0")}`,
      patentType,
      slotIndex,
      name: `自定义模板 ${slotIndex}`,
      claims: null,
      description: null,
      abstract: null,
      unavailableReason: null,
      revision: 0,
      createdAt,
      updatedAt: createdAt,
    }));
  const paragraph = (text: string) => ({
    id: crypto.randomUUID(),
    type: "paragraph" as const,
    attrs: {
      alignment: "left" as const,
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 14,
    },
    content: [{ type: "text" as const, text, marks: [] }],
  });
  return {
    catalog: {
      revision: 0,
      invention: { selection: { kind: "system" }, slots: slots("invention", 100) },
      "utility-model": {
        selection: { kind: "system" },
        slots: slots("utility-model", 200),
      },
    },
    auxiliary: {
      invention: {
        patentType: "invention",
        figureExplanation: paragraph("图{{figureNumber}}为本发明的______示意图。"),
        drawingLegend: paragraph("其中，______。"),
        updatedAt: createdAt,
      },
      "utility-model": {
        patentType: "utility-model",
        figureExplanation: paragraph("图{{figureNumber}}为本实用新型的______示意图。"),
        drawingLegend: paragraph("其中，______。"),
        updatedAt: createdAt,
      },
    },
  };
}

afterAll(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all([...activeIpcDisposers].map((dispose) => dispose()));
});

beforeEach(() => {
  electron.handlers.clear();
  electron.fromWebContents.mockReset().mockReturnValue(electron.ownerWindow);
  electron.showOpenDialog.mockReset().mockResolvedValue({ canceled: true, filePaths: [] });
  electron.showSaveDialog.mockReset().mockResolvedValue({ canceled: true, filePath: undefined });
  electron.showMessageBox.mockReset().mockResolvedValue({ response: 0, checkboxChecked: false });
  electron.clipboardWrite.mockReset();
  electron.writeShortcutLink.mockReset().mockReturnValue(true);
});

test("copies formatted draft through native clipboard without accepting arbitrary HTML", async () => {
  registerIpcHandlers();
  const handler = electron.handlers.get("clipboard:write-text");
  const paragraphs = [
    {
      attrs: {
        alignment: "left",
        paragraphIndentMm: 9.88,
        lineSpacing: 1.5,
        defaultFontFamily: "宋体",
        defaultFontSizePt: 14,
      },
      content: [
        {
          type: "text",
          text: "箱体",
          marks: [{ type: "color", value: "#112233" }, { type: "underline" }],
        },
      ],
    },
  ];
  expect(await handler?.({}, { style: "formatted-draft", paragraphs })).toMatchObject({ ok: true });
  expect(electron.clipboardWrite).toHaveBeenCalledWith(
    expect.objectContaining({
      text: "箱体",
      html: expect.stringContaining("color:#112233;text-decoration:underline"),
    }),
  );
  expect(
    await handler?.({}, { style: "formatted-draft", paragraphs, html: "<script>" }),
  ).toMatchObject({ ok: false });
  expect(electron.clipboardWrite).toHaveBeenCalledTimes(1);
});

test("copies red draft text through the existing native clipboard boundary and rejects raw HTML", async () => {
  registerIpcHandlers();
  const handler = electron.handlers.get("clipboard:write-text");
  expect(
    await handler?.({}, { text: "箱体1  <文字>\n\n下一段。", style: "red-draft" }),
  ).toMatchObject({ ok: true });
  expect(electron.clipboardWrite).toHaveBeenCalledWith(
    expect.objectContaining({
      text: "箱体1  <文字>\n\n下一段。",
      html: expect.stringContaining("color:#D92D20"),
    }),
  );
  expect(electron.clipboardWrite.mock.calls[0]?.[0].html).toContain("&lt;文字&gt;");
  expect(await handler?.({}, { text: "bad", html: "<script>bad()</script>" })).toMatchObject({
    ok: false,
  });
  expect(electron.clipboardWrite).toHaveBeenCalledTimes(1);
  expect(await handler?.({}, "普通复制仍然有效")).toMatchObject({ ok: true });
});

test("discards staged image imports for an active document session", async () => {
  const discardPersistentStages = vi.spyOn(AssetStore.prototype, "discardPersistentStages");
  registerIpcHandlers();
  const sessionId = "00000000-0000-4000-8000-000000000942";
  const document = createBlankDocument("图片导入回收");
  const bytes = Uint8Array.from(
    await readFile(resolve(process.cwd(), "tests/fixtures/images/sample.png")),
  );
  await invoke("documents:activate", { sessionId, documentId: document.documentId });
  const imported = (await invoke("assets:import-many", {
    sessionId,
    operationId: "00000000-0000-4000-8000-000000000943",
    images: [
      {
        originalName: "sample.png",
        declaredMediaType: "image/png",
        bytes,
      },
    ],
  })) as { ok: true; value: Array<{ descriptor: { assetId: string } }> };
  const assetId = imported.value[0]?.descriptor.assetId;
  if (!assetId) throw new Error("Imported image descriptor is missing");

  await expect(
    invoke("assets:discard-imports", {
      sessionId,
      operationId: "00000000-0000-4000-8000-000000000943",
      assetIds: [assetId],
    }),
  ).resolves.toEqual({ ok: true, value: undefined });
  expect(discardPersistentStages).toHaveBeenCalledWith(
    sessionId,
    [assetId],
    "00000000-0000-4000-8000-000000000943",
  );
  discardPersistentStages.mockRestore();
});

test("stages existing image references into a different active document session", async () => {
  const putPersistentManyStaged = vi.spyOn(AssetStore.prototype, "putPersistentManyStaged");
  registerIpcHandlers();
  const sourceSessionId = "00000000-0000-4000-8000-000000000944";
  const targetSessionId = "00000000-0000-4000-8000-000000000945";
  const operationId = "00000000-0000-4000-8000-000000000946";
  const sourceDocument = createBlankDocument("图片复制来源");
  const targetDocument = createBlankDocument("图片复制目标");
  const bytes = Uint8Array.from(
    await readFile(resolve(process.cwd(), "tests/fixtures/images/sample.png")),
  );
  await invoke("documents:activate", {
    sessionId: sourceSessionId,
    documentId: sourceDocument.documentId,
  });
  await invoke("documents:activate", {
    sessionId: targetSessionId,
    documentId: targetDocument.documentId,
  });
  const imported = (await invoke("assets:import-many", {
    sessionId: sourceSessionId,
    operationId: "00000000-0000-4000-8000-000000000947",
    images: [{ originalName: "sample.png", declaredMediaType: "image/png", bytes }],
  })) as { ok: true; value: Array<{ descriptor: { assetId: string } }> };
  const assetId = imported.value[0]?.descriptor.assetId;
  if (!assetId) throw new Error("Imported image descriptor is missing");

  await expect(
    invoke("assets:stage-references", {
      sourceSessionId,
      targetSessionId,
      operationId,
      assetIds: [assetId],
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: [{ descriptor: { assetId } }],
  });
  expect(putPersistentManyStaged).toHaveBeenLastCalledWith(
    targetSessionId,
    [expect.objectContaining({ descriptor: expect.objectContaining({ assetId }) })],
    operationId,
  );
  putPersistentManyStaged.mockRestore();
});

test("writes current edited pixels to the clipboard and confirms lossy jpeg transparency", async () => {
  registerIpcHandlers();
  const sessionId = "00000000-0000-4000-8000-000000000941";
  const document = createBlankDocument("图片 IPC");
  const transparentPng = await sharp({
    create: { width: 3, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  await invoke("documents:activate", { sessionId, documentId: document.documentId });
  const imported = (await invoke("assets:import-bytes", {
    sessionId,
    originalName: "透明.png",
    declaredMediaType: "image/png",
    bytes: Uint8Array.from(transparentPng),
  })) as { ok: true; value: { descriptor: { assetId: string } } };
  expect(imported.ok).toBe(true);
  const assetId = imported.value.descriptor.assetId;

  await expect(
    invoke("assets:copy-images", {
      sessionId,
      images: [
        {
          assetId,
          rotationDeg: 90,
          layout: "inline",
          widthMm: 30,
          alignment: "right",
          label: "图片1",
          chemicalStructure: {
            ketSource: "(ket) (atom C)",
            editorMode: "molecule",
            widthMm: 30,
            alignment: "right",
          },
        },
      ],
      htmlTemplate: "<p>前\uE020PIMG0\uE021后</p>",
      text: "前后",
    }),
  ).resolves.toEqual({ ok: true, value: undefined });
  expect(electron.clipboardWrite).toHaveBeenCalledWith(
    expect.objectContaining({
      html: expect.stringContaining(
        'data-patent-image-layout="inline" data-patent-image-width-mm="30" data-patent-image-alignment="right"',
      ),
      text: "前后",
    }),
  );
  expect(electron.clipboardWrite.mock.calls.at(-1)?.[0]?.html).toContain(
    `data-patent-chemical-ket-base64="${Buffer.from("(ket) (atom C)", "utf8").toString("base64")}"`,
  );

  electron.showSaveDialog.mockResolvedValue({
    canceled: false,
    filePath: join(testDataDirectory, "透明.jpg"),
  });
  electron.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
  await expect(
    invoke("assets:save-image", {
      sessionId,
      image: { assetId, rotationDeg: 0, label: "透明" },
    }),
  ).resolves.toEqual({ ok: true, value: null });
  expect(electron.showMessageBox).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "知产小栈Work",
      message: expect.stringContaining("JPG 不支持透明背景"),
    }),
  );
});

test("does not let an older image copy finish over a newer copy", async () => {
  registerIpcHandlers();
  const sessionId = "00000000-0000-4000-8000-000000000951";
  const document = createBlankDocument("图片复制顺序");
  const firstPng = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const secondPng = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  await invoke("documents:activate", { sessionId, documentId: document.documentId });
  const importAsset = async (name: string, bytes: Buffer) =>
    (await invoke("assets:import-bytes", {
      sessionId,
      originalName: name,
      declaredMediaType: "image/png",
      bytes: Uint8Array.from(bytes),
    })) as { ok: true; value: { descriptor: { assetId: string } } };
  const first = await importAsset("first.png", firstPng);
  const second = await importAsset("second.png", secondPng);
  const originalGetOrLoad = AssetStore.prototype.getOrLoad;
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const getOrLoad = vi.spyOn(AssetStore.prototype, "getOrLoad").mockImplementation(async function (
    this: AssetStore,
    session,
    assetId,
  ) {
    if (assetId === first.value.descriptor.assetId) await firstBlocked;
    return originalGetOrLoad.call(this, session, assetId);
  });
  const request = (assetId: string, label: string) =>
    invoke("assets:copy-images", {
      sessionId,
      images: [{ assetId, rotationDeg: 0, label }],
    });

  const older = request(first.value.descriptor.assetId, "旧图片");
  await vi.waitFor(() => expect(getOrLoad).toHaveBeenCalled());
  await expect(request(second.value.descriptor.assetId, "新图片")).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  releaseFirst?.();
  await expect(older).resolves.toEqual({ ok: true, value: undefined });

  expect(electron.clipboardWrite).toHaveBeenCalledTimes(1);
  getOrLoad.mockRestore();
});

test("permanently rejects delayed work from a released session and requires a new activation", async () => {
  registerIpcHandlers();
  const sessionId = "00000000-0000-4000-8000-000000000901";
  const replacementSessionId = "00000000-0000-4000-8000-000000000902";
  const document = createBlankDocument("会话生命周期");

  expect(
    await invoke("documents:activate", { sessionId, documentId: document.documentId }),
  ).toEqual({ ok: true, value: undefined });
  expect(await invoke("documents:release", sessionId)).toEqual({ ok: true, value: undefined });

  const delayedAutosave = await invoke("drafts:save", {
    sessionId,
    documentId: document.documentId,
    displayName: document.title,
    originalPath: null,
    document,
    editorState: {},
  });
  const delayedAssetImport = await invoke("assets:import-bytes", {
    sessionId,
    originalName: "late.png",
    declaredMediaType: "image/png",
    bytes: Uint8Array.from([1, 2, 3]),
  });
  const delayedExport = await invoke("exports:docx", {
    sessionId,
    document,
    suggestedName: document.title,
  });

  for (const result of [delayedAutosave, delayedAssetImport, delayedExport]) {
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  }
  expect(electron.showSaveDialog).not.toHaveBeenCalled();
  expect(
    await invoke("documents:activate", { sessionId, documentId: document.documentId }),
  ).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  expect(
    await invoke("documents:activate", {
      sessionId: replacementSessionId,
      documentId: document.documentId,
    }),
  ).toEqual({ ok: true, value: undefined });
});

test("scopes default-template editor IPC to active sessions and retires it on close", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000931";
  const snapshot = templateCatalogFixture();
  const patentTemplates = {
    initialize: vi.fn(async () => undefined),
    readLauncherSummary: vi.fn(() => ({
      invention: { selection: { kind: "system" }, selectedTemplateName: null },
      "utility-model": { selection: { kind: "system" }, selectedTemplateName: null },
    })),
    readAuxiliary: vi.fn(() => snapshot.auxiliary),
    openEditor: vi.fn(() => ({ sessionId, ...snapshot })),
    capturePatent: vi.fn(() => ({ templateId: sessionId })),
    saveEditor: vi.fn((request: unknown) => ({ sessionId, request })),
    closeEditor: vi.fn(),
  };
  registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: {} as never,
    patents: {} as never,
    patentTemplates,
    fileService: {} as never,
    assetStore: { install: vi.fn(), readAsset: vi.fn() } as never,
    readOnly: false,
  } as never);

  await expect(invoke("patent-templates:read-summary")).resolves.toEqual({
    ok: true,
    value: {
      invention: { selection: { kind: "system" }, selectedTemplateName: null },
      "utility-model": { selection: { kind: "system" }, selectedTemplateName: null },
    },
  });
  expect(patentTemplates.readLauncherSummary).toHaveBeenCalledOnce();
  await expect(invoke("patent-templates:read-auxiliary")).resolves.toEqual({
    ok: true,
    value: snapshot.auxiliary,
  });
  expect(patentTemplates.readAuxiliary).toHaveBeenCalledOnce();
  await expect(
    invoke("patent-templates:open-editor", { patentType: "invention" }),
  ).resolves.toMatchObject({
    ok: true,
    value: { sessionId },
  });
  await expect(
    invoke("patent-templates:capture-current", {
      sessionId: "00000000-0000-4000-8000-000000000932",
      patentId: "00000000-0000-4000-8000-000000000933",
      expectedPatentRevision: 0,
      targetPatentType: "invention",
      targetTemplateId: "00000000-0000-4000-8000-000000000934",
    }),
  ).resolves.toMatchObject({ ok: false });
  expect(patentTemplates.capturePatent).not.toHaveBeenCalled();

  await expect(invoke("patent-templates:close-editor", { sessionId })).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  expect(patentTemplates.closeEditor).toHaveBeenCalledWith({ sessionId });
  await expect(invoke("patent-templates:close-editor", { sessionId })).resolves.toMatchObject({
    ok: false,
    error: { code: "CANCELLED" },
  });
});

test("isolates a custom template whose chemical preview resource is missing", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000951";
  const healthyAssetId = "00000000-0000-4000-8000-000000000952";
  const missingAssetId = "00000000-0000-4000-8000-000000000953";
  const snapshot = templateCatalogFixture();
  const factory = createLegacyFactoryPatentTemplatesV1(() => crypto.randomUUID());
  const [broken, healthy] = snapshot.catalog.invention.slots;
  if (!broken || !healthy) throw new Error("template slot fixture");
  for (const slot of [broken, healthy]) {
    slot.claims = structuredClone(factory.invention.claims);
    slot.description = structuredClone(factory.invention.description);
    slot.abstract = structuredClone(factory.invention.abstract);
  }
  broken.claims?.content.push({
    id: crypto.randomUUID(),
    type: "chemical-structure",
    ketSource: "(ket)",
    previewAssetId: missingAssetId,
    widthMm: 80,
    alignment: "center",
  });
  healthy.claims?.content.push({
    id: crypto.randomUUID(),
    type: "chemical-structure",
    ketSource: "(ket)",
    previewAssetId: healthyAssetId,
    widthMm: 80,
    alignment: "center",
  });
  snapshot.catalog.invention.selection = { kind: "custom", templateId: broken.templateId };
  const healthyAsset: StoredAsset = {
    descriptor: {
      assetId: healthyAssetId,
      kind: "image",
      originalName: "chemical.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: 3,
      sha256: "A".repeat(64),
      widthPx: 1,
      heightPx: 1,
      previewByteLength: 3,
      previewSha256: "B".repeat(64),
    },
    original: Uint8Array.from([1, 2, 3]),
    preview: Uint8Array.from([1, 2, 3]),
  };
  const readAsset = vi.fn(async (assetId: string) => {
    if (assetId === missingAssetId) {
      throw Object.assign(new Error("missing template preview"), { code: "CORRUPT_FILE" });
    }
    return healthyAsset;
  });
  const patentTemplates = {
    initialize: vi.fn(async () => undefined),
    openEditor: vi.fn(() => ({ sessionId, ...snapshot })),
    closeEditor: vi.fn(),
  };
  registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: {} as never,
    patents: {} as never,
    patentTemplates,
    fileService: {} as never,
    assetStore: { install: vi.fn(), readAsset } as never,
    readOnly: false,
  } as never);

  const result = await invoke("patent-templates:open-editor", { patentType: "invention" });
  expect(result).toMatchObject({ ok: true });
  if (!(result as { ok: boolean }).ok) throw new Error("open template editor fixture");
  const value = (
    result as {
      value: {
        catalog: PatentTemplateCatalog;
        assets: StoredAsset["descriptor"][];
      };
    }
  ).value;
  expect(value.catalog.invention.selection).toEqual({ kind: "system" });
  expect(value.catalog.invention.slots[0]).toMatchObject({
    templateId: broken.templateId,
    claims: null,
    description: null,
    abstract: null,
    unavailableReason: "模板资源损坏或缺失，请清空后重新填入。",
  });
  expect(value.catalog.invention.slots[1]).toMatchObject({
    templateId: healthy.templateId,
    unavailableReason: null,
  });
  expect(value.assets).toEqual([healthyAsset.descriptor]);
});

test("reports template save success when post-commit staged cleanup fails", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000941";
  const snapshot = templateCatalogFixture();
  const patentTemplates = {
    initialize: vi.fn(async () => undefined),
    readLauncherSummary: vi.fn(() => ({
      invention: { selection: { kind: "system" }, selectedTemplateName: null },
      "utility-model": { selection: { kind: "system" }, selectedTemplateName: null },
    })),
    openEditor: vi.fn(() => ({ sessionId, ...snapshot })),
    capturePatent: vi.fn(),
    saveEditor: vi.fn(() => ({ sessionId, ...snapshot })),
    closeEditor: vi.fn(),
  };
  const persistentAssetStore = {
    install: vi.fn(),
    readAsset: vi.fn(),
    stageMany: vi.fn(async (_sessionId: string, assets: StoredAsset[]) =>
      assets.map((asset) => ({
        descriptor: structuredClone(asset.descriptor),
        preview: Uint8Array.from(asset.preview),
      })),
    ),
    commitStaged: vi.fn(async () => undefined),
    discardStaged: vi.fn(async () => {
      throw new Error("暂存资源清理失败");
    }),
  };
  const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: {} as never,
    patents: {} as never,
    patentTemplates,
    fileService: {} as never,
    assetStore: persistentAssetStore,
    readOnly: false,
  } as never);

  await invoke("patent-templates:open-editor", { patentType: "invention" });
  await expect(
    invoke("chemistry:rasterize-preview", {
      sessionId,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><circle cx="1" cy="1" r="1"/></svg>',
    }),
  ).resolves.toMatchObject({ ok: true });
  await expect(
    invoke("patent-templates:save-editor", {
      sessionId,
      expectedRevision: 0,
      ...snapshot,
    }),
  ).resolves.toMatchObject({ ok: true, value: { sessionId } });
  expect(patentTemplates.saveEditor).toHaveBeenCalledOnce();
  expect(persistentAssetStore.discardStaged).toHaveBeenCalledOnce();
  await expect(dispose()).rejects.toThrow("应用退出清理未完整完成。");
});

test("opens a current patent PATDOC from legacy drafts and releases its document session", async () => {
  const payload = {
    patent: createBlankPatent({ patentType: "invention", name: "虚构历史专利草稿" }),
    assets: [],
    flowcharts: [],
  };
  const draftId = payload.patent.patentId;
  const draftDirectory = join(testDataDirectory, "drafts", draftId);
  const fileName = "20260817-000000.patdoc";
  await mkdir(draftDirectory, { recursive: true });
  const saved = await new FileService().savePatent(join(draftDirectory, fileName), payload);
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  await writeFile(
    join(draftDirectory, "draft.json"),
    `${JSON.stringify({
      draftId,
      documentId: draftId,
      displayName: "虚构历史专利草稿.patdoc",
      originalPath: null,
      savedAt: "2026-08-17T00:00:00.000Z",
      fileName,
    })}\n`,
    "utf8",
  );
  registerIpcHandlers();

  const opened = await invoke("drafts:open", draftId);

  expect(opened).toMatchObject({
    ok: true,
    value: {
      path: null,
      displayName: "虚构历史专利草稿.patdoc",
      document: {
        documentId: draftId,
        title: "虚构历史专利草稿",
        patentType: "invention",
      },
    },
  });
  const sessionId = (opened as { value?: { sessionId?: unknown } }).value?.sessionId;
  expect(sessionId).toEqual(expect.any(String));
  await expect(invoke("documents:release", sessionId)).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  await rm(draftDirectory, { recursive: true, force: true });
});

test("retires the exact session before waiting for an in-flight operation to drain", async () => {
  let finishDialog: ((value: { canceled: true; filePath: undefined }) => void) | undefined;
  electron.showSaveDialog.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishDialog = resolve;
      }),
  );
  registerIpcHandlers();
  const sessionId = "00000000-0000-4000-8000-000000000911";
  const document = createBlankDocument("释放中的会话");
  expect(
    await invoke("documents:activate", { sessionId, documentId: document.documentId }),
  ).toEqual({ ok: true, value: undefined });

  const save = invoke("documents:save", { sessionId, document, editorState: {} });
  await vi.waitFor(() => expect(electron.showSaveDialog).toHaveBeenCalledTimes(1));
  const release = invoke("documents:release", sessionId);

  const delayedAutosave = await invoke("drafts:save", {
    sessionId,
    documentId: document.documentId,
    displayName: document.title,
    originalPath: null,
    document,
    editorState: {},
  });
  const delayedAssetImport = await invoke("assets:import-bytes", {
    sessionId,
    originalName: "late.png",
    declaredMediaType: "image/png",
    bytes: Uint8Array.from([1, 2, 3]),
  });
  const delayedExport = await invoke("exports:docx", {
    sessionId,
    document,
    suggestedName: document.title,
  });

  for (const result of [delayedAutosave, delayedAssetImport, delayedExport]) {
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  }
  expect(electron.showSaveDialog).toHaveBeenCalledTimes(1);
  finishDialog?.({ canceled: true, filePath: undefined });
  await expect(save).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  await expect(release).resolves.toEqual({ ok: true, value: undefined });
});

test("releasing one UUID does not cancel another UUID for the same document", async () => {
  const filePath = join(testDataDirectory, "same-document-active-session.patdoc");
  const saveDocument = vi.spyOn(FileService.prototype, "saveDocument").mockResolvedValue({
    ok: true,
    value: {
      path: filePath,
      displayName: "same-document-active-session.patdoc",
      savedAt: "2026-08-16T00:00:00.000Z",
      previousVersionRetained: false,
    },
  });
  let finishDialog:
    | ((value: { canceled: boolean; filePath: string | undefined }) => void)
    | undefined;
  electron.showSaveDialog.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishDialog = resolve;
      }),
  );
  registerIpcHandlers();
  const retiringSessionId = "00000000-0000-4000-8000-000000000921";
  const activeSessionId = "00000000-0000-4000-8000-000000000922";
  const document = createBlankDocument("共享文档标识");
  for (const sessionId of [retiringSessionId, activeSessionId]) {
    expect(
      await invoke("documents:activate", { sessionId, documentId: document.documentId }),
    ).toEqual({ ok: true, value: undefined });
  }

  const activeSave = invoke("documents:save", {
    sessionId: activeSessionId,
    document,
    editorState: {},
  });
  await vi.waitFor(() => expect(electron.showSaveDialog).toHaveBeenCalledTimes(1));

  await expect(invoke("documents:release", retiringSessionId)).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  finishDialog?.({
    canceled: false,
    filePath,
  });
  await expect(activeSave).resolves.toMatchObject({ ok: true });
  expect(saveDocument).toHaveBeenCalledOnce();
  saveDocument.mockRestore();
});

test("opens authorized current patent paths and imports duplicate paths separately", async () => {
  const filePath = join(testDataDirectory, "command-line-open.patdoc");
  const patent = createBlankPatent({ patentType: "invention", name: "命令行打开" });
  const saved = await new FileService().savePatent(filePath, { patent, assets: [] });
  expect(saved).toMatchObject({ ok: true });
  const authorization = new OpenPathAuthorization();
  const imported = new Map<
    string,
    {
      patentId: string;
      sessionId: string;
      revision: number;
      patent: typeof patent;
      saveState: "saved";
    }
  >();
  let sequence = 920;
  const patents = {
    list: vi.fn(async () => []),
    create: vi.fn(
      async (request: { patentType: "invention" | "utility-model"; name: string | null }) => {
        const created = createBlankPatent({
          ...request,
          templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
        });
        const opened = {
          patentId: created.patentId,
          sessionId: `00000000-0000-4000-8000-${(sequence++).toString().padStart(12, "0")}`,
          revision: 0,
          patent: created,
          saveState: "saved" as const,
        };
        imported.set(opened.patentId, opened);
        return opened;
      },
    ),
    open: vi.fn(async (patentId: string) => {
      const opened = imported.get(patentId);
      if (!opened) throw new Error("fixture");
      return {
        ...opened,
        patent: { ...opened.patent, revision: opened.revision },
      };
    }),
    updateSettings: vi.fn(async (request: { patentId: string; expectedRevision: number }) => {
      const opened = imported.get(request.patentId);
      if (!opened || opened.revision !== request.expectedRevision) {
        throw new Error("fixture revision mismatch");
      }
      opened.revision += 1;
      return {
        patentId: request.patentId,
        revision: opened.revision,
        savedAt: "2026-08-02",
      };
    }),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(async (request: { patentId: string; expectedRevision: number }) => {
      const opened = imported.get(request.patentId);
      if (!opened || opened.revision !== request.expectedRevision) {
        throw new Error("fixture revision mismatch");
      }
      opened.revision += 1;
      return {
        patentId: request.patentId,
        revision: opened.revision,
        savedAt: "2026-08-02",
      };
    }),
    flush: vi.fn(),
    loadForExport: vi.fn(async () => patent),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(async () => ({ purgedPatentIds: [] })),
    release: vi.fn(),
  };
  const library = {
    list: vi.fn(async () => []),
    create: vi.fn(),
    open: vi.fn(),
    rename: vi.fn(),
    applyEdit: vi.fn(),
    flush: vi.fn(),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(async () => ({ purgedDocumentIds: [] })),
    importDocument: vi.fn(),
    replaceInitialDocument: vi.fn(),
    release: vi.fn(),
  };
  registerIpcHandlers(undefined, authorization, {
    library,
    patents,
    fileService: new FileService(),
    assetStore: { install: vi.fn(), readAsset: vi.fn() },
    readOnly: false,
  });

  expect(await invoke("patents:open-path", `${filePath}.exe`)).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  expect(await invoke("patents:open-path", filePath)).toMatchObject({
    ok: false,
    error: { code: "NO_PERMISSION" },
  });
  authorization.authorize(filePath);
  const first = await invoke("patents:open-path", filePath);
  authorization.authorize(filePath);
  const second = await invoke("patents:open-path", filePath);

  expect(first).toMatchObject({
    ok: true,
    value: { revision: 1, patent: { name: "命令行打开", revision: 1 } },
  });
  expect(second).toMatchObject({
    ok: true,
    value: { revision: 1, patent: { name: "命令行打开", revision: 1 } },
  });
  expect(patents.updateSettings).toHaveBeenCalledTimes(2);
  expect(patents.applyFigureEdit).not.toHaveBeenCalled();
  // Patent open-path currently imports each authorized duplicate; path/session reuse is not implemented.
  expect(patents.create).toHaveBeenCalledTimes(2);
  expect(await invoke("patents:open-path", filePath)).toMatchObject({
    ok: false,
    error: { code: "NO_PERMISSION" },
  });
});

test("loads the persisted patent revision for patent DOCX export and leaves no file on revision conflict", async () => {
  await mkdir(testDataDirectory, { recursive: true });
  const patent = createBlankPatent({ patentType: "invention", name: "导出版本" });
  const sessionId = "00000000-0000-4000-8000-000000000941";
  const outputPath = join(testDataDirectory, "conflicted-patent-export.docx");
  electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: outputPath });
  const patents = {
    list: vi.fn(async () => []),
    create: vi.fn(),
    open: vi.fn(),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush: vi.fn(),
    loadForExport: vi.fn(async () => {
      throw Object.assign(new Error("Revision conflict."), { code: "REVISION_CONFLICT" });
    }),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(async () => ({ purgedPatentIds: [] })),
    release: vi.fn(),
  };
  const library = {
    list: vi.fn(async () => []),
    create: vi.fn(),
    open: vi.fn(),
    rename: vi.fn(),
    applyEdit: vi.fn(),
    flush: vi.fn(),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(async () => ({ purgedDocumentIds: [] })),
    importDocument: vi.fn(),
    replaceInitialDocument: vi.fn(),
    release: vi.fn(),
  };
  registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library,
    patents,
    fileService: new FileService(),
    assetStore: { install: vi.fn(), readAsset: vi.fn() },
    readOnly: false,
  });
  await expect(
    invoke("documents:activate", { sessionId, documentId: patent.patentId }),
  ).resolves.toEqual({ ok: true, value: undefined });

  await expect(
    invoke("exports:patent-docx", {
      sessionId,
      patentId: patent.patentId,
      expectedRevision: 7,
      mode: "combined",
      suggestedName: "导出版本",
    }),
  ).resolves.toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
  expect(patents.loadForExport).toHaveBeenCalledWith({
    patentId: patent.patentId,
    sessionId,
    expectedRevision: 7,
  });
  await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("creates a print preview for a patent book bound to its patent session target", async () => {
  registerIpcHandlers();
  const sessionId = "00000000-0000-4000-8000-000000000945";
  const patent = createBlankPatent({ patentType: "invention", name: "专利打印预览" });
  const book = patent.books.find((candidate) => candidate.kind === "claims");
  if (!book) throw new Error("测试专利缺少权利要求书。");
  expect(await invoke("documents:activate", { sessionId, documentId: patent.patentId })).toEqual({
    ok: true,
    value: undefined,
  });

  const preview = await invoke("exports:preview", {
    sessionId,
    targetId: patent.patentId,
    document: {
      ...book.document,
      patentType: patent.patentType,
      assets: patent.assets,
    },
    suggestedName: "专利打印预览-权利要求书",
    layout: createDefaultPrintSettings(book.document.page).layout,
  });

  expect(preview).toMatchObject({
    ok: true,
    value: { bytes: expect.anything(), previewId: expect.any(String) },
  });
  expect(
    await invoke("exports:preview", {
      sessionId,
      targetId: book.document.documentId,
      document: book.document,
      suggestedName: "错误会话目标",
      layout: createDefaultPrintSettings(book.document.page).layout,
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});

test("creates the optional desktop shortcut with the installed executable", async () => {
  registerIpcHandlers();

  if (process.platform === "darwin") {
    // This fixture is a development process, not an installed .app bundle.
    expect(await invoke("application:create-desktop-shortcut")).toMatchObject({ ok: false });
    expect(electron.writeShortcutLink).not.toHaveBeenCalled();
    return;
  }

  expect(await invoke("application:create-desktop-shortcut")).toEqual({
    ok: true,
    value: undefined,
  });
  expect(electron.writeShortcutLink).toHaveBeenCalledWith(
    join(testDataDirectory, "知产小栈Work.lnk"),
    "create",
    {
      target: process.execPath,
      cwd: dirname(process.execPath),
      description: "知产小栈Work",
      icon: process.execPath,
      iconIndex: 0,
    },
  );
});

test("connects library sessions to persistent image assets and retires them on library release", async () => {
  const document = createBlankDocument("持久图片");
  const libraryDocumentId = "00000000-0000-4000-8000-000000000931";
  const sessionId = "00000000-0000-4000-8000-000000000932";
  const opened = {
    libraryDocumentId,
    sessionId,
    revision: 0,
    document,
    editorState: {},
    saveState: "saved" as const,
  };
  const persistentAssetId = "00000000-0000-4000-8000-000000000933";
  const persistentAssets = {
    install: vi.fn(async (_owner: AssetOwner, asset: StoredAsset) => ({
      descriptor: { ...asset.descriptor, assetId: persistentAssetId },
      preview: Uint8Array.from([137, 80, 78, 71]),
    })),
    readAsset: vi.fn(),
  };
  const library = {
    list: vi.fn(async () => []),
    create: vi.fn(async () => opened),
    open: vi.fn(async () => opened),
    rename: vi.fn(),
    applyEdit: vi.fn(),
    flush: vi.fn(),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(async () => ({ purgedDocumentIds: [] })),
    importDocument: vi.fn(),
    replaceInitialDocument: vi.fn(),
    release: vi.fn(async () => undefined),
  };
  registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library,
    fileService: {
      openDocument: vi.fn(),
      saveDocument: vi.fn(),
      openPatent: vi.fn(),
      savePatent: vi.fn(),
    },
    assetStore: persistentAssets,
    readOnly: false,
  });

  await expect(invoke("library:create")).resolves.toMatchObject({
    ok: true,
    value: { sessionId, libraryDocumentId },
  });
  const bytes = Uint8Array.from(
    await readFile(resolve(process.cwd(), "tests/fixtures/images/sample.png")),
  );

  const imported = await invoke("assets:import-bytes", {
    sessionId,
    originalName: "drawing.png",
    declaredMediaType: "image/png",
    bytes,
  });

  expect(imported).toMatchObject({
    ok: true,
    value: { descriptor: { assetId: persistentAssetId } },
  });
  expect(persistentAssets.install).toHaveBeenCalledWith(
    { kind: "library-document", libraryDocumentId },
    expect.objectContaining({ descriptor: expect.objectContaining({ mediaType: "image/png" }) }),
  );

  await expect(invoke("library:release", sessionId)).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  expect(library.release).toHaveBeenCalledWith(sessionId);
  await expect(
    invoke("assets:import-bytes", {
      sessionId,
      originalName: "late.png",
      declaredMediaType: "image/png",
      bytes,
    }),
  ).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
});

test("imports multiple selected image files into one active session", async () => {
  registerIpcHandlers();
  const sessionId = "00000000-0000-4000-8000-000000000941";
  const document = createBlankDocument("多图导入");
  expect(
    await invoke("documents:activate", { sessionId, documentId: document.documentId }),
  ).toEqual({ ok: true, value: undefined });
  electron.showOpenDialog.mockResolvedValueOnce({
    canceled: false,
    filePaths: [
      resolve(process.cwd(), "tests/fixtures/images/sample.png"),
      resolve(process.cwd(), "tests/fixtures/images/sample.tiff"),
    ] as string[],
  });

  const imported = await invoke("assets:choose-and-import-many", sessionId);

  expect(imported).toMatchObject({
    ok: true,
    value: [
      { descriptor: { originalName: "sample.png", mediaType: "image/png" } },
      { descriptor: { originalName: "sample.tiff", mediaType: "image/tiff" } },
    ],
  });
  expect(electron.showOpenDialog).toHaveBeenCalledWith(
    electron.ownerWindow,
    expect.objectContaining({ properties: ["openFile", "multiSelections"] }),
  );
});

test("rejects selecting more than 100 image files before reading them", async () => {
  registerIpcHandlers();
  const sessionId = "00000000-0000-4000-8000-000000000961";
  const document = createBlankDocument("多图数量限制");
  await invoke("documents:activate", { sessionId, documentId: document.documentId });
  electron.showOpenDialog.mockResolvedValueOnce({
    canceled: false,
    filePaths: Array.from({ length: 101 }, (_, index) => `missing-${index}.png`),
  });

  await expect(invoke("assets:choose-and-import-many", sessionId)).resolves.toMatchObject({
    ok: false,
    error: {
      code: "IMAGE_IMPORT_LIMIT",
      message: "图片导入超出限制：单次最多 100 张、单张最多 50 MiB、总计最多 250 MiB。",
    },
  });
});

test("rejects a selected image batch above 250 MiB before reading file contents", async () => {
  registerIpcHandlers();
  const sessionId = "00000000-0000-4000-8000-000000000962";
  const document = createBlankDocument("多图总大小限制");
  await invoke("documents:activate", { sessionId, documentId: document.documentId });
  await mkdir(testDataDirectory, { recursive: true });
  const filePaths = Array.from({ length: 6 }, (_, index) =>
    join(testDataDirectory, `large-sparse-${index}.png`),
  );
  for (const filePath of filePaths) {
    await writeFile(filePath, Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    await truncate(filePath, 50 * 1024 * 1024);
  }
  electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths });

  await expect(invoke("assets:choose-and-import-many", sessionId)).resolves.toMatchObject({
    ok: false,
    error: { code: "IMAGE_IMPORT_LIMIT" },
  });
});

test("exports a combined patent PDF through the print pipeline", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000951";
  const patent = createBlankPatent({ patentType: "invention", name: "PDF导出专利" });
  patent.patentId = "00000000-0000-4000-8000-000000000952";
  const patents = {
    list: vi.fn(async () => []),
    create: vi.fn(),
    open: vi.fn(),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush: vi.fn(),
    loadForExport: vi.fn(async () => patent),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(async () => ({ purgedPatentIds: [] })),
    release: vi.fn(),
  };
  const library = {
    list: vi.fn(async () => []),
    create: vi.fn(),
    open: vi.fn(),
    rename: vi.fn(),
    applyEdit: vi.fn(),
    flush: vi.fn(),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(async () => ({ purgedDocumentIds: [] })),
    importDocument: vi.fn(),
    replaceInitialDocument: vi.fn(),
    release: vi.fn(),
  };
  registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library,
    patents,
    fileService: new FileService(),
    assetStore: { install: vi.fn(), readAsset: vi.fn() },
    readOnly: false,
  });
  await mkdir(testDataDirectory, { recursive: true });
  expect(await invoke("documents:activate", { sessionId, documentId: patent.patentId })).toEqual({
    ok: true,
    value: undefined,
  });
  electron.showSaveDialog.mockResolvedValueOnce({
    canceled: false,
    filePath: join(testDataDirectory, "combined-patent.pdf"),
  });

  const exported = await invoke("exports:patent-pdf", {
    sessionId,
    patentId: patent.patentId,
    expectedRevision: 0,
    mode: "combined",
    suggestedName: "PDF导出专利",
  });

  expect(exported).toMatchObject({
    ok: true,
    value: { format: "pdf", outputPath: join(testDataDirectory, "combined-patent.pdf") },
  });
  expect(patents.loadForExport).toHaveBeenCalledWith({
    patentId: patent.patentId,
    sessionId,
    expectedRevision: 0,
  });
});

test("exports one auxiliary document through main without accepting renderer document content", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000961";
  const patent = createBlankPatent({ patentType: "invention", name: "含其他文档的专利" });
  patent.patentId = "00000000-0000-4000-8000-000000000962";
  const source = patent.books.find((book) => book.kind === "description");
  if (!source) throw new Error("测试专利缺少说明书。");
  const auxiliaryDocumentId = "00000000-0000-4000-8000-000000000963";
  patent.auxiliaryDocuments.push({
    auxiliaryDocumentId,
    title: "实验记录",
    document: {
      ...structuredClone(source.document),
      documentId: "00000000-0000-4000-8000-000000000964",
      title: "实验记录",
    },
    editorState: {},
    localRevision: 0,
    persistedRevision: 0,
    sourceFileName: null,
  });
  const patents = {
    list: vi.fn(async () => []),
    create: vi.fn(),
    open: vi.fn(),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush: vi.fn(),
    loadForExport: vi.fn(async () => patent),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(async () => ({ purgedPatentIds: [] })),
    release: vi.fn(),
  };
  const library = {
    list: vi.fn(async () => []),
    create: vi.fn(),
    open: vi.fn(),
    rename: vi.fn(),
    applyEdit: vi.fn(),
    flush: vi.fn(),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
    purgeExpired: vi.fn(async () => ({ purgedDocumentIds: [] })),
    importDocument: vi.fn(),
    replaceInitialDocument: vi.fn(),
    release: vi.fn(),
  };
  registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library,
    patents,
    fileService: new FileService(),
    assetStore: { install: vi.fn(), readAsset: vi.fn() },
    readOnly: false,
  });
  await mkdir(testDataDirectory, { recursive: true });
  expect(await invoke("documents:activate", { sessionId, documentId: patent.patentId })).toEqual({
    ok: true,
    value: undefined,
  });
  const outputPath = join(testDataDirectory, "auxiliary-document.docx");
  electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: outputPath });

  const exported = await invoke("exports:auxiliary-docx", {
    sessionId,
    patentId: patent.patentId,
    expectedRevision: 3,
    auxiliaryDocumentId,
    suggestedName: "含其他文档的专利-实验记录",
  });

  expect(exported).toMatchObject({
    ok: true,
    value: { format: "docx", outputPath },
  });
  expect(patents.loadForExport).toHaveBeenCalledWith({
    patentId: patent.patentId,
    sessionId,
    expectedRevision: 3,
  });
  expect(await readFile(outputPath)).not.toHaveLength(0);
});

test("uninitialized library reads report initialization failure while original writes stay blocked", async () => {
  const report = {
    previousShutdown: "unknown" as const,
    mode: "read-only" as const,
    replayedEditCount: 0,
    recoveredPatentCount: 0,
    quarantinedPatentCount: 0,
    backupCreated: false,
    recoverySourcesUnavailable: true,
    libraryInitializationFailure: "incomplete-library" as const,
    checkedAt: "2026-10-14T00:00:00.000Z",
  };
  registerIpcHandlers(undefined, new OpenPathAuthorization(), undefined, report, true);
  for (const channel of ["patents:list", "library:list"]) {
    await expect(invoke(channel, "active")).resolves.toMatchObject({
      ok: false,
      error: {
        code: "LIBRARY_INITIALIZATION_FAILED",
        message: "专利库尚未成功初始化，暂时无法读取。",
      },
    });
  }
  await expect(invoke("patents:create", {})).resolves.toMatchObject({
    ok: false,
    error: { code: "READ_ONLY_RECOVERY" },
  });
});

test("exposes a sanitized startup recovery report", async () => {
  const report = {
    previousShutdown: "unclean" as const,
    mode: "read-write" as const,
    replayedEditCount: 2,
    recoveredPatentCount: 1,
    quarantinedPatentCount: 0,
    backupCreated: false,
    checkedAt: "2026-08-11T00:00:00.000Z",
  };

  registerIpcHandlers(undefined, new OpenPathAuthorization(), undefined, report);

  await expect(invoke("application:get-startup-recovery-report")).resolves.toEqual({
    ok: true,
    value: report,
  });
});

test("scheduled patent backup archives unpublished drawing fragments and editable flowcharts", async () => {
  vi.useFakeTimers();
  const backupFolder = join(testDataDirectory, "flowchart-scheduled-backup");
  await mkdir(backupFolder, { recursive: true });
  const source = Uint8Array.from(Buffer.from("<mxfile><diagram>test</diagram></mxfile>", "utf8"));
  const sourceSha256 = createHash("sha256").update(source).digest("hex").toUpperCase();
  const patent = createBlankPatent({ patentType: "invention", name: "流程图备份专利" });
  const projectId = "00000000-0000-4000-8000-000000000992";
  patent.flowchartProjects = [
    {
      projectId,
      name: "流程图一",
      revision: 1,
      pageCount: 1,
      lastPageId: "page-1",
      sourceSha256,
      createdAt: patent.createdAt,
      modifiedAt: patent.modifiedAt,
    },
  ];
  const original = new Uint8Array(await readFile(resolve("tests/fixtures/images/sample.png")));
  const digest = createHash("sha256").update(original).digest("hex").toUpperCase();
  const asset: StoredAsset = {
    descriptor: {
      assetId: "00000000-0000-4000-8000-000000000995",
      kind: "image",
      originalName: "unpublished.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: original.length,
      sha256: digest,
      widthPx: 1000,
      heightPx: 800,
      previewByteLength: original.length,
      previewSha256: digest,
    },
    original,
    preview: original,
  };
  patent.assets = [asset.descriptor];
  patent.drawingProjects = [drawingProjectFixture(asset.descriptor.assetId)];
  patent.revision = 1;
  const exportBackup = vi.fn(async () => source);
  const createSnapshot = vi.fn();
  const savePatent = vi.fn(async (filePath: string, payload: unknown) => {
    await writeFile(filePath, Buffer.from("scheduled-backup"));
    return {
      ok: true as const,
      value: {
        path: filePath,
        displayName: "backup.patdoc",
        savedAt: new Date().toISOString(),
        previousVersionRetained: false,
      },
      payload,
    };
  });
  const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: vi.fn(async () => []) },
    patents: {
      list: vi.fn(async () => [
        {
          patentId: patent.patentId,
          name: patent.name,
          modifiedAt: patent.modifiedAt,
          revision: patent.revision,
        },
      ]),
      open: vi.fn(async () => ({
        sessionId: "00000000-0000-4000-8000-000000000993",
        patentId: patent.patentId,
        patent,
        revision: patent.revision,
      })),
      flush: vi.fn(async () => ({ patent, revision: patent.revision })),
      release: vi.fn(async () => undefined),
    },
    snapshots: {
      ...snapshotSchedulerStubs(),
      create: createSnapshot,
      open: vi.fn(),
      list: vi.fn(async () => []),
      delete: vi.fn(),
      preview: vi.fn(),
      previewAsset: vi.fn(),
    },
    flowcharts: { exportBackup },
    fileService: {
      savePatent,
      openPatent: vi.fn(async () => ({
        ok: true as const,
        value: { patent, assets: [asset], flowcharts: [{ projectId, source }] },
      })),
    },
    assetStore: { readAsset: vi.fn(async () => asset) },
    readOnly: false,
  } as never);

  try {
    await expect(
      invoke("backup:configure", { enabled: true, folder: backupFolder, intervalMinutes: 5 }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(savePatent).toHaveBeenCalled());

    expect(exportBackup).toHaveBeenCalledWith(patent.patentId, projectId);
    expect(savePatent.mock.calls[0]?.[1]).toMatchObject({
      flowcharts: [{ projectId, source }],
      patent: { drawingProjects: patent.drawingProjects, figures: [] },
      assets: [asset],
    });
    expect(createSnapshot).not.toHaveBeenCalled();
  } finally {
    await dispose();
    vi.useRealTimers();
  }
});

test("document backup metadata follows the captured revision and title", async () => {
  const folder = join(testDataDirectory, "document-capture-backup");
  const document = createBlankDocument("修改后的标题");
  const fileService = new FileService();
  registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: {
      list: async () => [
        {
          libraryDocumentId: document.documentId,
          title: "旧标题",
          revision: 1,
          createdAt: document.createdAt,
          modifiedAt: document.modifiedAt,
        },
      ],
      open: async () => ({
        sessionId: document.documentId,
        revision: 2,
        document,
        editorState: {},
      }),
      flush: async () => undefined,
      release: async () => undefined,
    },
    patents: { list: async () => [] },
    fileService,
    assetStore: { readAsset: vi.fn() },
    readOnly: false,
  } as never);
  await invoke("backup:configure", {
    enabled: true,
    folder,
    intervalMinutes: 5,
    waitOnExit: true,
  });
  const blocker = join(folder, "not-a-directory");
  await writeFile(blocker, "isolated backup configuration test");
  expect(
    await invoke("backup:configure", {
      enabled: true,
      folder: join(blocker, "child"),
      intervalMinutes: 5,
    }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_INPUT",
      message: "备份路径中的某一位置不是文件夹。",
      nextAction: "请重新选择有效的备份文件夹。",
    },
  });
  expect(await invoke("backup:status")).toMatchObject({
    ok: true,
    value: { enabled: true, folder },
  });
  expect(await invoke("backup:finalize", {})).toMatchObject({
    ok: true,
    value: { successCount: 1, failures: [] },
  });
  const response = (await invoke("backup:list")) as { value: unknown };
  const [entry] = BackupEntrySchema.array().parse(response.value);
  if (!entry) throw new Error("Missing captured document backup");
  expect(entry).toMatchObject({ displayName: document.title, revision: 2, managed: true });
  expect(entry?.fileName).toContain("-r2-");
  const archive = await fileService.openDocument(join(folder, entry.fileName));
  expect(archive).toMatchObject({
    ok: true,
    value: { settings: { backupSource: { displayName: document.title, revision: 2 } } },
  });
});

test("invalid optional source metadata does not break an external PATDOC backup list", async () => {
  const folder = join(testDataDirectory, "external-metadata-backup");
  await mkdir(folder, { recursive: true });
  const document = createBlankDocument("外部文档");
  const fileService = new FileService();
  expect(
    await fileService.saveDocument(join(folder, "external.patdoc"), {
      document,
      editorState: {},
      assets: [],
      settings: {
        backupSource: {
          documentType: "library_document",
          documentId: "",
          displayName: "",
          revision: -1,
        },
      },
    }),
  ).toMatchObject({ ok: true });
  registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: async () => [] },
    patents: { list: async () => [] },
    fileService,
    assetStore: { readAsset: vi.fn() },
    readOnly: false,
  } as never);
  await invoke("backup:configure", { enabled: false, folder, intervalMinutes: 5 });
  const response = (await invoke("backup:list")) as { value: unknown };
  expect(BackupEntrySchema.array().safeParse(response.value).success).toBe(true);
  expect(response.value).toMatchObject([
    { displayName: document.title, revision: 0, managed: false, status: "healthy" },
  ]);
});

test.each(["short", "maximum-length"])(
  "scheduled patent restore recreates archived editable flowcharts with a %s name",
  async (kind) => {
    const sourceName = kind === "short" ? "待恢复流程图专利" : "名".repeat(500);
    const source = Uint8Array.from(
      Buffer.from("<mxfile><diagram>restore</diagram></mxfile>", "utf8"),
    );
    const sourceSha256 = createHash("sha256").update(source).digest("hex").toUpperCase();
    const archivedPatent = createBlankPatent({ patentType: "invention", name: sourceName });
    const archivedProjectId = "00000000-0000-4000-8000-000000000994";
    archivedPatent.flowchartProjects = [
      {
        projectId: archivedProjectId,
        name: "待恢复流程图",
        revision: 1,
        pageCount: 1,
        lastPageId: "page-1",
        sourceSha256,
        createdAt: archivedPatent.createdAt,
        modifiedAt: archivedPatent.modifiedAt,
      },
    ];
    const restoredPatent = createBlankPatent({
      patentType: "invention",
      name: `${sourceName.slice(0, 495)} (恢复)`,
    });
    const sessionId = "00000000-0000-4000-8000-000000000995";
    const createFlowchart = vi.fn(async () => ({
      patentRevision: 2,
      project: {
        ...archivedPatent.flowchartProjects[0],
        projectId: "00000000-0000-4000-8000-000000000996",
      },
    }));
    const patents = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({
        patentId: restoredPatent.patentId,
        sessionId,
        revision: 0,
        patent: restoredPatent,
        saveState: "saved" as const,
      })),
      updateSettings: vi.fn(async () => ({ revision: 1 })),
      release: vi.fn(async () => undefined),
      open: vi.fn(async () => ({
        patentId: restoredPatent.patentId,
        sessionId,
        revision: 2,
        patent: { ...restoredPatent, revision: 2 },
        saveState: "saved" as const,
      })),
      moveToTrash: vi.fn(),
      permanentlyDelete: vi.fn(),
    };
    registerIpcHandlers(undefined, new OpenPathAuthorization(), {
      library: { list: vi.fn(async () => []) },
      patents,
      flowcharts: { create: createFlowchart },
      fileService: {
        openPatent: vi.fn(async () => ({
          ok: true as const,
          value: {
            patent: archivedPatent,
            assets: [],
            flowcharts: [{ projectId: archivedProjectId, source }],
          },
        })),
      },
      assetStore: { install: vi.fn(), readAsset: vi.fn() },
      readOnly: false,
    } as never);
    await expect(
      invoke("backup:configure", { enabled: false, folder: testDataDirectory, intervalMinutes: 5 }),
    ).resolves.toEqual({ ok: true, value: undefined });

    await expect(invoke("backup:restore", "flowchart-restore.patdoc")).resolves.toMatchObject({
      ok: true,
      value: { documentType: "patent", documentId: restoredPatent.patentId },
    });
    expect(patents.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: restoredPatent.name }),
    );
    expect(patents.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ name: restoredPatent.name }),
    );
    expect(createFlowchart).toHaveBeenCalledWith(
      expect.objectContaining({
        patentId: restoredPatent.patentId,
        expectedPatentRevision: 1,
        name: "待恢复流程图",
        source,
      }),
    );
  },
);

test("tile reads enforce window ownership and cannot finish successfully after session release", async () => {
  const patent = createBlankPatent({ patentType: "invention", name: "分块读取会话" });
  const sessionId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  patent.assets = [
    {
      assetId,
      kind: "drawing-tiles",
      originalName: "drawing.cadtiles",
      mediaType: "application/vnd.zxw.cad-tiles+zip",
      extension: "cadtiles",
      byteLength: 1,
      sha256: "A".repeat(64),
      widthPx: 1000,
      heightPx: 800,
      previewByteLength: 1,
      previewSha256: "A".repeat(64),
    },
  ];
  patent.drawingProjects = [drawingProjectFixture(assetId)];
  const frame = {};
  const sender = { id: 2101, mainFrame: frame, once: vi.fn(), isDestroyed: () => false };
  const event = { sender, senderFrame: frame };
  registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: vi.fn(async () => []) },
    patents: {
      list: vi.fn(async () => []),
      open: vi.fn(async () => ({
        patentId: patent.patentId,
        sessionId,
        revision: patent.revision,
        patent,
        saveState: "saved",
      })),
      requireActiveReadSession: vi.fn(() => patent),
      release: vi.fn(async () => undefined),
    },
    fileService: {},
    assetStore: {
      readAsset: vi.fn(async () => ({
        descriptor: patent.assets[0],
        original: new Uint8Array([1]),
        preview: new Uint8Array([1]),
      })),
    },
    readOnly: false,
  } as never);
  const readTile = vi
    .spyOn(AssetStore.prototype, "readDrawingTile")
    .mockResolvedValue(Buffer.from([1]));
  try {
    expect(await invoke("patents:open", patent.patentId, event)).toEqual({
      ok: true,
      value: expect.anything(),
    });
    const request = { sessionId, assetId, tileId: "tile-0" };
    expect(await invoke("drawings:read-tile", request, event)).toEqual({
      ok: true,
      value: Buffer.from([1]),
    });
    expect(
      await invoke("drawings:read-tile", request, { ...event, senderFrame: {} }),
    ).toMatchObject({ ok: false, error: { code: "NO_PERMISSION" } });
    expect(
      await invoke("drawings:read-tile", request, {
        sender: { ...sender, id: 2102 },
        senderFrame: frame,
      }),
    ).toMatchObject({ ok: false, error: { code: "NO_PERMISSION" } });
    expect(readTile).toHaveBeenCalledOnce();
    let finish!: (bytes: Buffer) => void;
    readTile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = invoke("drawings:read-tile", request, event);
    await vi.waitFor(() => expect(readTile).toHaveBeenCalledTimes(2));
    expect(await invoke("patents:release", sessionId, event)).toMatchObject({ ok: true });
    finish(Buffer.from([2]));
    expect(await pending).toMatchObject({ ok: false });
  } finally {
    readTile.mockRestore();
  }
});

test("tracks renderer-open patent sessions through release and renderer destruction", async () => {
  vi.useFakeTimers();
  const patent = createBlankPatent({ patentType: "invention", name: "会话快照专利" });
  const sessionIds = [
    "00000000-0000-4000-8000-000000000921",
    "00000000-0000-4000-8000-000000000922",
  ];
  let nextSession = 0;
  let destroyed: (() => void) | undefined;
  const sender = {
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "destroyed") destroyed = listener;
    }),
  };
  const snapshots = {
    create: vi.fn(),
    pruneAll: vi.fn(async () => ({ deletedCount: 0, cleanupError: null })),
    lastAutomaticSnapshotAt: vi.fn(() => null),
    open: vi.fn(),
    list: vi.fn(async () => []),
    delete: vi.fn(),
    preview: vi.fn(),
    previewAsset: vi.fn(),
  };
  const patents = {
    list: vi.fn(async () => []),
    open: vi.fn(async () => ({
      patentId: patent.patentId,
      sessionId: sessionIds[nextSession++],
      revision: patent.revision,
      patent,
      saveState: "saved" as const,
    })),
    release: vi.fn(async () => undefined),
  };
  const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: vi.fn(async () => []) },
    patents,
    snapshots,
    fileService: {},
    assetStore: { getOrLoad: vi.fn(), createSession: vi.fn(), destroySession: vi.fn() },
    readOnly: false,
  } as never);

  try {
    await vi.advanceTimersByTimeAsync(0);
    await expect(invoke("patents:open", patent.patentId, { sender })).resolves.toMatchObject({
      ok: true,
      value: { sessionId: sessionIds[0] },
    });
    await expect(invoke("patents:open", patent.patentId, { sender })).resolves.toMatchObject({
      ok: true,
      value: { sessionId: sessionIds[1] },
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(invoke("snapshot:status")).resolves.toMatchObject({
      ok: true,
      value: { openPatentCount: 1, nextCheckAt: expect.any(String) },
    });

    await expect(invoke("patents:release", sessionIds[0])).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(invoke("snapshot:status")).resolves.toMatchObject({
      ok: true,
      value: { openPatentCount: 1 },
    });

    destroyed?.();
    await vi.advanceTimersByTimeAsync(0);
    await expect(invoke("snapshot:status")).resolves.toMatchObject({
      ok: true,
      value: { openPatentCount: 0, nextCheckAt: null },
    });
    expect(patents.release).toHaveBeenCalledWith(sessionIds[1]);
  } finally {
    await dispose();
    vi.useRealTimers();
  }
});

test("opens without loading resources and releases a lazy read when the renderer is destroyed", async () => {
  const patent = createBlankPatent({ patentType: "invention", name: "加载期间销毁专利" });
  const sessionId = "00000000-0000-4000-8000-000000000925";
  const assetId = "00000000-0000-4000-8000-000000000926";
  const descriptor = {
    assetId,
    kind: "image" as const,
    originalName: "drawing.png",
    mediaType: "image/png" as const,
    extension: "png" as const,
    byteLength: 4,
    sha256: "A".repeat(64),
    widthPx: 1,
    heightPx: 1,
    previewByteLength: 4,
    previewSha256: "B".repeat(64),
  };
  patent.assets = [descriptor];
  let finishAssetLoad: ((asset: StoredAsset) => void) | undefined;
  const readAsset = vi.fn(
    () =>
      new Promise<StoredAsset>((resolve) => {
        finishAssetLoad = resolve;
      }),
  );
  let destroyed: (() => void) | undefined;
  const sender = {
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "destroyed") destroyed = listener;
    }),
    isDestroyed: vi.fn(() => false),
  };
  const release = vi.fn(async () => undefined);
  const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: vi.fn(async () => []) },
    patents: {
      list: vi.fn(async () => []),
      open: vi.fn(async () => ({
        patentId: patent.patentId,
        sessionId,
        revision: patent.revision,
        patent,
        saveState: "saved" as const,
      })),
      release,
    },
    snapshots: {
      ...snapshotSchedulerStubs(),
      open: vi.fn(),
      list: vi.fn(async () => []),
      delete: vi.fn(),
      preview: vi.fn(),
      previewAsset: vi.fn(),
    },
    fileService: {},
    assetStore: { readAsset },
    readOnly: false,
  } as never);

  const opening = invoke("patents:open", patent.patentId, { sender });
  await expect(opening).resolves.toMatchObject({ ok: true });
  expect(readAsset).not.toHaveBeenCalled();
  const reading = invoke("drawings:read-source", { sessionId, assetId }, { sender });
  await vi.waitFor(() => expect(readAsset).toHaveBeenCalledWith(assetId));
  destroyed?.();
  try {
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(sessionId));
    finishAssetLoad?.({
      descriptor,
      original: Uint8Array.from([1]),
      preview: Uint8Array.from([1]),
    });
    await expect(reading).resolves.toMatchObject({ ok: false });
    await expect(invoke("snapshot:status")).resolves.toMatchObject({
      ok: true,
      value: { openPatentCount: 0, nextCheckAt: null },
    });
    expect(release).toHaveBeenCalledOnce();
  } finally {
    finishAssetLoad?.({
      descriptor,
      original: Uint8Array.from([1]),
      preview: Uint8Array.from([1]),
    });
    await reading;
    await dispose();
  }
});

test("renderer destruction releases patent sessions when local cleanup fails", async () => {
  const patent = createBlankPatent({ patentType: "invention", name: "销毁清理失败专利" });
  const sessionId = "00000000-0000-4000-8000-000000000924";
  let destroyed: (() => void) | undefined;
  const sender = {
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "destroyed") destroyed = listener;
    }),
  };
  const release = vi.fn(async () => undefined);
  const discardStages = vi
    .spyOn(AssetStore.prototype, "discardAllPersistentStages")
    .mockRejectedValueOnce(new Error("暂存资源清理失败"));
  const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: vi.fn(async () => []) },
    patents: {
      list: vi.fn(async () => []),
      open: vi.fn(async () => ({
        patentId: patent.patentId,
        sessionId,
        revision: patent.revision,
        patent,
        saveState: "saved" as const,
      })),
      release,
    },
    snapshots: {
      ...snapshotSchedulerStubs(),
      open: vi.fn(),
      list: vi.fn(async () => []),
      delete: vi.fn(),
      preview: vi.fn(),
      previewAsset: vi.fn(),
    },
    fileService: {},
    assetStore: { getOrLoad: vi.fn() },
    readOnly: false,
  } as never);

  try {
    await expect(invoke("patents:open", patent.patentId, { sender })).resolves.toMatchObject({
      ok: true,
      value: { sessionId },
    });
    destroyed?.();
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(sessionId));
  } finally {
    discardStages.mockRestore();
    await dispose();
  }
});

test("snapshot creation accepts only explicit renderer sources and returns the creation outcome", async () => {
  const patentId = "00000000-0000-4000-8000-000000000923";
  const result = {
    outcome: "created" as const,
    revision: 8,
    createdAt: "2026-08-16T03:04:05.000Z",
    source: "manual-create" as const,
  };
  const createSnapshot = vi.fn(async () => result);
  const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: vi.fn(async () => []) },
    patents: { list: vi.fn(async () => []) },
    snapshots: {
      create: createSnapshot,
      pruneAll: vi.fn(async () => ({ deletedCount: 0, cleanupError: null })),
      lastAutomaticSnapshotAt: vi.fn(() => null),
      open: vi.fn(),
      list: vi.fn(async () => []),
      delete: vi.fn(),
      preview: vi.fn(),
      previewAsset: vi.fn(),
    },
    fileService: {},
    assetStore: {},
    readOnly: false,
  } as never);

  try {
    await expect(
      invoke("snapshot:create", {
        documentType: "patent",
        documentId: patentId,
        source: "manual-create",
      }),
    ).resolves.toEqual({ ok: true, value: result });
    expect(createSnapshot).toHaveBeenCalledWith(patentId, "manual-create");

    for (const source of [undefined, "automatic", "initial", "historical"]) {
      await expect(
        invoke("snapshot:create", {
          documentType: "patent",
          documentId: patentId,
          ...(source === undefined ? {} : { source }),
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
    expect(createSnapshot).toHaveBeenCalledOnce();
  } finally {
    await dispose();
  }
});

test("snapshot listing returns readable histories together with named partial warnings", async () => {
  const readablePatentId = "00000000-0000-4000-8000-000000000931";
  const unreadablePatentId = "00000000-0000-4000-8000-000000000932";
  const listSnapshots = vi.fn(async (patentId: string) => {
    if (patentId === unreadablePatentId) throw new Error("快照密文无法读取");
    return [
      {
        revision: 2,
        createdAt: "2026-08-16T01:02:03.000Z",
        source: "automatic" as const,
        sizeBytes: 1024,
        status: "healthy" as const,
        errorMessage: null,
        deletable: false,
        contentSummary: null,
      },
    ];
  });
  const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: vi.fn(async () => []) },
    patents: {
      list: vi.fn(async () => [
        { patentId: readablePatentId, name: "可读取专利" },
        { patentId: unreadablePatentId, name: "损坏历史专利" },
      ]),
    },
    snapshots: {
      ...snapshotSchedulerStubs(),
      open: vi.fn(),
      list: listSnapshots,
      delete: vi.fn(),
    },
    fileService: {},
    assetStore: {},
    readOnly: false,
  } as never);

  try {
    await expect(invoke("snapshot:list", {})).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          expect.objectContaining({
            documentId: readablePatentId,
            displayName: "可读取专利",
            revision: 2,
            source: "automatic",
          }),
        ],
        warnings: [
          {
            documentType: "patent",
            documentId: unreadablePatentId,
            displayName: "损坏历史专利",
            message: "快照密文无法读取",
          },
        ],
      },
    });
  } finally {
    await dispose();
  }
});

test("manual snapshot creation delegates to source-aware creation", async () => {
  const patentId = "00000000-0000-4000-8000-000000000933";
  const creationResult = {
    outcome: "created" as const,
    revision: 7,
    createdAt: "2026-08-16T03:04:05.000Z",
    source: "manual-create" as const,
  };
  const createSnapshot = vi.fn(async () => creationResult);
  const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: vi.fn(async () => []) },
    patents: { list: vi.fn(async () => []) },
    snapshots: {
      ...snapshotSchedulerStubs(),
      create: createSnapshot,
      open: vi.fn(),
      list: vi.fn(async () => []),
      delete: vi.fn(),
    },
    fileService: {},
    assetStore: {},
    readOnly: false,
  } as never);

  try {
    await expect(
      invoke("snapshot:create", {
        documentType: "patent",
        documentId: patentId,
        source: "manual-create",
      }),
    ).resolves.toEqual({ ok: true, value: creationResult });
    expect(createSnapshot).toHaveBeenCalledWith(patentId, "manual-create");
  } finally {
    await dispose();
  }
});

test("read-only recovery rejects every mutating snapshot operation without side effects", async () => {
  const patentId = "00000000-0000-4000-8000-000000000939";
  const createSnapshot = vi.fn();
  const openSnapshot = vi.fn();
  const deleteSnapshot = vi.fn();
  const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: vi.fn(async () => []) },
    patents: { list: vi.fn(async () => []) },
    snapshots: {
      ...snapshotSchedulerStubs(),
      create: createSnapshot,
      open: openSnapshot,
      list: vi.fn(async () => []),
      delete: deleteSnapshot,
    },
    fileService: {},
    assetStore: {},
    readOnly: true,
  } as never);

  try {
    await expect(
      invoke("snapshot:create", {
        documentType: "patent",
        documentId: patentId,
        source: "manual-create",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "READ_ONLY_RECOVERY" } });
    await expect(
      invoke("snapshot:restore", { documentType: "patent", documentId: patentId, revision: 1 }),
    ).resolves.toMatchObject({ ok: false, error: { code: "READ_ONLY_RECOVERY" } });
    await expect(
      invoke("snapshot:delete", { documentType: "patent", documentId: patentId, revision: 1 }),
    ).resolves.toMatchObject({ ok: false, error: { code: "READ_ONLY_RECOVERY" } });
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(openSnapshot).not.toHaveBeenCalled();
    expect(deleteSnapshot).not.toHaveBeenCalled();
  } finally {
    await dispose();
  }
});

test("allows validated snapshot previews in read-only recovery without mutations", async () => {
  const patentId = "00000000-0000-4000-8000-000000000941";
  const assetId = "00000000-0000-4000-8000-000000000942";
  const preview = {
    current: { revision: 3, createdAt: "2026-08-16T03:00:00.000Z", books: [] },
    baseline: null,
    comparison: "initial" as const,
    skippedRevisions: [],
  };
  const previewSnapshot = vi.fn(async () => preview);
  const previewAsset = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const createSnapshot = vi.fn();
  const open = vi.fn();
  const deleteSnapshot = vi.fn();
  const patentMutations = {
    create: vi.fn(),
    updateSettings: vi.fn(),
    setDrawingBooksEnabled: vi.fn(),
    applyBookEdit: vi.fn(),
    applyFigureEdit: vi.fn(),
    flush: vi.fn(),
    moveToTrash: vi.fn(),
    restore: vi.fn(),
    permanentlyDelete: vi.fn(),
  };
  const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: vi.fn(async () => []) },
    patents: { list: vi.fn(async () => []), ...patentMutations },
    snapshots: {
      ...snapshotSchedulerStubs(),
      create: createSnapshot,
      open,
      list: vi.fn(async () => []),
      delete: deleteSnapshot,
      preview: previewSnapshot,
      previewAsset,
    },
    fileService: {},
    assetStore: {},
    readOnly: true,
  } as never);

  try {
    await expect(
      invoke("snapshot:preview", { documentType: "patent", documentId: patentId, revision: 3 }),
    ).resolves.toEqual({ ok: true, value: preview });
    await expect(
      invoke("snapshot:preview-asset", {
        documentType: "patent",
        documentId: patentId,
        revision: 3,
        assetId,
      }),
    ).resolves.toEqual({ ok: true, value: new Uint8Array([1, 2, 3]) });
    expect(previewSnapshot).toHaveBeenCalledWith(patentId, 3);
    expect(previewAsset).toHaveBeenCalledWith(patentId, 3, assetId);

    await expect(
      invoke("snapshot:preview", { documentType: "patent", documentId: "invalid", revision: 3 }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(previewSnapshot).toHaveBeenCalledOnce();
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(deleteSnapshot).not.toHaveBeenCalled();
    for (const mutation of Object.values(patentMutations)) {
      expect(mutation).not.toHaveBeenCalled();
    }
  } finally {
    await dispose();
  }
});

test("manual-safe settings reads do not repair or quarantine the settings file", async () => {
  const settingsPath = join(testDataDirectory, "settings.json");
  const original = "not-json";
  await mkdir(testDataDirectory, { recursive: true });
  await rm(`${settingsPath}.last-good`, { force: true });
  await writeFile(settingsPath, original, "utf8");
  const dispose = registerIpcHandlers(
    undefined,
    new OpenPathAuthorization(),
    undefined,
    undefined,
    true,
  );

  try {
    await expect(invoke("settings:read")).resolves.toMatchObject({ ok: true });
    await expect(readFile(settingsPath, "utf8")).resolves.toBe(original);
    await expect(readFile(`${settingsPath}.last-good`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await dispose();
  }
});

test("snapshot status includes the last automatic snapshot timestamp", async () => {
  const lastAutomaticSnapshotAt = "2026-08-16T02:03:04.000Z";
  const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: vi.fn(async () => []) },
    patents: { list: vi.fn(async () => []) },
    snapshots: {
      ...snapshotSchedulerStubs(),
      lastAutomaticSnapshotAt: () => lastAutomaticSnapshotAt,
      open: vi.fn(),
      list: vi.fn(async () => []),
      delete: vi.fn(),
    },
    fileService: {},
    assetStore: {},
    readOnly: false,
  } as never);

  try {
    await expect(invoke("snapshot:status")).resolves.toMatchObject({
      ok: true,
      value: {
        lastAutomaticSnapshotAt,
        openPatentCount: 0,
        lastCheckAt: null,
        lastError: null,
      },
    });
  } finally {
    await dispose();
  }
});

test("a late snapshot status read cannot replace successfully configured settings", async () => {
  const latest = {
    ...structuredClone(DEFAULT_APP_SETTINGS),
    snapshot: { enabled: true, intervalMinutes: 3 as const },
  };
  const read = vi.spyOn(SettingsService.prototype, "read").mockResolvedValue(latest);
  const update = vi.spyOn(SettingsService.prototype, "update").mockResolvedValue(latest);
  const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: vi.fn(async () => []) },
    patents: { list: vi.fn(async () => []) },
    snapshots: {
      ...snapshotSchedulerStubs(),
      open: vi.fn(),
      list: vi.fn(async () => []),
      delete: vi.fn(),
    },
    fileService: {},
    assetStore: {},
    readOnly: false,
  } as never);
  let resolveOld: ((value: typeof latest) => void) | undefined;
  try {
    await invoke("snapshot:status");
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const pending = invoke("snapshot:status");
    await expect(invoke("snapshot:configure", latest.snapshot)).resolves.toMatchObject({
      ok: true,
    });
    resolveOld?.({ ...latest, snapshot: { enabled: false, intervalMinutes: 3 } });
    await expect(pending).resolves.toMatchObject({
      ok: true,
      value: { enabled: true, intervalMinutes: 3 },
    });
  } finally {
    resolveOld?.(latest);
    await dispose();
    read.mockRestore();
    update.mockRestore();
  }
});

test.each([false, true])(
  "snapshot restore preserves the clone name, warnings and flowcharts (%s)",
  async (withFlowchart) => {
    const sourcePatent = createBlankPatent({ patentType: "invention", name: "原始专利" });
    const source = Buffer.from('<mxfile><diagram id="history"/></mxfile>');
    const project = {
      projectId: "00000000-0000-4000-8000-000000000939",
      name: "历史流程",
      revision: 1,
      pageCount: 1,
      lastPageId: "history",
      sourceSha256: "A".repeat(64),
      createdAt: sourcePatent.createdAt,
      modifiedAt: sourcePatent.modifiedAt,
    };
    if (withFlowchart) sourcePatent.flowchartProjects = [project];
    const createFlowchart = vi.fn(async () => ({ project, patentRevision: 2 }));
    const restoredPatentId = "00000000-0000-4000-8000-000000000935";
    const shellSessionId = "00000000-0000-4000-8000-000000000936";
    const restoredSessionId = "00000000-0000-4000-8000-000000000937";
    let restoredName = "";
    const release = vi.fn(async (sessionId: string) => {
      if (sessionId === restoredSessionId) throw new Error("release failed");
    });
    const patents = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({
        patentId: restoredPatentId,
        sessionId: shellSessionId,
        revision: 0,
        patent: { ...sourcePatent, patentId: restoredPatentId, revision: 0 },
        saveState: "saved" as const,
      })),
      updateSettings: vi.fn(async (input: { name: string }) => {
        restoredName = input.name;
        return { patentId: restoredPatentId, revision: 1, savedAt: "2026-08-16T02:05:00.000Z" };
      }),
      applyFigureEdit: vi.fn(),
      setDrawingBooksEnabled: vi.fn(),

      open: vi.fn(async () => ({
        patentId: restoredPatentId,
        sessionId: restoredSessionId,
        revision: withFlowchart ? 2 : 1,
        patent: {
          ...sourcePatent,
          patentId: restoredPatentId,
          name: restoredName,
          revision: 1,
        },
        saveState: "saved" as const,
      })),
      release,
      moveToTrash: vi.fn(),
      permanentlyDelete: vi.fn(),
    };
    const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
      library: { list: vi.fn(async () => []) },
      patents,
      flowcharts: { create: createFlowchart },
      snapshots: {
        ...snapshotSchedulerStubs(),
        readFlowchartArchive: vi.fn(async () =>
          withFlowchart ? [{ projectId: project.projectId, source }] : [],
        ),
        open: vi.fn(async () => ({
          revision: 4,
          createdAt: "2026-08-16T01:02:03.000Z",
          patent: sourcePatent,
        })),
        list: vi.fn(async () => []),
        delete: vi.fn(),
      },
      fileService: {},
      assetStore: { readAsset: vi.fn(), install: vi.fn() },
      readOnly: false,
    } as never);

    try {
      const result = await invoke("snapshot:restore", {
        documentType: "patent",
        documentId: sourcePatent.patentId,
        revision: 4,
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          documentId: restoredPatentId,
          displayName: expect.stringContaining("快照恢复 v4，2026-08-16 01:02 UTC"),
          warning: expect.stringContaining("恢复副本已经创建"),
        },
      });
      expect(release).toHaveBeenCalledWith(restoredSessionId);
      if (withFlowchart)
        expect(createFlowchart).toHaveBeenCalledWith(
          expect.objectContaining({ name: "历史流程", source }),
        );
    } finally {
      await dispose();
    }
  },
);

test("rejects unsupported library-document snapshot restoration explicitly", async () => {
  const dispose = registerIpcHandlers(undefined, new OpenPathAuthorization(), {
    library: { list: vi.fn(async () => []) },
    patents: { list: vi.fn(async () => []) },
    snapshots: {
      ...snapshotSchedulerStubs(),
      open: vi.fn(),
      list: vi.fn(async () => []),
      delete: vi.fn(),
    },
    fileService: {},
    assetStore: {},
    readOnly: false,
  } as never);

  try {
    await expect(
      invoke("snapshot:restore", {
        documentType: "library_document",
        documentId: "00000000-0000-4000-8000-000000000938",
        revision: 0,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "NOT_IMPLEMENTED" } });
  } finally {
    await dispose();
  }
});

test("protected startup recovery can prepare a validated PATDOC in a new library without enabling original writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ipc-self-recovery-"));
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, "original.txt"), "原文件");
  const archive = join(root, "backup.patdoc");
  await writePatdoc(archive, {
    patent: createBlankPatent({ patentType: "invention", name: "备份恢复测试" }),
    assets: [],
    flowcharts: [],
  });
  const activate = vi.fn(async () => undefined);
  const restart = vi.fn();
  const frame = {};
  const event = { sender: { mainFrame: frame }, senderFrame: frame };
  registerIpcHandlers(
    undefined,
    new OpenPathAuthorization(),
    undefined,
    {
      previousShutdown: "unclean",
      mode: "read-only",
      replayedEditCount: 0,
      recoveredPatentCount: 0,
      quarantinedPatentCount: 0,
      backupCreated: false,
      recoverySourcesUnavailable: true,
      checkedAt: "2026-10-04T00:00:00.000Z",
    },
    true,
    undefined,
    {
      settings: new SettingsService(join(root, "settings.json")),
      onCloseToTrayChanged: vi.fn(),
      recoveryLibrary: { sourceRoot, activate, restart },
    },
  );
  electron.showOpenDialog
    .mockResolvedValueOnce({ canceled: false, filePaths: [archive] })
    .mockResolvedValueOnce({ canceled: false, filePaths: [root] });
  const result = (await invoke("application:prepare-recovery", { kind: "file" }, event)) as {
    ok: boolean;
    value: { token: string; libraryPath: string };
  };
  expect(result.ok).toBe(true);
  expect(result.value.libraryPath).not.toBe(sourceRoot);
  expect(activate).not.toHaveBeenCalled();
  expect(restart).not.toHaveBeenCalled();
  expect(await readFile(join(sourceRoot, "original.txt"), "utf8")).toBe("原文件");
  await expect(
    invoke(
      "snapshot:restore",
      { documentType: "patent", documentId: crypto.randomUUID(), revision: 0 },
      event,
    ),
  ).resolves.toMatchObject({ ok: false, error: { code: "READ_ONLY_RECOVERY" } });
  await expect(
    invoke("application:activate-recovery", result.value.token, event),
  ).resolves.toMatchObject({ ok: true });
  await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
  expect(activate).toHaveBeenCalledWith(result.value.libraryPath);
});

test.each(["file", "destination"] as const)(
  "canceling %s selection during protected recovery never changes the library",
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), "ipc-recovery-cancel-"));
    const sourceRoot = join(root, "source");
    await mkdir(sourceRoot);
    const archive = join(root, "backup.patdoc");
    await writePatdoc(archive, {
      patent: createBlankPatent({ patentType: "invention", name: "取消测试" }),
      assets: [],
      flowcharts: [],
    });
    const activate = vi.fn(async () => undefined);
    const restart = vi.fn();
    const frame = {};
    const event = { sender: { mainFrame: frame }, senderFrame: frame };
    registerIpcHandlers(
      undefined,
      new OpenPathAuthorization(),
      undefined,
      {
        previousShutdown: "unclean",
        mode: "read-only",
        replayedEditCount: 0,
        recoveredPatentCount: 0,
        quarantinedPatentCount: 0,
        backupCreated: false,
        checkedAt: "2026-10-04T00:00:00.000Z",
      },
      true,
      undefined,
      {
        settings: new SettingsService(join(root, "settings.json")),
        onCloseToTrayChanged: vi.fn(),
        recoveryLibrary: { sourceRoot, activate, restart },
      },
    );
    if (stage === "destination")
      electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [archive] });
    await expect(invoke("application:prepare-recovery", { kind: "file" }, event)).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(activate).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    await expect(
      invoke("application:prepare-recovery", { kind: "file" }, { ...event, senderFrame: {} }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  },
);

test("update IPC restricts frames, reports missing channel, rejects arbitrary URLs and saves opt-out", async () => {
  registerIpcHandlers();
  const frame = {};
  const event = { sender: { mainFrame: frame }, senderFrame: frame };
  expect(await invoke("updates:read", undefined, { ...event, senderFrame: {} })).toMatchObject({
    ok: false,
  });
  expect(await invoke("updates:check", undefined, event)).toMatchObject({
    ok: true,
    value: { status: "unconfigured", release: null },
  });
  expect(await invoke("updates:open-download", "https://evil.example.com", event)).toMatchObject({
    ok: false,
  });
  expect(
    await invoke(
      "updates:dismiss",
      { version: "1.2.0", action: "skip", url: "https://evil.example.com" },
      event,
    ),
  ).toMatchObject({ ok: false });
  expect(await invoke("settings:update", { autoCheckUpdates: false }, event)).toMatchObject({
    ok: true,
    value: { autoCheckUpdates: false },
  });
  expect(await invoke("settings:read", undefined, event)).toMatchObject({
    ok: true,
    value: { autoCheckUpdates: false },
  });
});

test("agreement calls only accept the trusted top-level application window", async () => {
  const read = vi.fn(async () => ({ needsConfirmation: true }));
  const accept = vi.fn(async () => ({ needsConfirmation: false }));
  registerIpcHandlers(undefined, undefined, undefined, undefined, false, undefined, {
    agreements: { read, accept } as never,
  } as never);
  const frame = {};
  const sender = { mainFrame: frame, getURL: () => "patent-app://app/index.html" };
  const event = { sender, senderFrame: frame };
  expect(await invoke("agreements:read", undefined, event)).toMatchObject({ ok: true });
  expect(read).toHaveBeenCalledOnce();
  expect(await invoke("agreements:read", undefined, { sender, senderFrame: {} })).toMatchObject({
    ok: false,
  });
  expect(
    await invoke("agreements:read", undefined, {
      sender: { ...sender, getURL: () => "https://example.com" },
      senderFrame: frame,
    }),
  ).toMatchObject({ ok: false });
  expect(read).toHaveBeenCalledOnce();
  const request = {
    appVersion: "1.1.1",
    termsVersion: "terms-1",
    privacyVersion: "privacy-1",
    participate: false,
  };
  expect(await invoke("agreements:accept", request, event)).toMatchObject({ ok: true });
  expect(accept).toHaveBeenCalledWith(request);
  expect(
    await invoke("agreements:accept", { ...request, participate: "true" }, event),
  ).toMatchObject({ ok: false });
  expect(accept).toHaveBeenCalledOnce();
});

test.each(["http://127.0.0.1:5173", "http://localhost:5173/"])(
  "agreement and statistics calls accept the normalized development entry %s",
  async (rendererUrl) => {
    vi.stubEnv("ELECTRON_RENDERER_URL", rendererUrl);
    try {
      const read = vi.fn(async () => ({ needsConfirmation: true }));
      const accept = vi.fn(async () => ({ needsConfirmation: true }));
      const choose = vi.fn(async () => ({}));
      registerIpcHandlers(undefined, undefined, undefined, undefined, false, undefined, {
        agreements: { read, accept },
        usageStatistics: { read, choose },
      } as never);
      const frame = {};
      const sender = { mainFrame: frame, getURL: () => new URL(rendererUrl).href };
      const event = { sender, senderFrame: frame };
      const requests = [
        ["agreements:read", undefined],
        [
          "agreements:accept",
          { appVersion: "1.1.1", termsVersion: "t1", privacyVersion: "p1", participate: false },
        ],
        ["usage-statistics:read", undefined],
        ["usage-statistics:choose", { enabled: false }],
      ] as const;
      for (const [channel, input] of requests) {
        expect(await invoke(channel, input, event)).toMatchObject({ ok: true });
        for (const url of [
          `${new URL(rendererUrl).origin}/other`,
          `${new URL(rendererUrl).origin}/?other=1`,
          "http://127.0.0.1:5174/",
          "https://example.com/",
          "http://untrusted@127.0.0.1:5173/",
        ]) {
          expect(
            await invoke(channel, input, {
              ...event,
              sender: { ...sender, getURL: () => url },
            }),
          ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
        }
        expect(await invoke(channel, input, { ...event, senderFrame: {} })).toMatchObject({
          ok: false,
        });
      }
      expect(read).toHaveBeenCalledTimes(2);
      expect(accept).toHaveBeenCalledOnce();
      expect(choose).toHaveBeenCalledOnce();
      electron.fromWebContents.mockReturnValue(null);
      expect(await invoke("agreements:read", undefined, event)).toMatchObject({ ok: false });
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test("automatic update checking waits for the agreement and starts after successful confirmation", async () => {
  const start = vi.spyOn(SoftwareUpdateService.prototype, "start");
  try {
    const read = vi.fn(async () => ({ needsConfirmation: true }));
    const accept = vi.fn(async () => ({ needsConfirmation: false }));
    registerIpcHandlers(undefined, undefined, undefined, undefined, false, undefined, {
      agreements: { read, accept } as never,
    } as never);
    const frame = {};
    const sender = { mainFrame: frame, getURL: () => "patent-app://app/index.html" };
    const event = { sender, senderFrame: frame };
    await invoke("updates:start", undefined, event);
    expect(start).not.toHaveBeenCalled();
    await invoke(
      "agreements:accept",
      {
        appVersion: "1.1.1",
        termsVersion: "terms-1",
        privacyVersion: "privacy-1",
        participate: false,
      },
      event,
    );
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
  } finally {
    start.mockRestore();
  }
});
