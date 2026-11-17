import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { PatentApi } from "../../../src/shared/ipc/contract.js";

export const COMPLETE_LIBRARY_PATENT_NAME = "虚构多域迁移装置";
export const TRANSFERRED_CLAIM_TEXT =
  "1. 一种虚构多域迁移装置，其特征在于，包括可复核传感部和隔离控制部。";

type MachineSettings = Readonly<{
  zoomPercent: number;
  recentDirectory: string | null;
  windowBounds: Readonly<{ x: number; y: number; width: number; height: number }> | null;
  welcomeCompleted: boolean;
  printerDeviceName: string | null;
  backupEnabled: boolean;
  backupFolder: string | null;
  aiEnabled: boolean;
  customAiProfileIds: readonly string[];
  credentialProfileIds: readonly string[];
}>;

export type TransferredLibrarySemantics = Readonly<{
  library: Readonly<{
    drafts: readonly Readonly<{
      summary: Readonly<{ draftId: string; documentId: string }>;
      document: Readonly<{ documentId: string; title: string }>;
      editorState: unknown;
      assets: readonly unknown[];
    }>[];
  }> &
    Readonly<Record<string, unknown>>;
  portableSettings: unknown;
  machineSettings: MachineSettings;
}>;

export async function seedCompleteLibrary(
  page: Page,
  options: Readonly<{ legacyDraftPatdocPath: string; legacyDraftRoot: string }>,
): Promise<void> {
  const pngBytes = await readFile(join(process.cwd(), "tests", "fixtures", "images", "sample.png"));
  const draft = await page.evaluate(
    async ({ imageBytes, completePatentName, transferredClaimText }) => {
      const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
      const unwrap = <T>(
        result: { ok: true; value: T } | { ok: false; error: { code: string } },
        operation: string,
      ): T => {
        if (!result.ok) throw new Error(`${operation} failed: ${result.error.code}`);
        return result.value;
      };
      const id = () => {
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
        bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
        const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
        return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
          .slice(6, 8)
          .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
      };
      const paragraphAttributes = {
        alignment: "left" as const,
        paragraphIndentMm: 0,
        lineSpacing: 1.5,
        defaultFontFamily: "SimSun",
        defaultFontSizePt: 12,
      };
      const paragraph = (text: string) => ({
        id: id(),
        type: "paragraph" as const,
        attrs: paragraphAttributes,
        content: [{ type: "text" as const, text, marks: [] }],
      });

      const initialSettings = unwrap(await api.settings.read(), "settings.read");
      const customAiProfileId = "4fc8777f-0172-4c3f-98db-44c280f1051f";
      const templates = structuredClone(initialSettings.patentTemplates);
      const claimsParagraph = templates.invention.claims.content.find(
        (block) => block.type === "paragraph",
      );
      if (claimsParagraph?.type !== "paragraph") {
        throw new Error("patent template fixture missing");
      }
      claimsParagraph.content = [
        {
          type: "text",
          text: "1. {{patentName}}，其特征在于，包括虚构模板定位部。",
          marks: [],
        },
      ];
      unwrap(
        await api.settings.update({
          zoomPercent: 125,
          recentDirectory: "D:\\虚构电脑A\\仅本机案件",
          windowBounds: { x: 31, y: 47, width: 1280, height: 820 },
          welcomeCompleted: true,
          referenceMarkSyncIntroDismissed: true,
          printPreferences: {
            printerDeviceName: "虚构电脑A打印机",
            duplexMode: "longEdge",
            color: false,
            orientation: "landscape",
            paperSize: "A4",
          },
          patentTemplates: templates,
          backup: {
            enabled: false,
            folder: "D:\\虚构电脑A\\实时备份",
            intervalMinutes: 17,
          },
          snapshot: { enabled: true, intervalMinutes: 10 },
          pageMargins: {
            marginTopMm: 18,
            marginRightMm: 19,
            marginBottomMm: 20,
            marginLeftMm: 21,
          },
          shortcuts: {
            ...initialSettings.shortcuts,
            "check-problems": "Ctrl+Alt+K",
            "open-custom-dual-view-1": "Ctrl+Alt+1",
          },
          customDualViewPresets: [{ leftBookKind: "claims", rightBookKind: "description" }],
          aiCorrection: {
            ...initialSettings.aiCorrection,
            enabled: false,
            activeProfileId: customAiProfileId,
            profiles: [
              ...initialSettings.aiCorrection.profiles,
              {
                profileId: customAiProfileId,
                providerId: "custom",
                displayName: "虚构电脑A私有模型",
                baseUrl: "https://fictional.invalid/v1",
                model: "fictional-local-model",
              },
            ],
            deepseekThinkingEnabled: false,
            timeoutMs: 45_000,
            maxUploadCharacters: 42_000,
          },
        }),
        "settings.update",
      );
      unwrap(
        await api.aiCorrection.setApiKey({
          profileId: customAiProfileId,
          apiKey: "虚构-API-密钥-仅用于自动化",
        }),
        "aiCorrection.setApiKey",
      );

      const opened = unwrap(
        await api.patents.create({
          patentType: "invention",
          name: completePatentName,
          customer: "虚构委托方",
        }),
        "patents.create.complete",
      );
      let patent = opened.patent;
      const flowchart = unwrap(
        await api.flowcharts.create({
          patentId: opened.patentId,
          expectedPatentRevision: patent.revision,
          name: "虚构闭环流程工程",
          source: new TextEncoder().encode(
            '<mxfile><diagram id="page-1"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>',
          ),
          pageCount: 1,
          lastPageId: "page-1",
        }),
        "flowcharts.create",
      );
      patent = { ...patent, revision: flowchart.patentRevision };

      const image = unwrap(
        await api.assets.importBytes({
          sessionId: opened.sessionId,
          originalName: "虚构装置附图.png",
          declaredMediaType: "image/png",
          bytes: Uint8Array.from(imageBytes),
        }),
        "assets.importBytes.patent",
      );
      const chemical = unwrap(
        await api.chemistry.rasterizePreview({
          sessionId: opened.sessionId,
          svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><path d="M10 40h100" stroke="#111"/><circle cx="35" cy="40" r="8" fill="none" stroke="#111"/></svg>',
        }),
        "chemistry.rasterizePreview",
      );
      const descriptionBook = patent.books.find((book) => book.kind === "description");
      const claimsBook = patent.books.find((book) => book.kind === "claims");
      if (!descriptionBook || !claimsBook) throw new Error("patent books fixture missing");
      const richDescription = {
        ...descriptionBook.document,
        content: [
          paragraph("虚构迁移装置包括传感部1和控制部2。"),
          {
            id: id(),
            type: "paragraph" as const,
            attrs: paragraphAttributes,
            content: [
              { type: "text" as const, text: "质量关系", marks: [{ type: "bold" as const }] },
              { type: "inline-formula" as const, source: "m=ρV", formulaKind: "math" as const },
            ],
          },
          {
            id: id(),
            type: "block-formula" as const,
            source: "E=mc^2",
            formulaKind: "math" as const,
          },
          {
            id: id(),
            type: "block-formula" as const,
            source: String.raw`\ce{2H2 + O2 -> 2H2O}`,
            formulaKind: "chemistry" as const,
          },
          {
            id: id(),
            type: "chemical-structure" as const,
            ketSource: '{"root":{"nodes":[{"$ref":"mol0"}]},"mol0":{"type":"molecule"}}',
            editorMode: "molecule" as const,
            previewAssetId: chemical.descriptor.assetId,
            widthMm: 72,
            alignment: "center" as const,
          },
          {
            id: id(),
            type: "table" as const,
            columnWidthsMm: [40, 40],
            headerRowCount: 1 as const,
            layoutMode: "fixed" as const,
            rows: [
              {
                id: id(),
                cells: [
                  {
                    id: id(),
                    rowSpan: 1,
                    colSpan: 1,
                    horizontalAlignment: "center" as const,
                    verticalAlignment: "middle" as const,
                    borderStyle: "single" as const,
                    content: [paragraph("阶段")],
                  },
                  {
                    id: id(),
                    rowSpan: 1,
                    colSpan: 1,
                    horizontalAlignment: "center" as const,
                    verticalAlignment: "middle" as const,
                    borderStyle: "single" as const,
                    content: [paragraph("结果")],
                  },
                ],
              },
            ],
          },
          {
            id: id(),
            type: "figure" as const,
            assetId: image.descriptor.assetId,
            widthMm: 68,
            alignment: "center" as const,
          },
        ],
      };
      const bookEdit = unwrap(
        await api.patents.applyBookEdit({
          patentId: opened.patentId,
          sessionId: opened.sessionId,
          bookKind: "description",
          expectedRevision: patent.revision,
          document: richDescription,
          editorState: { selection: { anchor: 1, head: 1 } },
          assets: [image.descriptor, chemical.descriptor],
        }),
        "patents.applyBookEdit.description",
      );
      const figureId = id();
      const descriptionWithFigureRelation = {
        ...richDescription,
        content: [
          ...richDescription.content,
          {
            ...paragraph("图1为虚构装置的隔离结构示意图。"),
            semanticRole: "description-drawing-explanation" as const,
            figureId,
          },
          paragraph("其中：1、传感部；2、控制部。"),
        ],
      };
      const descriptionRelationEdit = unwrap(
        await api.patents.applyBookEdit({
          patentId: opened.patentId,
          sessionId: opened.sessionId,
          bookKind: "description",
          expectedRevision: bookEdit.revision,
          document: descriptionWithFigureRelation,
          editorState: { unlinkedFigureExplanations: [], selection: { anchor: 2 } },
          assets: [image.descriptor, chemical.descriptor],
        }),
        "patents.applyBookEdit.descriptionFigureRelation",
      );
      const figureEdit = unwrap(
        await api.patents.applyFigureEdit({
          patentId: opened.patentId,
          sessionId: opened.sessionId,
          expectedRevision: descriptionRelationEdit.revision,
          figures: [{ figureId, assetId: image.descriptor.assetId, widthMm: 80 }],
          abstractDrawingFigureId: figureId,
          assets: [image.descriptor, chemical.descriptor],
        }),
        "patents.applyFigureEdit",
      );
      const references = unwrap(
        await api.patents.updateSettings({
          patentId: opened.patentId,
          expectedRevision: figureEdit.revision,
          name: completePatentName,
          customer: "虚构委托方",
          patentType: "invention",
          referenceMarks: [
            { referenceMarkId: id(), number: 1, keyword: "传感部" },
            { referenceMarkId: id(), number: 2, keyword: "控制部" },
          ],
          referenceMarkSettings: { synchronizedEditingEnabled: true },
        }),
        "patents.updateSettings.references",
      );
      unwrap(
        await api.snapshot.create({
          documentType: "patent",
          documentId: opened.patentId,
          source: "manual-create",
        }),
        "snapshot.create.first",
      );
      const claimEdit = unwrap(
        await api.patents.applyBookEdit({
          patentId: opened.patentId,
          sessionId: opened.sessionId,
          bookKind: "claims",
          expectedRevision: references.revision,
          document: { ...claimsBook.document, content: [paragraph(transferredClaimText)] },
          editorState: { selection: { anchor: 3, head: 3 } },
          assets: [image.descriptor, chemical.descriptor],
        }),
        "patents.applyBookEdit.claims",
      );
      unwrap(
        await api.snapshot.create({
          documentType: "patent",
          documentId: opened.patentId,
          source: "manual-create",
        }),
        "snapshot.create.second",
      );
      unwrap(
        await api.patents.flush({
          patentId: opened.patentId,
          expectedRevision: claimEdit.revision,
        }),
        "patents.flush.complete",
      );
      const exportedDraft = unwrap(
        await api.patents.exportPatdoc({
          patentId: opened.patentId,
          expectedRevision: claimEdit.revision,
        }),
        "patents.exportPatdoc.legacyDraft",
      );
      if (!exportedDraft) throw new Error("legacy draft PATDOC export cancelled");
      unwrap(await api.patents.release(opened.sessionId), "patents.release.complete");

      const noDrawings = unwrap(
        await api.patents.create({
          patentType: "invention",
          name: "虚构无附图书方法",
          customer: null,
        }),
        "patents.create.noDrawings",
      );
      unwrap(
        await api.patents.setDrawingBooksEnabled({
          patentId: noDrawings.patentId,
          sessionId: noDrawings.sessionId,
          expectedRevision: noDrawings.revision,
          enabled: false,
        }),
        "patents.setDrawingBooksEnabled",
      );
      unwrap(await api.patents.release(noDrawings.sessionId), "patents.release.noDrawings");

      const utility = unwrap(
        await api.patents.create({
          patentType: "utility-model",
          name: "虚构实用新型夹具",
          customer: "虚构委托方乙",
        }),
        "patents.create.utility",
      );
      unwrap(await api.patents.release(utility.sessionId), "patents.release.utility");

      const trashed = unwrap(
        await api.patents.create({
          patentType: "invention",
          name: "虚构回收站专利",
          customer: null,
        }),
        "patents.create.trash",
      );
      unwrap(await api.patents.release(trashed.sessionId), "patents.release.trash");
      unwrap(await api.patents.moveToTrash(trashed.patentId), "patents.moveToTrash");

      const document = unwrap(await api.library.create(), "library.create.active");
      const documentImage = unwrap(
        await api.assets.importBytes({
          sessionId: document.sessionId,
          originalName: "虚构普通文档插图.png",
          declaredMediaType: "image/png",
          bytes: Uint8Array.from(imageBytes),
        }),
        "assets.importBytes.document",
      );
      const initialBlock = document.document.content[0];
      const textBlock = initialBlock?.type === "paragraph" ? { ...initialBlock } : paragraph("");
      textBlock.content = [{ type: "text", text: "虚构普通文档修订内容", marks: [] }];
      const documentFigure = {
        id: id(),
        type: "figure" as const,
        assetId: documentImage.descriptor.assetId,
        widthMm: 55,
        alignment: "left" as const,
      };
      const editedDocument = {
        ...document.document,
        title: "虚构普通文档",
        content: [textBlock, documentFigure],
        assets: [documentImage.descriptor],
      };
      unwrap(
        await api.library.applyEdit({
          libraryDocumentId: document.libraryDocumentId,
          sessionId: document.sessionId,
          operationId: id(),
          baseRevision: document.revision,
          targetRevision: document.revision + 1,
          modelVersion: 1,
          operations: [
            { type: "set-title", title: editedDocument.title },
            { type: "put-block", index: 0, block: textBlock },
            { type: "put-block", index: 1, block: documentFigure },
            { type: "set-assets", assets: editedDocument.assets },
          ],
          editorState: { selection: { anchor: 4, head: 4 } },
        }),
        "library.applyEdit.active",
      );
      unwrap(await api.library.release(document.sessionId), "library.release.active");

      const trashedDocument = unwrap(await api.library.create(), "library.create.trash");
      const trashInitialBlock = trashedDocument.document.content[0];
      const trashBlock =
        trashInitialBlock?.type === "paragraph" ? { ...trashInitialBlock } : paragraph("");
      trashBlock.content = [{ type: "text", text: "虚构回收站普通文档内容", marks: [] }];
      unwrap(
        await api.library.applyEdit({
          libraryDocumentId: trashedDocument.libraryDocumentId,
          sessionId: trashedDocument.sessionId,
          operationId: id(),
          baseRevision: trashedDocument.revision,
          targetRevision: trashedDocument.revision + 1,
          modelVersion: 1,
          operations: [
            { type: "set-title", title: "虚构回收站普通文档" },
            { type: "put-block", index: 0, block: trashBlock },
          ],
          editorState: {},
        }),
        "library.applyEdit.trash",
      );
      unwrap(await api.library.release(trashedDocument.sessionId), "library.release.trash");
      unwrap(
        await api.library.moveToTrash(trashedDocument.libraryDocumentId),
        "library.moveToTrash",
      );
      return { draftId: opened.patentId };
    },
    {
      imageBytes: [...pngBytes],
      completePatentName: COMPLETE_LIBRARY_PATENT_NAME,
      transferredClaimText: TRANSFERRED_CLAIM_TEXT,
    },
  );
  const draftFileName = "20260817-000000.patdoc";
  const draftDirectory = join(options.legacyDraftRoot, draft.draftId);
  await mkdir(draftDirectory, { recursive: true });
  await rename(options.legacyDraftPatdocPath, join(draftDirectory, draftFileName));
  await writeFile(
    join(draftDirectory, "draft.json"),
    `${JSON.stringify(
      {
        draftId: draft.draftId,
        documentId: draft.draftId,
        displayName: "虚构健康历史草稿.patdoc",
        originalPath: "D:\\虚构历史来源\\健康草稿.patdoc",
        savedAt: "2026-08-17T00:00:00.000Z",
        fileName: draftFileName,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function collectTransferredLibrarySemantics(
  page: Page,
): Promise<TransferredLibrarySemantics> {
  return await page.evaluate(async () => {
    const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
    const unwrap = <T>(
      result: { ok: true; value: T } | { ok: false; error: { code: string } },
      operation: string,
    ): T => {
      if (!result.ok) throw new Error(`${operation} failed: ${result.error.code}`);
      return result.value;
    };
    const collectPatent = async (summary: { patentId: string }) => {
      const opened = unwrap(await api.patents.open(summary.patentId), "patents.open.collect");
      try {
        const flowcharts = [];
        for (const project of opened.patent.flowchartProjects) {
          const source = unwrap(
            await api.flowcharts.exportBackup({
              patentId: opened.patentId,
              projectId: project.projectId,
            }),
            "flowcharts.exportBackup.collect",
          );
          flowcharts.push({ project, sourceBytes: [...source] });
        }

        const assets = [];
        for (const descriptor of opened.patent.assets) {
          const preview = unwrap(
            await api.assets.getPreview(opened.sessionId, descriptor.assetId),
            "assets.getPreview.patent.collect",
          );
          assets.push({ descriptor, loadedPreviewBytes: [...preview] });
        }
        return { summary, patent: opened.patent, flowcharts, assets };
      } finally {
        unwrap(await api.patents.release(opened.sessionId), "patents.release.collect");
      }
    };

    const collectDocument = async (summary: { libraryDocumentId: string }) => {
      const opened = unwrap(
        await api.library.open(summary.libraryDocumentId),
        "library.open.collect",
      );
      try {
        const assets = [];
        for (const descriptor of opened.document.assets) {
          const preview = unwrap(
            await api.assets.getPreview(opened.sessionId, descriptor.assetId),
            "assets.getPreview.document.collect",
          );
          assets.push({ descriptor, loadedPreviewBytes: [...preview] });
        }
        return {
          summary,
          revision: opened.revision,
          document: opened.document,
          editorState: opened.editorState,
          assets,
        };
      } finally {
        unwrap(await api.library.release(opened.sessionId), "library.release.collect");
      }
    };

    const activePatentSummaries = unwrap(await api.patents.list("active"), "patents.list.active");
    const trashPatentSummaries = unwrap(await api.patents.list("trash"), "patents.list.trash");
    const activePatents = [];
    for (const summary of activePatentSummaries) activePatents.push(await collectPatent(summary));

    const activeDocumentSummaries = unwrap(await api.library.list("active"), "library.list.active");
    const trashDocumentSummaries = unwrap(await api.library.list("trash"), "library.list.trash");
    const activeDocuments = [];
    for (const summary of activeDocumentSummaries)
      activeDocuments.push(await collectDocument(summary));

    const portableTrashSummary = <T extends { deletedAt: string | null; modifiedAt: string }>(
      summary: T,
    ) => {
      if (summary.deletedAt === null) throw new Error("trash summary has no deletion time");
      // Recovery may rebuild a trash row's general display timestamp from its
      // canonical payload. The deletion timestamp is the portable trash contract.
      const { modifiedAt: _recoveryDerivedModifiedAt, ...portable } = summary;
      return portable;
    };

    const draftSummaries = unwrap(await api.drafts.list(), "drafts.list");
    const drafts = [];
    for (const summary of draftSummaries) {
      const opened = unwrap(await api.drafts.open(summary.draftId), "drafts.open.collect");
      try {
        const assets = [];
        for (const descriptor of opened.document.assets) {
          const preview = unwrap(
            await api.assets.getPreview(opened.sessionId, descriptor.assetId),
            "assets.getPreview.draft.collect",
          );
          assets.push({ descriptor, loadedPreviewBytes: [...preview] });
        }
        drafts.push({
          summary: { ...summary, originalPath: null },
          document: opened.document,
          editorState: opened.editorState,
          assets,
        });
      } finally {
        unwrap(await api.documents.release(opened.sessionId), "documents.release.draft.collect");
      }
    }

    const snapshots = unwrap(await api.snapshot.list(), "snapshot.list");
    const settings = unwrap(await api.settings.read(), "settings.read.collect");
    const aiSettings = unwrap(await api.aiCorrection.getSettings(), "aiCorrection.getSettings");
    const portableAiProfiles = settings.aiCorrection.profiles.filter(
      (profile) => profile.providerId !== "custom",
    );
    const portableSettings = {
      referenceMarkSyncIntroDismissed: settings.referenceMarkSyncIntroDismissed,
      printPreferences: {
        duplexMode: settings.printPreferences.duplexMode,
        color: settings.printPreferences.color,
        orientation: settings.printPreferences.orientation,
        paperSize: settings.printPreferences.paperSize,
      },
      patentTemplates: settings.patentTemplates,
      snapshot: settings.snapshot,
      pageMargins: settings.pageMargins,
      shortcuts: settings.shortcuts,
      customDualViewPresets: settings.customDualViewPresets,
      backupIntervalMinutes: settings.backup.intervalMinutes,
      aiCorrection: {
        activeProfileId: portableAiProfiles.some(
          (profile) => profile.profileId === settings.aiCorrection.activeProfileId,
        )
          ? settings.aiCorrection.activeProfileId
          : null,
        profiles: portableAiProfiles,
        deepseekThinkingEnabled: settings.aiCorrection.deepseekThinkingEnabled,
        timeoutMs: settings.aiCorrection.timeoutMs,
        maxUploadCharacters: settings.aiCorrection.maxUploadCharacters,
      },
    };
    const machineSettings: MachineSettings = {
      zoomPercent: settings.zoomPercent,
      recentDirectory: settings.recentDirectory,
      windowBounds: settings.windowBounds,
      welcomeCompleted: settings.welcomeCompleted,
      printerDeviceName: settings.printPreferences.printerDeviceName,
      backupEnabled: settings.backup.enabled,
      backupFolder: settings.backup.folder,
      aiEnabled: settings.aiCorrection.enabled,
      customAiProfileIds: settings.aiCorrection.profiles
        .filter((profile) => profile.providerId === "custom")
        .map((profile) => profile.profileId)
        .sort(),
      credentialProfileIds: [...aiSettings.credentialProfileIds].sort(),
    };

    return {
      library: {
        activePatents: activePatents.sort((left, right) =>
          left.summary.patentId.localeCompare(right.summary.patentId),
        ),
        trashPatents: trashPatentSummaries
          .map(portableTrashSummary)
          .sort((left, right) => left.patentId.localeCompare(right.patentId)),
        activeDocuments: activeDocuments.sort((left, right) =>
          left.summary.libraryDocumentId.localeCompare(right.summary.libraryDocumentId),
        ),
        trashDocuments: trashDocumentSummaries
          .map(portableTrashSummary)
          .sort((left, right) => left.libraryDocumentId.localeCompare(right.libraryDocumentId)),
        drafts: drafts.sort((left, right) =>
          left.summary.draftId.localeCompare(right.summary.draftId),
        ),
        snapshots,
      },
      portableSettings,
      machineSettings,
    } satisfies TransferredLibrarySemantics;
  });
}

export async function collectMachineSettings(page: Page): Promise<MachineSettings> {
  return await page.evaluate(async () => {
    const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
    const read = await api.settings.read();
    if (!read.ok) throw new Error(`settings.read target failed: ${read.error.code}`);
    const ai = await api.aiCorrection.getSettings();
    if (!ai.ok) throw new Error(`aiCorrection.getSettings target failed: ${ai.error.code}`);
    return {
      zoomPercent: read.value.zoomPercent,
      recentDirectory: read.value.recentDirectory,
      windowBounds: read.value.windowBounds,
      welcomeCompleted: read.value.welcomeCompleted,
      printerDeviceName: read.value.printPreferences.printerDeviceName,
      backupEnabled: read.value.backup.enabled,
      backupFolder: read.value.backup.folder,
      aiEnabled: read.value.aiCorrection.enabled,
      customAiProfileIds: read.value.aiCorrection.profiles
        .filter((profile) => profile.providerId === "custom")
        .map((profile) => profile.profileId)
        .sort(),
      credentialProfileIds: [...ai.value.credentialProfileIds].sort(),
    } satisfies MachineSettings;
  });
}

export async function editTransferredClaim(
  page: Page,
): Promise<{ patentId: string; revision: number }> {
  return await page.evaluate(
    async ({ patentName }) => {
      const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
      const listed = await api.patents.list("active");
      if (!listed.ok) throw new Error(`patents.list edit failed: ${listed.error.code}`);
      const summary = listed.value.find((item) => item.name === patentName);
      if (!summary) throw new Error("transferred patent missing");
      const opened = await api.patents.open(summary.patentId);
      if (!opened.ok) throw new Error(`patents.open edit failed: ${opened.error.code}`);
      const claims = opened.value.patent.books.find((book) => book.kind === "claims");
      if (!claims) throw new Error("claims book missing");
      const first = claims.document.content[0];
      if (first?.type !== "paragraph") throw new Error("claims paragraph missing");
      const editedText = `${first.content
        .map((node) => (node.type === "text" ? node.text : ""))
        .join("")} 保存后追加虚构校验特征。`;
      const saved = await api.patents.applyBookEdit({
        patentId: opened.value.patentId,
        sessionId: opened.value.sessionId,
        bookKind: "claims",
        expectedRevision: opened.value.revision,
        document: {
          ...claims.document,
          content: [
            {
              ...first,
              content: [{ type: "text", text: editedText, marks: [] }],
            },
          ],
        },
        editorState: { selection: { anchor: editedText.length, head: editedText.length } },
        assets: opened.value.patent.assets,
      });
      if (!saved.ok) throw new Error(`patents.applyBookEdit edit failed: ${saved.error.code}`);
      const flushed = await api.patents.flush({
        patentId: opened.value.patentId,
        expectedRevision: saved.value.revision,
      });
      if (!flushed.ok) throw new Error(`patents.flush edit failed: ${flushed.error.code}`);
      const released = await api.patents.release(opened.value.sessionId);
      if (!released.ok) throw new Error(`patents.release edit failed: ${released.error.code}`);
      return { patentId: opened.value.patentId, revision: saved.value.revision };
    },
    { patentName: COMPLETE_LIBRARY_PATENT_NAME },
  );
}
