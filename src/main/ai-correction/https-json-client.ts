import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolveAiEndpoint } from "./endpoint-policy.js";
import type { PostJson } from "./openai-compatible-provider.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type ResolvedEndpoint = { hostname: string; addresses: string[] };
type TransportInput = {
  url: URL;
  hostname: string;
  addresses: string[];
  method: "GET" | "POST";
  authorization: string;
  timeoutMs: number;
  signal: AbortSignal;
  body?: string;
};
type Transport = (input: TransportInput) => Promise<{ statusCode: number; body: string }>;

export class AiRequestError extends Error {
  readonly code = "AI_REQUEST_FAILED" as const;
  constructor(
    message = "AI 服务请求失败，请检查配置后重试。",
    readonly reason?: "context-window",
  ) {
    super(message);
    this.name = "AiRequestError";
  }
}

export function aiHttpError(status: number, body = ""): AiRequestError {
  if (status === 402)
    return new AiRequestError(
      "模型服务账户余额不足，请检查服务商账户余额，补充余额后重试。当前对话已保留。",
    );
  if (status === 401 || status === 403)
    return new AiRequestError("AI 服务鉴权失败，请重新检查 API Key。");
  if (status === 429) return new AiRequestError("AI 服务请求过于频繁，请稍后重试。");
  if (status === 400 || status === 413 || status === 422) {
    let detail = "";
    try {
      const parsed: unknown = JSON.parse(body.slice(0, 16_384));
      if (
        parsed &&
        typeof parsed === "object" &&
        "error" in parsed &&
        parsed.error &&
        typeof parsed.error === "object"
      ) {
        const error = parsed.error as Record<string, unknown>;
        detail = [error.code, error.type, error.message]
          .filter((value) => typeof value === "string")
          .join(" ");
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Non-JSON error pages are deliberately not exposed to the renderer.
    }
    if (
      /context(?:[_ -]?length| window)|maximum context|too many tokens|prompt is too long/iu.test(
        detail,
      )
    ) {
      return new AiRequestError("AI 会话上下文已达到模型上限。", "context-window");
    }
    return new AiRequestError("AI 服务拒绝了请求参数，请检查模型是否支持当前请求格式。");
  }
  if (status === 404)
    return new AiRequestError("AI 服务接口或模型不存在，请检查服务地址和模型配置。");
  if (status >= 500) return new AiRequestError("AI 服务暂时不可用，请稍后重试。");
  return new AiRequestError();
}

const nodeTransport: Transport = async (input) =>
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
        method: input.method,
        ...(input.url.protocol === "https:"
          ? { servername: input.hostname, rejectUnauthorized: true }
          : {}),
        headers: {
          Host: input.url.host,
          Authorization: input.authorization,
          "Content-Type": "application/json",
          ...(input.body === undefined ? {} : { "Content-Length": Buffer.byteLength(input.body) }),
        },
        signal: input.signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.byteLength;
          if (length > MAX_RESPONSE_BYTES) {
            request.destroy(new AiRequestError("AI 服务响应过大，已中止读取。"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.setTimeout(input.timeoutMs, () =>
      request.destroy(new AiRequestError("AI 服务请求超时。")),
    );
    request.on("error", (error) =>
      reject(error instanceof AiRequestError ? error : new AiRequestError()),
    );
    request.end(input.body);
  });

export type GetJson = (
  url: URL,
  request: { authorization: string; timeoutMs: number; signal: AbortSignal },
) => Promise<unknown>;

type ClientOptions = {
  resolveEndpoint?: (url: URL) => Promise<ResolvedEndpoint>;
  transport?: Transport;
};

async function requestJson(
  url: URL,
  request: { authorization: string; timeoutMs: number; signal: AbortSignal; body?: unknown },
  method: "GET" | "POST",
  resolveEndpoint: (url: URL) => Promise<ResolvedEndpoint>,
  transport: Transport,
): Promise<unknown> {
  const endpoint = await resolveEndpoint(url);
  const response = await transport({
    url,
    ...endpoint,
    method,
    authorization: request.authorization,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw aiHttpError(response.statusCode, response.body);
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new AiRequestError("AI 服务返回了无法识别的数据。");
  }
}

export function createHttpsJsonClient({
  resolveEndpoint = resolveAiEndpoint,
  transport = nodeTransport,
}: ClientOptions = {}): PostJson {
  return async (url, request) =>
    await requestJson(url, request, "POST", resolveEndpoint, transport);
}

export function createHttpsJsonGetter({
  resolveEndpoint = resolveAiEndpoint,
  transport = nodeTransport,
}: ClientOptions = {}): GetJson {
  return async (url, request) => await requestJson(url, request, "GET", resolveEndpoint, transport);
}
