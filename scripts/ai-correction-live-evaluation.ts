// Explicit opt-in only. Uses synthetic documents and never writes credentials or patent data.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { app, safeStorage } from "electron";
import { AiCredentialVault } from "../src/main/ai-correction/ai-credential-vault.js";
import { createHttpsSseClient } from "../src/main/ai-correction/https-sse-client.js";
import { OpenAiCompatibleProvider } from "../src/main/ai-correction/openai-compatible-provider.js";
import { buildCorrectionMessages, type ProviderSegment } from "../src/main/ai-correction/prompt.js";
import { AI_CORRECTION_PROMPT_VERSION } from "../src/shared/ai-correction/prompt-version.js";

const description = [
  "一种用于温室灌溉的过滤装置",
  "技术领域",
  "本实用新型涉及农业灌溉技术领域，具体涉及一种用于温室灌溉的过滤装置。",
  "背景技术",
  "温室灌溉系统通常利用水泵向输水管提供水流。水流中的砂粒及植物碎屑容易堵塞滴灌管出口。现有过滤装置通过滤网截留杂质，使用一段时间后需要取出滤网进行清洗。操作人员取出滤网时，需先关闭水泵，再打开过滤箱，清洗过程中灌溉系统不能继续供水。因此，需要一种便于拆装滤网的过滤装置。",
  "实用新型内容",
  "为便于拆装滤网，本实用新型提供一种用于温室灌溉的过滤装置。该装置包括过滤箱、进水管、出水管、滤网框和控制器。进水管连接过滤箱的左侧，出水管连接过滤箱的右侧。滤网框位于进水管与出水管之间，滤网框内设有滤网。过滤箱的顶部设有检修口，滤网框能够从检修口取出。检修口设置有盖板，盖板与过滤箱之间设有密封圈。",
  "过滤箱的内壁设有两条导向槽，滤网框的两侧分别置于两条导向槽内。滤网框沿导向槽上下移动。盖板上设置有压杆，盖板关闭后，压杆的下端与滤网框的上端抵接，以限制滤网框向上移动。压杆与滤网框之间设置有弹性垫片，弹性垫片用于缓冲压杆与滤网框之间的接触。",
  "过滤箱的进水侧设置有第一压力传感器，过滤箱的出水侧设置有第二压力传感器。第一压力传感器和第二压力传感器均与控制器电连接。控制器根据两侧的压力差发出清洗提示。控制器连接有指示灯，指示灯用于显示过滤箱的工作状态。",
  "通过导向槽引导滤网框移动，操作人员能够沿确定方向取出滤网框，减少滤网框取出时与过滤箱内壁的碰撞。盖板关闭后，压杆限制滤网框的位置，密封圈减少检修口处的漏水。上述结构能够提高滤网框拆装的便利性，并保持正常供水时滤网框的位置稳定。",
  "附图说明",
  "图1为本装置的整体结构示意图；图2为滤网框与导向槽的配合示意图。",
  "具体实施方式",
  "下面结合图1和图2对本装置进行说明。本实施例中，过滤箱由不锈钢板连接而成，进水管和出水管分别连接于过滤箱的两侧。检修口设置在过滤箱顶部，盖板通过铰链与过滤箱连接。盖板的自由端设置有锁扣，锁扣闭合后，盖板压紧密封圈。打开锁扣后，盖板能够绕铰链转动。",
  "滤网框由矩形边框及固定在边框内的滤网组成。矩形边框两侧设有与导向槽配合的滑动部。两条导向槽竖直设置，滑动部能够沿导向槽的长度方向滑动。矩形边框的上端设有拉手，操作人员通过拉手取出滤网框。拉手与压杆错开设置，使压杆关闭后不与拉手发生干涉。",
  "在本实施例中，压杆通过螺纹连接固定在盖板下表面，压杆的下端设置有弹性垫片。压杆能够随盖板同步转动。盖板关闭时，压杆的下端压紧滤网框。通过调整压杆的伸出长度，可以改变弹性垫片的压缩量。调整完成后，利用锁紧螺母固定压杆。",
  "第一压力传感器设置在滤网的进水侧，第二压力传感器设置在滤网的出水侧。两个压力传感器分别检测对应位置的水压，并将检测信号发送至控制器。控制器比较两个检测信号对应的压力值，当压力差达到设定值时，控制器使指示灯闪烁。指示灯闪烁仅用于提示操作人员检查滤网，不直接控制水泵启停。",
  "正常供水时，水流从进水管进入过滤箱，经滤网后从出水管流出。滤网截留水流中的杂质，杂质留在滤网的进水侧。操作人员看到指示灯闪烁后，关闭水泵及进水阀，释放过滤箱内的压力，再打开盖板并取出滤网框。",
  "清洗完成后，将滤网框重新插入导向槽，确认滤网框到位后关闭盖板。检查密封圈的位置，避免密封圈被夹在盖板边缘之外。随后闭合锁扣，开启进水阀，观察检修口是否漏水。确认无漏水后启动水泵，使灌溉系统恢复供水。。",
  "控致器安装在过滤箱外侧的安装板上，安装板与过滤箱通过螺钉连接。控制器与传感器之间的导线通过线槽布置，线槽的开口处设有盖条。盖条用于限制导线的位置，避免导线与滤网框发生接触。",
  "在另一实施例中，过滤箱也可以采用工程塑料制成。该实施例的材料选择不影响滤网框沿导向槽移动的方式。滤网的网孔尺寸根据灌溉管路的需求选择，本装置不限定具体网孔尺寸。",
];
const cases: Array<{ id: string; segments: ProviderSegment[] }> = [
  {
    id: "description",
    segments: description.map((text, i) => ({
      segmentId: `segment-${i + 1}`,
      bookKind: "description",
      text,
      boundary: { startsAtParagraphStart: true, endsAtParagraphEnd: true },
      requestContext: { chunkIndex: 1, chunkCount: 1, completeDocument: true },
    })),
  },
  {
    id: "claims",
    segments: [
      "1.一种过滤装置，其特征在于：包括过滤箱、进水管、出水管和滤网框，所述进水管和出水管分别连接过滤箱两侧，所述滤网框设置于过滤箱内部；",
      "所述过滤箱顶部设置有检修口，所述检修口设有盖板，所述滤网框能够从检修口取出。",
      "2.根据权利要求1所述的过滤装置，其特征在于：所述过滤箱内壁设有导向槽，所述滤网框两侧分别设有与导向槽配合的滑动部。。",
      "3.根据权利要求1所述的过滤装置，其特征在于：所述盖板下端设置有压杆，所述压杆下端与所述滤网框的的上端抵接。",
    ].map((text, i) => ({
      segmentId: `segment-${i + 1}`,
      bookKind: "claims",
      text,
      boundary: { startsAtParagraphStart: true, endsAtParagraphEnd: true },
      claim: {
        number: String(i < 2 ? 1 : i),
        paragraphIndex: i === 1 ? 2 : 1,
        paragraphCount: i < 2 ? 2 : 1,
        groupId: i < 2 ? "claim-1" : `claim-${i}`,
        complete: true,
      },
      requestContext: { chunkIndex: 1, chunkCount: 1, completeDocument: true },
    })),
  },
  {
    id: "abstract",
    segments: [
      {
        segmentId: "segment-1",
        bookKind: "abstract",
        text: "本实用新型涉及农业灌溉技术领域，公开了一种过滤装置，包括过滤箱、进水管、出水管和滤网框。过滤箱顶部设有检修口，检修口设置盖板。滤网框两侧设有与过滤箱内壁导向槽配合的滑动部，滤网框能够沿导向槽从检修口取出。盖板下端设置压杆，压杆与滤网框的的上端抵接。打开盖板后，压杆随盖板移动，操作人员可通过滤网框上端的拉手取出滤网框。本装置便于拆装滤网框，可减少滤网框拆装时与箱体内壁的碰撞。。",
        boundary: { startsAtParagraphStart: true, endsAtParagraphEnd: true },
        requestContext: { chunkIndex: 1, chunkCount: 1, completeDocument: true },
      },
    ],
  },
];

