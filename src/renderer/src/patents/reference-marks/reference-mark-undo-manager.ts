import type { PatentBookDocument } from "../../../../shared/document/model";
import type { JsonObject } from "../../../../shared/ipc/primitives";
import type { CanonicalPatent, PatentBookKind } from "../../../../shared/patent/model";
import type {
  PatentReferenceMark,
  PatentReferenceMarkSettings,
} from "../../../../shared/patent/reference-marks";
import { nextHistoryOrder } from "../history/history-order";

export type ReferenceHistoryBookKind = Extract<
  PatentBookKind,
  "claims" | "description" | "abstract" | "description-drawings" | "abstract-drawing"
>;

type ReferenceHistoryOwnership = {
  referenceMarks: boolean;
  referenceMarkSettings: boolean;
  bookKinds: PatentBookKind[];
};

export type ReferenceHistoryPoint = {
  order: number;
  patentId: string;
  ownerBookKind: ReferenceHistoryBookKind;
  before: CanonicalPatent;
  after: CanonicalPatent;
  owned: ReferenceHistoryOwnership;
};

export type ReferenceHistoryEdit = {
  referenceMarks: PatentReferenceMark[];
  referenceMarkSettings: PatentReferenceMarkSettings;
  bookEdits: Array<{
    bookKind: PatentBookKind;
    document: PatentBookDocument;
    editorState: JsonObject;
  }>;
};

export type ReferenceHistoryTransition = {
  direction: "undo" | "redo";
  point: ReferenceHistoryPoint;
  edit: ReferenceHistoryEdit;
};

type HistoryBucket = {
  undo: ReferenceHistoryPoint[];
  redo: ReferenceHistoryPoint[];
};

const MAX_HISTORY_POINTS = 100;

