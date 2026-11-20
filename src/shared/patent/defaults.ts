import { DEFAULT_PAGE_SETTINGS } from "../document/defaults.js";
import { CANONICAL_DOCUMENT_FORMAT_VERSION } from "../document/model.js";
import { randomUuid } from "../id.js";
import { createBlankDesignPatent } from "./design-patent.js";
import {
  CANONICAL_PATENT_FORMAT_VERSION,
  type CanonicalPatent,
  PATENT_BOOK_LABELS,
  PATENT_BOOK_ORDER,
  type PatentBook,
  type PatentBookKind,
  type PatentType,
} from "./model.js";
import {
  blockingTemplateIssues,
  createFactoryPatentTemplates,
  instantiateBookTemplate,
  type PatentTemplateSettings,
  PatentTemplateSettingsSchema,
} from "./templates.js";

export type CreateBlankPatentOptions = {
  patentType: PatentType;
  name: string | null;
  customer?: string | null | undefined;
  templates?: PatentTemplateSettings;
};

export type PatentFactoryDependencies = {
  now(): Date;
  createId(): string;
};

export function createBlankPatent(
  { patentType, name, customer, templates }: CreateBlankPatentOptions,
  dependencies: Partial<PatentFactoryDependencies> = {},
): CanonicalPatent {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUuid;
  const timestamp = now().toISOString();
  const normalizedName = normalizePatentName(name);
  const templateSettings = PatentTemplateSettingsSchema.parse(
    templates ?? createFactoryPatentTemplates(createId),
  );
  const issues = templateSettings.enabled ? blockingTemplateIssues(templateSettings) : [];
  if (issues.length > 0) {
    throw new Error(`专利模板无效：${issues.map((issue) => issue.message).join("；")}`);
  }
  const templateGroup =
    patentType === "design" ? templateSettings.invention : templateSettings[patentType];

  return {
    formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
    patentId: createId(),
    name: normalizedName,
    customer: normalizeCustomer(customer),
    patentType,
    createdAt: timestamp,
    modifiedAt: timestamp,
    revision: 0,
    drawingBooksEnabled: true,
    activeBookKind: "description",
    books: PATENT_BOOK_ORDER.map((kind) =>
      createBlankPatentBook(
        kind,
        templateGroup,
        templateSettings.enabled && patentType !== "design",
        normalizedName,
        patentType,
        timestamp,
        createId,
      ),
    ),
    auxiliaryDocuments: [],
    docxImportReport: null,
    figures: [],
    flowchartProjects: [],
    drawingProjects: [],
    abstractDrawingFigureId: null,
    assets: [],

    referenceMarks: [],
    referenceMarkSettings: { synchronizedEditingEnabled: false },
    designPatent: patentType === "design" ? createBlankDesignPatent() : null,
  };
}

/** Creates an import destination without applying any user or factory five-book templates. */
export function createImportedPatent(
  options: Omit<CreateBlankPatentOptions, "templates">,
  dependencies: Partial<PatentFactoryDependencies> = {},
): CanonicalPatent {
  const createId = dependencies.createId ?? randomUuid;
  return createBlankPatent(
    {
      ...options,
      templates: {
        ...createFactoryPatentTemplates(createId),
        enabled: false,
      },
    },
    { ...dependencies, createId },
  );
}

function normalizePatentName(name: string | null): string | null {
  if (name === null) return null;

  const trimmedName = name.trim();
  return trimmedName.length > 0 ? trimmedName : null;
}

function normalizeCustomer(customer: string | null | undefined): string | null {
  if (customer === null || customer === undefined) return null;

  const trimmedCustomer = customer.trim();
  return trimmedCustomer.length > 0 ? trimmedCustomer : null;
}

function createBlankPatentBook(
  kind: PatentBookKind,
  templates: PatentTemplateSettings["invention"],
  templatesEnabled: boolean,
  name: string | null,
  patentType: PatentType,
  timestamp: string,
  createId: () => string,
): PatentBook {
  if (!templatesEnabled) return createEmptyPatentBook(kind, timestamp, createId);
  if (kind === "description-drawings" || kind === "abstract-drawing") {
    return createBlankDrawingPatentBook(kind, timestamp, createId);
  }

  const document = instantiateBookTemplate({
    template: templates[kind],
    kind,
    patentName: name,
    patentType,
    timestamp,
    createId,
  });

  return {
    bookId: createId(),
    kind,
    document,
    editorState: {},
    localRevision: 0,
    persistedRevision: 0,
  };
}

export function createBlankDrawingPatentBook(
  kind: Extract<PatentBookKind, "description-drawings" | "abstract-drawing">,
  timestamp: string,
  createId: () => string,
): PatentBook {
  return createEmptyPatentBook(kind, timestamp, createId);
}

function createEmptyPatentBook(
  kind: PatentBookKind,
  timestamp: string,
  createId: () => string,
): PatentBook {
  return {
    bookId: createId(),
    kind,
    document: {
      formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
      documentId: createId(),
      title: PATENT_BOOK_LABELS[kind],
      createdAt: timestamp,
      modifiedAt: timestamp,
      page: { ...DEFAULT_PAGE_SETTINGS },
      content: [],
    },
    editorState: {},
    localRevision: 0,
    persistedRevision: 0,
  };
}
