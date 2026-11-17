import { readPatdocWorkspace, withPatdocWorkspace } from "./continuation.js";
import { createBlankPatent } from "./defaults.js";

test("portable workspace keeps visible state without changing book content or accepting machine paths", () => {
  const patent = createBlankPatent({ patentType: "invention", name: "接续" });
  const workspace = {
    version: 1 as const,
    activeBookKind: "claims" as const,
    zoomPercent: 113,
    columns: true,
    columnZoomPercent: 87,
    books: [{ bookKind: "claims" as const, scrollTop: 420, selection: { from: 2, to: 5 } }],
    aiCorrectionOpen: false,
    assistantOpen: false,
  };
  const saved = withPatdocWorkspace(patent, workspace);
  expect(readPatdocWorkspace(saved)).toEqual(workspace);
  expect(saved.books.map((book) => book.document)).toEqual(
    patent.books.map((book) => book.document),
  );
  expect(() => withPatdocWorkspace(patent, { ...workspace, path: "C:/private" })).toThrow();
});
