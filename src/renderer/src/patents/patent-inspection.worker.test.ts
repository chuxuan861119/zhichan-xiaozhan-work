import { createBlankPatent } from "../../../shared/patent/defaults";
import { inspectPatent } from "../../../shared/patent/validation";
import type { PatentInspectionReport } from "../../../shared/patent-inspection/types";
import { type InspectionRequest, inspectionPatch } from "./inspection-protocol";

test("worker snapshots and incremental facts retain instant and full inspection results", async () => {
  const scope = {
    onmessage: null as ((event: MessageEvent<InspectionRequest>) => void) | null,
    postMessage: vi.fn(),
  };
  vi.stubGlobal("self", scope);
  try {
    await import("./patent-inspection.worker");
    const previous = createBlankPatent({ patentType: "invention", name: "检查等效性" });
    const next = {
      ...previous,
      revision: 1,
      books: previous.books.map((book) =>
        book.kind === "description"
          ? {
              ...book,
              document: { ...book.document, content: book.document.content.slice(0, 1) },
            }
          : book,
      ),
    };
    const send = (request: InspectionRequest, expected: typeof previous) => {
      scope.onmessage?.(new MessageEvent("message", { data: structuredClone(request) }));
      const response = scope.postMessage.mock.lastCall?.[0] as {
        id: number;
        report: PatentInspectionReport;
      };
      expect(response.id).toBe(request.id);
      const complete = inspectPatent(expected, request.mode);
      expect(response.report.issues).toEqual(complete.issues);
      expect(response.report.degradedRules).toEqual(complete.degradedRules);
    };
    send({ id: 1, patent: previous, mode: "instant", changed: "unknown" }, previous);
    send(
      {
        id: 2,
        patch: inspectionPatch(previous, next),
        mode: "instant",
        changed: ["description", "patent-metadata"],
      },
      next,
    );
    send({ id: 3, patch: inspectionPatch(next, next), mode: "full", changed: [] }, next);
    send(
      {
        id: 4,
        patch: inspectionPatch(next, previous),
        mode: "full",
        changed: ["description", "patent-metadata"],
      },
      previous,
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
