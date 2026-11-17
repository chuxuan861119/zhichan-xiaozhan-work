// Explicit, bounded live testing; only synthetic text is sent. No credentials are logged/copied.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { app, safeStorage } from "electron";
import { AiCredentialVault } from "../src/main/ai-correction/ai-credential-vault.js";
import { createHttpsSseClient } from "../src/main/ai-correction/https-sse-client.js";
import { OpenAiCompatibleProvider } from "../src/main/ai-correction/openai-compatible-provider.js";
import { PatentPolishService } from "../src/main/ai-correction/patent-polish-service.js";
import { validateTextPolishConversationSummary } from "../src/main/ai-correction/text-polish-context.js";
import { TextPolishHistoryStore } from "../src/main/ai-correction/text-polish-history-store.js";
import { AiCorrectionSettingsSchema } from "../src/shared/ai-correction/model.js";
import type { TextPolishConversationSnapshot } from "../src/shared/ai-correction/text-polish-contract.js";
import { createBlankPatent } from "../src/shared/patent/defaults.js";

const option = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const report: {
  model?: string;
  requests: Array<Record<string, unknown>>;
  checks: Array<Record<string, unknown>>;
} = { requests: [], checks: [] };
let label = "setup";
const requestLabels = new Map<string, string>();
const check = (name: string, passed: boolean) => {
  report.checks.push({ name, passed });
  console.log(JSON.stringify({ event: "check", name, passed }));
};
const details = (value: Record<string, unknown>) => {
  const row = report.checks.at(-1);
  assert(row);
  Object.assign(row, value);
};

