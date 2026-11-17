import type { BlockNode } from "../document/model.js";
import { parseClaimReferences } from "../patent/claim-reference-expression.js";
import {
  type ClaimStructureWarning,
  claimStructureWarnings,
  parseClaimParagraphs,
} from "../patent/claim-text-tools.js";
import type { DescriptionChapterKind } from "../patent/description.js";
import { type CanonicalPatent, PATENT_BOOK_ORDER, type PatentBookKind } from "../patent/model.js";
import { visibleBlockText, visiblePatentBookText } from "../patent/text.js";
import { inspectionTextBlocks } from "./blocks.js";
import {
  buildClaimGraph,
  type ClaimFact,
  type ClaimGraph,
  ClaimGraphInputError,
} from "./claim-graph.js";
import { inspectionChapterKind } from "./description-input.js";
import { extractFormulaFacts, type FormulaFact } from "./formula-facts.js";
import { extractNumericFacts, type NumericFact } from "./numeric-facts.js";
import {
  extractSemanticCandidateFactsForBooks,
  type SemanticCandidateFact,
} from "./semantic-candidate-facts.js";
import type { InspectionDependency, InspectionMode, PatentLocation } from "./types.js";

export type PatentBookFacts = Readonly<{
  visibleText: string;
  chapters: ReadonlyMap<DescriptionChapterKind, Readonly<{ headingId: string; bodyText: string }>>;
}>;

export type ClaimStructureFact = Readonly<ClaimStructureWarning & { targetId: string | null }>;

export type DrawingReferenceFact = Readonly<{
  bookKind: PatentBookKind;
  targetId: string;
  figureNumber: number;
}>;

export type PatentFactSource = Readonly<{
  patentId: string;
  revision: number;
  snapshotFingerprint: string;
}>;

export type PatentFactIndex = Readonly<{
  source: PatentFactSource;
  books: ReadonlyMap<PatentBookKind, PatentBookFacts>;
  claims: readonly ClaimFact[];
  claimStructureWarnings: readonly ClaimStructureFact[];
  drawingReferences: readonly DrawingReferenceFact[];
  assetsById: ReadonlyMap<string, CanonicalPatent["assets"][number]>;
  full: null | Readonly<{
    claimGraph: ClaimGraph | null;
    numeric: readonly NumericFact[];
    formulas: readonly FormulaFact[];
    semanticCandidates: readonly SemanticCandidateFact[];
  }>;
}>;

export type BuildPatentFactIndexOptions = Readonly<{
  previous?: PatentFactIndex | null;
  changedDependencies?: ReadonlySet<InspectionDependency> | "unknown";
}>;

const KNOWN_INSPECTION_DEPENDENCIES = new Set<string>([
  "claims",
  "description",
  "description-drawings",
  "abstract",
  "abstract-drawing",
  "patent-metadata",
  "figures",
  "assets",
  "reference-marks",
]);

