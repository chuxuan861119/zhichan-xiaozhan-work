import { useEffect, useMemo, useRef } from "react";
import type { CanonicalPatent } from "../../../shared/patent/model";
import type { InspectionMode } from "../../../shared/patent-inspection/types";
import { createInspectionRunner } from "./inspection-runner";
import { withResourceInspection } from "./resource-inspection-runner";
import { usePatentInspection } from "./use-patent-inspection";

export function useBackgroundPatentInspection(
  patent: CanonicalPatent | null,
  sessionId: string | null = null,
  automaticMode: InspectionMode = "instant",
) {
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const runner = useMemo(
    () =>
      withResourceInspection(createInspectionRunner(), async (patent, signal) => {
        const sessionId = sessionRef.current;
        const api = window.patentApi?.patents;
        if (!sessionId || !api?.inspectResources) throw new Error("资源核验不可用。");
        const operationId = crypto.randomUUID();
        const cancel = () => {
          void api.cancelResourceInspection?.({ sessionId, operationId }).catch(() => undefined);
        };
        signal.throwIfAborted();
        signal.addEventListener("abort", cancel, { once: true });
        try {
          const result = await api.inspectResources({
            sessionId,
            operationId,
            patentId: patent.patentId,
            expectedRevision: patent.revision,
          });
          signal.throwIfAborted();
          if (!result.ok) throw new Error("资源核验未完成。");
          return result.value;
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      }),
    [],
  );
  useEffect(() => () => runner.dispose(), [runner]);
  return usePatentInspection(patent, { ...runner, automaticMode });
}
