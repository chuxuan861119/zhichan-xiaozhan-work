import { request } from "node:https";
import { type DailyAggregate, DailyAggregateSchema } from "../../shared/usage-statistics/model.js";
import { secureUsageEndpoint } from "./usage-statistics-config.js";

/** Separate Node TLS request: no browser session, cookies, credentials or redirects. */
export function sendUsageAggregate(
  endpoint: string,
  payload: DailyAggregate,
  signal: AbortSignal,
): Promise<number> {
  const body = JSON.stringify(DailyAggregateSchema.parse(payload));
  if (Buffer.byteLength(body) > 2048)
    return Promise.reject(new Error("Statistics payload too large"));
  return new Promise((resolve, reject) => {
    const outgoing = request(
      secureUsageEndpoint(endpoint),
      {
        method: "POST",
        signal,
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": `UsageStatistics/${payload.schema_version}`,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        resolve(status);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
