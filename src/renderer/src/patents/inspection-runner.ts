import type { CanonicalPatent } from "../../../shared/patent/model";
import type {
  InspectionDependency,
  InspectionMode,
  PatentInspectionReport,
} from "../../../shared/patent-inspection/types";
import { inspectionPatch } from "./inspection-protocol";

export function createInspectionRunner(
  createWorker = () =>
    new Worker(new URL("./patent-inspection.worker.ts", import.meta.url), { type: "module" }),
) {
  let worker: Worker | null = null;
  let previous: CanonicalPatent | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let sequence = 0;
  let cancelPending: (() => void) | null = null;
  const dispose = () => {
    if (idle !== null) clearTimeout(idle);
    idle = null;
    worker?.terminate();
    worker = null;
    previous = null;
  };
  const cancel = () => cancelPending?.();
  const inspect = (
    patent: CanonicalPatent,
    mode: InspectionMode = "full",
  ): Promise<PatentInspectionReport> => {
    cancel();
    if (idle !== null) clearTimeout(idle);
    worker ??= createWorker();
    const target = worker;
    const id = ++sequence;
    const changed: InspectionDependency[] = [];
    if (previous?.patentId === patent.patentId) {
      for (const book of patent.books) {
        if (previous.books.find((item) => item.kind === book.kind)?.document !== book.document)
          changed.push(book.kind);
      }
      if (previous.assets !== patent.assets) changed.push("assets");
      if (
        previous.figures !== patent.figures ||
        previous.abstractDrawingFigureId !== patent.abstractDrawingFigureId
      )
        changed.push("figures");
      if (
        previous.referenceMarks !== patent.referenceMarks ||
        previous.referenceMarkSettings !== patent.referenceMarkSettings
      )
        changed.push("reference-marks");
      changed.push("patent-metadata");
    }
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timeout);
        cancelPending = null;
      };
      const fail = () => {
        if (target !== worker || id !== sequence) return;
        finish();
        dispose();
        reject(new Error("后台检查未完成，请重试。"));
      };
      const timeout = setTimeout(fail, 15000);
      cancelPending = fail;
      target.onmessage = (event) => {
        if (event.data.id !== id || target !== worker || id !== sequence) return;
        finish();
        previous = patent;
        idle = setTimeout(dispose, 30_000);
        resolve(event.data.report as PatentInspectionReport);
      };
      target.onerror = fail;
      try {
        target.postMessage(
          previous?.patentId === patent.patentId
            ? { id, mode, changed, patch: inspectionPatch(previous, patent) }
            : { id, patent, mode, changed: "unknown" },
        );
      } catch {
        fail();
      }
    });
  };
  return {
    inspect,
    cancel,
    dispose: () => {
      cancel();
      dispose();
    },
  };
}