async function main() {
  assert(process.argv.includes("--run-live"), "Explicit live opt-in required");
  const source = option("--source-user-data");
  const output = option("--report");
  assert(source && output);
  assert.notEqual(resolve(source), resolve(app.getPath("userData")));
  const settings = AiCorrectionSettingsSchema.parse(
    JSON.parse(await readFile(resolve(source, "settings.json"), "utf8")).aiCorrection,
  );
  const profile = settings.profiles.find((item) => item.profileId === settings.activeProfileId);
  assert(
    profile?.providerId === "deepseek" &&
      new URL(profile.baseUrl).origin === "https://api.deepseek.com",
  );
  report.model = profile.model;
  const vault = new AiCredentialVault(source, safeStorage);
  label = "credential-read";
  check("credential-encryption-available", safeStorage.isEncryptionAvailable());
  check("configured-credential-readable", await vault.hasApiKey(profile.profileId));
  assert(await vault.hasApiKey(profile.profileId), "Configured credential unavailable");
  if (process.argv.includes("--credentials-only")) {
    await writeFile(output, JSON.stringify(report, null, 2), "utf8");
    return;
  }
  const sse = createHttpsSseClient();
  const provider = new OpenAiCompatibleProvider(
    async () => {
      throw new Error("Streaming required");
    },
    async (url, request, onData) => {
      assert(report.requests.length < 8, "Live request budget exhausted");
      const messages = request.body.messages as Array<{ content: string }>;
      const payload = JSON.parse(messages.at(-1)?.content ?? "{}");
      const caseLabel = requestLabels.get(payload.untrustedCurrentInstruction) ?? label;
      const row: Record<string, unknown> = {
        case: caseLabel,
        model: request.body.model,
        thinking: request.body.thinking,
        effort: request.body.reasoning_effort,
        outputTokenCap: 4096,
      };
      report.requests.push(row);
      const start = Date.now();
      console.log(
        JSON.stringify({ event: "request", number: report.requests.length, case: caseLabel }),
      );
      try {
        await sse(url, { ...request, body: { ...request.body, max_tokens: 4096 } }, (data) => {
          const event = data as {
            usage?: Record<string, unknown>;
            choices?: Array<{
              delta?: { reasoning_content?: string; content?: string };
              finish_reason?: string;
            }>;
          };
          if (event.usage) {
            row.usage = Object.fromEntries(
              Object.entries(event.usage).filter(([, value]) => typeof value === "number"),
            );
          }
          for (const choice of event.choices ?? []) {
            if (choice.delta?.reasoning_content) {
              row.firstReasoningMs ??= Date.now() - start;
              row.reasoningCharacters =
                Number(row.reasoningCharacters ?? 0) + choice.delta.reasoning_content.length;
            }
            if (choice.delta?.content)
              row.contentCharacters =
                Number(row.contentCharacters ?? 0) + choice.delta.content.length;
            if (choice.finish_reason) row.finishReason = choice.finish_reason;
          }
          onData(data);
        });
      } finally {
        row.elapsedMs = Date.now() - start;
        console.log(JSON.stringify({ event: "transport-end", ...row }));
      }
    },
  );
  const patent = createBlankPatent({ patentType: "invention", name: "LOCAL_ONLY_DO_NOT_SEND" });
  const book = patent.books.find((item) => item.kind === "description");
  const block = book?.document.content.find((item) => item.type === "paragraph");
  assert(block?.type === "paragraph");
  const selected =
    "测试方案代号为青鹭。过滤箱内设可抽出的滤网框，框体沿导向槽移动。传统滤网拆装不便。本方案只设机械拉手，不含传感器和电机。";
  block.content = [{ type: "text", text: selected, marks: [] }];
  // Resume only this harness's synthetic temporary history, without repeating paid calls.
  const resume = option("--resume-test-profile");
  let historyRoot = resolve(app.getPath("userData"), "history");
  if (resume) {
    const resumePath = realpathSync(resume);
    assert.equal(dirname(resumePath).toLowerCase(), realpathSync(tmpdir()).toLowerCase());
    assert(/^assistant-live-[a-f0-9-]+$/u.test(basename(resumePath)));
    historyRoot = resolve(resumePath, "history");
    const ids = readdirSync(historyRoot);
    assert.equal(ids.length, 1);
    patent.patentId = ids[0];
    const previous = option("--previous-report");
    assert(previous);
    const prior = JSON.parse(await readFile(previous, "utf8"));
    assert.equal(prior.model, profile.model);
    assert.equal(prior.requests.length, 5);
    assert.equal(prior.requests[4].finishReason, "length");
    report.requests.push(...prior.requests);
    report.checks.push(...prior.checks);
  }
  const history = new TextPolishHistoryStore(historyRoot);
  const sessionId = randomUUID();
  let stopId: string | null = null;
  let stopAt = 0;
  const service = new PatentPolishService({
    readSettings: async () => settings,
    vault,
    provider,
    history,
    patents: {
      requireActiveReadSession: (session, id) => {
        assert.equal(session, sessionId);
        assert.equal(id, patent.patentId);
        return structuredClone(patent);
      },
    },
    emit: (event) => {
      if (
        "conversationId" in event &&
        event.type === "reasoning" &&
        event.conversationId === stopId
      ) {
        stopAt = Date.now();
        service.cancelConversation("live", {
          identity: {
            conversationId: stopId,
            patentId: patent.patentId,
            sessionId,
            bookKind: "description",
          },
          turnId: event.turnId,
        });
        stopId = null;
      }
    },
  });
  const snapshot = (id: string) =>
    service.snapshotConversation("live", {
      conversationId: id,
      patentId: patent.patentId,
      sessionId,
      bookKind: "description",
    });
  const wait = async (id: string) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const value = await snapshot(id);
      if (!value.activeTurn) return value;
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error("Live sample timed out");
  };
  const reply = (value: TextPolishConversationSnapshot) => {
    const message = value.messages.at(-1);
    return message?.role === "assistant" ? message.reply : null;
  };
  const send = async (value: TextPolishConversationSnapshot, instruction: string) => {
    requestLabels.set(instruction, label);
    return service.sendConversation("live", {
      identity: value,
      expectedConversationRevision: value.conversationRevision,
      clientRequestId: randomUUID(),
      kind: "new",
      instruction,
    });
  };
  try {
    if (resume) {
      const records = history
        .history(patent.patentId)
        .map((item) => history.snapshot(patent.patentId, item.conversationId));
      assert.equal(records.length, 2);
      const a = records.find((item) => item?.source.kind === "selection");
      const b = records.find((item) => item?.source.kind === "generation");
      assert(a?.source.kind === "selection" && b?.source.kind === "generation");
      assert.equal(a.source.anchor.originalText, selected);
      assert.equal(b.messages[0]?.role, "user");
      assert(b.source.requirement.startsWith("本对话代号赤狐。"));
      label = "A-history-reopen-after-process-exit";
      const opened = await service.workspace("live", {
        patentId: patent.patentId,
        sessionId,
        action: "open",
        conversationId: a.conversationId,
      });
      assert(opened.snapshot);
      await send(opened.snapshot, "只答本对话的方案代号和约定的新部件名称，20字以内。");
      const continued = await wait(a.conversationId);
      check(
        label,
        /青鹭/u.test(reply(continued)?.message ?? "") &&
          /滤芯架/u.test(reply(continued)?.message ?? ""),
      );
      details({ reply: reply(continued) });
      label = "A-cancel-during-real-reasoning";
      stopId = a.conversationId;
      await send(continued, "比较滤芯架的两种机械导向方式，简要说明优缺点，100字以内。");
      const cancelled = await wait(a.conversationId);
      check(
        label,
        stopAt > 0 &&
          cancelled.lastTurnOutcome?.status === "cancelled" &&
          Date.now() - stopAt < 3000,
      );
      details({ cancelLatencyMs: stopAt ? Date.now() - stopAt : null });
      check(
        "cancel-does-not-affect-B",
        history.snapshot(patent.patentId, b.conversationId)?.lastTurnOutcome?.status ===
          "completed",
      );
      label = "A-followup-after-cancel";
      await send(cancelled, "只回答：方案代号、约定的新部件名称、是否有电机。40字以内。");
      const recovered = await wait(a.conversationId);
      const answer = reply(recovered)?.message ?? "";
      check(
        label,
        /青鹭/u.test(answer) &&
          /滤芯架/u.test(answer) &&
          /无|没有|不含/u.test(answer) &&
          recovered.lastTurnOutcome?.status === "completed",
      );
      details({ reply: reply(recovered) });
      check("history-saved", history.history(patent.patentId).length === 2);
      assert(report.checks.every((item) => item.passed));
      return;
    }
    label = "A-selection-background";
    const a = await service.startConversation("live", {
      patentId: patent.patentId,
      sessionId,
      expectedPatentRevision: patent.revision,
      clientRequestId: randomUUID(),
      uploadConfirmed: true,
      scope: {
        kind: "selection",
        bookKind: "description",
        blocks: [
          { blockId: block.id, blockType: "paragraph", startOffset: 0, endOffset: selected.length },
        ],
        selectedTextHash: createHash("sha256").update(selected).digest("hex"),
      },
      instruction: "仅起草背景技术，正文不超过100字，不要其他章节。",
    });
    const first = await wait(a.conversationId);
    const firstReply = reply(first);
    check(
      label,
      firstReply?.kind === "revision" &&
        !/技术领域|发明内容|具体实施方式/u.test(firstReply.revisedText) &&
        [...firstReply.revisedText].length <= 110,
    );
    details({ reply: firstReply });
    assert.equal(first.lastTurnOutcome?.status, "completed");

    label = "A-followup-abstract";
    await send(
      first,
      "现在改为生成正式说明书摘要，约100字，保留机械结构，不添加传感器或电机。之后将滤网框统一称为滤芯架。",
    );
    // Reset changes only the visible chat; A's real network request continues.
    await service.resetConversation("live", {
      identity: first,
      expectedConversationRevision: first.conversationRevision,
    });
    label = "B-independent-generation";
    const b = await service.startConversation("live", {
      patentId: patent.patentId,
      sessionId,
      expectedPatentRevision: patent.revision,
      clientRequestId: randomUUID(),
      uploadConfirmed: true,
      scope: { kind: "generation", bookKind: "claims" },
      instruction:
        "本对话代号赤狐。请问你是否知道另一对话的方案代号？不知道就明确说明，不猜测；回答不超过40字。",
    });
    const [abstract, independent] = await Promise.all([
      wait(a.conversationId),
      wait(b.conversationId),
    ]);
    const abstractReply = reply(abstract);
    check(
      "A-abstract-under-300",
      abstractReply?.kind === "revision" && [...abstractReply.revisedText].length <= 300,
    );
    details({ reply: abstractReply });
    const bReply = reply(independent);
    check(
      "B-does-not-know-A",
      !!bReply &&
        !JSON.stringify(bReply).includes("青鹭") &&
        /不知|不知道|无法|没有/u.test(bReply.message),
    );
    details({ reply: bReply });

    label = "B-followup-own-context";
    await send(independent, "本对话的代号是什么？只答代号。");
    const bFollowup = await wait(b.conversationId);
    check(
      label,
      reply(bFollowup)?.message.includes("赤狐") === true &&
        !JSON.stringify(reply(bFollowup)).includes("青鹭"),
    );
    details({ reply: reply(bFollowup) });

    label = "A-short-history-summary";
    const lastSummaryMessage = abstract.messages.at(-1);
    assert(lastSummaryMessage);
    const summaryOutput = await vault.withApiKey(profile.profileId, (apiKey) =>
      provider.summarizeTextPolishConversation({
        ...profile,
        apiKey,
        timeoutMs: 180_000,
        thinkingEnabled: true,
        signal: AbortSignal.timeout(180_000),
        messages: abstract.messages,
        coveredThroughMessageId: lastSummaryMessage.messageId,
      }),
    );
    const summary = { ...summaryOutput, summaryId: randomUUID() };
    validateTextPolishConversationSummary(summary, abstract.messages);
    check(label, summary.items.length > 0);
    details({ summary });
    label = "A-after-short-compression";
    const compressed = await vault.withApiKey(profile.profileId, (apiKey) =>
      provider.converseTextPolish({
        ...profile,
        apiKey,
        timeoutMs: 180_000,
        thinkingEnabled: true,
        signal: AbortSignal.timeout(180_000),
        source: abstract.source,
        messages: [],
        summary,
        latestValidDraft: abstract.latestValidDraft,
        instruction:
          "只回答：方案代号、后来约定的滤网框新名称、是否有电机。不要重新起草摘要，40字以内。",
      }),
    );
    check(
      label,
      /青鹭/u.test(compressed.message) &&
        /滤芯架/u.test(compressed.message) &&
        compressed.kind === "answer",
    );
    details({ reply: compressed });

    label = "A-history-reopen-followup";
    const opened = await service.workspace("live", {
      patentId: patent.patentId,
      sessionId,
      action: "open",
      conversationId: a.conversationId,
    });
    assert(opened.snapshot);
    await send(opened.snapshot, "只答本对话的方案代号和约定的新部件名称，20字以内。");
    const continued = await wait(a.conversationId);
    check(
      label,
      /青鹭/u.test(reply(continued)?.message ?? "") &&
        /滤芯架/u.test(reply(continued)?.message ?? ""),
    );
    details({ reply: reply(continued) });

    label = "A-cancel-during-real-reasoning";
    stopId = a.conversationId;
    await send(continued, "比较滤芯架的两种机械导向方式，简要说明优缺点，100字以内。");
    const cancelled = await wait(a.conversationId);
    check(
      label,
      stopAt > 0 && cancelled.lastTurnOutcome?.status === "cancelled" && Date.now() - stopAt < 3000,
    );
    details({ cancelLatencyMs: stopAt ? Date.now() - stopAt : null });
    check(
      "cancel-does-not-affect-B",
      (await snapshot(b.conversationId)).lastTurnOutcome?.status === "completed",
    );
    check("history-saved", history.history(patent.patentId).length === 2);
  } finally {
    service.releaseOwner("live");
    await writeFile(output, JSON.stringify(report, null, 2), "utf8");
  }
  assert(
    report.checks.every((item) => item.passed),
    "Some live checks failed; inspect synthetic report",
  );
}

