import { createHash } from "node:crypto";
import {
  AiApiKeyRequestSchema,
  AiCorrectionCancelRequestSchema,
  AiCorrectionProfileRequestSchema,
  AiCorrectionStartRequestSchema,
  AiModelDiscoveryRequestSchema,
  AiProviderDocsRequestSchema,
  AiTextHashRequestSchema,
} from "../../shared/ai-correction/contract.js";
import {
  AI_PROVIDER_PRESETS,
  type AiCorrectionSettings,
  AiCorrectionSettingsRequestSchema,
  AiCorrectionSettingsSchema,
} from "../../shared/ai-correction/model.js";
import { DEEPSEEK_PRIVACY_URL, DEEPSEEK_TERMS_URL } from "../../shared/ai-correction/policy.js";
import {
  TextPolishCancelRequestSchema,
  TextPolishConversationCancelRequestSchema,
  TextPolishConversationResetRequestSchema,
  TextPolishConversationSendRequestSchema,
  TextPolishConversationSnapshotRequestSchema,
  TextPolishConversationStartRequestSchema,
  TextPolishStartRequestSchema,
  TextPolishWorkspaceRequestSchema,
} from "../../shared/ai-correction/text-polish-contract.js";
import { IPC_CHANNELS } from "../../shared/ipc/contract.js";
import type { AppError, AppResult } from "../../shared/ipc/result.js";

type Register = (
  channel: string,
  handler: (event: unknown, input?: unknown) => unknown | Promise<unknown>,
) => void;

type Dependencies = {
  confirmCredentialReset?(event: unknown): Promise<boolean>;
  connectionsEnabled?(): Promise<boolean>;
  readSettings(): Promise<AiCorrectionSettings>;
  updateSettings(settings: AiCorrectionSettings): Promise<AiCorrectionSettings>;
  vault: {
    listProfileIds(): Promise<string[]>;
    hasUnindexedCredentials?(): Promise<boolean>;
    setApiKey(
      profileId: string,
      apiKey: string,
      options?: { resetUnavailable?: boolean },
    ): Promise<void>;
    clearApiKey(profileId: string): Promise<void>;
  };
  correction: {
    start(
      request: ReturnType<typeof AiCorrectionStartRequestSchema.parse>,
      event: unknown,
      ensureConnection?: () => Promise<void>,
    ): Promise<{ jobId: string }>;
    cancel(jobId: string, event: unknown): boolean;
  };
  polish: {
    workspace?(
      request: ReturnType<typeof TextPolishWorkspaceRequestSchema.parse>,
      event: unknown,
    ): Promise<unknown>;
    start(
      request: ReturnType<typeof TextPolishStartRequestSchema.parse>,
      event: unknown,
    ): Promise<{ jobId: string }>;
    cancel(jobId: string, event: unknown): boolean;
    startConversation?(
      request: ReturnType<typeof TextPolishConversationStartRequestSchema.parse>,
      event: unknown,
    ): Promise<unknown>;
    sendConversation?(
      request: ReturnType<typeof TextPolishConversationSendRequestSchema.parse>,
      event: unknown,
    ): Promise<unknown>;
    cancelConversation?(
      request: ReturnType<typeof TextPolishConversationCancelRequestSchema.parse>,
      event: unknown,
    ): boolean;
    resetConversation?(
      request: ReturnType<typeof TextPolishConversationResetRequestSchema.parse>,
      event: unknown,
    ): Promise<unknown>;
    snapshotConversation?(
      request: ReturnType<typeof TextPolishConversationSnapshotRequestSchema.parse>,
      event: unknown,
    ): Promise<unknown>;
  };
  testConnection(profileId: string): Promise<void>;
  discoverModels(input: { baseUrl: string; apiKey: string; timeoutMs: number }): Promise<string[]>;
  openExternal(url: string): Promise<void>;
};

class AiModelNotFoundError extends Error {
  readonly code = "AI_MODEL_NOT_FOUND" as const;
}

