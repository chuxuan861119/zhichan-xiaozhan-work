import type { ExportIssue } from "../../shared/exports/report.js";
import type { CanonicalPatent, PatentBook, PatentBookKind } from "../../shared/patent/model.js";
import {
  availablePatentBookKinds,
  isPatentBookAvailable,
  PATENT_BOOK_LABELS,
} from "../../shared/patent/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { DocxExportError } from "./docx-exporter.js";
import { drawingBookContent, drawingFiguresForBook } from "./patent-drawing-content.js";
import { ChemicalStructurePreviewAssetError, renderPrintHtml } from "./print-template.js";

const COMBINED_EXPORT_ORDER = [
  "abstract",
  "abstract-drawing",
  "claims",
  "description",
  "description-drawings",
] as const satisfies readonly PatentBookKind[];

export type PatentPrintRequest =
  | {
      patent: CanonicalPatent;
      mode: "combined";
      assets: readonly StoredAsset[];
    }
  | {
      patent: CanonicalPatent;
      mode: "single";
      bookKind: PatentBookKind;
      assets: readonly StoredAsset[];
    };

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function exportOrder(request: PatentPrintRequest): PatentBookKind[] {
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

function patentBook(patent: CanonicalPatent, bookKind: PatentBookKind): PatentBook {
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

function printableBook(patent: CanonicalPatent, book: PatentBook): PatentBook["document"] {
  const document = structuredClone(book.document);
  document.content = structuredClone(drawingBookContent(patent, book));
  const drawings = drawingFiguresForBook(patent, book.kind);
  document.content.push(
    ...drawings.map((figure) => ({
      id: figure.figureId,
      type: "figure" as const,
      assetId: figure.assetId,
      widthMm: figure.widthMm,
      alignment: "center" as const,
      rotationDeg: figure.rotationDeg ?? 0,
    })),
  );
  return document;
}

function extractBody(html: string): string {
  return /<body>([\s\S]*)<\/body>/u.exec(html)?.[1] ?? "";
}

function extractStyles(html: string): string {
  return /<style>([\s\S]*)<\/style>/u.exec(html)?.[1] ?? "";
}

function patentPrintStyles(): string {
  return `
@page {
  @top-center {
    content: string(patent-book-title);
    border-bottom: 1px solid #000;
    font-family: SimSun, serif;
    font-size: 12pt;
  }
  @bottom-center { content: counter(page); margin-top: 3mm; font-family: SimSun, serif; font-size: 12pt; }
}
.patent-export-book { break-inside: auto; }
.patent-export-book + .patent-export-book { break-before:page; page-break-before: always; }
.patent-export-header {
  string-set: patent-book-title content();
  margin: 0 0 8mm;
  padding-bottom: 2mm;
  border-bottom: 1px solid #000;
  text-align: center;
  font-family: SimSun, serif;
  font-size: 12pt;
}
`;
}

export async function createPatentPrintPackage(
  request: PatentPrintRequest,
): Promise<{ html: string; issues: ExportIssue[] }> {
  const orderedBooks = exportOrder(request).map((bookKind) => patentBook(request.patent, bookKind));
  const issues: ExportIssue[] = [];
  let renderedBooks: { book: PatentBook; html: string }[];
  try {
    renderedBooks = await Promise.all(
      orderedBooks.map(async (book) => ({
        book,
        html: await renderPrintHtml(printableBook(request.patent, book), request.assets, {
          includeDocumentHeader: false,
          onIssue: (issue) => issues.push(issue),
          figureLabel: (nodeId) => {
            if (book.kind !== "description-drawings" && book.kind !== "abstract-drawing") {
              return null;
            }
            const index = request.patent.figures.findIndex((figure) => figure.figureId === nodeId);
            return index < 0 ? null : `图${index + 1}`;
          },
        }),
      })),
    );
  } catch (error) {
    if (error instanceof ChemicalStructurePreviewAssetError) {
      throw new DocxExportError([
        {
          severity: "error",
          code: "MISSING_ASSET",
          nodeId: error.nodeId,
          message: error.message,
        },
      ]);
    }
    throw error;
  }
  const baseStyles = renderedBooks[0] ? extractStyles(renderedBooks[0].html) : "";
  const sections = renderedBooks
    .map(({ book, html }) => {
      const label = PATENT_BOOK_LABELS[book.kind];
      return `<section class="patent-export-book"><header class="patent-export-header">${escapeHtml(
        label,
      )}</header>${extractBody(html)}</section>`;
    })
    .join("");

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><title>${escapeHtml(
    request.patent.name ?? "未命名专利",
  )}</title><style>${baseStyles}\n${patentPrintStyles()}</style></head><body>${sections}</body></html>`;
  return { html, issues };
}

export async function renderPatentPrintHtml(request: PatentPrintRequest): Promise<string> {
  return (await createPatentPrintPackage(request)).html;
}
