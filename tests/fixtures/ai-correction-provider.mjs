import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";

const logPath = process.argv[2];
const port = Number(process.argv[3] ?? 11434);
const delay = Number(process.argv[4] ?? 500);
const subsequentDelay = Number(process.argv[5] ?? delay);
let correctionRequests = 0;
if (!logPath) throw new Error("缺少请求日志路径。");

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  response.once("close", () => {
    if (!response.writableFinished)
      void appendFile(logPath, `${JSON.stringify({ event: "aborted" })}\n`);
  });
  await appendFile(
    logPath,
    `${JSON.stringify({ method: request.method, url: request.url, raw })}\n`,
  );
  response.setHeader("Content-Type", "application/json");

  if (request.method === "GET" && request.url === "/v1/models") {
    response.end(JSON.stringify({ data: [{ id: "qwen3:8b" }] }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const body = JSON.parse(raw);
  const userMessage = body.messages.find((message) => message.role === "user");
  const payload = JSON.parse(userMessage.content);
  if (typeof payload.untrustedCurrentInstruction === "string") {
    const instruction = payload.untrustedCurrentInstruction;
    const finalContent = JSON.stringify(
      instruction.includes("为什么")
        ? { kind: "answer", message: "因为该表达更符合专利文书的严谨语气。" }
        : {
            kind: "revision",
            message: "已按要求调整表述。",
            revisedText: instruction.includes("精简")
              ? "本装置包括主体和连接件。"
              : "本装置包括主体以及与主体连接的连接件。",
          },
    );
    response.end(JSON.stringify({ choices: [{ message: { content: finalContent } }] }));
    return;
  }
  const segment = payload.untrustedPatentText.find(({ text }) => text.includes("错别子"));
  const startOffset = segment?.text.indexOf("子") ?? -1;
  const issues =
    segment && startOffset >= 0
      ? [
          {
            segmentId: segment.segmentId,
            contextBefore: segment.text.slice(0, startOffset),
            contextAfter: segment.text.slice(startOffset + 1),
            originalText: "子",
            category: "spelling",
            risk: "low",
            applicability: "replace",
            replacement: "字",
            explanation: "此处应为“错别字”。",
          },
        ]
      : [];
  const finalContent = JSON.stringify({ issues });
  if (body.stream === true) {
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "正在核对专利术语与错别字" } }] })}\n\n`,
    );
    correctionRequests += 1;
    await new Promise((resolve) =>
      setTimeout(resolve, correctionRequests === 1 ? delay : subsequentDelay),
    );
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: finalContent }, finish_reason: "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
    return;
  }
  response.end(JSON.stringify({ choices: [{ message: { content: finalContent } }] }));
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`READY ${server.address().port}\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
