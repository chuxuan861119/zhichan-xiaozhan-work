import type { CanonicalPatent } from "../../../../shared/patent/model";
import { inspectReferenceMarkStatus } from "../../../../shared/patent/reference-mark-operations";

self.onmessage = (event: MessageEvent<CanonicalPatent>) => {
  self.postMessage(inspectReferenceMarkStatus(event.data));
};
