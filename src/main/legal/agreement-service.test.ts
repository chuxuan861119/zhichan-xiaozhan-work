// @vitest-environment node
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { UsageState } from "../../shared/usage-statistics/model.js";
import { AgreementService } from "./agreement-service.js";

const policy = { termsVersion: "terms-1", privacyVersion: "privacy-1", operator: "", contact: "" };
const usageState: UsageState = {
  enabled: true,
  accepted: false,
  available: true,
  status: "pending",
  message: "",
  noticeVersion: "usage-1",
  lastAttempt: null,
  disclosure: {
    operator: "测试",
    contact: "测试",
    recipient: "测试",
    region: "测试",
    retentionMonths: 18,
    securityLogNotice: "测试",
  },
};
async function fixture(
  options: {
    root?: string;
    version?: string;
    privacy?: string;
    write?: (value: string) => Promise<void>;
    legacy?: boolean;
    available?: boolean;
    history?: boolean;
    notice?: string;
    platform?: string;
    enabled?: boolean;
  } = {},
) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "agreement-")));
  let state = {
    ...usageState,
    enabled: options.enabled ?? true,
    accepted: options.legacy ?? false,
    noticeVersion: options.notice ?? usageState.noticeVersion,
    available: options.available ?? true,
  };
  let history = options.history ?? options.legacy ?? false;
  const session = vi.fn();
  const choose = vi.fn(async (choice: { enabled: boolean }) => {
    history ||= choice.enabled;
    state = {
      ...state,
      enabled: choice.enabled,
      accepted: choice.enabled || state.accepted,
      status: choice.enabled ? "participating" : "disabled",
    };
    return state;
  });
  const service = new AgreementService({
    statePath: join(root, "agreement-consent.json"),
    appVersion: options.version ?? "1.1.1",
    platform: options.platform ?? "darwin",
    policy: { ...policy, privacyVersion: options.privacy ?? policy.privacyVersion },
    usage: {
      read: async () => state,
      choose,
      setSessionAllowed: session,
      hasConsentHistory: () => history,
    },
    ...(options.write ? { write: options.write } : {}),
  });
  const accept = async (participate = false) =>
    service.accept({
      appVersion: options.version ?? "1.1.1",
      termsVersion: policy.termsVersion,
      privacyVersion: options.privacy ?? policy.privacyVersion,
      participate,
      statisticsNoticeVersion: state.noticeVersion,
    });
  return { service, root, session, choose, accept };
}
test("opt-out survives restart; only a new software version prompts again", async () => {
  const f = await fixture();
  expect((await f.service.read()).needsConfirmation).toBe(true);
  await f.accept();
  expect(f.choose).toHaveBeenCalledWith({ enabled: false });
  expect((await (await fixture({ root: f.root })).service.read()).needsConfirmation).toBe(false);
  expect(
    (await (await fixture({ root: f.root, version: "1.1.2" })).service.read()).showStatistics,
  ).toBe(true);
});
test("Windows confirms statistics through the full policies without a separate checkbox", async () => {
  const f = await fixture({ platform: "win32" });
  expect(await f.service.read()).toMatchObject({ needsConfirmation: true, showStatistics: false });
  await f.accept(false);
  expect(f.choose).toHaveBeenCalledWith({ enabled: true, noticeVersion: "usage-1" });
  expect(
    (
      await (
        await fixture({ root: f.root, platform: "win32", version: "1.1.2", legacy: true })
      ).service.read()
    ).needsConfirmation,
  ).toBe(false);
});
test("Windows does not restore a saved opt-out on policy updates", async () => {
  const f = await fixture({ platform: "win32", enabled: false });
  await f.accept();
  expect(f.choose).not.toHaveBeenCalled();
  const next = await fixture({
    root: f.root,
    platform: "win32",
    enabled: false,
    privacy: "privacy-2",
  });
  expect(await next.service.read()).toMatchObject({
    needsConfirmation: true,
    showStatistics: false,
  });
  await next.accept();
  expect(next.choose).not.toHaveBeenCalled();
});
test("unconfigured Windows statistics stay pending and do not block local use", async () => {
  const f = await fixture({ platform: "win32", available: false });
  expect((await f.service.read()).showStatistics).toBe(false);
  await f.accept();
  expect(f.choose).not.toHaveBeenCalled();
  expect(f.session).toHaveBeenLastCalledWith(true);
  const sameScope = await fixture({ root: f.root, platform: "win32" });
  expect(await sameScope.service.read()).toMatchObject({
    needsConfirmation: true,
    showStatistics: false,
  });
  const opened = await fixture({ root: f.root, platform: "win32", notice: "usage-2" });
  expect(await opened.service.read()).toMatchObject({
    needsConfirmation: true,
    reason: "policy-update",
    showStatistics: false,
  });
  await opened.accept();
  expect(opened.choose).toHaveBeenCalledWith({ enabled: true, noticeVersion: "usage-2" });
});
test("consent history and withdrawn setting survive policy-only confirmation without re-enabling", async () => {
  const f = await fixture();
  await f.accept(true);
  const next = await fixture({ root: f.root, version: "1.1.2", privacy: "privacy-2" });
  expect((await next.service.read()).showStatistics).toBe(false);
  await next.accept(false);
  expect(next.choose).not.toHaveBeenCalled();
  expect(
    JSON.parse(await readFile(join(f.root, "agreement-consent.json"), "utf8"))
      .everStatisticsConsent,
  ).toBe(true);
});
test.each(["darwin", "win32"])(
  "pending background agreement write keeps %s statistics blocked",
  async (platform) => {
    let finish!: () => void;
    const write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const f = await fixture({ write, platform });
    await f.service.read();
    const pending = f.accept(true);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(f.session).not.toHaveBeenCalledWith(true);
    finish();
    expect((await pending).needsConfirmation).toBe(false);
    expect(f.session).toHaveBeenLastCalledWith(true);
  },
);
test.each(["darwin", "win32"])(
  "failed agreement write keeps %s statistics blocked; retry works",
  async (platform) => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const f = await fixture({ write, platform });
    await f.service.read();
    await expect(f.accept()).rejects.toThrow("disk full");
    expect((await f.service.read()).needsConfirmation).toBe(true);
    expect(f.session).not.toHaveBeenCalledWith(true);
    expect((await f.accept()).needsConfirmation).toBe(false);
    expect(f.session).toHaveBeenLastCalledWith(true);
  },
);
test("stale displayed versions are refused and duplicate confirmation is idempotent", async () => {
  const f = await fixture();
  await expect(
    f.service.accept({ appVersion: "old", termsVersion: "terms-1", privacyVersion: "privacy-1" }),
  ).rejects.toThrow("协议版本");
  await Promise.all([f.accept(true), f.accept(true)]);
  expect(f.choose).toHaveBeenCalledTimes(1);
});
test("unopened statistics never block opting out; cannot accept an unavailable service", async () => {
  const f = await fixture({ available: false });
  await expect(f.accept(true)).rejects.toThrow("尚未准备");
  expect(f.choose).not.toHaveBeenCalled();
  expect((await f.accept(false)).needsConfirmation).toBe(false);
});
test("corrupt confirmation records are not silently replaced", async () => {
  const f = await fixture();
  const path = join(f.root, "agreement-consent.json");
  await writeFile(path, "corrupt");
  await expect(f.service.read()).rejects.toThrow("原记录未被覆盖");
  expect(await readFile(path, "utf8")).toBe("corrupt");
});
test("legacy consent hides statistics but still requires the first full agreement", async () => {
  const f = await fixture({ legacy: true });
  const state = await f.service.read();
  expect(state.needsConfirmation).toBe(true);
  expect(state.showStatistics).toBe(false);
  await f.accept();
  expect(f.choose).not.toHaveBeenCalled();
});

test("consent granted later in settings is remembered even when its notice subsequently changes", async () => {
  const f = await fixture();
  await f.accept(false);
  const same = await fixture({ root: f.root, version: "1.1.2", history: true, legacy: true });
  expect((await same.service.read()).needsConfirmation).toBe(false);
  const changed = await fixture({ root: f.root, history: true, legacy: false, notice: "usage-2" });
  expect(await changed.service.read()).toMatchObject({
    needsConfirmation: true,
    showStatistics: true,
    reason: "policy-update",
  });
});
