import { basename, dirname } from "node:path";
import sharp from "sharp";
import { fitDocumentTables } from "../../shared/document/table-page-fit.js";
import type {
  DocxImportCancelRequest,
  DocxImportCommitRequest,
  DocxImportPrepareRequest,
  DocxImportPreview,
  DocxImportPreviewWarning,
  DocxImportTarget,
  DocxImportUpdateRequest,
} from "../../shared/ipc/contract.js";
import { createImportedPatent } from "../../shared/patent/defaults.js";
import {
  type AuxiliaryDocument,
  type CanonicalPatent,
  PATENT_BOOK_LABELS,
  type PatentBookKind,
} from "../../shared/patent/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { ImageImportError, importImage } from "../assets/image-importer.js";
import type { OpenedPatent } from "../library/patent-service.js";
import { convertParsedWordDocument, type ResolvedDocxImage } from "./docx-canonical-converter.js";
import {
  type ClassifiedDocxUnit,
  classifyDocxDocuments,
  type DocxClassificationResult,
} from "./docx-document-classifier.js";
import { extractDocxDrawings } from "./docx-drawing-extractor.js";
import { type DocxPackage, readDocxPackage } from "./docx-package-reader.js";
import {
  type ParsedWordDocument,
  parseWordprocessingDocument,
  type WordInline,
} from "./wordprocessingml-parser.js";

const SESSION_IDLE_TTL_MS = 30 * 60 * 1_000;
const MAX_ACTIVE_SESSIONS = 4;
const MAX_ACTIVE_BYTES = 512 * 1024 * 1024;
const IMAGE_SIGNATURE_SIZE = 64;
const IMAGE_SIGNATURE_MAX_MEAN_DIFFERENCE = 4;
const IMAGE_SIGNATURE_MAX_INK_DISAGREEMENT = 0.04;
const SILENT_DEFAULT_WARNING_CODES = new Set([
  "SIMPLIFIED_PARAGRAPH_SPACING",
  "EXTERNAL_RELATIONSHIP_IGNORED",
]);

function requiresImportConfirmation(warning: DocxImportPreviewWarning): boolean {
  return !SILENT_DEFAULT_WARNING_CODES.has(warning.code);
}

type DialogLike = {
  showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue>;
};

type SessionAssetStore = {
  stageMany(
    sessionId: string,
    assets: StoredAsset[],
  ): Promise<readonly { descriptor: StoredAsset["descriptor"] }[]>;
  commitStaged(sessionId: string, assetIds: readonly string[]): Promise<void>;
  discardStaged(sessionId: string, assetIds: readonly string[]): Promise<void>;
  readPreview?(assetId: string): Promise<Uint8Array>;
};

type InternalUnit = {
  classified: ClassifiedDocxUnit;
  title: string;
  target: DocxImportTarget;
};

type ImportSession = {
  appendTo?: DocxImportPrepareRequest["appendTo"];
  sessionId: string;
  ownerId: string;
  sourceFileNames: string[];
  units: InternalUnit[];
  warnings: DocxImportPreviewWarning[];
  imagesBySourceAndRelationship: Map<string, ResolvedDocxImage>;
  imageSignaturesByAssetId: Map<string, Uint8Array>;
  descriptors: StoredAsset["descriptor"][];
  stagedAssetIds: string[];
  byteLength: number;
  lastAccessedAt: number;
};

export type DocxImportSessionErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_FORBIDDEN"
  | "SESSION_LIMIT"
  | "ASSET_NOT_FOUND"
  | "ASSIGNMENTS_INCOMPLETE"
  | "DUPLICATE_OFFICIAL_TARGET"
  | "WARNINGS_UNACKNOWLEDGED"
  | "UNRECOGNIZED_DOCUMENT";

export class DocxImportSessionError extends Error {
  constructor(
    readonly code: DocxImportSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocxImportSessionError";
  }
}

