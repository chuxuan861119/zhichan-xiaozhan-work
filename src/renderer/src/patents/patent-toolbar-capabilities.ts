import type { PatentBookKind } from "../../../shared/patent/model";
import type { RichTextEditorCapabilities } from "../editor/rich-text-editor-core";

export const DISABLED_PATENT_BOOK_CAPABILITIES: RichTextEditorCapabilities = {
  headings: false,
  lists: false,
  tables: false,
  formulas: false,
  chemistry: false,
  chemicalStructures: false,
  images: false,
  pageBreaks: false,
};

export const ORDINARY_DOCUMENT_CAPABILITIES: RichTextEditorCapabilities = {
  headings: true,
  lists: true,
  tables: true,
  formulas: true,
  chemistry: true,
  chemicalStructures: true,
  images: true,
  pageBreaks: true,
};

const DESCRIPTION_CAPABILITIES: RichTextEditorCapabilities = {
  headings: true,
  lists: true,
  tables: true,
  formulas: true,
  chemistry: true,
  chemicalStructures: true,
  images: true,
  pageBreaks: false,
};

const CLAIMS_AND_ABSTRACT_CAPABILITIES: RichTextEditorCapabilities = {
  headings: false,
  lists: false,
  tables: false,
  formulas: true,
  chemistry: true,
  chemicalStructures: true,
  images: false,
  pageBreaks: false,
};

const CLAIMS_CAPABILITIES: RichTextEditorCapabilities = {
  ...CLAIMS_AND_ABSTRACT_CAPABILITIES,
  images: true,
};

export function capabilitiesForPatentBook(kind: PatentBookKind): RichTextEditorCapabilities {
  if (kind === "description") return DESCRIPTION_CAPABILITIES;

  if (kind === "claims") return CLAIMS_CAPABILITIES;

  if (kind === "abstract") return CLAIMS_AND_ABSTRACT_CAPABILITIES;

  return DISABLED_PATENT_BOOK_CAPABILITIES;
}
