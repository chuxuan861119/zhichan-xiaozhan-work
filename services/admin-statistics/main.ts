import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  dayStart,
  shanghaiDay,
  USAGE_PUBLICATION_DELAY_DAYS,
  USAGE_RETRY_DAYS,
  UsageReleaseSchema,
  VersionGroupSchema,
} from "../../src/shared/usage-statistics/model.js";
import { createUsageReceiver } from "../usage-statistics/server.js";
import { PreciseUsageStore } from "../usage-statistics/precise-store.js";
// The admin HTTP layer is isolated JavaScript and has independent Node tests.
// @ts-expect-error -- compiled together by esbuild; not part of the Electron application.
import { createAdminServer } from "./server.mjs";

const schema = z
  .object({
    privateDirectory: z.string().min(1),
    trafficPath: z.string().min(1),
    databasePath: z.string().min(1),
    origin: z.url(),
    port: z.number().int().min(1024).max(65535),
    usagePort: z.number().int().min(1024).max(65535),
    publicVersionGroups: z.array(VersionGroupSchema).max(200),
    releases: z.array(UsageReleaseSchema).max(200).default([]),
    preciseReleases: z.array(UsageReleaseSchema).max(200).default([]),
    retentionMonths: z.number().int().min(1).max(18),
    clientReleaseActive: z.boolean(),
    snapshotView: z.enum(["all", "versions", "releases"]),
    assetsDirectory: z.string().min(1),
  })
  .strict();
async function main() {
  process.umask(0o077);
  const config = schema.parse(JSON.parse(readFileSync(process.argv[2]!, "utf8")));
  const site = new URL(config.origin);
  const local = site.hostname === "127.0.0.1" || site.hostname === "localhost";
  if (
    (site.protocol !== "https:" && !local) ||
    site.origin !== config.origin ||
    config.port === config.usagePort
  )
    throw Error("Invalid service origin or ports");
  if (
    config.clientReleaseActive !== !!(config.publicVersionGroups.length || config.releases.length)
  )
    throw Error("Release state and accepted versions must agree");
  if (config.releases.length && config.snapshotView !== "releases")
    throw Error("Release reporting view is required");
  if (config.preciseReleases.some((p) => !config.releases.some((r) => r.platform === p.platform && r.version === p.version && r.channel === p.channel))) throw Error("Precise releases must be enabled releases");
  const store = new PreciseUsageStore(config.databasePath, config.preciseReleases);
  store.prune(shanghaiDay(Date.now()), config.retentionMonths);
  let maintenanceFailed = false;
  const receiver = createUsageReceiver({
    store,
    publicVersionGroups: config.publicVersionGroups,
    releases: config.releases,
    preciseReleases: config.preciseReleases,
    requestsPerMinute: 300,
    acceptLegacy: false,
    trustProxy: true,
  });
  const admin = await createAdminServer({
    ...config,
    secureCookies: !local,
    readUsage: () => ({
      state: maintenanceFailed
        ? "error"
        : config.clientReleaseActive
          ? "active"
          : "waiting-release",
      receiverReady: receiver.listening,
      publicVersionGroups: config.publicVersionGroups,
      releases: config.releases,
      endpoint: config.origin + "/v1/usage/daily-aggregate",
      reception: store.receptionHealth(shanghaiDay(Date.now())),
      reporting: {
        protocol: 5,
        provisional: true,
        latestAvailableDay: shanghaiDay(dayStart(shanghaiDay(Date.now())) - 86_400_000),
        retryDays: USAGE_RETRY_DAYS,
        delayDays: USAGE_PUBLICATION_DELAY_DAYS,
        latestPublishableDay: shanghaiDay(
          dayStart(shanghaiDay(Date.now())) - USAGE_PUBLICATION_DELAY_DAYS * 86_400_000,
        ),
      },
      backup: (() => {
        try {
          const status = JSON.parse(
            readFileSync(config.privateDirectory + "/backup-status.json", "utf8"),
          );
          return {
            lastCompletedAt:
              status.status === "ok" &&
              typeof status.generatedAt === "string" &&
              Number.isFinite(Date.parse(status.generatedAt))
                ? status.generatedAt
                : null,
          };
        } catch {
          return { lastCompletedAt: null };
        }
      })(),
      snapshots: store.reports(shanghaiDay(Date.now()), config.snapshotView),
    }),
  });
  const timer = setInterval(() => {
    try {
      store.prune(shanghaiDay(Date.now()), config.retentionMonths);
      maintenanceFailed = false;
    } catch {
      maintenanceFailed = true;
      process.stderr.write("Usage retention maintenance failed.\n");
    }
  }, 86400000);
  timer.unref();
  const listen = (server: ReturnType<typeof createUsageReceiver>, port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  await listen(receiver, config.usagePort);
  await listen(admin, config.port);
  process.stdout.write(
    "Statistics services ready on loopback; administrator credentials are private.\n",
  );
  const close = () => {
    clearInterval(timer);
    admin.close(() => receiver.close(() => store.close()));
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
main().catch(() => {
  process.stderr.write("Statistics service failed; check private configuration and permissions.\n");
  process.exit(1);
});
