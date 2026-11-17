import { randomUUID } from "node:crypto";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  type FileChild,
  Footer,
  Header,
  ImageRun,
  Packer,
  PageOrientation,
  Paragraph,
  SectionType,
  SimpleField,
  TextRun,
} from "docx";
import yauzl, { type ZipFile } from "yauzl";
import { DOCX_HEADING_STYLES } from "../../shared/document/docx-heading-style.js";
import { DOCX_LIST_PARAGRAPH_STYLES } from "../../shared/document/docx-list-style.js";
import { normalizeTableColumnWidths } from "../../shared/document/table-column-widths.js";
import { pageBodyWidthMm } from "../../shared/document/table-page-fit.js";
import type { ExportIssue, ExportReport } from "../../shared/exports/report.js";
import {
  availablePatentBookKinds,
  type CanonicalPatent,
  isPatentBookAvailable,
  PATENT_BOOK_LABELS,
  type PatentBookKind,
} from "../../shared/patent/model.js";
import type { AssetStore, StoredAsset } from "../assets/asset-store.js";
import { isVectorSvgSafeForExport } from "../assets/vector-image-safety.js";
import { writeExportFile } from "../platform/atomic-export-write.js";
import { sanitizeExportSvg } from "./chemical-structure-export.js";
import {
  type MappingContext,
  mapBlockNode,
  orderedNumbering,
  prepareChemicalStructureAssets,
  prepareFigureImageMedia,
  prepareFormulaExports,
  validateTable,
} from "./docx-content-mapper.js";
import { DocxExportError, millimetresToTwips } from "./docx-exporter.js";
import { type DocxImageData, prepareDocxImageData } from "./docx-image-data.js";
import { drawingBookContent, drawingFiguresForBook } from "./patent-drawing-content.js";

const COMBINED_EXPORT_ORDER = [
  "abstract",
  "abstract-drawing",
  "claims",
  "description",
  "description-drawings",
] as const satisfies readonly PatentBookKind[];

type PatentDocxPackageRequest =
  | {
      patent: CanonicalPatent;
      mode: "combined";
    }
  | {
      patent: CanonicalPatent;
      mode: "single";
      bookKind: PatentBookKind;
    };

type PatentDocxPackage = {
  buffer: Buffer;
  issues: ExportIssue[];
};

type AtomicDocxWriter = (path: string, data: Buffer) => Promise<void>;

const LOCKED_OUTPUT_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

function nativeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function numberedSiblingPath(outputPath: string, index: number): string {
  const extension = extname(outputPath);
  return join(dirname(outputPath), `${basename(outputPath, extension)} (${index})${extension}`);
}

async function writeWithLockedTargetFallback(
  outputPath: string,
  buffer: Buffer,
  writeAtomic: AtomicDocxWriter,
): Promise<{ outputPath: string; issue: ExportIssue | null }> {
  try {
    await writeAtomic(outputPath, buffer);
    return { outputPath, issue: null };
  } catch (error) {
    if (!LOCKED_OUTPUT_ERROR_CODES.has(nativeErrorCode(error) ?? "")) throw error;
  }

  for (let index = 1; ; index += 1) {
    const fallbackPath = numberedSiblingPath(outputPath, index);
    try {
      await access(fallbackPath);
      continue;
    } catch (error) {
      if (nativeErrorCode(error) !== "ENOENT") throw error;
    }
    try {
      await writeAtomic(fallbackPath, buffer);
      return {
        outputPath: fallbackPath,
        issue: {
          severity: "warning",
          code: "EXPORT_FAILED",
          nodeId: null,
          message: `原目标文件正被其他程序占用，已自动另存为“${basename(fallbackPath)}”。`,
        },
      };
    } catch (error) {
      if (nativeErrorCode(error) === "EEXIST") continue;
      throw error;
    }
  }
}

function exportOrder(request: PatentDocxPackageRequest): PatentBookKind[] {
  if (request.mode === "combined") {
    const available = new Set(availablePatentBookKinds(request.patent));
    return COMBINED_EXPORT_ORDER.filter((kind) => available.has(kind));
  }
  if (!isPatentBookAvailable(request.patent, request.bookKind)) {
    throw new DocxExportError([
      {
        severity: "error",
        code: "EXPORT_FAILED",
        nodeId: null,
        message: `“${PATENT_BOOK_LABELS[request.bookKind]}”当前不可用。`,
      },
    ]);
  }
  return [request.bookKind];
}