export type DocxImportSessionServiceOptions = {
  dialog: DialogLike;
  assetStore: SessionAssetStore;
  patents: {
    createImported(input: { patent: CanonicalPatent; operationId: string }): Promise<OpenedPatent>;
    appendImportedDocuments?(input: {
      patentId: string;
      sessionId: string;
      expectedRevision: number;
      operationId: string;
      documents: AuxiliaryDocument[];
      assets: StoredAsset["descriptor"][];
    }): Promise<OpenedPatent>;
  };
  readPackage?: typeof readDocxPackage;
  parseDocument?: typeof parseWordprocessingDocument;
  classify?: typeof classifyDocxDocuments;
  importImage?: typeof importImage;
  createImageSignature?: (bytes: Uint8Array) => Promise<Uint8Array>;
  initialImportDirectory?: string;
  now?: () => number;
  randomUUID?: () => string;
};

export class DocxImportSessionService {
  readonly dialog: DialogLike;
  readonly #assetStore: SessionAssetStore;
  readonly #patents: DocxImportSessionServiceOptions["patents"];
  readonly #readPackage: typeof readDocxPackage;
  readonly #parseDocument: typeof parseWordprocessingDocument;
  readonly #classify: typeof classifyDocxDocuments;
  readonly #importImage: typeof importImage;
  readonly #createImageSignature: (bytes: Uint8Array) => Promise<Uint8Array>;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #sessions = new Map<string, ImportSession>();
  #lastImportDirectory: string | null;

  constructor(options: DocxImportSessionServiceOptions) {
    this.dialog = options.dialog;
    this.#assetStore = options.assetStore;
    this.#patents = options.patents;
    this.#readPackage = options.readPackage ?? readDocxPackage;
    this.#parseDocument = options.parseDocument ?? parseWordprocessingDocument;
    this.#classify = options.classify ?? classifyDocxDocuments;
    this.#importImage = options.importImage ?? importImage;
    this.#createImageSignature = options.createImageSignature ?? createImageSignature;
    this.#lastImportDirectory = options.initialImportDirectory ?? null;
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  }

