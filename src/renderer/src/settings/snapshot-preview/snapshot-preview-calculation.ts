import {
  PATENT_BOOK_LABELS,
  PATENT_BOOK_ORDER,
  type PatentBookKind,
} from "../../../../shared/patent/model";
import type {
  SnapshotContentPreview,
  SnapshotPreviewVersion,
} from "../../../../shared/snapshot/model";
import { buildSnapshotBookDiff, type SnapshotBookDiff } from "./snapshot-book-diff";
import { buildSnapshotFiguresDiff } from "./snapshot-figures-diff";

export type SnapshotPreviewCalculation = {
  books: SnapshotBookDiff[];
  auxiliary: Record<string, SnapshotBookDiff>;
};

export type SnapshotPreviewCalculationResponse =
  | { ok: true; value: SnapshotPreviewCalculation }
  | { ok: false };

export function figuresForBook(version: SnapshotPreviewVersion | null, bookKind: PatentBookKind) {
  const figures = version?.figures ?? [];
  return bookKind === "abstract-drawing"
    ? figures.filter((figure) => figure.figureId === version?.abstractDrawingFigureId)
    : figures;
}

export function buildSnapshotPreviewCalculation(
  preview: SnapshotContentPreview,
): SnapshotPreviewCalculation {
  const baselineByKind = new Map(preview.baseline?.books.map((book) => [book.kind, book.document]));
  const books = PATENT_BOOK_ORDER.map((bookKind) => {
    const current = preview.current.books.find((book) => book.kind === bookKind);
    if (!current) throw new Error(`快照缺少${PATENT_BOOK_LABELS[bookKind]}`);
    const diff = buildSnapshotBookDiff({
      bookKind,
      baseline: baselineByKind.get(bookKind) ?? null,
      current: current.document,
      baselineRevision: preview.baseline?.revision ?? null,
      currentRevision: preview.current.revision,
    });
    if (
      (bookKind !== "description-drawings" && bookKind !== "abstract-drawing") ||
      !preview.baseline
    )
      return diff;
    const figureChanges = buildSnapshotFiguresDiff({
      bookKind,
      baselineFigures: figuresForBook(preview.baseline, bookKind),
      currentFigures: figuresForBook(preview.current, bookKind),
    });
    return figureChanges.length ? { ...diff, changes: [...figureChanges, ...diff.changes] } : diff;
  });
  const auxiliary: Record<string, SnapshotBookDiff> = {};
  const currentAux = new Map(
    preview.current.auxiliaryDocuments?.map((item) => [item.auxiliaryDocumentId, item]),
  );
  const baselineAux = new Map(
    preview.baseline?.auxiliaryDocuments?.map((item) => [item.auxiliaryDocumentId, item]),
  );
  for (const id of new Set([...currentAux.keys(), ...baselineAux.keys()])) {
    const current = currentAux.get(id);
    const baseline = baselineAux.get(id);
    const item = current ?? baseline;
    if (!item) continue;
    auxiliary[id] = buildSnapshotBookDiff({
      bookKind: "description",
      current: current?.document ?? { ...item.document, content: [] },
      baseline: baseline?.document ?? (preview.baseline ? { ...item.document, content: [] } : null),
      currentRevision: preview.current.revision,
      baselineRevision: preview.baseline?.revision ?? null,
    });
  }
  return { books, auxiliary };
}

// Stop counting as soon as the background threshold is reached; do not stringify large payloads.
export function needsBackgroundSnapshotCalculation(preview: SnapshotContentPreview): boolean {
  const pending: unknown[] = [
    preview.current.books,
    preview.baseline?.books,
    preview.current.auxiliaryDocuments,
    preview.baseline?.auxiliaryDocuments,
  ];
  let size = 0;
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") size += value.length;
    else if (Array.isArray(value)) {
      size += value.length;
      if (size > 6000) return true;
      for (const item of value) pending.push(item);
    } else if (value && typeof value === "object") {
      size += 1;
      pending.push(...Object.values(value));
    }
    if (size > 6000) return true;
  }
  return false;
}
