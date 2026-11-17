import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc/contract.js";
import {
  AiCorrectionEventRouter,
  TextPolishConversationEventRouter,
  TextPolishEventRouter,
} from "./ai-correction-event-router.js";

function target() {
  return { isDestroyed: () => false, send: vi.fn() };
}

describe("AI correction event router", () => {
  test.each(["navigation", "crash", "destroyed"])(
    "cancels only the detached renderer's correction jobs on %s",
    (reason) => {
      const router = new AiCorrectionEventRouter();
      const owner = Object.assign(new EventEmitter(), target());
      const other = target();
      const cancel = vi.fn();
      const jobId = randomUUID();
      const otherJob = randomUUID();
      router.bindLifecycle(owner, cancel);
      router.bind(jobId, owner);
      router.bind(otherJob, other);
      owner.emit("did-start-navigation", {}, "about:blank#hash", true, true);
      owner.emit("did-start-navigation", {}, "about:blank", false, false);
      expect(cancel).not.toHaveBeenCalled();
      if (reason === "navigation")
        owner.emit("did-start-navigation", {}, "about:blank", false, true);
      else owner.emit(reason === "crash" ? "render-process-gone" : "destroyed");
      expect(cancel).toHaveBeenCalledExactlyOnceWith(jobId);
      expect(router.owns(jobId, owner)).toBe(false);
      expect(router.owns(otherJob, other)).toBe(true);
      owner.emit("destroyed");
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
  test("routes text polish reasoning and releases the owner on completion", () => {
    const router = new TextPolishEventRouter();
    const owner = target();
    const jobId = randomUUID();
    router.bind(jobId, owner);

    router.emit({ type: "reasoning", jobId, delta: "正在润色" });
    expect(owner.send).toHaveBeenCalledWith(IPC_CHANNELS.textPolishEvent, {
      type: "reasoning",
      jobId,
      delta: "正在润色",
    });
    router.emit({
      type: "polish-completed",
      jobId,
      result: {
        anchor: {
          bookKind: "description",
          blocks: [{ blockId: randomUUID(), blockType: "paragraph", startOffset: 0, endOffset: 2 }],
          originalText: "原文",
          originalTextHash: "a".repeat(64),
        },
        polishedText: "新文",
      },
    });
    expect(router.owns(jobId, owner)).toBe(false);
  });

  test("sends sensitive reasoning only to the task owner", () => {
    const router = new AiCorrectionEventRouter();
    const owner = target();
    const other = target();
    const jobId = randomUUID();
    router.bind(jobId, owner);

    router.emit({ type: "reasoning", jobId, delta: "专利正文复述" });

    expect(owner.send).toHaveBeenCalledWith(IPC_CHANNELS.aiCorrectionEvent, {
      type: "reasoning",
      jobId,
      delta: "专利正文复述",
    });
    expect(other.send).not.toHaveBeenCalled();
  });

  test("releases terminal jobs and all jobs owned by a destroyed sender", () => {
    const router = new AiCorrectionEventRouter();
    const owner = target();
    const firstJobId = randomUUID();
    const secondJobId = randomUUID();
    router.bind(firstJobId, owner);
    router.bind(secondJobId, owner);

    router.emit({ type: "completed", jobId: firstJobId, issues: [], resultLimitReached: false });
    expect(router.owns(firstJobId, owner)).toBe(false);
    expect(router.releaseTarget(owner)).toEqual([secondJobId]);
    expect(router.owns(secondJobId, owner)).toBe(false);
  });

  test("routes conversation events by renderer owner and drops destroyed owners", () => {
    const router = new TextPolishConversationEventRouter();
    const owner = target();
    const other = target();
    const ownerToken = randomUUID();
    const conversationId = randomUUID();
    router.bindOwner(ownerToken, owner);

    router.emit(
      {
        type: "phase",
        conversationId,
        conversationRevision: 1,
        turnId: randomUUID(),
        phase: "thinking",
      },
      ownerToken,
    );
    expect(owner.send).toHaveBeenCalledWith(
      IPC_CHANNELS.textPolishConversationEvent,
      expect.objectContaining({ conversationId }),
    );
    expect(other.send).not.toHaveBeenCalled();

    owner.isDestroyed = () => true;
    router.emit(
      {
        type: "reasoning",
        conversationId,
        conversationRevision: 2,
        turnId: randomUUID(),
        delta: "后续上下文",
      },
      ownerToken,
    );
    expect(owner.send).toHaveBeenCalledTimes(1);
  });
});
