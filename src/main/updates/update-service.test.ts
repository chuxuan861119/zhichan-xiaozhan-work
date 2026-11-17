// @vitest-environment node
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import writeFileAtomic from "write-file-atomic";
import { compareVersions, UpdateFeedSchema } from "../../shared/updates/model.js";
import { SoftwareUpdateService } from "./update-service.js";

vi.mock("write-file-atomic", async (importOriginal) => {
  const original = await importOriginal<{ default: typeof writeFileAtomic }>();
  return { default: vi.fn(original.default) };
});

const release = (version = "1.2.0", platform = "darwin", arch = "arm64") => ({
  version,
  platform,
  arch,
  publishedAt: "2026-10-05T00:00:00Z",
  notes: ["修复编辑器问题", "更新分类号数据库"],
  downloadUrl: "https://downloads.example.com/mac.dmg",
  classificationVersion: "2026.01",
});
const feed = (releases = [release()]) => ({ schemaVersion: 1, channel: "stable", releases });
it("uses only the configured preview channel and labels current releases honestly", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-updates-"));
  let channel = "preview";
  let version = "1.1.3";
  const opened = vi.fn(async () => {});
  const service = new SoftwareUpdateService({
    currentVersion: "1.1.3",
    platform: "win32",
    arch: "x64",
    statePath: join(root, "state.json"),
    config: {
      feedUrl: "https://zcxzz.cn/updates/work/preview.json",
      downloadOrigins: ["https://zcxzz.cn"],
      channel: "preview",
    },
    automaticAllowed: true,
    readEnabled: async () => true,
    openExternal: opened,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          ...feed([
            {
              ...release(version, "win32", "x64"),
              downloadUrl: "https://zcxzz.cn/downloads/work-1.1.4.exe",
            },
          ]),
          channel,
        }),
      ),
  });
  expect(await service.check()).toMatchObject({
    status: "latest",
    channel: "preview",
    message: "当前已是最新预览版本",
  });
  version = "1.1.4";
  expect((await service.check()).status).toBe("available");
  await service.openDownload("1.1.4");
  expect(opened).toHaveBeenCalledWith("https://zcxzz.cn/downloads/work-1.1.4.exe");
  channel = "stable";
  expect((await service.check()).status).toBe("error");
  await expect(service.openDownload("1.1.4")).rejects.toThrow();
  await service.close();
});
async function fixture(
  fetcher: typeof fetch = vi.fn(async () => new Response(JSON.stringify(feed()))),
  reuseRoot?: string,
) {
  const root = reuseRoot ?? (await mkdtemp(join(tmpdir(), "updates-test-")));
  const service = new SoftwareUpdateService({
    currentVersion: "1.1.1",
    platform: "darwin",
    arch: "arm64",
    statePath: join(root, "updates.json"),
    config: {
      feedUrl: "https://updates.example.com/stable.json",
      downloadOrigins: ["https://downloads.example.com"],
    },
    fetcher,
    openExternal: vi.fn(async () => {}),
    readEnabled: async () => true,
    automaticAllowed: true,
    startupDelayMs: 10,
    intervalMs: 1000,
  });
  return { service, fetcher, root };
}
describe("software update boundaries", () => {
  it("compares versions numerically and treats stable as newer than prerelease", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2.0", "1.2.0-rc.10")).toBe(1);
    expect(compareVersions("1.2.0-rc.10", "1.2.0-rc.2")).toBe(1);
    expect(compareVersions("1.2.0+build", "1.2.0")).toBe(0);
    expect(UpdateFeedSchema.safeParse(feed([release("01.2.0")])).success).toBe(false);
    expect(UpdateFeedSchema.safeParse(feed([release("1.2.0-beta.1")])).success).toBe(false);
  });
  it("selects only the current platform/architecture and highest version", async () => {
    const { service } = await fixture(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              feed([
                release("9.0.0", "win32", "x64"),
                release("8.0.0", "darwin", "x64"),
                release("1.2.0"),
                release("1.10.0"),
              ]),
            ),
          ),
      ),
    );
    expect((await service.check()).release?.version).toBe("1.10.0");
    await service.close();
  });
  it("deduplicates concurrent checks and sends no document or installation data", async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const { service } = await fixture(fetcher);
    const a = service.check();
    const b = service.check();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    finish(new Response(JSON.stringify(feed())));
    expect((await a).status).toBe("available");
    expect((await b).status).toBe("available");
    expect(fetcher.mock.calls[0]).toEqual([
      "https://updates.example.com/stable.json",
      expect.objectContaining({ method: "GET", redirect: "error", credentials: "omit" }),
    ]);
    await service.close();
  });
  it("rejects malformed, insecure and untrusted download URLs, and oversized feeds", async () => {
    for (const downloadUrl of [
      "http://downloads.example.com/x",
      "https://evil.example.com/x",
      "https://user:pass@downloads.example.com/x",
      "javascript:alert(1)",
    ]) {
      const { service } = await fixture(
        vi.fn(async () => new Response(JSON.stringify(feed([{ ...release(), downloadUrl }])))),
      );
      expect((await service.check()).status).toBe("error");
      await expect(service.openDownload("1.2.0")).rejects.toThrow();
      await service.close();
    }
    const { service } = await fixture(vi.fn(async () => new Response(" ".repeat(262145))));
    expect((await service.check()).status).toBe("error");
    await service.close();
  });
  it("does not claim latest when platform release is absent or service is unconfigured", async () => {
    const { service } = await fixture(
      vi.fn(async () => new Response(JSON.stringify(feed([release("2.0.0", "win32", "x64")])))),
    );
    expect((await service.check()).status).toBe("unavailable");
    await service.close();
    const empty = new SoftwareUpdateService({
      currentVersion: "1.1.1",
      platform: "darwin",
      arch: "arm64",
      statePath: "/nonexistent/updates.json",
      config: { feedUrl: "", downloadOrigins: [] },
      automaticAllowed: false,
      readEnabled: async () => true,
      openExternal: async () => {},
    });
    expect((await empty.check()).status).toBe("unconfigured");
    await empty.close();
  });
  it("persists skip and postponement but manual checks still show the release", async () => {
    const { service, root } = await fixture();
    await service.check();
    await service.dismiss("1.2.0", "skip");
    expect(JSON.parse(await readFile(join(root, "updates.json"), "utf8")).skippedVersion).toBe(
      "1.2.0",
    );
    expect((await service.check("automatic")).notification).toBe(false);
    expect((await service.check()).release?.version).toBe("1.2.0");
    await service.dismiss("1.2.0", "later");
    expect((await service.check("automatic")).notification).toBe(false);
    await service.close();
  });
  it("turning checks off aborts background requests and prevents stale notifications; manual check works", async () => {
    const fetcher = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { service } = await fixture(fetcher);
    const pending = service.check("automatic");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    service.setEnabled(false);
    await pending;
    expect(service.state().notification).toBe(false);
    expect(service.state().status).toBe("idle");
    fetcher.mockImplementation(async () => new Response(JSON.stringify(feed())));
    expect((await service.check()).status).toBe("available");
    await service.close();
  });
});

