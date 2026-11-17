import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolveAiEndpoint } from "./endpoint-policy.js";
import { AiRequestError, aiHttpError } from "./https-json-client.js";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;

export type SseResolvedEndpoint = { hostname: string; addresses: string[] };
export type SseTransportInput = {
  url: URL;
  hostname: string;
  addresses: string[];
  authorization: string;
  signal: AbortSignal;
  body: string;
};
export type SseTransportResponse = {
  statusCode: number;
  contentType: string;
  body: AsyncIterable<Buffer>;
};
export type SseTransport = (input: SseTransportInput) => Promise<SseTransportResponse>;

export type PostSse = (
  url: URL,
  request: {
    authorization: string;
    timeoutMs: number;
    signal: AbortSignal;
    body: Record<string, unknown>;
  },
  onData: (data: unknown) => void,
) => Promise<void>;

type ClientOptions = {
  endpointOverride?: URL;
  resolveEndpoint?: (url: URL) => Promise<SseResolvedEndpoint>;
  transport?: SseTransport;
};

const nodeTransport: SseTransport = async (input) =>
  await new Promise((resolve, reject) => {
    const address = input.addresses[0];
    if (!address) return reject(new AiRequestError());
    const requestUrl = input.url.protocol === "http:" ? httpRequest : httpsRequest;
    const request = requestUrl(
      {
        protocol: input.url.protocol,
        hostname: address,
        port: input.url.port || (input.url.protocol === "http:" ? 80 : 443),
        path: `${input.url.pathname}${input.url.search}`,
        method: "POST",
        ...(input.url.protocol === "https:"
          ? { servername: input.hostname, rejectUnauthorized: true }
          : {}),
        headers: {
          Host: input.url.host,
          Authorization: input.authorization,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(input.body),
        },
        signal: input.signal,
      },
      (response) =>
        resolve({
          statusCode: response.statusCode ?? 0,
          contentType: String(response.headers["content-type"] ?? ""),
          body: response,
        }),
    );
    request.on("error", (error) =>
      reject(error instanceof AiRequestError ? error : new AiRequestError()),
    );
    request.end(input.body);
  });

function parseEvent(event: string, onData: (data: unknown) => void): boolean {
  const data = event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return false;
  if (data === "[DONE]") return true;
  try {
    onData(JSON.parse(data) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AiRequestError("AI 服务返回了无法识别的流式数据。");
    }
    throw error;
  }
  return false;
}

async function readEventStream(
  response: SseTransportResponse,
  onData: (data: unknown) => void,
): Promise<void> {
  if (!response.contentType.toLowerCase().startsWith("text/event-stream")) {
    throw new AiRequestError("AI 服务未返回流式数据。");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let done = false;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      throw new AiRequestError("AI 服务响应过大，已中止读取。");
    }
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = /\r?\n\r?\n/u.exec(buffer);
    while (boundary) {
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      if (Buffer.byteLength(event, "utf8") > MAX_EVENT_BYTES) {
        throw new AiRequestError("AI 服务响应过大，已中止读取。");
      }
      if (parseEvent(event, onData)) {
        done = true;
        break;
      }
      boundary = /\r?\n\r?\n/u.exec(buffer);
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_EVENT_BYTES) {
      throw new AiRequestError("AI 服务响应过大，已中止读取。");
    }
    if (done) break;
  }
  if (!done) throw new AiRequestError("AI 服务流式响应提前结束。");
}

export function createHttpsSseClient({
  endpointOverride,
  resolveEndpoint = resolveAiEndpoint,
  transport = nodeTransport,
}: ClientOptions = {}): PostSse {
  return async (url, request, onData) => {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) abortFromCaller();
    else request.signal.addEventListener("abort", abortFromCaller, { once: true });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const duration =
      request.timeoutMs >= 60_000
        ? `${request.timeoutMs / 60_000} 分钟`
        : `${request.timeoutMs / 1000} 秒`;
    const timeoutMessage = `AI 本次请求已超过 ${duration}，请缩短任务或稍后重试。`;
    let rejectOnAbort: (() => void) | undefined;
    try {
      const targetUrl = endpointOverride ?? url;
      controller.signal.throwIfAborted();
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
      deadline = setTimeout(() => {
        timedOut = true;
        controller.abort(new AiRequestError(timeoutMessage));
      }, request.timeoutMs);
      const endpoint = await Promise.race([resolveEndpoint(targetUrl), aborted]);
      controller.signal.throwIfAborted();
      const response = await transport({
        url: targetUrl,
        ...endpoint,
        authorization: request.authorization,
        signal: controller.signal,
        body: JSON.stringify(request.body),
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        let body = "";
        if ([400, 413, 422].includes(response.statusCode)) {
          for await (const chunk of response.body) {
            body += chunk.toString("utf8");
            if (Buffer.byteLength(body, "utf8") >= 16_384) break;
          }
        }
        throw aiHttpError(response.statusCode, body);
      }
      await readEventStream(response, onData);
    } catch (error) {
      if (timedOut) throw new AiRequestError(timeoutMessage);
      if (request.signal.aborted) {
        throw request.signal.reason instanceof Error ? request.signal.reason : error;
      }
      throw error instanceof Error ? error : new AiRequestError();
    } finally {
      if (deadline) clearTimeout(deadline);
      if (rejectOnAbort) controller.signal.removeEventListener("abort", rejectOnAbort);
      request.signal.removeEventListener("abort", abortFromCaller);
    }
  };
}
