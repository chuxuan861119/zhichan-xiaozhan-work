import { z } from "zod";
import {
  TextPolishConversationSnapshotSchema,
  TextPolishInputDraftSchema,
} from "../ai-correction/text-polish-contract.js";

// Covers 2 MiB dialogue plus 100 x 20,000-character reasoning blocks and JSON overhead.
export const MAX_TEXT_POLISH_HISTORY_JSON_BYTES = 16 * 1024 * 1024;

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const file = `(?:active\\.json|draft-(?:new|${uuid})\\.json|conversation-${uuid}\\.json)`;
export const textPolishHistoryPathPattern = new RegExp(
  `^text-polish-history/(${uuid})/(${file})(?:\\.unreadable-${uuid})?$`,
  "u",
);

/** Remove only the known transient field; preserve all other JSON data, including recovery data. */
export function stripTextPolishReasoning(bytes: Uint8Array): Uint8Array {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // Unreadable recovery files cannot safely be rewritten and remain opaque.
    return bytes;
  }
  if (!value || typeof value !== "object" || !("snapshot" in value)) return bytes;
  const snapshot = value.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !("reasoningByTurn" in snapshot)) return bytes;
  delete snapshot.reasoningByTurn;
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Unreadable recovery attachments are preserved byte-for-byte, never interpreted as active state. */
export function validateTextPolishHistoryEntry(logicalPath: string, bytes: Uint8Array): void {
  const match = textPolishHistoryPathPattern.exec(logicalPath);
  if (!match) throw new Error("Invalid polish history path");
  if (logicalPath.includes(".unreadable-")) return;
  if (bytes.byteLength > MAX_TEXT_POLISH_HISTORY_JSON_BYTES)
    throw new Error("Polish history JSON exceeds size limit");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const name = match[2] ?? "";
  if (name === "active.json")
    z.object({ conversationId: z.uuid().nullable() }).strict().parse(value);
  else if (name.startsWith("draft-")) TextPolishInputDraftSchema.parse(value);
  else {
    const record = z
      .object({
        updatedAt: z.string(),
        title: z.string().trim().min(1).max(80).optional(),
        snapshot: TextPolishConversationSnapshotSchema,
      })
      .strict()
      .parse(value);
    if (
      record.snapshot.patentId !== match[1] ||
      record.snapshot.conversationId !== name.slice(13, -5)
    )
      throw new Error("Polish history identity mismatch");
  }
}
