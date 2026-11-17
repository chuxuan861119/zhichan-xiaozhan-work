import { moveReferenceOrder, reconcileReferenceOrder } from "./reference-mark-order";

test("keeps saved positions, drops stale duplicates and appends new marks", () => {
  expect(reconcileReferenceOrder(["a", "b", "c"], ["b", "old", "b", "a"])).toEqual(["b", "a", "c"]);
});
test("moves in both directions without changing identities or the source", () => {
  const ids = ["a", "b", "c"];
  expect(moveReferenceOrder(ids, "a", "c")).toEqual(["b", "c", "a"]);
  expect(moveReferenceOrder(ids, "c", "a")).toEqual(["c", "a", "b"]);
  expect(moveReferenceOrder(ids, "missing", "a")).toEqual(ids);
  expect(ids).toEqual(["a", "b", "c"]);
});