export function buildPatentFactIndex(
  patent: CanonicalPatent,
  mode: InspectionMode = "full",
  options: BuildPatentFactIndexOptions = {},
): PatentFactIndex {
  const source = createPatentFactSource(patent);
  const previous = options.previous;
  const changedDependencies = options.changedDependencies;
  const changedDependencySet =
    typeof changedDependencies === "string" ? undefined : changedDependencies;
  const canReuseBase =
    previous !== null &&
    previous !== undefined &&
    previous.source.patentId === source.patentId &&
    changedDependencySet !== undefined &&
    hasOnlyKnownDependencies(changedDependencySet);
  const canReuseBook = (kind: PatentBookKind) => canReuseBase && !changedDependencySet?.has(kind);
  const canReuseClaims = canReuseBook("claims");
  const canReuseDrawingReferences =
    canReuseBase && !PATENT_BOOK_ORDER.some((kind) => changedDependencySet?.has(kind));
  const canReuseAssets = canReuseBase && !changedDependencySet?.has("assets");
  const books = new Map(
    patent.books.map((book) => [
      book.kind,
      canReuseBook(book.kind)
        ? (previous?.books.get(book.kind) ?? {
            visibleText: visiblePatentBookText(book.document),
            chapters:
              book.kind === "description"
                ? buildDescriptionChapters(book.document.content)
                : new Map(),
          })
        : {
            visibleText: visiblePatentBookText(book.document),
            chapters:
              book.kind === "description"
                ? buildDescriptionChapters(book.document.content)
                : new Map(),
          },
    ]),
  );

  const claimsBook = patent.books.find((book) => book.kind === "claims");
  const claimParagraphs = (canReuseClaims ? [] : (claimsBook?.document.content ?? [])).flatMap(
    (block) =>
      block.type === "paragraph" ? [{ paragraphId: block.id, text: visibleBlockText(block) }] : [],
  );
  const claimStructure = parseClaimParagraphs(claimParagraphs.map((paragraph) => paragraph.text));
  const claims = canReuseClaims
    ? (previous?.claims ?? [])
    : claimStructure.claims.map((claim) => {
        const {
          numbers: referencedNumbers,
          error: referenceError,
          alternative,
        } = parseClaimReferences(claim.text);
        return {
          number: claim.number,
          paragraphId: claimParagraphs[claim.startParagraphIndex]?.paragraphId ?? "",
          paragraphIds: claimParagraphs
            .slice(claim.startParagraphIndex, claim.endParagraphIndex)
            .map((paragraph) => paragraph.paragraphId),
          paragraphs: claimParagraphs
            .slice(claim.startParagraphIndex, claim.endParagraphIndex)
            .map((paragraph) => ({ paragraphId: paragraph.paragraphId, text: paragraph.text })),
          text: claim.text,
          kind: referencedNumbers.length === 0 ? ("independent" as const) : ("dependent" as const),
          subjectName: extractClaimSubjectName(claim.text),
          referencedNumbers,
          ...(referenceError ? { referenceError } : {}),
          multipleDependent: referencedNumbers.length > 1,
          alternativeReference: alternative,
        };
      });
  const structureWarnings = canReuseClaims
    ? (previous?.claimStructureWarnings ?? [])
    : claimStructureWarnings(claimStructure).map((warning) => ({
        ...warning,
        targetId: claimParagraphs[warning.paragraphIndex]?.paragraphId ?? null,
      }));

  const drawingReferences = canReuseDrawingReferences
    ? (previous?.drawingReferences ?? [])
    : patent.books.flatMap((book) =>
        book.document.content.flatMap((block) =>
          [...visibleBlockText(block).matchAll(/图\s*(\d+)/gu)].map((match) => ({
            bookKind: book.kind,
            targetId: block.id,
            figureNumber: Number(match[1]),
          })),
        ),
      );

  const base: Omit<PatentFactIndex, "full"> = {
    source,
    books,
    claims,
    claimStructureWarnings: structureWarnings,
    drawingReferences,
    assetsById: canReuseAssets
      ? (previous?.assetsById ?? new Map(patent.assets.map((asset) => [asset.assetId, asset])))
      : new Map(patent.assets.map((asset) => [asset.assetId, asset])),
  };

  if (mode === "instant") return { ...base, full: null };

  const previousFull = previous?.full;
  const sameSource =
    previous !== null && previous !== undefined && isSamePatentFactSource(previous.source, source);
  const claimGraph =
    previousFull && sameSource && canReuse(["claims"], changedDependencySet)
      ? previousFull.claimGraph
      : buildInspectableClaimGraph(claims);
  const numeric =
    previousFull && sameSource && canReuse(numericDependencies(patent), changedDependencySet)
      ? previousFull.numeric
      : buildNumericFacts(patent);
  const formulas =
    previousFull && sameSource && canReuse(formulaDependencies(patent), changedDependencySet)
      ? previousFull.formulas
      : buildFormulaFacts(patent);
  const semanticCandidates =
    previousFull && sameSource && canReuse(semanticDependencies(patent), changedDependencySet)
      ? previousFull.semanticCandidates
      : buildSemanticCandidates(patent);

  return {
    ...base,
    full: { claimGraph, numeric, formulas, semanticCandidates },
  };
}

function buildInspectableClaimGraph(claims: readonly ClaimFact[]): ClaimGraph | null {
  try {
    return buildClaimGraph(claims);
  } catch (error) {
    // Invalid numbering is editable document content, not a failure of all facts.
    // Graph-dependent rules report degradation; independent rules still run.
    if (error instanceof ClaimGraphInputError) return null;
    throw error;
  }
}

function canReuse(
  dependencies: readonly InspectionDependency[],
  changedDependencies: ReadonlySet<InspectionDependency> | undefined,
): boolean {
  if (changedDependencies === undefined) return false;
  for (const dependency of changedDependencies) {
    if (!KNOWN_INSPECTION_DEPENDENCIES.has(String(dependency))) return false;
  }
  return !dependencies.some((dependency) => changedDependencies.has(dependency));
}