async function runIsolated() {
  assert(process.argv.includes("--run-live"), "Explicit live opt-in required");
  const source = option("--source-user-data");
  const target = option("--user-data-dir");
  assert(source && target);
  const sourcePath = realpathSync(source).toLowerCase();
  const targetPath = realpathSync(target).toLowerCase();
  assert(targetPath !== sourcePath && !targetPath.startsWith(`${sourcePath}\\`));
  // Windows safeStorage uses the DPAPI-protected key from Local State, not just the account.
  // Seed only that encrypted key into a fresh isolated profile before Electron initializes it.
  // Never copy decrypted API keys, cookies, settings, documents, or the source credential file.
  if (process.platform === "win32") {
    const state = JSON.parse(readFileSync(resolve(source, "Local State"), "utf8"));
    assert(typeof state.os_crypt?.encrypted_key === "string");
    writeFileSync(
      resolve(target, "Local State"),
      JSON.stringify({
        os_crypt: {
          encrypted_key: state.os_crypt.encrypted_key,
          audit_enabled: state.os_crypt.audit_enabled === true,
        },
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  }
  app.setPath("userData", target);
  app.setPath("sessionData", target);
  await app.whenReady();
  await main();
}

// No BrowserWindow; never attach to or alter the user's current application.
runIsolated()
  .then(() => app.exit(0))
  .catch(async (error: unknown) => {
    const output = option("--report");
    if (output) await writeFile(output, JSON.stringify(report, null, 2), "utf8");
    console.error(
      JSON.stringify({
        event: "failed",
        case: label,
        kind: error instanceof Error ? error.name : "Error",
      }),
    );
    app.exit(1);
  });