function patentBook(
  patent: CanonicalPatent,
  bookKind: PatentBookKind,
): CanonicalPatent["books"][number] {
  const book = patent.books.find((candidate) => candidate.kind === bookKind);
  if (!book) {
    throw new DocxExportError([
      {
        severity: "error",
        code: "EXPORT_FAILED",
        nodeId: null,
        message: `专利缺少“${PATENT_BOOK_LABELS[bookKind]}”。`,
      },
    ]);
  }
  return book;
}

type DrawingImageData =
  | {
      type: "svg";
      data: Uint8Array;
      fallback: { type: "png"; data: Uint8Array };
    }
  | {
      type: "png" | "jpg" | "bmp";
      data: Uint8Array;
    };

function imageData(asset: StoredAsset): DrawingImageData | null {
  if (asset.descriptor.kind === "vector-image") {
    const svg = Buffer.from(asset.original).toString("utf8");
    if (isVectorSvgSafeForExport(svg)) {
      return {
        type: "svg",
        data: Uint8Array.from(asset.original),
        fallback: { type: "png", data: Uint8Array.from(asset.preview) },
      };
    }
    return { type: "png", data: Uint8Array.from(asset.preview) };
  }
  if (asset.descriptor.kind === "flowchart-preview") {
    const svg = Buffer.from(asset.original).toString("utf8");
    if (!sanitizeExportSvg(svg)) return null;
    return { type: "svg", data: asset.original, fallback: { type: "png", data: asset.preview } };
  }
  if (asset.descriptor.mediaType === "image/jpeg") return { type: "jpg", data: asset.original };
  if (asset.descriptor.mediaType === "image/bmp") return { type: "bmp", data: asset.original };
  if (asset.descriptor.mediaType === "image/tiff") return { type: "png", data: asset.preview };
  return { type: "png", data: asset.original };
}

function drawingChildren(
  patent: CanonicalPatent,
  bookKind: PatentBookKind,
  assets: ReadonlyMap<string, StoredAsset>,
  issues: ExportIssue[],
  contentWidthMm: number,
  preparedDrawings: ReadonlyMap<string, DocxImageData>,
): FileChild[] {
  return drawingFiguresForBook(patent, bookKind).flatMap((figure) => {
    const asset = assets.get(figure.assetId);
    if (!asset) {
      issues.push({
        severity: "error",
        code: "MISSING_ASSET",
        nodeId: figure.figureId,
        message: `附图资源不存在：${figure.assetId}`,
      });
      return [];
    }
    const figureNumber = patent.figures.findIndex(
      (candidate) => candidate.figureId === figure.figureId,
    );
    const widthMm = Math.min(figure.widthMm, contentWidthMm);
    const widthPx = Math.max(1, Math.round((widthMm * 96) / 25.4));
    const quarterTurned = figure.rotationDeg === 90 || figure.rotationDeg === 270;
    const displayedAspectRatio = quarterTurned
      ? asset.descriptor.widthPx / asset.descriptor.heightPx
      : asset.descriptor.heightPx / asset.descriptor.widthPx;
    const heightPx = Math.max(1, Math.round(widthPx * displayedAspectRatio));
    const image = imageData(asset);
    if (image === null) {
      issues.push({
        severity: "warning",
        code: "FLOWCHART_RENDERED_AS_IMAGE",
        nodeId: figure.figureId,
        message: "流程图 SVG 无法安全导出，已降级为 PNG 图片。",
      });
    }
    const imageOptions = preparedDrawings.get(figure.figureId) ??
      image ?? { type: "png" as const, data: asset.preview };
    const transformation = {
      width: widthPx,
      height: heightPx,
    };
    const imageRun =
      imageOptions.type === "svg"
        ? new ImageRun({
            type: imageOptions.type,
            data: imageOptions.data,
            fallback: imageOptions.fallback,
            transformation,
          })
        : new ImageRun({
            type: imageOptions.type as "png" | "jpg" | "bmp",
            data: imageOptions.data,
            transformation,
          });
    return [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [imageRun],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: `图${figureNumber + 1}`, font: "SimSun", size: 24 })],
      }),
    ];
  });
}