function hasOnlyKnownDependencies(changedDependencies: ReadonlySet<InspectionDependency>): boolean {
  return [...changedDependencies].every((dependency) =>
    KNOWN_INSPECTION_DEPENDENCIES.has(String(dependency)),
  );
}

export function createPatentFactSource(patent: CanonicalPatent): PatentFactSource {
  return {
    patentId: patent.patentId,
    revision: patent.revision,
    snapshotFingerprint: fingerprintCanonicalPatent(patent),
  };
}

function isSamePatentFactSource(
  previous: PatentFactSource | undefined,
  current: PatentFactSource,
): boolean {
  return (
    previous !== undefined &&
    previous.patentId === current.patentId &&
    previous.revision === current.revision &&
    previous.snapshotFingerprint === current.snapshotFingerprint
  );
}

function fingerprintCanonicalPatent(patent: CanonicalPatent): string {
  const serialized = JSON.stringify(canonicalizeForFingerprint(patent)) ?? "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForFingerprint);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalizeForFingerprint(record[key])]),
  );
}

function numericDependencies(patent: CanonicalPatent): readonly InspectionDependency[] {
  return patent.books.map((book) => book.kind);
}

function formulaDependencies(patent: CanonicalPatent): readonly InspectionDependency[] {
  return patent.books.map((book) => book.kind);
}

function semanticDependencies(patent: CanonicalPatent): readonly InspectionDependency[] {
  return [...patent.books.map((book) => book.kind), "patent-metadata"] as InspectionDependency[];
}

function buildNumericFacts(patent: CanonicalPatent): readonly NumericFact[] {
  return patent.books.flatMap((book) =>
    inspectionTextBlocks(book.document.content).flatMap((block) => {
      const text = block.text;
      if (!text) return [];
      return extractNumericFacts(text, bookLocation(book.kind, block.id));
    }),
  );
}

function buildFormulaFacts(patent: CanonicalPatent): readonly FormulaFact[] {
  return patent.books.flatMap((book) =>
    book.document.content.flatMap((block) =>
      block.type === "block-formula"
        ? extractFormulaFacts(block, bookLocation(book.kind, block.id))
        : [],
    ),
  );
}

function buildSemanticCandidates(patent: CanonicalPatent): readonly SemanticCandidateFact[] {
  return extractSemanticCandidateFactsForBooks(
    patent.books.flatMap((book) =>
      book.document.content.map((block) => ({
        bookKind: book.kind,
        targetId: block.id,
        text: visibleBlockText(block),
      })),
    ),
  );
}

function bookLocation(bookKind: PatentBookKind, targetId: string): PatentLocation {
  return { kind: "book", bookKind, targetId };
}

function extractClaimSubjectName(text: string): string | null {
  const normalized = text.replace(/^\s*\d+[.．、]\s*/u, "");
  const independent = normalized.match(
    /^(?:一种|一项|一套|多个|若干)\s*([^，,：:。；;]+?)(?=，|,|：|:|。|；|;|其特征|包括|包含|具有|$)/u,
  )?.[1];
  if (independent?.trim()) return independent.trim();
  const dependent = normalized.match(
    /所述的\s*([^，,：:。；;]+?)(?=，|,|：|:|。|；|;|其特征|包括|包含|具有|$)/u,
  )?.[1];
  return dependent?.trim() || null;
}

function buildDescriptionChapters(
  content: readonly BlockNode[],
): ReadonlyMap<DescriptionChapterKind, Readonly<{ headingId: string; bodyText: string }>> {
  const chapters = new Map<DescriptionChapterKind, { headingId: string; bodyText: string }>();
  let current: DescriptionChapterKind | null = null;
  let parent: DescriptionChapterKind | null = null;

  for (const block of content) {
    const chapterKind = inspectionChapterKind(block);
    if (chapterKind) {
      const subsection =
        chapterKind === "technical-problem" || chapterKind === "technical-solution";
      if (!subsection) parent = chapterKind === "invention-content" ? chapterKind : null;
      current = chapterKind;
      if (!chapters.has(current)) chapters.set(current, { headingId: block.id, bodyText: "" });
      continue;
    }
    if (!current) continue;
    const chapter = chapters.get(current);
    if (!chapter) continue;
    chapter.bodyText += visibleBlockText(block);
    if (parent && current !== parent) {
      const parentChapter = chapters.get(parent);
      if (parentChapter) parentChapter.bodyText += visibleBlockText(block);
    }
  }

  return chapters;
}
