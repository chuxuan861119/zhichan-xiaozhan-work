import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  DailyAggregateSchema,
  dayStart,
  sameUsageRelease,
  shanghaiDay,
  USAGE_RETRY_DAYS,
  type UsageRelease,
} from "../../src/shared/usage-statistics/model.js";
import type { UsageStore } from "./store.js";

type ReceiverOptions = {
  store: Pick<UsageStore, "accept"> & Partial<Pick<UsageStore, "recordReception">>;
  publicVersionGroups: readonly string[];
  releases?: readonly UsageRelease[];
  preciseReleases?: readonly UsageRelease[];
  clock?: () => number;
  requestsPerMinute?: number;
  acceptLegacy?: boolean;
  trustProxy?: boolean;
  requestsPerSourceMinute?: number;
};
export function createUsageReceiver(options: ReceiverOptions) {
  const now = options.clock ?? Date.now;
  let minute = 0;
  let requests = 0;
  const sources = new Map<string, number>();
  let lastLimitedMinute = -1;
  const respond = (response: ServerResponse, status: number, outcome?: string) => {
    const minuteNow = Math.floor(now() / 60_000);
    if (outcome && (outcome !== "rate_limited" || lastLimitedMinute !== minuteNow)) {
      if (outcome === "rate_limited") lastLimitedMinute = minuteNow;
      try {
        options.store.recordReception?.(shanghaiDay(now()), outcome);
      } catch {
        process.stderr.write("Usage reception diagnostics could not be saved.\n");
      }
    }
    response.writeHead(status, { "Cache-Control": "no-store", Connection: "close" });
    response.end();
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== "/v1/usage/daily-aggregate")
      return respond(response, 404);
    const current = Math.floor(now() / 60_000);
    if (minute !== current) {
      minute = current;
      requests = 0;
      sources.clear();
    }
    if (++requests > (options.requestsPerMinute ?? 600))
      return respond(response, 429, "rate_limited");
    const source = options.trustProxy
      ? String(request.headers["x-real-ip"] || request.socket.remoteAddress)
      : String(request.socket.remoteAddress);
    const sourceCount = (sources.get(source) ?? 0) + 1;
    if (!sources.has(source) && sources.size >= 10000)
      return respond(response, 429, "rate_limited");
    sources.set(source, sourceCount);
    if (sourceCount > (options.requestsPerSourceMinute ?? 120))
      return respond(response, 429, "rate_limited");
    if (
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "") ||
      Number(request.headers["content-length"] ?? 0) > 2048
    )
      return respond(response, 400, "invalid");
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > 2048) {
        rejected = true;
        chunks.length = 0;
        respond(response, 400, "invalid");
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      let payload: ReturnType<typeof DailyAggregateSchema.parse>;
      try {
        payload = DailyAggregateSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const identity =
          payload.schema_version !== 1
            ? {
                platform: payload.platform,
                version: payload.app_version,
                channel: payload.release_channel,
              }
            : null;
        const allowed =
          payload.schema_version === 1
            ? options.publicVersionGroups.includes(payload.version_group)
            : (options.releases ?? []).some(
                (release) => identity !== null && sameUsageRelease(release, identity),
              );
        const precise = identity !== null && (options.preciseReleases ?? []).some((release) => sameUsageRelease(release, identity));
        if (payload.schema_version === 5 && !precise) return respond(response, 400, "unreleased");
        if (payload.schema_version !== 5 && precise) return respond(response, 400, "legacy_rejected");
        if (payload.schema_version < 3 && !options.acceptLegacy)
          return respond(response, 400, "legacy_rejected");
        const today = shanghaiDay(now());
        const age = (dayStart(today) - dayStart(payload.day)) / 86_400_000;
        if (age < 1 || age > (payload.schema_version >= 3 ? USAGE_RETRY_DAYS : 1))
          return respond(response, 400, "outside_window");
        if (!allowed) return respond(response, 400, "unreleased");
      } catch {
        return respond(response, 400, "invalid");
      }
      try {
        const result = options.store.accept(payload);
        if (result === "conflict") return respond(response, 409, "conflict");
        if (result === "closed") return respond(response, 410, "closed");
        respond(response, 204, result === "duplicate" ? "duplicate" : "accepted");
      } catch {
        respond(response, 503, "storage_error");
      }
    });
    request.on("error", () => {
      if (!response.headersSent) respond(response, 400);
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 30;
  return server;
}