function assetStoreFromResolved(assets: ReadonlyMap<string, StoredAsset>): AssetStore {
  return {
    get: (_sessionId: string, assetId: string) => assets.get(assetId) ?? null,
  } as unknown as AssetStore;
}

function bookHeader(label: string): Header {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
        },
        children: [new TextRun({ text: label, font: "SimSun", size: 24 })],
      }),
    ],
  });
}

function pageFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new SimpleField("PAGE")],
      }),
    ],
  });
}

export async function createPatentDocxPackage(
  request: PatentDocxPackageRequest,
  resolvedAssets: readonly StoredAsset[] = [],
): Promise<PatentDocxPackage> {
  const issues: ExportIssue[] = [];
  const orderedBooks = exportOrder(request).map((bookKind) => {
    const book = patentBook(request.patent, bookKind);
    return {
      ...book,
      document: {
        ...book.document,
        content: drawingBookContent(request.patent, book).map((node) =>
          node.type === "table" ? normalizeTableColumnWidths(node) : node,
        ),
      },
    };
  });
  const assets = new Map(resolvedAssets.map((asset) => [asset.descriptor.assetId, asset] as const));
  const allContent = orderedBooks.flatMap((book) => book.document.content);
  for (const book of orderedBooks) {
    for (const node of book.document.content) {
      if (node.type === "table")
        issues.push(...validateTable(node, pageBodyWidthMm(book.document.page)));
    }
  }
  if (issues.some((issue) => issue.severity === "error")) throw new DocxExportError(issues);
  const assetStore = assetStoreFromResolved(assets);
  const firstBook = orderedBooks[0];
  const page = firstBook?.document.page;
  if (!page) {
    throw new DocxExportError([
      {
        severity: "error",
        code: "EXPORT_FAILED",
        nodeId: null,
        message: "专利没有可导出的书册。",
      },
    ]);
  }
  const chemicalStructureAssets = await prepareChemicalStructureAssets(
    { content: allContent },
    assetStore,
    "patent-export",
    issues,
    Math.max(1, page.widthMm - page.marginLeftMm - page.marginRightMm),
    Math.max(1, page.heightMm - page.marginTopMm - page.marginBottomMm),
  );
  if (issues.some((issue) => issue.severity === "error")) throw new DocxExportError(issues);
  const formulaExports = await prepareFormulaExports({ content: allContent }, issues);
  if (issues.some((issue) => issue.severity === "error")) throw new DocxExportError(issues);
  const numbering = orderedNumbering({ content: allContent });
  const assetCache: MappingContext["assetCache"] = new Map();
  const preparedAssetMediaCache = await prepareFigureImageMedia(
    allContent,
    assetStore,
    "patent-export",
    assetCache,
  );
  const preparedDrawings = new Map<string, DocxImageData>();
  for (const book of orderedBooks) {
    for (const figure of drawingFiguresForBook(request.patent, book.kind)) {
      if (preparedDrawings.has(figure.figureId)) continue;
      const asset = assets.get(figure.assetId);
      if (!asset) continue;
      preparedDrawings.set(
        figure.figureId,
        await prepareDocxImageData(
          imageData(asset) ?? { type: "png", data: asset.preview },
          figure.rotationDeg ?? 0,
          asset.descriptor.widthPx,
          asset.descriptor.heightPx,
        ),
      );
    }
  }
  const preparedFormulaMediaCache: MappingContext["preparedFormulaMediaCache"] = new WeakMap();
  const embeddedMediaTypes: MappingContext["embeddedMediaTypes"] = new Set();
  let nextDrawingId = 1;

  const docx = new Document({
    title: request.patent.name ?? "未命名专利",
    styles: {
      paragraphStyles: DOCX_LIST_PARAGRAPH_STYLES,
      default: {
        ...DOCX_HEADING_STYLES,
        document: {
          run: {
            font: "SimSun",
            size: 24,
          },
        },
      },
    },
    numbering: { config: numbering.config },
    sections: orderedBooks.map((book) => {
      const contentWidthMm = Math.max(
        1,
        book.document.page.widthMm -
          book.document.page.marginLeftMm -
          book.document.page.marginRightMm,
      );
      const contentHeightMm = Math.max(
        1,
        book.document.page.heightMm -
          book.document.page.marginTopMm -
          book.document.page.marginBottomMm,
      );
      const context: MappingContext = {
        sessionId: "patent-export",
        assetStore,
        assetCache,
        preparedAssetMediaCache,
        preparedFormulaMediaCache,
        formulaExports,
        chemicalStructureAssets,
        nextDrawingId,
        contentWidthMm,
        contentHeightMm,
        issues,
        embeddedMediaTypes,
        orderedListReferences: numbering.references,
      };
      const richTextChildren = book.document.content.flatMap((node) => mapBlockNode(node, context));
      nextDrawingId = context.nextDrawingId;
      return {
        headers: { default: bookHeader(PATENT_BOOK_LABELS[book.kind]) },
        footers: { default: pageFooter() },
        properties: {
          type: SectionType.NEXT_PAGE,
          page: {
            size: {
              width: millimetresToTwips(book.document.page.widthMm),
              height: millimetresToTwips(book.document.page.heightMm),
              orientation: PageOrientation.PORTRAIT,
            },
            margin: {
              top: millimetresToTwips(book.document.page.marginTopMm),
              right: millimetresToTwips(book.document.page.marginRightMm),
              bottom: millimetresToTwips(book.document.page.marginBottomMm),
              left: millimetresToTwips(book.document.page.marginLeftMm),
            },
            ...(request.mode === "single" ? { pageNumbers: { start: 1 } } : {}),
          },
        },
        children: [
          ...(richTextChildren.length > 0 ? richTextChildren : [new Paragraph({})]),
          ...drawingChildren(
            request.patent,
            book.kind,
            assets,
            issues,
            contentWidthMm,
            preparedDrawings,
          ),
        ],
      };
    }),
  });
  if (issues.some((issue) => issue.severity === "error")) throw new DocxExportError(issues);
  return { buffer: await Packer.toBuffer(docx), issues };
}

