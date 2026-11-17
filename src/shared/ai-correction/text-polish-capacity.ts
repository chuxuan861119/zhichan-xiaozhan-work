import type {
  TextPolishConversationMessage,
  TextPolishConversationSource,
} from "./text-polish-contract.js";
import {
  conversationTextBytes,
  TEXT_POLISH_MAX_ASSISTANT_MESSAGE_CHARACTERS,
  TEXT_POLISH_MAX_CONVERSATION_TEXT_BYTES,
} from "./text-polish-contract.js";

/** Reserve both reply fields, replacement latest draft, and compaction notices. */
export function textPolishHistoryCapacity(
  messages: readonly TextPolishConversationMessage[],
  latestDraft: string,
  incomingText = "",
) {
  const bytes = conversationTextBytes({ messages, latestValidDraft: latestDraft });
  const reserved = TEXT_POLISH_MAX_ASSISTANT_MESSAGE_CHARACTERS * 3 * 3 + 2 * 500 * 3;
  return {
    bytes,
    canSend:
      messages.length + 4 <= 300 &&
      bytes -
        new TextEncoder().encode(latestDraft).length +
        new TextEncoder().encode(incomingText).length +
        reserved <=
        TEXT_POLISH_MAX_CONVERSATION_TEXT_BYTES,
  };
}

// Advisory estimate: failed turns and compressed history may not be sent. Never discard content
// or disable sending based on this estimate; the service remains authoritative.
export function textPolishCapacity(
  source: TextPolishConversationSource | null,
  messages: readonly TextPolishConversationMessage[],
  latestDraft: string,
  instruction: string,
  limit: number,
  referenceText = "",
) {
  const users = messages.filter((message) => message.role === "user");
  const material =
    source?.kind === "selection" ? source.anchor.originalText : (source?.requirement ?? "");
  const text = [
    material,
    latestDraft,
    instruction,
    referenceText,
    ...users.flatMap((message) => [message.text, message.referenceText ?? ""]),
  ].join("");
  const estimatedCharacters = text.length;
  const estimate = Math.ceil(new TextEncoder().encode(text).length / 2) + 12_000;
  return {
    estimatedCharacters,
    turns: users.length,
    warning:
      estimatedCharacters >= limit * 0.8 ||
      estimate >= 64_000 ||
      users.length >= 80 ||
      !textPolishHistoryCapacity(messages, latestDraft, instruction + referenceText).canSend,
  };
}
