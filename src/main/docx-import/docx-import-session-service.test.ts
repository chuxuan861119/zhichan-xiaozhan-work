import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, Packer, Paragraph } from "docx";
import { describe, expect, it, vi } from "vitest";
import { type CanonicalPatent, CanonicalPatentSchema } from "../../shared/patent/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import type { OpenedPatent } from "../library/patent-service.js";
import { DocxImportSessionError, DocxImportSessionService } from "./docx-import-session-service.js";
import type { DocxPackage } from "./docx-package-reader.js";
import type { ParsedWordDocument } from "./wordprocessingml-parser.js";

const SOURCE_PATH = join(tmpdir(), "imports", "claims.docx");
const SESSION_ID = "00000000-0000-4000-8000-000000000901";
const UNIT_ID = "00000000-0000-4000-8000-000000000902";
const PATENT_ID = "00000000-0000-4000-8000-000000000903";

function parsed(text = "权利要求书"): ParsedWordDocument {
  return {
    warnings: [],
    blocks: [
      {
        type: "paragraph",
        headingLevel: 1,
        alignment: "left",
        firstLineIndentMm: null,
        lineSpacing: null,
        list: null,
        inlines: [{ type: "text", text, style: {} }],
      },
    ],
  };
}

function pkg(): DocxPackage {
  return {
    sourceFileName: "claims.docx",
    parts: new Map(),
    findings: [],
    externalRelationships: [],
  };
}

function imageParagraph(
  relationshipId: string,
  partName: string,
): ParsedWordDocument["blocks"][number] {
  return {
    type: "paragraph",
    headingLevel: null,
    alignment: "center",
    firstLineIndentMm: null,
    lineSpacing: null,
    list: null,
    inlines: [
      {
        type: "image",
        relationshipId,
        partName,
        widthEmu: null,
        heightEmu: null,
      },
    ],
  };
}

function storedImage(byte: number) {
  const assetId = `00000000-0000-4000-8000-${(950 + byte).toString(16).padStart(12, "0")}`;
  return {
    descriptor: {
      assetId,
      kind: "image" as const,
      originalName: `image-${byte}.png`,
      mediaType: "image/png" as const,
      extension: "png" as const,
      byteLength: 1,
      sha256: byte.toString(16).toUpperCase().padStart(64, "0"),
      widthPx: 1,
      heightPx: 1,
      previewByteLength: 1,
      previewSha256: (byte + 100).toString(16).toUpperCase().padStart(64, "0"),
    },
    original: Uint8Array.from([byte]),
    preview: Uint8Array.from([137, 80, 78, 71, byte]),
  };
}

