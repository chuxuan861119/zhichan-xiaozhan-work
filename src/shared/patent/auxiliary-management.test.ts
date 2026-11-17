import { describe, expect, it } from "vitest";
import {
  adjacentAuxiliaryAfterDelete,
  moveAuxiliaryDocument,
  uniqueAuxiliaryTitle,
} from "./auxiliary-management.js";

describe("auxiliary management", () => {
  it("keeps a different active document and selects the next or previous deleted neighbor", () => {
    expect(adjacentAuxiliaryAfterDelete(["a", "b", "c"], "a", "b")).toBe("a");
    expect(adjacentAuxiliaryAfterDelete(["a", "b", "c"], "b", "b")).toBe("c");
    expect(adjacentAuxiliaryAfterDelete(["a", "b"], "b", "b")).toBe("a");
    expect(adjacentAuxiliaryAfterDelete(["a"], "a", "a")).toBeNull();
    expect(adjacentAuxiliaryAfterDelete(["a"], null, "a")).toBeNull();
  });
  it("creates bounded distinct names", () => {
    expect(uniqueAuxiliaryTitle("材料", ["材料", "材料（2）"])).toBe("材料（3）");
    expect(uniqueAuxiliaryTitle("甲".repeat(200), ["甲".repeat(200)]).length).toBe(200);
  });
  it("moves only the requested neighbor and preserves all objects", () => {
    const docs = ["a", "b", "c"].map((auxiliaryDocumentId) => ({ auxiliaryDocumentId }));
    expect(moveAuxiliaryDocument(docs, "b", "up")).toEqual([docs[1], docs[0], docs[2]]);
    expect(moveAuxiliaryDocument(docs, "c", "down")).toEqual(docs);
    expect(() => moveAuxiliaryDocument(docs, "missing", "up")).toThrow();
    expect(docs.map((item) => item.auxiliaryDocumentId)).toEqual(["a", "b", "c"]);
  });
});
