import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import {
  AI_PROVIDER_PRESETS,
  type AiCorrectionSettings,
  DEFAULT_AI_CORRECTION_SETTINGS,
} from "../../../shared/ai-correction/model";
import { AiCorrectionSettingsDialog } from "./ai-correction-settings-dialog";

describe("AI correction settings dialog", () => {
  test("places the primary add action inside the embedded empty state", async () => {
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          getSettings: async () => ({
            ok: true,
            value: {
              settings: structuredClone(DEFAULT_AI_CORRECTION_SETTINGS),
              credentialProfileIds: [],
            },
          }),
        },
      },
    });

    const { container } = render(
      <AiCorrectionSettingsDialog open embedded onClose={() => undefined} />,
    );

    const emptyState = await screen.findByText("还没有可用模型");
    const emptyContainer = emptyState.closest(".ai-model-empty");
    expect(emptyContainer).toBeTruthy();
    expect(screen.getByText("高级设置").closest("details")).toHaveProperty("open", false);
    expect(
      within(emptyContainer as HTMLElement).getByRole("button", { name: "添加模型" }),
    ).toBeDefined();
    expect(container.querySelector(".ai-model-manager__section-heading > button")).toBeNull();
  });

  test("opens the model editor when Electron does not expose crypto.randomUUID", async () => {
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          getSettings: async () => ({
            ok: true,
            value: {
              settings: structuredClone(DEFAULT_AI_CORRECTION_SETTINGS),
              credentialProfileIds: [],
            },
          }),
        },
      },
    });

    try {
      render(<AiCorrectionSettingsDialog open onClose={() => undefined} />);

      expect(screen.queryByRole("checkbox", { name: "启用 AI 纠错" })).toBeNull();
      expect(screen.queryByText("AI 纠错")).toBeNull();
      expect(
        screen.queryByText("开始检查后发送所选范围正文，API Key 由 Windows 账户加密保护。"),
      ).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "添加模型" }));

      expect(screen.getByRole("dialog", { name: "添加模型" })).toBeTruthy();
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        value: original,
      });
    }
  });

  test("adds a preset model without requiring endpoint or model-name typing", async () => {
    let settings: AiCorrectionSettings = structuredClone(DEFAULT_AI_CORRECTION_SETTINGS);
    let credentialProfileIds: string[] = [];
    const updateSettings = vi.fn(async (next: AiCorrectionSettings) => {
      settings = next;
      return { ok: true as const, value: { settings, credentialProfileIds } };
    });
    const setApiKey = vi.fn(async ({ profileId }: { profileId: string; apiKey: string }) => {
      credentialProfileIds = [profileId];
      return { ok: true as const, value: { settings, credentialProfileIds } };
    });
    const openProviderDocs = vi.fn(async () => ({ ok: true as const, value: undefined }));
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          getSettings: async () => ({
            ok: true,
            value: { settings, credentialProfileIds },
          }),
          updateSettings,
          setApiKey,
          clearApiKey: vi.fn(),
          testConnection: vi.fn(),
          openProviderDocs,
          start: vi.fn(),
          cancel: vi.fn(),
          onEvent: vi.fn(),
        },
      },
    });
    const onSettingsChanged = vi.fn();
    render(
      <AiCorrectionSettingsDialog
        open
        onClose={() => undefined}
        onSettingsChanged={onSettingsChanged}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "添加模型" }));
    expect(screen.getByRole("dialog", { name: "添加模型" })).toBeTruthy();
    expect((screen.getByLabelText("模型提供商") as HTMLSelectElement).value).toBe("deepseek");
    expect(screen.queryByLabelText("服务地址")).toBeNull();
    expect(screen.getByText(AI_PROVIDER_PRESETS[0].baseUrl)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看文档" }));
    await waitFor(() => expect(openProviderDocs).toHaveBeenCalledWith({ providerId: "deepseek" }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const saved = updateSettings.mock.calls[0]?.[0];
    expect(saved?.profiles[0]).toMatchObject({
      providerId: "deepseek",
      baseUrl: AI_PROVIDER_PRESETS[0].baseUrl,
      model: AI_PROVIDER_PRESETS[0].models[0].id,
    });
    expect(setApiKey).toHaveBeenCalledWith({
      profileId: saved?.profiles[0]?.profileId,
      apiKey: "secret",
    });
    expect(await screen.findByText("API Key 已安全保存")).toBeTruthy();
    expect(screen.queryByDisplayValue("secret")).toBeNull();
    expect(onSettingsChanged).toHaveBeenCalled();
  });

  test("validates a draft key and adds account models to the model selector", async () => {
    const discoverModels = vi.fn(async () => ({
      ok: true as const,
      value: { models: ["deepseek-v4-pro", "account-only-model"] },
    }));
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          getSettings: async () => ({
            ok: true,
            value: {
              settings: structuredClone(DEFAULT_AI_CORRECTION_SETTINGS),
              credentialProfileIds: [],
            },
          }),
          discoverModels,
        },
      },
    });
    render(<AiCorrectionSettingsDialog open onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "添加模型" }));
    expect(screen.queryByRole("option", { name: "Kimi Code Plan" })).toBeNull();
    expect(screen.queryByRole("option", { name: "小米 MiMo API" })).toBeNull();
    expect(screen.queryByRole("option", { name: "OpenAI API" })).toBeNull();
    expect(within(screen.getByLabelText("模型提供商")).getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByRole("option", { name: "其他自定义" })).toBeNull();

    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "temporary-secret" } });
    const editorDialog = screen.getByRole("dialog", { name: "添加模型" });
    fireEvent.click(screen.getByRole("button", { name: "验证并读取模型" }));
    expect(within(editorDialog).getByRole("status").textContent).toBe("正在验证连接并读取模型…");

    await waitFor(() =>
      expect(discoverModels).toHaveBeenCalledWith({
        providerId: "deepseek",
        baseUrl: "https://api.deepseek.com",
        apiKey: "temporary-secret",
      }),
    );
    expect(await screen.findByRole("option", { name: "account-only-model" })).toBeTruthy();
    expect(within(editorDialog).getByRole("status").textContent).toBe(
      "连接验证成功，已读取 2 个可用模型。",
    );
  });

  test("explicitly saves general request settings", async () => {
    let settings: AiCorrectionSettings = structuredClone(DEFAULT_AI_CORRECTION_SETTINGS);
    const updateSettings = vi.fn(async (next: AiCorrectionSettings) => {
      settings = next;
      return {
        ok: true as const,
        value: { settings, credentialProfileIds: [] },
      };
    });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          getSettings: async () => ({
            ok: true as const,
            value: { settings, credentialProfileIds: [] },
          }),
          updateSettings,
        },
      },
    });

    render(<AiCorrectionSettingsDialog open embedded onClose={() => undefined} />);

    const timeoutInput = await screen.findByLabelText("模型验证与读取超时（毫秒）");
    fireEvent.change(timeoutInput, { target: { value: "45000" } });
    expect(updateSettings).not.toHaveBeenCalled();
    fireEvent.blur(timeoutInput);
    expect(updateSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("保存连接设置"));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 45_000 })),
    );

    const characterLimitInput = screen.getByLabelText("当前文档检查字数上限");
    fireEvent.change(characterLimitInput, { target: { value: "60000" } });
    fireEvent.blur(characterLimitInput);
    await waitFor(() => expect(screen.getByText("保存连接设置")).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByText("保存连接设置"));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeoutMs: 45_000, maxUploadCharacters: 60_000 }),
      ),
    );
    expect(await screen.findByText("模型连接设置已保存。")).toBeDefined();
    expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });
  test("offers explicit recovery after a key-storage failure and sends the recovery flag only on request", async () => {
    let settings: AiCorrectionSettings = structuredClone(DEFAULT_AI_CORRECTION_SETTINGS);
    const setApiKey = vi.fn(
      async (request: { profileId: string; apiKey: string; resetUnavailable?: boolean }) =>
        request.resetUnavailable
          ? { ok: true as const, value: { settings, credentialProfileIds: [request.profileId] } }
          : {
              ok: false as const,
              error: { code: "INVALID_INPUT", message: "AI 服务密钥不可用，请重新输入 API Key。" },
            },
    );
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          getSettings: async () => ({ ok: true, value: { settings, credentialProfileIds: [] } }),
          updateSettings: async (next: AiCorrectionSettings) => {
            settings = next;
            return { ok: true, value: { settings, credentialProfileIds: [] } };
          },
          setApiKey,
        },
      },
    });
    render(<AiCorrectionSettingsDialog open onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "添加模型" }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "replacement" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));
    fireEvent.click(await screen.findByRole("button", { name: "重置不可用密钥并保存" }));
    await waitFor(() =>
      expect(setApiKey).toHaveBeenLastCalledWith(
        expect.objectContaining({ apiKey: "replacement", resetUnavailable: true }),
      ),
    );
    expect(setApiKey.mock.calls[0]?.[0].resetUnavailable).toBeUndefined();
  });
});

test("old encrypted keys are shown as pending verification without disabling the actual verification action", async () => {
  const profileId = "a878463b-d7d4-4e59-8471-e04a03ef5367";
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      aiCorrection: {
        getSettings: async () => ({
          ok: true,
          value: {
            settings: {
              ...DEFAULT_AI_CORRECTION_SETTINGS,
              profiles: [
                {
                  profileId,
                  providerId: "deepseek",
                  displayName: "旧配置",
                  baseUrl: "https://api.deepseek.com",
                  model: "deepseek-chat",
                },
              ],
              activeProfileId: profileId,
            },
            credentialProfileIds: [],
            credentialStatusUnknown: true,
          },
        }),
      },
    },
  });
  render(<AiCorrectionSettingsDialog open embedded onClose={() => undefined} />);
  await screen.findByText("旧版加密密钥，使用时验证");
  expect(screen.getByRole("button", { name: "验证" })).toHaveProperty("disabled", false);
  expect(screen.queryByText("尚未配置 API Key")).toBeNull();
});