  async prepare(
    ownerId: string,
    request: DocxImportPrepareRequest = {},
  ): Promise<DocxImportPreview | null> {
    if (request.appendTo)
      throw new DocxImportSessionError(
        "SESSION_FORBIDDEN",
        "不再支持追加其他文档，请使用五书导入。",
      );
    this.expireIdleSessions();
    if (this.#sessions.size >= MAX_ACTIVE_SESSIONS) {
      throw new DocxImportSessionError("SESSION_LIMIT", "同时进行的 DOCX 导入任务过多。");
    }
    const selection = await this.dialog.showOpenDialog({
      title: "导入 DOCX",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Word 文档", extensions: ["docx"] }],
      ...(this.#lastImportDirectory ? { defaultPath: this.#lastImportDirectory } : {}),
    });
    if (selection.canceled || selection.filePaths.length === 0) return null;
    const firstSelectedPath = selection.filePaths[0];
    if (!firstSelectedPath) return null;
    this.#lastImportDirectory = dirname(firstSelectedPath);

    const sessionId = this.#randomUUID();
    const sources: Array<{ sourceFileName: string; document: ParsedWordDocument }> = [];
    const packages = new Map<string, DocxPackage>();
    let byteLength = 0;
    for (const path of selection.filePaths) {
      const pkg = await this.#readPackage(path);
      const document = await this.#parseDocument(pkg);
      const sourceFileName = basename(path);
      sources.push({ sourceFileName, document });
      packages.set(sourceFileName, pkg);
      byteLength += [...pkg.parts.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
    }
    if (this.#activeBytes() + byteLength > MAX_ACTIVE_BYTES) {
      throw new DocxImportSessionError("SESSION_LIMIT", "DOCX 导入预览占用空间超过限制。");
    }

    const classified = this.#classify(sources);
    const unknown = classified.units.filter(
      (unit) => unit.suggestedTarget.kind !== "official-book",
    );
    if (classified.units.length === 0 || unknown.length > 0) {
      const names = [...new Set(unknown.map((unit) => unit.sourceFileName))].join("、");
      throw new DocxImportSessionError(
        "UNRECOGNIZED_DOCUMENT",
        names
          ? `无法识别，不能导入：${names}。请选择能够识别的五书 Word 文档。`
          : "无法识别，不能导入。请选择包含五书内容的 Word 文档。",
      );
    }
    if (classified.conflicts.length > 0)
      throw new DocxImportSessionError(
        "DUPLICATE_OFFICIAL_TARGET",
        "所选文件包含重复的五书类型，无法确定导入内容，请重新选择文件。",
      );
    const staged = await this.#stageImages(sessionId, sources, packages);
    const warnings = this.#warningsFor(sources, packages, classified);
    const session: ImportSession = {
      sessionId,
      ownerId,
      sourceFileNames: sources.map((source) => source.sourceFileName),
      units: classified.units.map((unit) => ({
        classified: unit,
        title: unit.title,
        target: importTargetFor(unit),
      })),
      warnings,
      imagesBySourceAndRelationship: staged.images,
      imageSignaturesByAssetId: staged.signatures,
      descriptors: staged.descriptors,
      stagedAssetIds: staged.descriptors.map((descriptor) => descriptor.assetId),
      byteLength,
      lastAccessedAt: this.#now(),
    };
    this.#sessions.set(sessionId, session);
    return this.#preview(session);
  }

  async update(ownerId: string, request: DocxImportUpdateRequest): Promise<DocxImportPreview> {
    const session = this.#requireOwnedSession(ownerId, request.sessionId);
    const unit = session.units.find((candidate) => candidate.classified.unitId === request.unitId);
    if (!unit) throw new DocxImportSessionError("ASSIGNMENTS_INCOMPLETE", "导入项目不存在。");
    if (
      request.target.kind !== "official-book" ||
      unit.target.kind !== "official-book" ||
      request.target.bookKind !== unit.target.bookKind ||
      request.title !== unit.title
    ) {
      throw new DocxImportSessionError(
        "UNRECOGNIZED_DOCUMENT",
        "导入位置由识别结果确定，不能手动更改。",
      );
    }
    unit.title = request.title;
    unit.target = request.target;
    session.lastAccessedAt = this.#now();
    return this.#preview(session);
  }

  async previewAsset(ownerId: string, sessionId: string, assetId: string): Promise<Uint8Array> {
    const session = this.#requireOwnedSession(ownerId, sessionId);
    if (!session.descriptors.some((descriptor) => descriptor.assetId === assetId)) {
      throw new DocxImportSessionError("ASSET_NOT_FOUND", "DOCX 导入图片预览不存在。");
    }
    if (!this.#assetStore.readPreview) {
      throw new DocxImportSessionError("ASSET_NOT_FOUND", "DOCX 导入图片预览不可用。");
    }
    return this.#assetStore.readPreview(assetId);
  }

  async commit(ownerId: string, request: DocxImportCommitRequest): Promise<OpenedPatent> {
    const session = this.#requireOwnedSession(ownerId, request.sessionId);
    if (
      session.appendTo?.patentId !== request.appendTo?.patentId ||
      session.appendTo?.sessionId !== request.appendTo?.sessionId ||
      (session.appendTo &&
        request.assignments.some((assignment) => assignment.target.kind !== "auxiliary"))
    ) {
      throw new DocxImportSessionError(
        "SESSION_FORBIDDEN",
        "导入目标与当前预览不一致，请重新选择文件。",
      );
    }
    this.#validateAssignments(session, request);
    const acknowledged = new Set(request.acknowledgedWarningIds);
    if (
      session.warnings.some(
        (warning) =>
          requiresImportConfirmation(warning) &&
          warning.severity === "important" &&
          !acknowledged.has(warning.warningId),
      )
    ) {
      throw new DocxImportSessionError("WARNINGS_UNACKNOWLEDGED", "请先确认所有重要导入提示。");
    }

    const patent = this.#buildPatent(session, request);
    const opened = await this.#patents.createImported({ patent, operationId: request.sessionId });
    await this.#assetStore.commitStaged(request.sessionId, session.stagedAssetIds);
    this.#sessions.delete(request.sessionId);
    return opened;
  }

  async cancel(ownerId: string, request: DocxImportCancelRequest): Promise<void> {
    const session = this.#requireOwnedSession(ownerId, request.sessionId);
    this.#sessions.delete(request.sessionId);
    await this.#assetStore.discardStaged(request.sessionId, session.stagedAssetIds);
  }

  expireIdleSessions(): void {
    const cutoff = this.#now() - SESSION_IDLE_TTL_MS;
    for (const session of this.#sessions.values()) {
      if (session.lastAccessedAt > cutoff) continue;
      this.#sessions.delete(session.sessionId);
      void this.#assetStore.discardStaged(session.sessionId, session.stagedAssetIds);
    }
  }

  async #stageImages(
    sessionId: string,
    sources: readonly { sourceFileName: string; document: ParsedWordDocument }[],
    packages: ReadonlyMap<string, DocxPackage>,
  ): Promise<{
    images: Map<string, ResolvedDocxImage>;
    descriptors: StoredAsset["descriptor"][];
    signatures: Map<string, Uint8Array>;
  }> {
    const stored: StoredAsset[] = [];
    const signatures: Uint8Array[] = [];
    const keys: string[] = [];
    for (const source of sources) {
      const pkg = packages.get(source.sourceFileName);
      if (!pkg) continue;
      for (const drawing of extractDocxDrawings(source.document, pkg)) {
        try {
          const asset = await this.#importImage({
            originalName: drawing.fileName,
            bytes: drawing.bytes,
          });
          stored.push(asset);
          signatures.push(await this.#createImageSignature(asset.preview));
          keys.push(imageKey(source.sourceFileName, drawing.relationshipId));
        } catch (error) {
          if (!(error instanceof ImageImportError)) throw error;
        }
      }
    }
    const imported = stored.length > 0 ? await this.#assetStore.stageMany(sessionId, stored) : [];
    const images = new Map<string, ResolvedDocxImage>();
    imported.forEach((asset, index) => {
      const key = keys[index];
      if (key) images.set(key, { assetId: asset.descriptor.assetId });
    });
    const signaturesByAssetId = new Map<string, Uint8Array>();
    imported.forEach((asset, index) => {
      const signature = signatures[index];
      if (signature) signaturesByAssetId.set(asset.descriptor.assetId, signature);
    });
    const descriptors = [
      ...new Map(imported.map((asset) => [asset.descriptor.assetId, asset.descriptor])).values(),
    ];
    return { images, descriptors, signatures: signaturesByAssetId };
  }

