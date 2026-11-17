import { z } from "zod";
import { AiRequestError, type GetJson } from "./https-json-client.js";

const MAX_DISCOVERED_MODELS = 200;
const ModelListSchema = z
  .object({
    data: z
      .array(z.object({ id: z.string().trim().max(200) }).passthrough())
      .max(MAX_DISCOVERED_MODELS),
  })
  .passthrough();

export class AiModelDiscoveryService {
  constructor(private readonly getJson: GetJson) {}

  async discover(input: {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<string[]> {
    const endpoint = new URL(
      "models",
      input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`,
    );
    try {
      const response = ModelListSchema.parse(
        await this.getJson(endpoint, {
          authorization: `Bearer ${input.apiKey}`,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
        }),
      );
      return [...new Set(response.data.map(({ id }) => id).filter(Boolean))];
    } catch (error) {
      if (error instanceof AiRequestError) throw error;
      throw new AiRequestError("该提供商未返回可识别的模型列表，请使用官方预置模型。");
    }
  }
}
