import type { SnapshotContentPreview } from "../../../../shared/snapshot/model";
import {
  buildSnapshotPreviewCalculation,
  type SnapshotPreviewCalculationResponse,
} from "./snapshot-preview-calculation";

self.onmessage = (event: MessageEvent<SnapshotContentPreview>) => {
  let response: SnapshotPreviewCalculationResponse;
  try {
    response = { ok: true, value: buildSnapshotPreviewCalculation(event.data) };
  } catch {
    response = { ok: false };
  }
  self.postMessage(response);
};
