import type { CanonicalPatent, PatentBook } from "../../../shared/patent/model";
import type { InspectionDependency, InspectionMode } from "../../../shared/patent-inspection/types";

export type InspectionPatch = {
  fields: Partial<Omit<CanonicalPatent, "books">>;
  books: Array<{ kind: PatentBook["kind"]; fields: Partial<PatentBook> }>;
};
export type InspectionRequest = {
  id: number;
  mode: InspectionMode;
  changed: InspectionDependency[] | "unknown";
  patent?: CanonicalPatent;
  patch?: InspectionPatch;
};

/** Private immutable renderer snapshots; a cancelled/restarted worker receives a full snapshot. */
export function inspectionPatch(previous: CanonicalPatent, next: CanonicalPatent): InspectionPatch {
  const fields: InspectionPatch["fields"] = {};
  for (const key of Object.keys(next) as Array<keyof CanonicalPatent>) {
    if (key !== "books" && next[key] !== previous[key]) Object.assign(fields, { [key]: next[key] });
  }
  const books: InspectionPatch["books"] = [];
  for (const book of next.books) {
    const old = previous.books.find((item) => item.kind === book.kind);
    const changes: Partial<PatentBook> = {};
    for (const key of Object.keys(book) as Array<keyof PatentBook>) {
      if (book[key] !== old?.[key]) Object.assign(changes, { [key]: book[key] });
    }
    if (Object.keys(changes).length) books.push({ kind: book.kind, fields: changes });
  }
  return { fields, books };
}

export function applyInspectionPatch(
  previous: CanonicalPatent,
  patch: InspectionPatch,
): CanonicalPatent {
  return {
    ...previous,
    ...patch.fields,
    books: previous.books.map((book) => {
      const changed = patch.books.find((item) => item.kind === book.kind);
      return changed ? { ...book, ...changed.fields } : book;
    }),
  };
}