function bucketKey(patentId: string, ownerBookKind: ReferenceHistoryBookKind): string {
  return `${patentId}:${ownerBookKind}`;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function equalDocument(left: PatentBookDocument, right: PatentBookDocument): boolean {
  const { modifiedAt: _leftModifiedAt, ...leftComparable } = left;
  const { modifiedAt: _rightModifiedAt, ...rightComparable } = right;
  return equal(leftComparable, rightComparable);
}

function ownership(
  before: CanonicalPatent,
  after: CanonicalPatent,
  ownerBookKind: ReferenceHistoryBookKind,
): ReferenceHistoryOwnership | null {
  const changed = {
    referenceMarks: !equal(before.referenceMarks, after.referenceMarks),
    referenceMarkSettings: !equal(before.referenceMarkSettings, after.referenceMarkSettings),
    bookKinds: after.books.flatMap((book) => {
      const previous = before.books.find((candidate) => candidate.kind === book.kind);
      return previous &&
        equalDocument(previous.document, book.document) &&
        equal(previous.editorState, book.editorState)
        ? []
        : [book.kind];
    }),
  };
  if (!changed.referenceMarks && !changed.referenceMarkSettings && changed.bookKinds.length === 0) {
    return null;
  }
  if (!changed.bookKinds.includes(ownerBookKind)) changed.bookKinds.push(ownerBookKind);
  return changed;
}

function matchesExpected(
  point: ReferenceHistoryPoint,
  current: CanonicalPatent,
  expected: CanonicalPatent,
): boolean {
  if (point.owned.referenceMarks && !equal(current.referenceMarks, expected.referenceMarks)) {
    return false;
  }
  if (
    point.owned.referenceMarkSettings &&
    !equal(current.referenceMarkSettings, expected.referenceMarkSettings)
  ) {
    return false;
  }
  return point.owned.bookKinds.every((bookKind) => {
    const currentBook = current.books.find((book) => book.kind === bookKind);
    const expectedBook = expected.books.find((book) => book.kind === bookKind);
    return (
      currentBook !== undefined &&
      expectedBook !== undefined &&
      equalDocument(currentBook.document, expectedBook.document) &&
      equal(currentBook.editorState, expectedBook.editorState)
    );
  });
}

function createEdit(
  point: ReferenceHistoryPoint,
  current: CanonicalPatent,
  target: CanonicalPatent,
): ReferenceHistoryEdit {
  return {
    referenceMarks: structuredClone(
      point.owned.referenceMarks ? target.referenceMarks : current.referenceMarks,
    ),
    referenceMarkSettings: structuredClone(
      point.owned.referenceMarkSettings
        ? target.referenceMarkSettings
        : current.referenceMarkSettings,
    ),
    bookEdits: point.owned.bookKinds.map((bookKind) => {
      const book = target.books.find((candidate) => candidate.kind === bookKind);
      if (!book) throw new Error(`标号历史缺少书册：${bookKind}`);
      return {
        bookKind,
        document: structuredClone(book.document),
        editorState: structuredClone(book.editorState),
      };
    }),
  };
}

function clonePoint(point: ReferenceHistoryPoint): ReferenceHistoryPoint {
  return structuredClone(point);
}

export class ReferenceMarkUndoManager {
  readonly #buckets = new Map<string, HistoryBucket>();

  record(input: Omit<ReferenceHistoryPoint, "owned" | "order">): boolean {
    const owned = ownership(input.before, input.after, input.ownerBookKind);
    if (!owned) return false;
    const key = bucketKey(input.patentId, input.ownerBookKind);
    const bucket = this.#buckets.get(key) ?? { undo: [], redo: [] };
    bucket.undo.push(clonePoint({ ...input, owned, order: nextHistoryOrder() }));
    if (bucket.undo.length > MAX_HISTORY_POINTS) bucket.undo.shift();
    bucket.redo = [];
    this.#buckets.set(key, bucket);
    return true;
  }

  canUndo(
    patentId: string,
    ownerBookKind: ReferenceHistoryBookKind,
    current: CanonicalPatent,
  ): boolean {
    const point = this.#buckets.get(bucketKey(patentId, ownerBookKind))?.undo.at(-1);
    return point ? matchesExpected(point, current, point.after) : false;
  }

  canRedo(
    patentId: string,
    ownerBookKind: ReferenceHistoryBookKind,
    current: CanonicalPatent,
  ): boolean {
    const point = this.#buckets.get(bucketKey(patentId, ownerBookKind))?.redo.at(-1);
    return point ? matchesExpected(point, current, point.before) : false;
  }

  takeUndo(
    patentId: string,
    ownerBookKind: ReferenceHistoryBookKind,
    current: CanonicalPatent,
  ): ReferenceHistoryTransition | null {
    return this.#take(patentId, ownerBookKind, current, "undo");
  }

  takeRedo(
    patentId: string,
    ownerBookKind: ReferenceHistoryBookKind,
    current: CanonicalPatent,
  ): ReferenceHistoryTransition | null {
    return this.#take(patentId, ownerBookKind, current, "redo");
  }

  commitUndo(transition: ReferenceHistoryTransition): boolean {
    return this.#commit(transition, "undo");
  }

  commitRedo(transition: ReferenceHistoryTransition): boolean {
    return this.#commit(transition, "redo");
  }

  invalidate(patentId: string): void {
    const prefix = `${patentId}:`;
    for (const key of this.#buckets.keys()) {
      if (key.startsWith(prefix)) this.#buckets.delete(key);
    }
  }

  discardRedoForEdit(patentId: string, bookKind: PatentBookKind): void {
    for (const bucket of this.#buckets.values()) {
      if (
        bucket.redo.some(
          (point) =>
            point.patentId === patentId &&
            (point.ownerBookKind === bookKind || point.owned.bookKinds.includes(bookKind)),
        )
      ) {
        bucket.redo = [];
      }
    }
  }

  order(
    patentId: string,
    owner: ReferenceHistoryBookKind,
    current: CanonicalPatent,
    direction: "undo" | "redo",
  ): number {
    const point = this.#buckets.get(bucketKey(patentId, owner))?.[direction].at(-1);
    if (!point) return 0;
    return matchesExpected(point, current, direction === "undo" ? point.after : point.before)
      ? point.order
      : 0;
  }

  #take(
    patentId: string,
    ownerBookKind: ReferenceHistoryBookKind,
    current: CanonicalPatent,
    direction: "undo" | "redo",
  ): ReferenceHistoryTransition | null {
    const point = this.#buckets.get(bucketKey(patentId, ownerBookKind))?.[direction].at(-1);
    if (!point) return null;
    const expected = direction === "undo" ? point.after : point.before;
    if (!matchesExpected(point, current, expected)) return null;
    const target = direction === "undo" ? point.before : point.after;
    return { direction, point, edit: createEdit(point, current, target) };
  }

  #commit(transition: ReferenceHistoryTransition, direction: "undo" | "redo"): boolean {
    if (transition.direction !== direction) return false;
    const key = bucketKey(transition.point.patentId, transition.point.ownerBookKind);
    const bucket = this.#buckets.get(key);
    if (!bucket || bucket[direction].at(-1) !== transition.point) return false;
    bucket[direction].pop();
    transition.point.order = nextHistoryOrder();
    const destination = direction === "undo" ? bucket.redo : bucket.undo;
    destination.push(transition.point);
    if (destination.length > MAX_HISTORY_POINTS) destination.shift();
    return true;
  }
}