it.each(["win32", "darwin", "openharmony"])(
  "selects a validated release for %s",
  async (platform) => {
    const root = await mkdtemp(join(tmpdir(), "update-platform-"));
    const service = new SoftwareUpdateService({
      currentVersion: "1.1.1",
      platform,
      arch: "arm64",
      statePath: join(root, "state.json"),
      config: {
        feedUrl: "https://updates.example.com/feed",
        downloadOrigins: ["https://downloads.example.com"],
      },
      automaticAllowed: true,
      readEnabled: async () => true,
      openExternal: async () => {},
      fetcher: async () => new Response(JSON.stringify(feed([release("1.2.0", platform)]))),
    });
    expect((await service.check()).release?.platform).toBe(platform);
    await service.close();
  },
);
it("rejects duplicate version precedence and obeys the SemVer reference ordering", () => {
  const versions = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (let index = 0; index < versions.length - 1; index++)
    expect(compareVersions(versions[index] ?? "", versions[index + 1] ?? "")).toBe(-1);
  expect(UpdateFeedSchema.safeParse(feed([release("1.2.0"), release("1.2.0+build")])).success).toBe(
    false,
  );
});
it("times out failed networking even after automatic checks have been turned off", async () => {
  const root = await mkdtemp(join(tmpdir(), "update-timeout-"));
  const service = new SoftwareUpdateService({
    currentVersion: "1.1.1",
    platform: "darwin",
    arch: "arm64",
    statePath: join(root, "state.json"),
    config: {
      feedUrl: "https://updates.example.com/feed",
      downloadOrigins: ["https://downloads.example.com"],
    },
    automaticAllowed: true,
    readEnabled: async () => true,
    openExternal: async () => {},
    timeoutMs: 10,
    fetcher: (_input, init) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(Error("timeout"))),
      ),
  });
  service.setEnabled(false);
  expect((await service.check()).status).toBe("error");
  await service.close();
});
it("automatic startup is delayed and disabled development instances never fetch", async () => {
  const { service, fetcher } = await fixture();
  service.start(true);
  expect(fetcher).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(service.state().notification).toBe(true));
  await service.close();
  const root = await mkdtemp(join(tmpdir(), "update-dev-"));
  const get = vi.fn();
  const dev = new SoftwareUpdateService({
    currentVersion: "1.1.1",
    platform: "darwin",
    arch: "arm64",
    statePath: join(root, "state.json"),
    config: {
      feedUrl: "https://updates.example.com/feed",
      downloadOrigins: ["https://downloads.example.com"],
    },
    automaticAllowed: false,
    readEnabled: async () => true,
    openExternal: async () => {},
    fetcher: get,
    startupDelayMs: 1,
  });
  dev.start(true);
  await dev.check("automatic");
  expect(get).not.toHaveBeenCalled();
  await dev.close();
});

