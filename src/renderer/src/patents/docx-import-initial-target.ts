import {
  type CanonicalPatent,
  PATENT_BOOK_ORDER,
  type PatentBookKind,
} from "../../../shared/patent/model";

export type DocxImportInitialTarget =
  | Readonly<{ kind: "book"; bookKind: PatentBookKind }>
  | Readonly<{ kind: "auxiliary"; auxiliaryDocumentId: string }>;

export function selectDocxImportInitialTarget(
  report: CanonicalPatent["docxImportReport"],
): DocxImportInitialTarget | null {
  let selected: DocxImportInitialTarget | null = null;
  let selectedRank = Number.POSITIVE_INFINITY;

  for (const assignment of report?.assignments ?? []) {
    const rank =
      assignment.target.kind === "official-book"
        ? PATENT_BOOK_ORDER.indexOf(assignment.target.bookKind)
        : PATENT_BOOK_ORDER.length;
    if (rank < 0 || rank >= selectedRank) continue;
    selectedRank = rank;
    selected =
      assignment.target.kind === "official-book"
        ? { kind: "book", bookKind: assignment.target.bookKind }
        : {
            kind: "auxiliary",
            auxiliaryDocumentId: assignment.target.auxiliaryDocumentId,
          };
  }

  return selected;
}
