import type { CanonicalPatent } from "../../../shared/patent/model";
import { DEFAULT_PATENT_INSPECTION_RULES } from "../../../shared/patent-inspection/default-rules";
import { runPatentInspection } from "../../../shared/patent-inspection/engine";
import {
  buildPatentFactIndex,
  type PatentFactIndex,
} from "../../../shared/patent-inspection/facts";
import { applyInspectionPatch, type InspectionRequest } from "./inspection-protocol";

let previous: PatentFactIndex | null = null;
let current: CanonicalPatent | null = null;
self.onmessage = (event: MessageEvent<InspectionRequest>) => {
  const { id, mode, changed } = event.data;
  if (event.data.patent) current = event.data.patent;
  else if (current && event.data.patch) current = applyInspectionPatch(current, event.data.patch);
  else throw new Error("后台检查快照缺失。");
  let facts: PatentFactIndex | null = null;
  const report = runPatentInspection(current, DEFAULT_PATENT_INSPECTION_RULES, {
    mode,
    buildFacts: (patent, requestedMode) => {
      facts = buildPatentFactIndex(patent, requestedMode, {
        previous,
        changedDependencies: changed === "unknown" ? "unknown" : new Set(changed),
      });
      return facts;
    },
  });
  previous = facts;
  self.postMessage({ id, report });
};
