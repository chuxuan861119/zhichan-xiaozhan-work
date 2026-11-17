import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  DaySchema,
  shanghaiDay,
  UsageReleaseSchema,
  VersionGroupSchema,
} from "../../src/shared/usage-statistics/model.js";
import { createUsageReceiver } from "./server.js";
import { PreciseUsageStore } from "./precise-store.js";

const ConfigSchema = z
  .object({
    databasePath: z.string().min(1),
    publicVersionGroups: z.array(VersionGroupSchema).max(200),
    releases: z.array(UsageReleaseSchema).max(200).default([]),
    preciseReleases: z.array(UsageReleaseSchema).max(200).default([]),
    port: z.number().int().min(1024).max(65535),
    retentionMonths: z.number().int().min(1).max(18),
    requestsPerMinute: z.number().int().min(1).max(10_000),
  })
  .strict();
function main() {
  process.umask(0o077);
  const [mode, path, day, view] = process.argv.slice(2);
  if (!path || !["serve", "publish", "report"].includes(mode ?? ""))
    throw new Error("Usage: serve|publish|report CONFIG [DAY] [all|versions|releases]");
  const config = ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  if (config.preciseReleases.some((p) => !config.releases.some((r) => JSON.stringify(r) === JSON.stringify(p)))) throw Error("Precise releases must be enabled releases");
  const store = new PreciseUsageStore(config.databasePath, config.preciseReleases);
  const today = shanghaiDay(Date.now());
  store.prune(today, config.retentionMonths);
  if (mode === "serve") {
    const server = createUsageReceiver({
      store,
      publicVersionGroups: config.publicVersionGroups,
      releases: config.releases,
      preciseReleases: config.preciseReleases,
      requestsPerMinute: config.requestsPerMinute,
      acceptLegacy: false,
      trustProxy: true,
    });
    server.listen(config.port, "127.0.0.1", () =>
      process.stdout.write("Usage receiver ready on loopback.\n"),
    );
    const retention = setInterval(() => {
      try {
        store.prune(shanghaiDay(Date.now()), config.retentionMonths);
      } catch {
        process.stderr.write("Usage retention failed.\n");
      }
    }, 86_400_000);
    retention.unref();
    const close = () => {
      clearInterval(retention);
      server.close(() => {
        store.close();
      });
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    server.on("error", () => {
      process.stderr.write("Usage receiver unavailable.\n");
      process.exitCode = 1;
      close();
    });
  } else {
    try {
      const reportDay = DaySchema.parse(day);
      if (view === "releases") {
        const snapshots = store.reports(today, "releases").filter((s) => s.day === reportDay);
        if (!snapshots.length || snapshots.some((s) => s.status === "provisional")) throw new Error("Final snapshot unavailable");
        process.stdout.write(`${JSON.stringify({ ...snapshots[0], groups: snapshots.flatMap((s) => s.groups) }, null, 2)}\n`);
      } else if (mode === "publish") {
        const selected = z.enum(["all", "versions", "releases"]).parse(view);
        process.stdout.write(
          `${JSON.stringify(store.publish(reportDay, today, selected), null, 2)}\n`,
        );
      } else {
        const snapshot = store.snapshot(reportDay);
        if (!snapshot) throw new Error("Snapshot unavailable");
        process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      }
    } finally {
      store.close();
    }
  }
}
try {
  main();
} catch {
  process.stderr.write(
    "Usage service operation failed; check mode, configuration, permissions and report window.\n",
  );
  process.exitCode = 1;
}
