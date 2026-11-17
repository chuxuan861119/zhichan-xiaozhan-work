// @vitest-environment node
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { DEFAULT_AI_CORRECTION_SETTINGS } from "../../shared/ai-correction/model.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { type AutomationAiDependencies, runAutomationAi } from "./ai.js";

function fixture() {
  const patent = createBlankPatent({ patentType: "invention", name: "测试装置" });
  const profileId = randomUUID();
  const provider = { correct: vi.fn(async () => []), polish: vi.fn(async () => "生成正文") };
  const dependencies: AutomationAiDependencies = {
    connectionsEnabled: async () => true,
    readSettings: async () => ({
      ...DEFAULT_AI_CORRECTION_SETTINGS,
      enabled: true,
      activeProfileId: profileId,
      profiles: [
        {
          profileId,
          providerId: "deepseek",
          displayName: "测试",
          baseUrl: "https://api.deepseek.com",
          model: "test",
        },
      ],
    }),
    vault: { hasApiKey: async () => true, withApiKey: async (_id, use) => use("example-test-key") },
    provider,
  };
  const controller = new AbortController();
  const context = { signal: controller.signal, assertAuthorized: vi.fn(), progress: vi.fn() };
  return { patent, dependencies, provider, controller, context };
}
test("isolated correction and generation reuse configured services without editing the patent", async () => {
  const { patent, dependencies, provider, context } = fixture();
  const before = structuredClone(patent);
  const generated = await runAutomationAi(
    dependencies,
    "ai.polish",
    patent,
    {
      patentId: patent.patentId,
      expectedRevision: 0,
      scope: { kind: "generation", bookKind: "description" },
      requirement: "介绍一个测试装置",
    },
    context,
  );
  expect(generated).toMatchObject({ revision: 0, result: { generatedText: "生成正文" } });
  expect(JSON.stringify(generated)).not.toContain("example-test-key");
  const checked = await runAutomationAi(
    dependencies,
    "ai.correct",
    patent,
    {
      patentId: patent.patentId,
      expectedRevision: 0,
      scope: { kind: "current-book", bookKind: "description" },
    },
    context,
  );
  expect(checked).toMatchObject({ issues: [] });
  expect(provider.correct).toHaveBeenCalled();
  expect(patent).toEqual(before);
});
test("disabled connections, mismatched patent and invalid revision never reach a provider", async () => {
  const { patent, dependencies, provider, context } = fixture();
  const input = {
    patentId: patent.patentId,
    expectedRevision: 0,
    scope: { kind: "generation", bookKind: "claims" },
    requirement: "生成文字",
  };
  await expect(
    runAutomationAi(
      { ...dependencies, connectionsEnabled: async () => false },
      "ai.polish",
      patent,
      input,
      context,
    ),
  ).rejects.toMatchObject({ code: "AI_DISABLED" });
  await expect(
    runAutomationAi(
      dependencies,
      "ai.polish",
      patent,
      { ...input, patentId: randomUUID() },
      context,
    ),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  await expect(
    runAutomationAi(dependencies, "ai.polish", patent, { ...input, expectedRevision: 1 }, context),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(provider.polish).not.toHaveBeenCalled();
});
test("cancellation aborts the provider and cannot return a late generated answer", async () => {
  const { patent, dependencies, controller, context } = fixture();
  let providerSignal: AbortSignal | undefined;
  const polish = vi.fn(
    async (input: Parameters<AutomationAiDependencies["provider"]["polish"]>[0]) => {
      providerSignal = input.signal;
      return new Promise<string>((resolve) =>
        input.signal.addEventListener("abort", () => resolve("迟到结果"), { once: true }),
      );
    },
  );
  const task = runAutomationAi(
    { ...dependencies, provider: { ...dependencies.provider, polish } },
    "ai.polish",
    patent,
    {
      patentId: patent.patentId,
      expectedRevision: 0,
      scope: { kind: "generation", bookKind: "claims" },
      requirement: "生成文字",
    },
    context,
  );
  const rejected = expect(task).rejects.toMatchObject({ code: "CANCELLED" });
  await vi.waitFor(() => expect(polish).toHaveBeenCalled());
  controller.abort();
  await rejected;
  expect(providerSignal?.aborted).toBe(true);
});

test("provider failures cannot expose credentials or raw remote response text", async () => {
  const { patent, dependencies, context } = fixture();
  const task = runAutomationAi(
    {
      ...dependencies,
      provider: {
        ...dependencies.provider,
        polish: async () => {
          throw new Error("remote echoed example-test-key");
        },
      },
    },
    "ai.polish",
    patent,
    {
      patentId: patent.patentId,
      expectedRevision: 0,
      scope: { kind: "generation", bookKind: "claims" },
      requirement: "起草文字",
    },
    context,
  );
  await expect(task).rejects.toMatchObject({ code: "AI_FAILED" });
  await expect(task).rejects.not.toThrow("example-test-key");
});