function openDocx(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("DOCX 文件无法打开。"));
      else resolve(zip);
    });
  });
}

async function verifyDocx(path: string): Promise<void> {
  const zip = await openDocx(path);
  await new Promise<void>((resolve, reject) => {
    let hasDocumentXml = false;
    zip.on("error", reject);
    zip.on("entry", (entry) => {
      if (entry.fileName === "word/document.xml") hasDocumentXml = true;
      zip.readEntry();
    });
    zip.on("end", () => {
      if (hasDocumentXml) resolve();
      else reject(new Error("DOCX 文件缺少 word/document.xml。"));
    });
    zip.readEntry();
  });
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function savePatentDocxToPath(
  outputPath: string,
  request: PatentDocxPackageRequest,
  resolvedAssets: readonly StoredAsset[] = [],
  writeAtomic: AtomicDocxWriter = writeExportFile,
): Promise<ExportReport> {
  const packageResult = await createPatentDocxPackage(request, resolvedAssets);
  if (packageResult.issues.some((issue) => issue.severity === "error")) {
    throw new DocxExportError(packageResult.issues);
  }

  const directory = dirname(outputPath);
  const temporaryPath = join(directory, `.${basename(outputPath)}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, packageResult.buffer, { flag: "wx" });
    await verifyDocx(temporaryPath);
    const saved = await writeWithLockedTargetFallback(
      outputPath,
      packageResult.buffer,
      writeAtomic,
    );
    return {
      format: "docx",
      outputPath: saved.outputPath,
      issues: saved.issue ? [...packageResult.issues, saved.issue] : packageResult.issues,
    };
  } catch (error) {
    if (error instanceof DocxExportError) throw error;
    throw new DocxExportError([
      {
        severity: "error",
        code: "EXPORT_FAILED",
        nodeId: null,
        message: error instanceof Error ? error.message : "DOCX 导出失败。",
      },
    ]);
  } finally {
    await removeIfPresent(temporaryPath).catch(() => undefined);
  }
}