function drawingImportHarness(abstractByte: number, abstractVisualByte = abstractByte) {
  const descriptionBlocks = [
    imageParagraph("rDescription1", "word/media/description-1.png"),
    imageParagraph("rDescription2", "word/media/description-2.png"),
  ];
  const abstractBlocks = [imageParagraph("rAbstract", "word/media/abstract.png")];
  const createImported = vi.fn(async ({ patent }: { patent: CanonicalPatent }) => {
    const validated = CanonicalPatentSchema.parse(patent);
    return {
      patentId: validated.patentId,
      sessionId: crypto.randomUUID(),
      revision: 0,
      patent: validated,
      saveState: "saved" as const,
    };
  });
  const readPreview = vi.fn(async (assetId: string) => {
    const descriptorByte = assetId === storedImage(1).descriptor.assetId ? 1 : 2;
    return storedImage(descriptorByte).preview;
  });
  const service = new DocxImportSessionService({
    dialog: {
      showOpenDialog: vi.fn(async () => ({
        canceled: false,
        filePaths: [
          join(tmpdir(), "imports", "说明书附图.docx"),
          join(tmpdir(), "imports", "摘要附图.docx"),
        ],
      })),
    },
    readPackage: vi.fn(async (path) =>
      path.includes("摘要附图")
        ? {
            sourceFileName: "摘要附图.docx",
            parts: new Map([["word/media/abstract.png", Uint8Array.from([abstractByte])]]),
            findings: [],
            externalRelationships: [],
          }
        : {
            sourceFileName: "说明书附图.docx",
            parts: new Map([
              ["word/media/description-1.png", Uint8Array.from([1])],
              ["word/media/description-2.png", Uint8Array.from([2])],
            ]),
            findings: [],
            externalRelationships: [],
          },
    ),
    parseDocument: vi.fn(async (docxPackage) => ({
      blocks: docxPackage.sourceFileName === "摘要附图.docx" ? abstractBlocks : descriptionBlocks,
      warnings: [],
    })),
    classify: vi.fn(() => ({
      conflicts: [],
      units: [
        {
          unitId: "00000000-0000-4000-8000-000000000961",
          sourceFileName: "说明书附图.docx",
          title: "说明书附图",
          blocks: descriptionBlocks,
          suggestedTarget: {
            kind: "official-book" as const,
            bookKind: "description-drawings" as const,
          },
          confidence: "high" as const,
          evidence: ["说明书附图"],
        },
        {
          unitId: "00000000-0000-4000-8000-000000000962",
          sourceFileName: "摘要附图.docx",
          title: "摘要附图（待选择）",
          blocks: abstractBlocks,
          suggestedTarget: {
            kind: "official-book" as const,
            bookKind: "abstract-drawing" as const,
          },
          recognizedBookKind: "abstract-drawing" as const,
          confidence: "high" as const,
          evidence: ["摘要附图"],
        },
      ],
    })),
    importImage: vi.fn(async ({ bytes }) => storedImage(bytes[0] ?? 0)),
    createImageSignature: vi.fn(async (bytes) =>
      Uint8Array.from(
        { length: 64 * 64 },
        () => (bytes.at(-1) === abstractByte ? abstractVisualByte : (bytes.at(-1) ?? 0)) * 20,
      ),
    ),
    assetStore: {
      stageMany: vi.fn(async (_sessionId, assets: StoredAsset[]) =>
        assets.map((asset) => ({ descriptor: asset.descriptor })),
      ),
      commitStaged: vi.fn(async () => undefined),
      discardStaged: vi.fn(async () => undefined),
      readPreview,
    },
    patents: { createImported },
  });
  return { service, createImported, readPreview };
}

function harness(
  overrides: {
    now?: () => number;
    warning?: boolean;
    silentDefaults?: boolean;
    initialImportDirectory?: string;
    sourcePath?: string;
  } = {},
) {
  const createImported = vi.fn(
    async ({
      patent,
    }: {
      patent: CanonicalPatent;
      operationId: string;
    }): Promise<OpenedPatent> => ({
      patentId: patent.patentId,
      sessionId: "00000000-0000-4000-8000-000000000904",
      revision: 0,
      patent,
      saveState: "saved" as const,
    }),
  );
  const discardStaged = vi.fn(async () => undefined);
  const commitStaged = vi.fn(async () => undefined);
  const service = new DocxImportSessionService({
    dialog: {
      showOpenDialog: vi.fn(async () => ({
        canceled: false,
        filePaths: [overrides.sourcePath ?? SOURCE_PATH],
      })),
    },
    readPackage: vi.fn(async () => ({
      ...pkg(),
      externalRelationships: overrides.silentDefaults
        ? [
            {
              sourcePart: "word/document.xml",
              relationshipId: "rIdExternal",
              target: "https://example.com/reference",
            },
          ]
        : [],
    })),
    parseDocument: vi.fn(async () => ({
      ...parsed(),
      warnings: overrides.silentDefaults
        ? [
            {
              code: "SIMPLIFIED_PARAGRAPH_SPACING" as const,
              message: "固定值或最小值行距暂不支持，已使用默认行距。",
            },
          ]
        : overrides.warning
          ? [{ code: "UNSUPPORTED_SMARTART" as const, message: "SmartArt 无法转换" }]
          : [],
    })),
    classify: vi.fn(() => ({
      conflicts: [],
      units: [
        {
          unitId: UNIT_ID,
          sourceFileName: "claims.docx",
          title: "权利要求书",
          blocks: parsed().blocks,
          suggestedTarget: { kind: "official-book" as const, bookKind: "claims" as const },
          confidence: "high" as const,
          evidence: ["标题"],
        },
      ],
    })),
    assetStore: {
      stageMany: vi.fn(async () => []),
      commitStaged,
      discardStaged,
    },
    patents: { createImported },
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.initialImportDirectory
      ? { initialImportDirectory: overrides.initialImportDirectory }
      : {}),
    randomUUID: vi
      .fn()
      .mockReturnValueOnce(SESSION_ID)
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000905")
      .mockReturnValue(PATENT_ID),
  });
  return { service, createImported, commitStaged, discardStaged };
}