it("checks two hours after a manual check without extending the remaining interval", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
  const root = await mkdtemp(join(tmpdir(), "updates-two-hours-"));
  const fetcher = vi.fn(async () => new Response(JSON.stringify(feed())));
  let finishStartup!: () => void;
  const startupFinished = new Promise<void>((resolve) => {
    finishStartup = resolve;
  });
  const service = new SoftwareUpdateService({
    currentVersion: "1.1.1",
    platform: "darwin",
    arch: "arm64",
    statePath: join(root, "updates.json"),
    config: {
      feedUrl: "https://updates.example.com/feed",
      downloadOrigins: ["https://downloads.example.com"],
    },
    readEnabled: async () => true,
    openExternal: async () => {},
    automaticAllowed: true,
    fetcher,
    onChanged: (state) => {
      if (state.status === "available") finishStartup();
    },
  });
  try {
    await service.read();
    service.start(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await startupFinished;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await service.check();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 - 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {
    await service.close();
    vi.useRealTimers();
  }
});

it("checks and notifies on every application start despite a recent successful check", async () => {
  const { service: previous, root } = await fixture();
  await previous.check();
  await previous.close();
  const { service, fetcher } = await fixture(undefined, root);
  try {
    service.start(true);
    service.start(true);
    await vi.waitFor(() => expect(service.state().notification).toBe(true), {
      timeout: 500,
      interval: 5,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(service.state().release?.version).toBe("1.2.0");
  } finally {
    await service.close();
  }
});

it("restores postponed/skip history and a newer release is not suppressed", async () => {
  const { service, root } = await fixture();
  await service.check();
  await service.dismiss("1.2.0", "later");
  await service.close();
  const { service: restored } = await fixture(undefined, root);
  expect((await restored.read()).lastCheckedAt).not.toBeNull();
  expect((await restored.check("automatic")).notification).toBe(false);
  await restored.dismiss("1.2.0", "skip");
  await restored.close();
  const { service: newer } = await fixture(
    async () => new Response(JSON.stringify(feed([release("1.3.0")]))),
    root,
  );
  const state = await newer.check("automatic");
  expect(state.release?.version).toBe("1.3.0");
  expect(state.notification).toBe(true);
  await newer.close();
});
it("idempotent enabled-setting writes do not discard an in-flight successful check", async () => {
  let finish!: (value: Response) => void;
  const get = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const { service } = await fixture(get);
  const result = service.check();
  await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
  service.setEnabled(true);
  finish(new Response(JSON.stringify(feed())));
  expect((await result).status).toBe("available");
  await service.close();
});

it.each(["later", "skip"] as const)(
  "a check cannot overwrite a concurrently saving %s reminder preference",
  async (action) => {
    const { service, root, fetcher } = await fixture();
    await service.check();
    const original = await vi.importActual<{ default: typeof writeFileAtomic }>(
      "write-file-atomic",
    );
    let releaseWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    vi.mocked(writeFileAtomic).mockImplementationOnce(async (...args) => {
      writeStarted();
      await pendingWrite;
      return original.default(...args);
    });
    const dismissed = service.dismiss("1.2.0", action);
    await started;
    const checked = service.check();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    // Let the buffered response finish while the previous disk write is still blocked.
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseWrite();
    await Promise.all([dismissed, checked]);
    await service.close();
    const history = JSON.parse(await readFile(join(root, "updates.json"), "utf8"));
    expect(history[action === "skip" ? "skippedVersion" : "postponedVersion"]).toBe("1.2.0");
    expect(history.lastCheckedAt).not.toBeNull();
    if (action === "later") expect(history.remindAfter).toBeGreaterThan(Date.now());
  },
);
