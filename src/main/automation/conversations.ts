import { setTimeout as delay } from "node:timers/promises";
import type {
  TextPolishConversationEvent,
  TextPolishConversationSnapshot,
  TextPolishEvent,
  TextPolishInputDraft,
} from "../../shared/ai-correction/text-polish-contract.js";
import {
  AutomationConversationReadSchema,
  AutomationConversationRunSchema,
} from "../../shared/automation/conversations.js";
import { AutomationError } from "../../shared/automation/protocol.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import type { PatentPolishService } from "../ai-correction/patent-polish-service.js";
import type { TextPolishHistoryStore } from "../ai-correction/text-polish-history-store.js";
import type { AutomationAiContext } from "./ai.js";
import { payloadHash } from "./ledger.js";

export type AutomationConversationContext = AutomationAiContext & {
  operationId: string;
  begin(): void;
};
type Result = {
  snapshot: TextPolishConversationSnapshot | null;
  draft?: TextPolishInputDraft;
  draftHash?: string;
};
function publicSnapshot(
  snapshot: TextPolishConversationSnapshot | null,
): TextPolishConversationSnapshot | null {
  if (!snapshot) return null;
  const { reasoningByTurn: _reasoning, ...result } = snapshot;
  return result;
}

/** Shares the GUI state machine and its ownership checks; virtual sessions exist only during a command. */
export class AutomationConversations {
  private readonly contexts = new Map<
    string,
    { patent: CanonicalPatent; context: AutomationConversationContext }
  >();
  constructor(
    private readonly service: PatentPolishService,
    private readonly history: TextPolishHistoryStore,
    private readonly connectionsEnabled: () => Promise<boolean>,
  ) {}

