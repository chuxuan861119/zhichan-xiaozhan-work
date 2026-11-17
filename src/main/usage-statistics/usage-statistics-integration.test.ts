// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BrowserWindow, PowerMonitor } from "electron";
import { expect, test, vi } from "vitest";
import legalPolicy from "../../../resources/legal-policies.json" with { type: "json" };
import { PreciseUsageStore } from "../../../services/usage-statistics/precise-store.js";
import { createUsageReceiver } from "../../../services/usage-statistics/server.js";
import { APPLICATION_VERSION } from "../../shared/branding.js";
import { type DailyAggregate, emptyBuckets } from "../../shared/usage-statistics/model.js";
import { AgreementService } from "../legal/agreement-service.js";
import { UsageActivity } from "../platform/usage-activity.js";
import { usageStatisticsConfig } from "./usage-statistics-config.js";
import { UsageStatisticsService } from "./usage-statistics-service.js";
import { sendUsageAggregate } from "./usage-statistics-transport.js";

vi.mock("node:https", async (original) => {
  const module = await original<typeof import("node:https")>();
  return { ...module, request: vi.fn(module.request) };
});

test("Windows foreground intervals flow once through TLS and SQLite despite a lost success response", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-chain-"));
  const dbPath = join(root, "usage.sqlite");
  const release = {
    platform: "windows" as const,
    version: APPLICATION_VERSION,
    channel: "preview" as const,
  };
  const store = new PreciseUsageStore(dbPath, [release]);
  const config = {
    ...usageStatisticsConfig(),
    endpoint: "https://stats.example.com/v1/usage/daily-aggregate",
    acceptedPlatforms: ["win32" as const],
    releases: [release],
  };
  let wall = Date.parse("2026-10-16T23:55:00+08:00");
  let mono = 0;
  let loseResponse = true;
  const received: DailyAggregate[] = [];
  const receiver = createUsageReceiver({
    store: {
      accept: (payload) => {
        received.push(payload);
        return store.accept(payload);
      },
    },
    publicVersionGroups: [],
    releases: config.releases,
    preciseReleases: config.releases,
    clock: () => wall,
  });
  const cert = await readFile(
    new URL("../../../tests/fixtures/usage-tls/test-cert.pem", import.meta.url),
  );
  const key = await readFile(
    new URL("../../../tests/fixtures/usage-tls/test-key.pem", import.meta.url),
  );
  const original = await vi.importActual<typeof import("node:https")>("node:https");
  vi.mocked(httpsRequest).mockImplementation(((
    url: URL,
    options: import("node:https").RequestOptions,
    callback: Parameters<typeof original.request>[2],
  ) => original.request(url, { ...options, ca: cert }, callback)) as typeof httpsRequest);
  const tls = createServer({ cert, key }, (request, response) =>
    receiver.emit("request", request, response),
  );
  await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
  const address = tls.address();
  if (!address || typeof address === "string") throw new Error("address");
  const endpoint = `https://127.0.0.1:${address.port}/v1/usage/daily-aggregate`;
  const window = Object.assign(new EventEmitter(), {
    focused: true,
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isFocused: () => window.focused,
    getChildWindows: () => [],
  });
  const power = Object.assign(new EventEmitter(), { getSystemIdleState: () => "active" });
  let service: UsageStatisticsService;
  const activity = new UsageActivity(
    () => window as unknown as BrowserWindow,
    power as unknown as PowerMonitor,
    (active) => {
      void service.observe(active);
    },
    "win32",
  );
  activity.bind(window as unknown as BrowserWindow);
  service = new UsageStatisticsService({
    statePath: join(root, "usage.json"),
    versionGroup: "1.1",
    appVersion: APPLICATION_VERSION,
    platform: "win32",
    config: { ...config, endpoint },
    allowed: true,
    foreground: () => activity.foreground(),
    send: async (payload, signal) => {
      const status = await sendUsageAggregate(endpoint, payload, signal);
      if (loseResponse && status === 204) {
        loseResponse = false;
        throw Error("isolated lost response after commit");
      }
      return status;
    },
    clock: () => ({ wall, mono }),
    jitterMs: () => 0,
  });
  const advance = async (ms: number) => {
    wall += ms;
    mono += ms;
    await service.observe(await activity.foreground());
  };
  const event = async (emitter: EventEmitter, name: string, ms = 0) => {
    wall += ms;
    mono += ms;
    emitter.emit(name);
    await service.read();
  };
  try {
    const agreement = new AgreementService({
      statePath: join(root, "agreement.json"),
      appVersion: APPLICATION_VERSION,
      platform: "win32",
      policy: legalPolicy,
      usage: service,
    });
    expect(await agreement.read()).toMatchObject({
      needsConfirmation: true,
      showStatistics: false,
    });
    service.start();
    await advance(5_000);
    expect(JSON.parse(await readFile(join(root, "usage.json"), "utf8")).current).toBeNull();
    await agreement.accept({
      appVersion: APPLICATION_VERSION,
      termsVersion: legalPolicy.termsVersion,
      privacyVersion: legalPolicy.privacyVersion,
    });
    await service.read();
    expect((await service.read()).accepted).toBe(true);
    await advance(20_000);
    window.focused = false;
    await event(window, "blur", 10_000);
    await advance(20_000);
    window.focused = true;
    await event(window, "focus");
    await advance(20_000);
    await event(power, "lock-screen", 10_000);
    await advance(20_000);
    await event(power, "unlock-screen");
    await advance(20_000);
    await event(power, "suspend", 10_000);
    await advance(120_000);
    await event(power, "resume");
    await advance(10_000);
    const before = JSON.parse(await readFile(join(root, "usage.json"), "utf8"));
    expect(before.current.openMs).toBe(100_000);
    await event(power, "suspend");
    const nextDay = Date.parse("2026-10-17T00:01:00+08:00");
    await advance(nextDay - wall);
    await vi.waitFor(async () =>
      expect((await service.read()).lastAttempt?.result).toBe("unknown"),
    );
    await advance(60_000);
    await vi.waitFor(async () =>
      expect((await service.read()).lastAttempt?.result).toBe("received"),
    );
    expect(received[1]).toEqual(received[0]);
    expect(received.slice(0, 1)).toEqual([
      {
        schema_version: 5,
        notice_version: "2026-10-28.precise-v1",
        foreground_seconds: 100,
        report_id: expect.any(String),
        day: "2026-10-16",
        platform: "windows",
        app_version: APPLICATION_VERSION,
        release_channel: "preview",
        active_installation_days: 1,
        duration_buckets: { ...emptyBuckets(), m1_5: 1 },
      },
    ]);
    await advance(10_000);
    expect(received).toHaveLength(2);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT count AS n FROM precise_activity").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
    expect(store.reports("2026-10-24", "releases")[0]?.groups[0]).toMatchObject({
      platform: "windows",
      version: APPLICATION_VERSION,
      channel: "preview",
      activeInstallationDays: 1,
      duration: { labels: expect.any(Array), counts: [0, 1, 0, 0, 0, 0] },
      foregroundSeconds: 100,
    });
    await service.choose({ enabled: false });
    await event(power, "resume");
    await advance(30_000);
    expect((await service.read()).enabled).toBe(false);
    expect(JSON.parse(await readFile(join(root, "usage.json"), "utf8")).current).toBeNull();
  } finally {
    activity.dispose();
    await service.close();
    await new Promise<void>((resolve) => tls.close(() => resolve()));
    store.close();
    vi.restoreAllMocks();
  }
});