describe("DocxImportSessionService", () => {
  it("rejects the retired append mode without creating a patent", async () => {
    const { service, createImported } = harness();
    await expect(
      service.prepare("window-a", { appendTo: { patentId: PATENT_ID, sessionId: UNIT_ID } }),
    ).rejects.toMatchObject({ code: "SESSION_FORBIDDEN" });
    expect(createImported).not.toHaveBeenCalled();
  });

  it("prepares a real local DOCX package with the production reader and parser", async () => {
    const directory = await mkdtemp(join(tmpdir(), "docx-import-session-real-"));
    try {
      const sourcePath = join(directory, "实验材料.docx");
      const bytes = await Packer.toBuffer(
        new Document({ sections: [{ children: [new Paragraph({ text: "实验材料正文" })] }] }),
      );
      await writeFile(sourcePath, bytes);
      const service = new DocxImportSessionService({
        dialog: {
          showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [sourcePath] })),
        },
        assetStore: {
          stageMany: vi.fn(async () => []),
          commitStaged: vi.fn(async () => undefined),
          discardStaged: vi.fn(async () => undefined),
        },
        patents: { createImported: vi.fn() },
      });

      await expect(service.prepare("renderer-1")).rejects.toMatchObject({
        code: "UNRECOGNIZED_DOCUMENT",
        message: expect.stringContaining("实验材料.docx"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("opens a multi-select DOCX dialog and prepares a path-free preview", async () => {
    const { service } = harness();
    const preview = await service.prepare("renderer-1");

    expect(preview).toMatchObject({
      sessionId: SESSION_ID,
      sourceFileNames: ["claims.docx"],
      units: [
        {
          unitId: UNIT_ID,
          sourceFileName: "claims.docx",
          target: { kind: "official-book", bookKind: "claims" },
        },
      ],
    });
    expect(JSON.stringify(preview)).not.toContain(tmpdir());
  });

  it("opens first in Documents and remembers the last successfully selected folder", async () => {
    const { service } = harness({ initialImportDirectory: join(tmpdir(), "Documents") });
    vi.mocked(service.dialog.showOpenDialog)
      .mockResolvedValueOnce({
        canceled: false,
        filePaths: [join(tmpdir(), "案件", "权利要求书.docx")],
      })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await service.prepare("renderer-1");
    await service.prepare("renderer-1");

    expect(service.dialog.showOpenDialog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ defaultPath: join(tmpdir(), "Documents") }),
    );
    expect(service.dialog.showOpenDialog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ defaultPath: join(tmpdir(), "案件") }),
    );
  });

  it("returns null when file selection is cancelled", async () => {
    const { service } = harness();
    vi.mocked(service.dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });
    await expect(service.prepare("renderer-1")).resolves.toBeNull();
  });

  it("enforces renderer ownership for update, commit and cancel", async () => {
    const { service } = harness();
    await service.prepare("renderer-1");
    await expect(
      service.update("renderer-2", {
        sessionId: SESSION_ID,
        unitId: UNIT_ID,
        title: "权利要求书",
        target: { kind: "official-book", bookKind: "claims" },
      }),
    ).rejects.toBeInstanceOf(DocxImportSessionError);
    await expect(service.cancel("renderer-2", { sessionId: SESSION_ID })).rejects.toMatchObject({
      code: "SESSION_FORBIDDEN",
    });
  });

  it("serves only owned staged images to the DOCX preview", async () => {
    const { service, readPreview } = drawingImportHarness(2);
    const preview = await service.prepare("renderer-1");
    if (!preview) throw new Error("preview expected");
    const figure = preview.units
      .flatMap((unit) => unit.document.content)
      .find((block) => block.type === "figure");
    if (figure?.type !== "figure") throw new Error("preview figure expected");

    await expect(
      service.previewAsset("renderer-1", preview.sessionId, figure.assetId),
    ).resolves.toEqual(Uint8Array.from([137, 80, 78, 71, 1]));
    await expect(
      service.previewAsset("renderer-2", preview.sessionId, figure.assetId),
    ).rejects.toMatchObject({ code: "SESSION_FORBIDDEN" });
    expect(readPreview).toHaveBeenCalledWith(figure.assetId);
  });

  it("blocks duplicate official targets and unacknowledged important warnings", async () => {
    const { service, createImported } = harness({
      warning: true,
      sourcePath: "/imports/claims.docx",
    });
    const preview = await service.prepare("renderer-1");
    if (!preview) throw new Error("preview expected");
    const assignment = {
      unitId: UNIT_ID,
      title: "权利要求书",
      target: { kind: "official-book" as const, bookKind: "claims" as const },
    };
    await expect(
      service.commit("renderer-1", {
        sessionId: SESSION_ID,
        patentType: "invention",
        name: "导入专利",
        customer: null,
        assignments: [assignment],
        acknowledgedWarningIds: [],
      }),
    ).rejects.toMatchObject({ code: "WARNINGS_UNACKNOWLEDGED" });
    expect(createImported).not.toHaveBeenCalled();

    await expect(
      service.commit("renderer-1", {
        sessionId: SESSION_ID,
        patentType: "invention",
        name: "导入专利",
        customer: null,
        assignments: [assignment, { ...assignment, unitId: crypto.randomUUID() }],
        acknowledgedWarningIds: preview.warnings.map((warning) => warning.warningId),
      }),
    ).rejects.toMatchObject({ code: "UNRECOGNIZED_DOCUMENT" });
  });

  it("silently applies safe defaults without blocking import", async () => {
    const { service, createImported } = harness({
      silentDefaults: true,
      sourcePath: "/imports/claims.docx",
    });
    const preview = await service.prepare("renderer-1");
    if (!preview) throw new Error("preview expected");

    expect(preview.warnings).toEqual([]);
    await service.commit("renderer-1", {
      sessionId: SESSION_ID,
      patentType: "invention",
      name: "导入专利",
      customer: null,
      assignments: [
        {
          unitId: UNIT_ID,
          title: "权利要求书",
          target: { kind: "official-book", bookKind: "claims" },
        },
      ],
      acknowledgedWarningIds: [],
    });

    const importedPatent = createImported.mock.calls[0]?.[0].patent;
    expect(importedPatent?.docxImportReport?.warnings.map((warning) => warning.code)).toEqual([
      "SIMPLIFIED_PARAGRAPH_SPACING",
      "EXTERNAL_RELATIONSHIP_IGNORED",
    ]);
  });

  it("commits one imported patent, invalidates the session and releases stages", async () => {
    const { service, createImported } = harness();
    await service.prepare("renderer-1");
    const opened = await service.commit("renderer-1", {
      sessionId: SESSION_ID,
      patentType: "utility-model",
      name: "导入专利",
      customer: "客户",
      assignments: [
        {
          unitId: UNIT_ID,
          title: "权利要求书",
          target: { kind: "official-book", bookKind: "claims" },
        },
      ],
      acknowledgedWarningIds: [],
    });

    expect(opened.patentId).toBeTruthy();
    expect(createImported).toHaveBeenCalledTimes(1);
    await expect(service.cancel("renderer-1", { sessionId: SESSION_ID })).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("keeps the preview session when patent creation fails so the user can retry", async () => {
    const { service, createImported, discardStaged } = harness();
    createImported.mockRejectedValueOnce(new Error("database temporarily unavailable"));
    await service.prepare("renderer-1");
    const request = {
      sessionId: SESSION_ID,
      patentType: "utility-model" as const,
      name: "可重试导入",
      customer: null,
      assignments: [
        {
          unitId: UNIT_ID,
          title: "权利要求书",
          target: { kind: "official-book" as const, bookKind: "claims" as const },
        },
      ],
      acknowledgedWarningIds: [],
    };

    await expect(service.commit("renderer-1", request)).rejects.toThrow(
      "database temporarily unavailable",
    );
    await expect(service.commit("renderer-1", request)).resolves.toMatchObject({
      patentId: PATENT_ID,
    });
    expect(createImported).toHaveBeenCalledTimes(2);
    expect(discardStaged).not.toHaveBeenCalled();
  });

  it("keeps the preview session when staged asset finalization fails so retry can recover", async () => {
    const { service, createImported, commitStaged, discardStaged } = harness();
    commitStaged.mockRejectedValueOnce(new Error("stage finalization interrupted"));
    await service.prepare("renderer-1");
    const request = {
      sessionId: SESSION_ID,
      patentType: "invention" as const,
      name: "图片提交重试",
      customer: null,
      assignments: [
        {
          unitId: UNIT_ID,
          title: "权利要求书",
          target: { kind: "official-book" as const, bookKind: "claims" as const },
        },
      ],
      acknowledgedWarningIds: [],
    };

    await expect(service.commit("renderer-1", request)).rejects.toThrow(
      "stage finalization interrupted",
    );
    await expect(service.commit("renderer-1", request)).resolves.toMatchObject({
      patentId: PATENT_ID,
    });
    expect(createImported).toHaveBeenCalledTimes(2);
    expect(commitStaged).toHaveBeenCalledTimes(2);
    expect(discardStaged).not.toHaveBeenCalled();
  });

  it("expires idle sessions and discards their staged assets", async () => {
    let now = 0;
    const { service, discardStaged } = harness({ now: () => now });
    await service.prepare("renderer-1");
    now = 31 * 60 * 1_000;
    service.expireIdleSessions();
    await expect(service.cancel("renderer-1", { sessionId: SESSION_ID })).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
    expect(discardStaged).toHaveBeenCalled();
  });

  it.each(["description", "description-drawings"] as const)(
    "preserves both occurrences of a reused image when committing %s with preview order",
    async (bookKind) => {
      const sharedAssetId = "00000000-0000-4000-8000-000000000920";
      const descriptor = {
        assetId: sharedAssetId,
        kind: "image" as const,
        originalName: "shared.png",
        mediaType: "image/png" as const,
        extension: "png" as const,
        byteLength: 3,
        sha256: "A".repeat(64),
        widthPx: 1,
        heightPx: 1,
        previewByteLength: 3,
        previewSha256: "B".repeat(64),
      };
      const imageBlocks: ParsedWordDocument["blocks"] = ["rIdShared", "rIdShared"].map(
        (relationshipId, index) => ({
          type: "paragraph" as const,
          headingLevel: null,
          alignment: "center" as const,
          firstLineIndentMm: null,
          lineSpacing: null,
          list: null,
          inlines: [
            {
              type: "image" as const,
              relationshipId,
              partName: "word/media/shared.png",
              widthEmu: (index === 0 ? 30 : 70) * 36000,
              heightEmu: null,
            },
          ],
        }),
      );
      const createImported = vi.fn(async ({ patent }: { patent: CanonicalPatent }) => {
        const validated = CanonicalPatentSchema.parse(patent);
        return {
          patentId: validated.patentId,
          sessionId: crypto.randomUUID(),
          revision: 0,
          patent: validated,
          saveState: "saved" as const,
        };
      });
      const service = new DocxImportSessionService({
        dialog: {
          showOpenDialog: vi.fn(async () => ({
            canceled: false,
            filePaths: [join(tmpdir(), "imports", "combined.docx")],
          })),
        },
        readPackage: vi.fn(async () => ({
          sourceFileName: "combined.docx",
          parts: new Map([["word/media/shared.png", Uint8Array.from([1, 2, 3])]]),
          findings: [],
          externalRelationships: [],
        })),
        parseDocument: vi.fn(async () => ({
          blocks: imageBlocks,
          warnings: [],
        })),
        classify: vi.fn(() => ({
          conflicts: [],
          units: [
            {
              unitId: crypto.randomUUID(),
              sourceFileName: "combined.docx",
              title: "说明书",
              blocks: imageBlocks,
              suggestedTarget: { kind: "official-book" as const, bookKind },
              confidence: "high" as const,
              evidence: ["测试分节"],
            },
          ],
        })),
        importImage: vi.fn(async () => ({
          descriptor: { ...descriptor, assetId: crypto.randomUUID() },
          original: Uint8Array.from([1, 2, 3]),
          preview: Uint8Array.from([1, 2, 3]),
        })),
        createImageSignature: vi.fn(async () => new Uint8Array(64 * 64)),
        assetStore: {
          stageMany: vi.fn(async (_sessionId, assets) => assets.map(() => ({ descriptor }))),
          commitStaged: vi.fn(async () => undefined),
          discardStaged: vi.fn(async () => undefined),
        },
        patents: { createImported },
      });

      const preview = await service.prepare("renderer-1");
      if (!preview) throw new Error("preview expected");
      const request = {
        sessionId: preview.sessionId,
        patentType: "invention" as const,
        name: "可往返五合一",
        customer: null,
        assignments: preview.units.map((unit) => ({
          unitId: unit.unitId,
          title: unit.title,
          target: unit.target,
          drawingOrder: unit.document.content.flatMap((block) =>
            block.type === "figure" ? [block.assetId] : [],
          ),
        })),
        acknowledgedWarningIds: [],
      };
      expect(request.assignments[0]?.drawingOrder).toEqual([sharedAssetId, sharedAssetId]);
      for (const drawingOrder of [
        [sharedAssetId],
        [sharedAssetId, sharedAssetId, sharedAssetId],
        [sharedAssetId, "00000000-0000-4000-8000-000000000999"],
      ]) {
        await expect(
          service.commit("renderer-1", {
            ...request,
            assignments: request.assignments.map((assignment) => ({
              ...assignment,
              drawingOrder,
            })),
          }),
        ).rejects.toMatchObject({ code: "ASSIGNMENTS_INCOMPLETE" });
      }
      expect(createImported).not.toHaveBeenCalled();
      await service.commit("renderer-1", request);

      const importedPatent = createImported.mock.calls[0]?.[0].patent;
      if (!importedPatent) throw new Error("imported patent expected");
      expect(importedPatent.assets).toEqual([descriptor]);
      const figures = importedPatent.books
        .find((book) => book.kind === bookKind)
        ?.document.content.filter((block) => block.type === "figure");
      expect(figures).toHaveLength(2);
      expect(new Set(figures?.map((figure) => figure.id)).size).toBe(2);
      if (bookKind === "description-drawings") {
        expect(importedPatent.figures.map((figure) => figure.widthMm)).toEqual([30, 70]);
        expect(importedPatent.figures.map((figure) => figure.assetId)).toEqual([
          sharedAssetId,
          sharedAssetId,
        ]);
      }
    },
  );

  it("auto-selects an abstract drawing only when it uniquely matches a specification figure", async () => {
    const { service, createImported } = drawingImportHarness(3, 2);
    const preview = await service.prepare("renderer-1");
    if (!preview) throw new Error("preview expected");
    await service.commit("renderer-1", {
      sessionId: preview.sessionId,
      patentType: "invention",
      name: "自动匹配摘要附图",
      customer: null,
      assignments: preview.units.map((unit) => ({
        unitId: unit.unitId,
        title: unit.title,
        target: unit.target,
      })),
      acknowledgedWarningIds: [],
    });

    const patent = createImported.mock.calls[0]?.[0].patent;
    if (!patent) throw new Error("imported patent expected");
    const selected = patent.figures.find(
      (figure) => figure.figureId === patent.abstractDrawingFigureId,
    );
    expect(selected?.assetId).toBe(storedImage(2).descriptor.assetId);
  });

  it("leaves the abstract drawing unselected when its image does not match", async () => {
    const { service, createImported } = drawingImportHarness(3);
    const preview = await service.prepare("renderer-1");
    if (!preview) throw new Error("preview expected");
    await service.commit("renderer-1", {
      sessionId: preview.sessionId,
      patentType: "invention",
      name: "不猜测摘要附图",
      customer: null,
      assignments: preview.units.map((unit) => ({
        unitId: unit.unitId,
        title: unit.title,
        target: unit.target,
      })),
      acknowledgedWarningIds: [],
    });

    const patent = createImported.mock.calls[0]?.[0].patent;
    expect(patent?.abstractDrawingFigureId).toBeNull();
  });
});
