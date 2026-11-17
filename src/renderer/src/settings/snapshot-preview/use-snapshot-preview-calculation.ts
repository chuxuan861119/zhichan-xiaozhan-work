import { useEffect, useMemo, useState } from "react";
import type { SnapshotContentPreview } from "../../../../shared/snapshot/model";
import {
  buildSnapshotPreviewCalculation,
  needsBackgroundSnapshotCalculation,
  type SnapshotPreviewCalculation,
  type SnapshotPreviewCalculationResponse,
} from "./snapshot-preview-calculation";

export function useSnapshotPreviewCalculation(preview: SnapshotContentPreview) {
  const background = useMemo(() => needsBackgroundSnapshotCalculation(preview), [preview]);
  const immediate = useMemo(
    () => (background ? null : buildSnapshotPreviewCalculation(preview)),
    [background, preview],
  );
  const [attempt, setAttempt] = useState(0);
  const [completed, setCompleted] = useState<{
    preview: SnapshotContentPreview;
    attempt: number;
    value: SnapshotPreviewCalculation | null;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    if (!background) return;
    let cancelled = false;
    let terminated = false;
    let worker: Worker | undefined;
    const terminate = () => {
      if (!terminated) {
        terminated = true;
        worker?.terminate();
      }
    };
    const finish = (response: SnapshotPreviewCalculationResponse) => {
      if (cancelled || terminated) return;
      setCompleted({
        preview,
        attempt,
        value: response.ok ? response.value : null,
        failed: !response.ok,
      });
      terminate();
    };
    try {
      worker = new Worker(new URL("./snapshot-preview.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<SnapshotPreviewCalculationResponse>) =>
        finish(event.data);
      worker.onerror = () => finish({ ok: false });
      worker.onmessageerror = () => finish({ ok: false });
      worker.postMessage(preview);
    } catch {
      finish({ ok: false });
    }
    return () => {
      cancelled = true;
      terminate();
    };
  }, [attempt, background, preview]);
  const result = completed?.preview === preview && completed.attempt === attempt ? completed : null;
  return {
    value: immediate ?? result?.value ?? null,
    failed: background && (result?.failed ?? false),
    retry: () => setAttempt((value) => value + 1),
  };
}
