import type { KlecksKeyboardCommand } from "./klecks-keyboard";

export type KlecksPortIdentity = Readonly<{
  sessionId: string;
  viewId: string;
  generation: number;
}>;
export type PortCode =
  | "ACCEPTED"
  | "INVALID_MESSAGE"
  | "STALE_TARGET"
  | "REPLAY"
  | "UNAVAILABLE"
  | "EDITOR_RESOURCE_LIMIT"
  | "COMMAND_FAILED";
type PortReply = { version: 1; sequence: number | null; code: PortCode };
const actions = new Set([
  "undo",
  "redo",
  "copy",
  "copyMerged",
  "cut",
  "paste",
  "pasteInPlace",
  "selectAll",
  "deselect",
  "reselect",
  "invertSelection",
  "clear",
  "fillDialog",
  "fillForeground",
  "fillBackground",
  "fillForegroundPreserve",
  "fillBackgroundPreserve",
  "saveProject",
  "layerViaCopy",
  "mergeLayers",
  "mergeVisible",
  "stampLayers",
  "stampVisible",
  "layerForward",
  "layerBackward",
  "layerToFront",
  "layerToBack",
  "selectAllLayers",
  "deleteLayers",
  "selectLayerAbove",
  "selectLayerBelow",
  "extendLayerAbove",
  "extendLayerBelow",
  "zoomIn",
  "zoomOut",
  "fitCanvas",
  "actualPixels",
  "defaultColors",
  "swapColors",
  "invertMask",
  "targetMask",
  "targetImage",
  "viewMask",
  "transform",
  "smallerBrush",
  "largerBrush",
  "softerBrush",
  "harderBrush",
]);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Control messages only; binary assets use a separately validated data path. */
export function handleKlecksPortRequest(
  input: unknown,
  current: KlecksPortIdentity | null,
  previousSequence: number,
  execute: (command: KlecksKeyboardCommand) => boolean,
): { sequence: number; reply: PortReply } {
  let sequence = previousSequence;
  let requestSequence: number | null = null;
  const reply = (code: PortCode) => ({
    sequence,
    reply: { version: 1 as const, sequence: requestSequence, code },
  });
  if (
    !record(input) ||
    !exact(input, ["version", "sequence", "identity", "action"]) ||
    input.version !== 1 ||
    typeof input.sequence !== "number" ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    typeof input.action !== "string" ||
    !actions.has(input.action) ||
    !record(input.identity)
  )
    return reply("INVALID_MESSAGE");
  requestSequence = input.sequence;
  if (requestSequence <= previousSequence) return reply("REPLAY");
  sequence = requestSequence;
  const identity = input.identity;
  if (
    !exact(identity, ["sessionId", "viewId", "generation"]) ||
    ![identity.sessionId, identity.viewId].every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 200,
    ) ||
    typeof identity.generation !== "number" ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 1
  )
    return reply("INVALID_MESSAGE");
  if (
    !current ||
    identity.sessionId !== current.sessionId ||
    identity.viewId !== current.viewId ||
    identity.generation !== current.generation
  )
    return reply("STALE_TARGET");
  try {
    // ACCEPTED acknowledges dispatch, not asynchronous persistence completion.
    return reply(
      execute({ action: input.action } as KlecksKeyboardCommand) ? "ACCEPTED" : "UNAVAILABLE",
    );
  } catch {
    return reply("COMMAND_FAILED");
  }
}

/** Caller must establish a trusted parent/frame channel before passing this dedicated port. */
export function bindKlecksCommandPort(
  port: MessagePort,
  identity: () => KlecksPortIdentity | null,
  execute: (command: KlecksKeyboardCommand) => boolean,
): () => void {
  let sequence = 0;
  const receive = (event: MessageEvent<unknown>) => {
    if (
      record(event.data) &&
      ["klecks:project", "klecks:documents", "klecks:tools"].includes(event.data.type as string)
    )
      return;
    const result = handleKlecksPortRequest(event.data, identity(), sequence, execute);
    sequence = result.sequence;
    port.postMessage(result.reply);
  };
  port.addEventListener("message", receive);
  port.start();
  return () => {
    port.removeEventListener("message", receive);
    port.close();
  };
}