  #warningsFor(
    sources: readonly { sourceFileName: string; document: ParsedWordDocument }[],
    packages: ReadonlyMap<string, DocxPackage>,
    classified: DocxClassificationResult,
  ): DocxImportPreviewWarning[] {
    const warnings: DocxImportPreviewWarning[] = [];
    for (const source of sources) {
      const relatedUnitIds = classified.units
        .filter((unit) => unit.sourceFileName === source.sourceFileName)
        .map((unit) => unit.unitId);
      for (const warning of source.document.warnings) {
        for (const unitId of relatedUnitIds) {
          warnings.push({
            warningId: this.#randomUUID(),
            unitId,
            code: warning.code,
            message: warning.message,
            severity: "important",
          });
        }
      }
      const pkg = packages.get(source.sourceFileName);
      for (const finding of pkg?.findings ?? []) {
        warnings.push({
          warningId: this.#randomUUID(),
          unitId: null,
          code: finding.code,
          message: finding.message,
          severity: "important",
        });
      }
      if ((pkg?.externalRelationships.length ?? 0) > 0) {
        warnings.push({
          warningId: this.#randomUUID(),
          unitId: null,
          code: "EXTERNAL_RELATIONSHIP_IGNORED",
          message: `${source.sourceFileName} 中的外部链接未加载。`,
          severity: "information",
        });
      }
    }
    return warnings;
  }

  #preview(session: ImportSession): DocxImportPreview {
    return {
      ...(session.appendTo ? { appendTo: { ...session.appendTo } } : {}),
      sessionId: session.sessionId,
      sourceFileNames: [...session.sourceFileNames],
      units: session.units.map((unit) => {
        const document = this.#convertUnit(session, unit, unit.target);
        return {
          unitId: unit.classified.unitId,
          sourceFileName: unit.classified.sourceFileName,
          title: unit.title,
          target: unit.target,
          confidence: unit.classified.confidence,
          evidence: [...unit.classified.evidence],
          document,
          imageCount: countImages(unit.classified.blocks),
        };
      }),
      duplicateOfficialTargets: duplicateOfficialTargets(session.units.map((unit) => unit.target)),
      warnings: session.warnings
        .filter(requiresImportConfirmation)
        .map((warning) => ({ ...warning })),
    };
  }

  #convertUnit(session: ImportSession, unit: InternalUnit, target: DocxImportTarget) {
    const parsed: ParsedWordDocument = {
      blocks:
        target.kind === "official-book" && target.bookKind === "description-drawings"
          ? imageOnlyBlocks(unit.classified.blocks)
          : unit.classified.blocks,
      warnings: [],
    };
    const document = convertParsedWordDocument(parsed, {
      title: target.kind === "official-book" ? PATENT_BOOK_LABELS[target.bookKind] : unit.title,
      mode: target.kind === "official-book" ? "formal-book" : "auxiliary",
      ...(target.kind === "official-book" ? { bookKind: target.bookKind } : {}),
      resolveImage: (relationshipId) =>
        session.imagesBySourceAndRelationship.get(
          imageKey(unit.classified.sourceFileName, relationshipId),
        ) ?? null,
    }).document;
    const fitted = fitDocumentTables(document, document.page, false);
    if (!fitted)
      throw new Error(
        "导入的表格无法在正文宽度内完整显示，请在源文件中减少列数或拆成多张表后重试。源文件未改变。",
      );
    return fitted;
  }

  #buildPatent(session: ImportSession, request: DocxImportCommitRequest): CanonicalPatent {
    const patent = createImportedPatent(
      {
        patentType: request.patentType,
        name: request.name,
        customer: request.customer,
      },
      { now: () => new Date(this.#now()), createId: this.#randomUUID },
    );
    const assignmentsById = new Map(
      request.assignments.map((assignment) => [assignment.unitId, assignment]),
    );
    const reportAssignments: NonNullable<CanonicalPatent["docxImportReport"]>["assignments"] = [];
    for (const unit of session.units) {
      const assignment = assignmentsById.get(unit.classified.unitId);
      if (!assignment) continue;
      const document = this.#convertUnit(
        session,
        { ...unit, title: assignment.title },
        assignment.target,
      );
      if (assignment.target.kind === "official-book") {
        const bookKind = assignment.target.bookKind;
        const book = patent.books.find((candidate) => candidate.kind === bookKind);
        if (!book) throw new Error("DOCX import target book is missing.");
        book.document =
          bookKind === "abstract-drawing"
            ? book.document
            : bookKind === "description-drawings" && assignment.drawingOrder
              ? {
                  ...document,
                  content: orderedDrawingContent(document.content, assignment.drawingOrder),
                }
              : document;
        reportAssignments.push({
          unitId: unit.classified.unitId,
          sourceFileName: unit.classified.sourceFileName,
          title: assignment.title,
          target: assignment.target,
          confidence: unit.classified.confidence,
          evidence: [...unit.classified.evidence],
        });
      }
    }
    patent.assets = session.descriptors.map((descriptor) => structuredClone(descriptor));
    const drawingBook = patent.books.find((book) => book.kind === "description-drawings");
    const drawingFigures =
      drawingBook?.document.content.flatMap((block) => (block.type === "figure" ? [block] : [])) ??
      [];
    patent.figures = drawingFigures.map((figure) => ({
      figureId: this.#randomUUID(),
      assetId: figure.assetId,
      widthMm: figure.widthMm,
      rotationDeg: figure.rotationDeg ?? 0,
    }));
    const abstractDrawingAssetIds = new Set(
      session.units.flatMap((unit) => {
        const assignment = assignmentsById.get(unit.classified.unitId);
        if (
          assignment?.target.kind !== "official-book" ||
          unit.classified.recognizedBookKind !== "abstract-drawing"
        ) {
          return [];
        }
        return imageInlines(unit.classified.blocks).flatMap((inline) => {
          const resolved = session.imagesBySourceAndRelationship.get(
            imageKey(unit.classified.sourceFileName, inline.relationshipId),
          );
          return resolved ? [resolved.assetId] : [];
        });
      }),
    );
    const matchingFigures = patent.figures.filter((figure) =>
      [...abstractDrawingAssetIds].some((abstractAssetId) =>
        imagesVisuallyMatch(session, abstractAssetId, figure.assetId),
      ),
    );
    if (matchingFigures.length === 1) {
      patent.abstractDrawingFigureId = matchingFigures[0]?.figureId ?? null;
    }
    patent.docxImportReport = {
      importedAt: new Date(this.#now()).toISOString(),
      sourceFileNames: [...session.sourceFileNames],
      assignments: reportAssignments,
      warnings: session.warnings.map(({ warningId, code, message, severity }) => ({
        warningId,
        code,
        message,
        severity,
      })),
    };
    return patent;
  }

  #validateAssignments(session: ImportSession, request: DocxImportCommitRequest): void {
    for (const assignment of request.assignments) {
      const original = session.units.find((unit) => unit.classified.unitId === assignment.unitId);
      if (
        !original ||
        assignment.target.kind !== "official-book" ||
        original.target.kind !== "official-book" ||
        assignment.target.bookKind !== original.target.bookKind ||
        assignment.title !== original.title
      ) {
        throw new DocxImportSessionError(
          "UNRECOGNIZED_DOCUMENT",
          "导入内容必须与五书识别结果一致，请重新选择文件。",
        );
      }
    }
    const expected = new Set(session.units.map((unit) => unit.classified.unitId));
    const actual = new Set(request.assignments.map((assignment) => assignment.unitId));
    if (
      actual.size !== request.assignments.length ||
      expected.size !== actual.size ||
      [...expected].some((unitId) => !actual.has(unitId))
    ) {
      throw new DocxImportSessionError("ASSIGNMENTS_INCOMPLETE", "导入项目分配不完整。");
    }
    const duplicates = duplicateOfficialTargets(
      request.assignments.map((assignment) => assignment.target),
    );
    if (duplicates.length > 0) {
      throw new DocxImportSessionError(
        "DUPLICATE_OFFICIAL_TARGET",
        "多个文档不能同时写入同一份五书。",
      );
    }
    for (const assignment of request.assignments) {
      if (!assignment.drawingOrder) continue;
      const unit = session.units.find(
        (candidate) => candidate.classified.unitId === assignment.unitId,
      );
      if (!unit) continue;
      const remaining = new Map<string, number>();
      for (const inline of imageInlines(unit.classified.blocks)) {
        const resolved = session.imagesBySourceAndRelationship.get(
          imageKey(unit.classified.sourceFileName, inline.relationshipId),
        );
        if (resolved) {
          remaining.set(resolved.assetId, (remaining.get(resolved.assetId) ?? 0) + 1);
        }
      }
      // Shared image assets may occur more than once; validate occurrences, not unique assets.
      for (const assetId of assignment.drawingOrder) {
        remaining.set(assetId, (remaining.get(assetId) ?? 0) - 1);
      }
      if ([...remaining.values()].some((count) => count !== 0)) {
        throw new DocxImportSessionError(
          "ASSIGNMENTS_INCOMPLETE",
          "说明书附图排序与已导入图片不一致。",
        );
      }
    }
  }

  #requireOwnedSession(ownerId: string, sessionId: string): ImportSession {
    this.expireIdleSessions();
    const session = this.#sessions.get(sessionId);
    if (!session) throw new DocxImportSessionError("SESSION_NOT_FOUND", "DOCX 导入预览已失效。");
    if (session.ownerId !== ownerId) {
      throw new DocxImportSessionError("SESSION_FORBIDDEN", "该导入预览属于其他窗口。");
    }
    session.lastAccessedAt = this.#now();
    return session;
  }

  #activeBytes(): number {
    return [...this.#sessions.values()].reduce((total, session) => total + session.byteLength, 0);
  }
}