async function main() {
  if (!process.argv.includes("--run-live")) throw new Error("opt-in required");
  const option = (name: string) =>
    process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const source = option("--source-user-data");
  const effort = option("--effort");
  if (!source || !["low", "high"].includes(effort ?? "")) throw new Error("invalid options");
  const settings = JSON.parse(
    await readFile(resolve(source, "settings.json"), "utf8"),
  ).aiCorrection;
  const profile = settings.profiles.find(
    (item: { profileId: string }) => item.profileId === settings.activeProfileId,
  );
  if (
    profile?.providerId !== "deepseek" ||
    new URL(profile.baseUrl).origin !== "https://api.deepseek.com"
  )
    throw new Error("official DeepSeek profile required");
  const vault = new AiCredentialVault(source, safeStorage);
  if (!(await vault.hasApiKey(profile.profileId))) {
    console.log(
      JSON.stringify({
        event: "unavailable",
        stage: "credential",
        encryptionAvailable: safeStorage.isEncryptionAvailable(),
      }),
    );
    throw new Error("credential unavailable");
  }
  const postSse = createHttpsSseClient();
  let failures = 0;
  for (const sample of cases) {
    const started = Date.now();
    console.log(
      JSON.stringify({
        event: "start",
        sample: sample.id,
        effort,
        version: AI_CORRECTION_PROMPT_VERSION,
      }),
    );
    let diagnostic: unknown;
    const provider = new OpenAiCompatibleProvider(
      async () => {
        throw new Error("SSE expected");
      },
      (url, request, onData) =>
        postSse(url, { ...request, body: { ...request.body, reasoning_effort: effort } }, onData),
      (value) => {
        diagnostic = value;
      },
    );
    try {
      const result = await vault.withApiKey(profile.profileId, (apiKey) =>
        provider.correct({
          ...profile,
          apiKey,
          timeoutMs: 600_000,
          thinkingEnabled: true,
          signal: AbortSignal.timeout(600_000),
          scopeKind: "current-book",
          segments: sample.segments,
        }),
      );
      console.log(
        JSON.stringify({
          event: "result",
          sample: sample.id,
          effort,
          model: profile.model,
          version: AI_CORRECTION_PROMPT_VERSION,
          elapsedMs: Date.now() - started,
          inputCharacters: sample.segments.reduce((sum, s) => sum + s.text.length, 0),
          promptCharacters: buildCorrectionMessages("current-book", sample.segments)[0].content
            .length,
          diagnostic,
          result,
        }),
      );
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : "";
      const reason = message.includes("提前结束")
        ? "stream-ended"
        : message.includes("超过") || message.includes("超时")
          ? "timeout"
          : message.includes("频繁")
            ? "rate-limit"
            : message.includes("过大")
              ? "response-limit"
              : "request-failed";
      console.log(
        JSON.stringify({
          event: "failed",
          sample: sample.id,
          effort,
          elapsedMs: Date.now() - started,
          reason,
          diagnostic,
        }),
      );
    }
  }
  if (failures) throw new Error("evaluation incomplete");
}

// No BrowserWindow: this helper must never activate a window or reuse the source profile directory.
app
  .whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(
      JSON.stringify({
        event: "failure",
        kind: error?.name,
        code: typeof error?.code === "string" ? error.code : undefined,
      }),
    );
    console.error("Live evaluation failed; no credentials or response bodies logged on failure.");
    app.exit(1);
  });
