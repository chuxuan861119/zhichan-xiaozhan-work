import { randomUUID } from "node:crypto";
import {
  type AiCorrectionEvent,
  AiCorrectionEventSchema,
  AiCorrectionStartRequestSchema,
} from "../../shared/ai-correction/contract.js";
import {
  type TextPolishEvent,
  TextPolishResultSchema,
  TextPolishStartRequestSchema,
} from "../../shared/ai-correction/text-polish-contract.js";
import { AutomationCorrectionSchema, AutomationPolishSchema } from "../../shared/automation/ai.js";
import { AutomationError } from "../../shared/automation/protocol.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import { PatentCorrectionService } from "../ai-correction/patent-correction-service.js";
import { PatentPolishService } from "../ai-correction/patent-polish-service.js";

type CorrectionDependencies = ConstructorParameters<typeof PatentCorrectionService>[0];
type PolishDependencies = ConstructorParameters<typeof PatentPolishService>[0];
export type AutomationAiDependencies = Pick<CorrectionDependencies, "readSettings" | "vault"> & {
  provider: CorrectionDependencies["provider"] & PolishDependencies["provider"];
  connectionsEnabled(): Promise<boolean>;
};
export type AutomationAiContext = {
  signal: AbortSignal;
  assertAuthorized(): void;
  progress(value: unknown): void;
};

/** One immutable, authorized patent capture per task. No shared GUI jobs or unrelated history. */
export async function runAutomationAi(
  dependencies: AutomationAiDependencies,
  command: "ai.correct" | "ai.polish",
  patent: CanonicalPatent,
  payload: Record<string, unknown>,
  context: AutomationAiContext,
): Promise<unknown> {
  const jobId = randomUUID();
  const sessionId = randomUUID();
  const assertActive = () => {
    context.assertAuthorized();
    if (context.signal.aborted) throw new AutomationError("CANCELLED", "AI 任务已取消。");
  };
  const ensureConnection = async () => {
    assertActive();
    if (!(await dependencies.connectionsEnabled()))
      throw new AutomationError("AI_DISABLED", "软件 AI 连接已关闭。");
    assertActive();
  };
  const patents = {
    requireActiveReadSession: (session: string, id: string) => {
      assertActive();
      if (session !== sessionId || id !== patent.patentId)
        throw new AutomationError("SCOPE_DENIED", "AI 上下文不属于目标专利。");
      return structuredClone(patent);
    },
  };
  // Validate before starting any provider or opening credentials.
  const input =
    command === "ai.correct"
      ? AiCorrectionStartRequestSchema.parse({
          ...AutomationCorrectionSchema.omit({ persisted: true }).parse(
            Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "persisted")),
          ),
          jobId,
          sessionId,
          uploadConfirmed: true,
        })
      : TextPolishStartRequestSchema.parse({
          ...AutomationPolishSchema.omit({ persisted: true }).parse(
            Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "persisted")),
          ),
          jobId,
          sessionId,
          uploadConfirmed: true,
        });
  if (input.patentId !== patent.patentId || input.expectedRevision !== patent.revision)
    throw new AutomationError("REVISION_CONFLICT", "AI 请求与读取版本不一致。");
  await ensureConnection();
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancel = () => {};
    const finish = (error: unknown, result: Record<string, unknown> = {}) => {
      if (settled) return;
      settled = true;
      context.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ patentId: patent.patentId, revision: patent.revision, ...result });
    };
    const abort = () => {
      cancel();
      finish(new AutomationError("CANCELLED", "AI 任务已取消。"));
    };
    const emit = (event: AiCorrectionEvent | TextPolishEvent) => {
      if (settled) return;
      if (event.type === "completed") {
        const checked = AiCorrectionEventSchema.parse(event);
        if (checked.type === "completed")
          finish(null, {
            issues: checked.issues,
            resultLimitReached: checked.resultLimitReached,
            discardedIssueCount: checked.discardedIssueCount,
          });
      } else if (event.type === "polish-completed")
        finish(null, { result: TextPolishResultSchema.parse(event.result) });
      else if (event.type === "failed")
        finish(
          new AutomationError("AI_FAILED", "AI 处理失败，请检查模型配置、处理范围和网络连接。"),
        );
      else if (event.type === "cancelled")
        finish(new AutomationError("CANCELLED", "AI 任务已取消。"));
      else if (event.type === "phase" || event.type === "progress") context.progress(event);
    };
    const correction = new PatentCorrectionService({
      readSettings: dependencies.readSettings,
      vault: dependencies.vault,
      patents,
      randomUUID,
      emit,
      provider: {
        correct: async (request) => {
          await ensureConnection();
          return dependencies.provider.correct(request);
        },
      },
    });
    const polish = new PatentPolishService({
      readSettings: dependencies.readSettings,
      vault: dependencies.vault,
      patents,
      emit: (event) => {
        if (!("conversationId" in event)) emit(event);
      },
      provider: {
        polish: async (request) => {
          await ensureConnection();
          return dependencies.provider.polish(request);
        },
      },
    });
    cancel = () => {
      correction.cancel(jobId);
      polish.cancel(jobId);
    };
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) {
      abort();
      return;
    }
    const starting =
      command === "ai.correct"
        ? correction.start(AiCorrectionStartRequestSchema.parse(input), ensureConnection)
        : polish.start(TextPolishStartRequestSchema.parse(input));
    void starting.catch((error) => finish(error));
  });
}
