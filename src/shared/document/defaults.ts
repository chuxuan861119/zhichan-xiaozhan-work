import { randomUuid } from "../id.js";
import { DEFAULT_PAGE_MARGINS } from "../settings/page-margins.js";
import { defaultDocumentFontSizePt } from "./font-policy.js";
import type {
  CanonicalDocument,
  PageSettings,
  ParagraphAttributes,
  PatentBookDocument,
} from "./model.js";
import { CANONICAL_DOCUMENT_FORMAT_VERSION } from "./model.js";

export const DEFAULT_PAGE_SETTINGS: PageSettings = {
  widthMm: 210,
  heightMm: 297,
  marginTopMm: DEFAULT_PAGE_MARGINS.marginTopMm,
  marginRightMm: DEFAULT_PAGE_MARGINS.marginRightMm,
  marginBottomMm: DEFAULT_PAGE_MARGINS.marginBottomMm,
  marginLeftMm: DEFAULT_PAGE_MARGINS.marginLeftMm,
};

export const DEFAULT_PARAGRAPH_ATTRIBUTES: ParagraphAttributes = {
  alignment: "left",
  paragraphIndentMm: 0,
  lineSpacing: 1.5,
  defaultFontFamily: "SimSun",
  defaultFontSizePt: 14,
};

export function createBlankDocument(title: string): CanonicalDocument {
  const timestamp = new Date().toISOString();
  const normalizedTitle = title.trim() || "未命名";

  return {
    formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
    documentId: randomUuid(),
    title: normalizedTitle,
    patentType: null,
    createdAt: timestamp,
    modifiedAt: timestamp,
    page: { ...DEFAULT_PAGE_SETTINGS },
    content: [
      {
        id: randomUuid(),
        type: "paragraph",
        attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES, defaultFontSizePt: defaultDocumentFontSizePt() },
        content: [],
      },
    ],
    assets: [],
  };
}

export function createBlankBookDocument(
  title: string,
  timestamp = new Date().toISOString(),
): PatentBookDocument {
  const normalizedTitle = title.trim() || "未命名";

  return {
    formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
    documentId: randomUuid(),
    title: normalizedTitle,
    createdAt: timestamp,
    modifiedAt: timestamp,
    page: { ...DEFAULT_PAGE_SETTINGS },
    content: [],
  };
}
