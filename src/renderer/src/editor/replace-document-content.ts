import type { Node } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";

/** Keep the smallest edit unless fitting an open slice changes the document structure. */
export function replaceDocumentContent(transaction: Transaction, next: Node): Transaction {
  const current = transaction.doc;
  const start = current.content.findDiffStart(next.content);
  if (start === null) return transaction;
  const end = current.content.findDiffEnd(next.content);
  if (!end) return transaction;
  const overlap = Math.max(0, start - Math.min(end.a, end.b));
  const precise = new Transform(current).replace(
    start,
    end.a + overlap,
    next.slice(start, end.b + overlap),
  );
  if (precise.doc.eq(next)) {
    for (const step of precise.steps) transaction.step(step);
    return transaction;
  }

  // A change inside a table followed by a change outside it produces an open
  // slice. ProseMirror may fit that slice by leaving an empty table behind.
  // Replace complete changed blocks instead, retaining unchanged prefix/suffix.
  let first = 0;
  let from = 0;
  while (
    first < current.childCount &&
    first < next.childCount &&
    current.child(first).eq(next.child(first))
  ) {
    from += current.child(first).nodeSize;
    first++;
  }
  let oldEnd = current.content.size;
  let newEnd = next.content.size;
  let oldIndex = current.childCount - 1;
  let newIndex = next.childCount - 1;
  while (
    oldIndex >= first &&
    newIndex >= first &&
    current.child(oldIndex).eq(next.child(newIndex))
  ) {
    oldEnd -= current.child(oldIndex--).nodeSize;
    newEnd -= next.child(newIndex--).nodeSize;
  }
  return transaction.replaceWith(from, oldEnd, next.content.cut(from, newEnd));
}
