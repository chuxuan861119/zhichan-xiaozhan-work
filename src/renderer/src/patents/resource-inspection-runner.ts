import type { CanonicalPatent } from "../../../shared/patent/model";
import {
  mergeResourceHealth,
  type ResourceHealthResult,
  resourceLocations,
} from "../../../shared/patent-inspection/resource-health";
import type {
  InspectionMode,
  PatentInspectionReport,
} from "../../../shared/patent-inspection/types";

type Runner = {
  inspect(patent: CanonicalPatent, mode?: InspectionMode): Promise<PatentInspectionReport>;
  cancel(): void;
  dispose(): void;
};
export function withResourceInspection(
  base: Runner,
  check: (patent: CanonicalPatent, signal: AbortSignal) => Promise<ResourceHealthResult>,
) {
  let current: AbortController | null = null;
  const cancel = () => {
    current?.abort();
    current = null;
    base.cancel();
  };
  return {
    cancel,
    dispose: () => {
      cancel();
      base.dispose();
    },
    async inspect(patent: CanonicalPatent, mode: InspectionMode = "full") {
      cancel();
      const controller = new AbortController();
      current = controller;
      try {
        const report = await base.inspect(patent, mode);
        controller.signal.throwIfAborted();
        if (mode !== "full" || !resourceLocations(patent).size) return report;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const aborted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("检查已停止。")), {
            once: true,
          });
          timeout = setTimeout(() => controller.abort(), 16_000);
        });
        try {
          const result = await Promise.race([check(patent, controller.signal), aborted]);
          controller.signal.throwIfAborted();
          return mergeResourceHealth(report, patent, result);
        } catch {
          controller.signal.throwIfAborted();
          return report;
        } finally {
          clearTimeout(timeout);
        }
      } finally {
        if (current === controller) current = null;
      }
    },
  };
}
