import type {
  TextPolishConversationEvent,
  TextPolishConversationMessage,
  TextPolishConversationSnapshot,
} from "../../../../shared/ai-correction/text-polish-contract";

export type TextPolishConversationProjection = Pick<
  TextPolishConversationSnapshot,
  | "conversationId"
  | "conversationRevision"
  | "messages"
  | "summary"
  | "activeTurn"
  | "lastTurnOutcome"
>;

export type ConversationEventApplication =
  | { kind: "applied"; projection: TextPolishConversationProjection }
  | { kind: "ignored"; projection: TextPolishConversationProjection }
  | { kind: "gap"; projection: TextPolishConversationProjection };

export function applyConversationSnapshot(
  current: TextPolishConversationProjection | null,
  snapshot: TextPolishConversationSnapshot,
): TextPolishConversationProjection {
  if (
    current &&
    current.conversationId === snapshot.conversationId &&
    snapshot.conversationRevision < current.conversationRevision
  ) {
    return current;
  }
  return {
    conversationId: snapshot.conversationId,
    conversationRevision: snapshot.conversationRevision,
    messages: [...snapshot.messages],
    summary: snapshot.summary,
    activeTurn: snapshot.activeTurn,
    lastTurnOutcome: snapshot.lastTurnOutcome,
  };
}

function appendMessage(
  messages: readonly TextPolishConversationMessage[],
  message: TextPolishConversationMessage,
): TextPolishConversationMessage[] {
  if (messages.some((candidate) => candidate.messageId === message.messageId)) {
    return [...messages];
  }
  return [...messages, message];
}

export function applyConversationEvent(
  current: TextPolishConversationProjection,
  event: TextPolishConversationEvent,
): ConversationEventApplication {
  if (event.conversationId !== current.conversationId) {
    return { kind: "ignored", projection: current };
  }
  if (event.type === "reasoning" && event.conversationRevision === current.conversationRevision) {
    return { kind: "applied", projection: current };
  }
  if (event.conversationRevision <= current.conversationRevision) {
    return { kind: "ignored", projection: current };
  }
  if (event.conversationRevision !== current.conversationRevision + 1) {
    return { kind: "gap", projection: current };
  }
  const next: TextPolishConversationProjection = {
    ...current,
    conversationRevision: event.conversationRevision,
  };
  if (event.type === "message") {
    next.messages = appendMessage(current.messages, event.message);
    next.activeTurn =
      event.message.role === "user"
        ? {
            turnId: event.message.turnId,
            clientRequestId: event.message.turnId,
            instruction: event.message.text,
            status: "preparing",
          }
        : null;
    if (event.message.role === "assistant") {
      next.lastTurnOutcome = { status: "completed", turnId: event.message.turnId };
    }
  } else if (event.type === "summary") {
    next.summary = event.summary;
    next.messages = appendMessage(current.messages, event.message);
  } else if (event.type === "phase") {
    if (current.activeTurn?.turnId === event.turnId) {
      const { summaryBatch: _previousBatch, ...activeTurn } = current.activeTurn;
      next.activeTurn = {
        ...activeTurn,
        ...(event.phase === "summarizing" && event.summaryBatch
          ? { summaryBatch: event.summaryBatch }
          : {}),
        status:
          event.phase === "summarizing"
            ? "summarizing"
            : event.phase === "preparing"
              ? "preparing"
              : "running",
      };
    }
  } else if (event.type === "turn-failed" || event.type === "turn-cancelled") {
    next.activeTurn = null;
    next.lastTurnOutcome =
      event.type === "turn-failed"
        ? {
            status: "failed",
            turnId: event.turnId,
            message: event.message,
            retryable: event.retryable,
          }
        : { status: "cancelled", turnId: event.turnId };
  }
  return { kind: "applied", projection: next };
}