function duplicateOfficialTargets(targets: readonly DocxImportTarget[]): PatentBookKind[] {
  const counts = new Map<PatentBookKind, number>();
  for (const target of targets) {
    if (target.kind !== "official-book") continue;
    counts.set(target.bookKind, (counts.get(target.bookKind) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([kind]) => kind);
}

function importTargetFor(unit: ClassifiedDocxUnit): DocxImportTarget {
  if (unit.suggestedTarget.kind === "official-book") return unit.suggestedTarget;
  throw new DocxImportSessionError(
    "UNRECOGNIZED_DOCUMENT",
    `无法识别，不能导入：${unit.sourceFileName}`,
  );
}

function imageKey(sourceFileName: string, relationshipId: string): string {
  return `${sourceFileName}\0${relationshipId}`;
}

async function createImageSignature(bytes: Uint8Array): Promise<Uint8Array> {
  const signature = await sharp(bytes)
    .flatten({ background: "#fff" })
    .resize(IMAGE_SIGNATURE_SIZE, IMAGE_SIGNATURE_SIZE, {
      fit: "contain",
      background: "#fff",
    })
    .grayscale()
    .raw()
    .toBuffer();
  return Uint8Array.from(signature);
}

function imagesVisuallyMatch(
  session: ImportSession,
  firstAssetId: string,
  secondAssetId: string,
): boolean {
  if (firstAssetId === secondAssetId) return true;
  const first = session.imageSignaturesByAssetId.get(firstAssetId);
  const second = session.imageSignaturesByAssetId.get(secondAssetId);
  if (!first || !second || first.length !== second.length || first.length === 0) return false;

  let absoluteDifference = 0;
  let inkDisagreement = 0;
  let firstInkPixels = 0;
  let secondInkPixels = 0;
  for (let index = 0; index < first.length; index += 1) {
    const firstValue = first[index] ?? 255;
    const secondValue = second[index] ?? 255;
    absoluteDifference += Math.abs(firstValue - secondValue);
    const firstIsInk = firstValue < 220;
    const secondIsInk = secondValue < 220;
    if (firstIsInk) firstInkPixels += 1;
    if (secondIsInk) secondInkPixels += 1;
    if (firstIsInk !== secondIsInk) inkDisagreement += 1;
  }
  if (firstInkPixels === 0 || secondInkPixels === 0) return false;
  return (
    absoluteDifference / first.length <= IMAGE_SIGNATURE_MAX_MEAN_DIFFERENCE &&
    inkDisagreement / first.length <= IMAGE_SIGNATURE_MAX_INK_DISAGREEMENT
  );
}

function countImages(blocks: readonly ClassifiedDocxUnit["blocks"][number][]): number {
  return imageInlines(blocks).length;
}

function imageOnlyBlocks(blocks: ClassifiedDocxUnit["blocks"]): ParsedWordDocument["blocks"] {
  return imageInlines(blocks).map((inline) => ({
    type: "paragraph" as const,
    headingLevel: null,
    alignment: "center" as const,
    firstLineIndentMm: null,
    lineSpacing: null,
    list: null,
    inlines: [inline],
  }));
}

function imageInlines(
  blocks: ClassifiedDocxUnit["blocks"],
): Extract<WordInline, { type: "image" }>[] {
  const images: Extract<WordInline, { type: "image" }>[] = [];
  for (const block of blocks) {
    const paragraphs =
      block.type === "paragraph"
        ? [block]
        : block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs));
    for (const paragraph of paragraphs) {
      for (const inline of paragraph.inlines) if (inline.type === "image") images.push(inline);
    }
  }
  return images;
}

function orderedDrawingContent(
  content: CanonicalPatent["books"][number]["document"]["content"],
  drawingOrder: readonly string[],
): CanonicalPatent["books"][number]["document"]["content"] {
  const figures = new Map<string, Extract<(typeof content)[number], { type: "figure" }>[]>();
  // Pop each occurrence separately, preserving its own block ID and properties.
  for (const block of [...content].reverse()) {
    if (block.type !== "figure") continue;
    const occurrences = figures.get(block.assetId) ?? [];
    occurrences.push(block);
    figures.set(block.assetId, occurrences);
  }
  return drawingOrder.map((assetId) => {
    const figure = figures.get(assetId)?.pop();
    if (!figure) throw new Error("Ordered DOCX drawing is missing.");
    return figure;
  });
}