function failure(error: unknown): { ok: false; error: AppError } {
  const rawCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "INTERNAL";
  const code: AppError["code"] =
    rawCode === "REVISION_CONFLICT"
      ? "REVISION_CONFLICT"
      : rawCode === "NOT_FOUND"
        ? "NOT_FOUND"
        : rawCode === "BUSY"
          ? "OPERATION_IN_PROGRESS"
          : rawCode === "AI_DISABLED" ||
              rawCode === "AI_CREDENTIAL_UNAVAILABLE" ||
              rawCode === "AI_MODEL_NOT_FOUND" ||
              rawCode === "INVALID_SELECTION" ||
              rawCode === "CONTENT_TOO_LARGE" ||
              rawCode === "BOOK_NOT_FOUND"
            ? "INVALID_INPUT"
            : rawCode === "CONTEXT_CAPACITY_EXCEEDED" || rawCode === "MODEL_CHANGED"
              ? "INVALID_INPUT"
              : "INTERNAL";
  const message = error instanceof Error ? error.message.slice(0, 500) : "AI 纠错操作失败。";
  return { ok: false, error: { code, message } };
}

export function registerAiCorrectionIpc(register: Register, dependencies: Dependencies): void {
  register(IPC_CHANNELS.textPolishWorkspace, async (event, input) => {
    try {
      if (!dependencies.polish.workspace) throw new Error("小栈AI助手历史尚未接入。");
      return {
        ok: true,
        value: await dependencies.polish.workspace(
          TextPolishWorkspaceRequestSchema.parse(input),
          event,
        ),
      };
    } catch (error) {
      return failure(error);
    }
  });
  const requireConnection = async () => {
    if (dependencies.connectionsEnabled && !(await dependencies.connectionsEnabled())) {
      throw Object.assign(new Error("AI 连接已关闭，请在设置的 AI 使用与隐私中开启。"), {
        code: "AI_DISABLED",
      });
    }
  };
  const readSupportedSettings = async () =>
    AiCorrectionSettingsSchema.parse(await dependencies.readSettings());
  const state = async (settings?: AiCorrectionSettings) => {
    const supported = settings ?? (await readSupportedSettings());
    return {
      settings: supported,
      credentialStatusUnknown: (await dependencies.vault.hasUnindexedCredentials?.()) ?? false,
      credentialProfileIds: (await dependencies.vault.listProfileIds()).filter((id) =>
        supported.profiles.some((profile) => profile.profileId === id),
      ),
    };
  };

  register(IPC_CHANNELS.aiCorrectionHashText, (_event, input) => {
    try {
      const text = AiTextHashRequestSchema.parse(input);
      return { ok: true, value: createHash("sha256").update(text, "utf8").digest("hex") };
    } catch (error) {
      return failure(error);
    }
  });
  register(
    IPC_CHANNELS.aiCorrectionGetSettings,
    async (): Promise<AppResult<Awaited<ReturnType<typeof state>>>> => {
      try {
        return { ok: true, value: await state() };
      } catch (error) {
        return failure(error);
      }
    },
  );
  register(IPC_CHANNELS.aiCorrectionUpdateSettings, async (_event, input) => {
    try {
      return {
        ok: true,
        value: await state(
          await dependencies.updateSettings(AiCorrectionSettingsRequestSchema.parse(input)),
        ),
      };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.aiCorrectionSetApiKey, async (event, input) => {
    try {
      const request = AiApiKeyRequestSchema.parse(input);
      const settings = await readSupportedSettings();
      if (!settings.profiles.some(({ profileId }) => profileId === request.profileId)) {
        throw new AiModelNotFoundError("找不到要保存密钥的 AI 模型。");
      }
      if (request.resetUnavailable && !(await dependencies.confirmCredentialReset?.(event))) {
        return {
          ok: false,
          error: { code: "CANCELLED", message: "已取消密钥重置，原密钥文件未更改。" },
        };
      }
      if (request.resetUnavailable)
        await dependencies.vault.setApiKey(request.profileId, request.apiKey, {
          resetUnavailable: true,
        });
      else await dependencies.vault.setApiKey(request.profileId, request.apiKey);
      return { ok: true, value: await state() };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.aiCorrectionClearApiKey, async (_event, input) => {
    try {
      await dependencies.vault.clearApiKey(AiCorrectionProfileRequestSchema.parse(input).profileId);
      return { ok: true, value: await state() };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.aiCorrectionTestConnection, async (_event, input) => {
    try {
      await requireConnection();
      await dependencies.testConnection(AiCorrectionProfileRequestSchema.parse(input).profileId);
      return { ok: true, value: undefined };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.aiCorrectionDiscoverModels, async (_event, input) => {
    try {
      await requireConnection();
      const request = AiModelDiscoveryRequestSchema.parse(input);
      const preset = AI_PROVIDER_PRESETS.find(
        (candidate) => candidate.providerId === request.providerId,
      );
      if (preset && request.baseUrl !== preset.baseUrl) {
        throw new Error("预置提供商的服务地址不可修改。");
      }
      const settings = await readSupportedSettings();
      const models = await dependencies.discoverModels({
        baseUrl: preset?.baseUrl ?? request.baseUrl,
        apiKey: request.apiKey,
        timeoutMs: settings.timeoutMs,
      });
      return { ok: true, value: { models } };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.aiCorrectionOpenProviderDocs, async (_event, input) => {
    try {
      const { providerId, document } = AiProviderDocsRequestSchema.parse(input);
      const preset = AI_PROVIDER_PRESETS.find((candidate) => candidate.providerId === providerId);
      if (!preset) throw new Error("未找到提供商文档。");
      await dependencies.openExternal(
        document === "privacy"
          ? DEEPSEEK_PRIVACY_URL
          : document === "terms"
            ? DEEPSEEK_TERMS_URL
            : preset.docsUrl,
      );
      return { ok: true, value: undefined };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.aiCorrectionStart, async (event, input) => {
    try {
      return {
        ok: true,
        value: await dependencies.correction.start(
          AiCorrectionStartRequestSchema.parse(input),
          event,
          requireConnection,
        ),
      };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.aiCorrectionCancel, async (event, input) => {
    try {
      if (
        !dependencies.correction.cancel(AiCorrectionCancelRequestSchema.parse(input).jobId, event)
      ) {
        throw new Error("未确认任务已停止，请重试。");
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.textPolishStart, async (event, input) => {
    try {
      await requireConnection();
      return {
        ok: true,
        value: await dependencies.polish.start(TextPolishStartRequestSchema.parse(input), event),
      };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.textPolishCancel, async (event, input) => {
    try {
      dependencies.polish.cancel(TextPolishCancelRequestSchema.parse(input).jobId, event);
      return { ok: true, value: undefined };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.textPolishConversationStart, async (event, input) => {
    try {
      await requireConnection();
      if (!dependencies.polish.startConversation) throw new Error("小栈AI助手连续对话尚未接入。\n");
      return {
        ok: true,
        value: await dependencies.polish.startConversation(
          TextPolishConversationStartRequestSchema.parse(input),
          event,
        ),
      };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.textPolishConversationSend, async (event, input) => {
    try {
      await requireConnection();
      if (!dependencies.polish.sendConversation) throw new Error("小栈AI助手连续对话尚未接入。\n");
      return {
        ok: true,
        value: await dependencies.polish.sendConversation(
          TextPolishConversationSendRequestSchema.parse(input),
          event,
        ),
      };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.textPolishConversationCancel, async (event, input) => {
    try {
      if (!dependencies.polish.cancelConversation)
        throw new Error("小栈AI助手连续对话尚未接入。\n");
      dependencies.polish.cancelConversation(
        TextPolishConversationCancelRequestSchema.parse(input),
        event,
      );
      return { ok: true, value: undefined };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.textPolishConversationReset, async (event, input) => {
    try {
      if (!dependencies.polish.resetConversation) throw new Error("小栈AI助手连续对话尚未接入。\n");
      return {
        ok: true,
        value: await dependencies.polish.resetConversation(
          TextPolishConversationResetRequestSchema.parse(input),
          event,
        ),
      };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.textPolishConversationSnapshot, async (event, input) => {
    try {
      if (!dependencies.polish.snapshotConversation)
        throw new Error("小栈AI助手连续对话尚未接入。\n");
      return {
        ok: true,
        value: await dependencies.polish.snapshotConversation(
          TextPolishConversationSnapshotRequestSchema.parse(input),
          event,
        ),
      };
    } catch (error) {
      return failure(error);
    }
  });
}