  capture(sessionId: string, patentId: string): CanonicalPatent | undefined {
    const entry = this.contexts.get(sessionId);
    if (!entry) return undefined;
    entry.context.assertAuthorized();
    if (entry.patent.patentId !== patentId)
      throw new AutomationError("SCOPE_DENIED", "对话不属于目标专利。");
    return structuredClone(entry.patent);
  }
  observe(event: TextPolishEvent | TextPolishConversationEvent, owner?: string): void {
    const entry = owner ? this.contexts.get(owner) : undefined;
    if (!entry || !("conversationId" in event) || event.type === "reasoning") return;
    try {
      entry.context.assertAuthorized();
      entry.context.progress({
        type: event.type,
        conversationId: event.conversationId,
        conversationRevision: event.conversationRevision,
        ...(event.type === "phase" ? { phase: event.phase } : {}),
      });
    } catch {
      /* The command abort path releases this session and cancels its provider. */
    }
  }
  read(payload: Record<string, unknown>): unknown {
    const input = AutomationConversationReadSchema.parse(payload);
    const draft = this.history.draft(input.patentId, input.conversationId ?? null);
    if (input.conversationId) {
      const snapshot = this.history.snapshot(input.patentId, input.conversationId, {
        readOnly: true,
      });
      if (!snapshot) throw new AutomationError("NOT_FOUND", "对话不存在。");
      return { snapshot: publicSnapshot(snapshot), draft, draftHash: payloadHash(draft) };
    }
    const items = this.history.history(input.patentId, { readOnly: true });
    return {
      items: items.slice(input.offset, input.offset + input.limit),
      total: items.length,
      draft,
      draftHash: payloadHash(draft),
    };
  }
  async run(
    patent: CanonicalPatent,
    payload: Record<string, unknown>,
    context: AutomationConversationContext,
  ): Promise<Result> {
    const input = AutomationConversationRunSchema.parse(payload);
    context.assertAuthorized();
    if (input.patentId !== patent.patentId)
      throw new AutomationError("SCOPE_DENIED", "对话不属于目标专利。");
    if (input.expectedRevision !== patent.revision)
      throw new AutomationError("REVISION_CONFLICT", "专利版本已变化。");
    const network = ["start", "send", "retry"].includes(input.action);
    if (network && !(await this.connectionsEnabled()))
      throw new AutomationError("AI_DISABLED", "软件联网已关闭。");
    context.assertAuthorized();
    if ("expectedConversationRevision" in input) {
      const saved = this.history.snapshot(patent.patentId, input.conversationId, {
        readOnly: true,
      });
      if (!saved) throw new AutomationError("NOT_FOUND", "对话不存在。");
      if (saved.activeTurn || saved.conversationRevision !== input.expectedConversationRevision)
        throw new AutomationError(
          "REVISION_CONFLICT",
          "对话正在运行或版本已变化，请重新读取；中断记录可先恢复。",
        );
    }
    if (
      input.action === "draft" &&
      payloadHash(this.history.draft(patent.patentId, input.conversationId)) !==
        input.expectedDraftHash
    )
      throw new AutomationError("REVISION_CONFLICT", "输入草稿已变化。");
    const sessionId = context.operationId;
    this.contexts.set(sessionId, { patent: structuredClone(patent), context });
    try {
      context.assertAuthorized();
      context.begin();
      if (input.action === "draft" || input.action === "recover") {
        let result = await this.service.workspace(sessionId, {
          patentId: patent.patentId,
          sessionId,
          action: input.action,
          conversationId: input.conversationId,
          ...(input.action === "draft" ? { draft: input.draft } : {}),
        });
        if (input.action === "recover" && input.conversationId) {
          context.assertAuthorized();
          result = await this.service.workspace(sessionId, {
            patentId: patent.patentId,
            sessionId,
            action: "open",
            conversationId: input.conversationId,
          });
          if (result.snapshot) {
            context.assertAuthorized();
            this.history.save(result.snapshot);
          }
        }
        context.assertAuthorized();
        return {
          snapshot: publicSnapshot(result.snapshot),
          draft: result.draft,
          draftHash: payloadHash(result.draft),
        };
      }
      let snapshot: TextPolishConversationSnapshot;
      if (input.action === "start") {
        const result = await this.service.startConversation(sessionId, {
          clientRequestId: context.operationId,
          patentId: patent.patentId,
          sessionId,
          expectedPatentRevision: patent.revision,
          scope: input.scope,
          instruction: input.instruction,
          uploadConfirmed: true,
        });
        snapshot = result.snapshot;
      } else {
        const opened = await this.service.workspace(sessionId, {
          patentId: patent.patentId,
          sessionId,
          action: "open",
          conversationId: input.conversationId,
        });
        if (!opened.snapshot) throw new AutomationError("NOT_FOUND", "对话不存在。");
        context.assertAuthorized();
        if (opened.snapshot.conversationRevision !== input.expectedConversationRevision)
          throw new AutomationError("REVISION_CONFLICT", "对话版本已变化。");
        const identity = {
          patentId: patent.patentId,
          sessionId,
          conversationId: input.conversationId,
          bookKind: opened.snapshot.bookKind,
        };
        if (input.action === "change-model") {
          const changed = await this.service.workspace(sessionId, {
            patentId: patent.patentId,
            sessionId,
            conversationId: input.conversationId,
            action: "change-model",
            expectedConversationRevision: input.expectedConversationRevision,
            targetModel: input.targetModel,
          });
          return { snapshot: publicSnapshot(changed.snapshot) };
        }
        if (input.action === "reset") {
          const reset = await this.service.resetConversation(sessionId, {
            identity,
            expectedConversationRevision: input.expectedConversationRevision,
          });
          return { snapshot: publicSnapshot(reset.snapshot) };
        }
        const result = await this.service.sendConversation(sessionId, {
          identity,
          expectedConversationRevision: input.expectedConversationRevision,
          clientRequestId: context.operationId,
          ...(input.action === "send"
            ? { kind: "new", instruction: input.instruction }
            : { kind: "retry", turnId: input.turnId }),
        });
        snapshot = result.snapshot;
      }
      while (snapshot.activeTurn) {
        context.assertAuthorized();
        await delay(100, undefined, { signal: context.signal });
        snapshot = await this.service.snapshotConversation(sessionId, {
          patentId: patent.patentId,
          sessionId,
          conversationId: snapshot.conversationId,
          bookKind: snapshot.bookKind,
        });
      }
      context.assertAuthorized();
      return { snapshot: publicSnapshot(snapshot) };
    } catch (error) {
      if (context.signal.aborted) throw new AutomationError("CANCELLED", "AI 对话已取消。");
      throw error;
    } finally {
      try {
        this.service.releaseSession(sessionId, patent.patentId);
      } finally {
        this.contexts.delete(sessionId);
      }
    }
  }
}
