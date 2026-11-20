import type { KlecksCaseDocuments } from "./klecks-case-documents";
import type { KlecksFrameClient } from "./klecks-frame-client";

/** Model navigation frames the target; ordinary tabs keep each document's viewport. */
export async function activateKlecksView(
  controller: Pick<KlecksCaseDocuments, "activate" | "identity">,
  frame: { tools: Pick<KlecksFrameClient["tools"], "send"> } | null,
  id: string,
  isCurrent: () => boolean,
  fit = false,
) {
  const opened = await controller.activate(id);
  if (!opened || !isCurrent()) return;
  const identity = controller.identity(id);
  if (!identity || !frame) return;
  if (fit) await frame.tools.send(identity, { action: "fit" });
  if (isCurrent()) await frame.tools.send(identity, { action: "focus" });
}
