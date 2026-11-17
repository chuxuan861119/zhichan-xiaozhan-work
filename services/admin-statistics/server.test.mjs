import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAdminServer, selectReport } from "./server.mjs";

test("usage metadata distinguishes open, received, waiting and unavailable selections without raw counters", () => {
  const now = Date.parse("2026-10-18T12:00:00+08:00");
  const usage = {
    state: "active",
    receiverReady: true,
    releases: [{ platform: "windows", version: "1.1.2", channel: "preview" }],
    snapshots: [],
    reporting: { retryDays: 7, delayDays: 8, latestPublishableDay: "2026-10-10" },
    reception: { lastReceivedDay: null, pending: [], outcomes: [] },
  };
  const report = (extra = {}, query = "") =>
    selectReport({ days: {} }, { ...usage, ...extra }, new URLSearchParams(query), now);
  assert.deepEqual(report().usage.filterOptions.versions, ["1.1.2"]);
  assert.equal(report().usage.emptyReason, "waiting-contribution");
  assert.equal(report({}, "platform=macos").usage.emptyReason, "release-not-open");
  assert.equal(
    report({}, "from=2026-10-18&to=2026-10-18").usage.emptyReason,
    "waiting-publication",
  );
  assert.equal(report({ state: "error" }).usage.emptyReason, "receiver-error");
  const waiting = report({
    reception: {
      ...usage.reception,
      lastReceivedDay: "2026-10-18",
      pending: [{ day: "2026-10-17", publishOn: "2026-10-25" }],
    },
  });
  assert.equal(waiting.usage.emptyReason, "waiting-publication");
  assert.equal(waiting.usage.nextPublicationDay, "2026-10-25");
});

test("traffic detail filters keep the same day range and expose schema coverage", () => {
  const row = {
    day: "2026-10-16",
    hour: "2026-10-16T01:00:00+08:00",
    product: "work",
    pages: 2,
    cachedPages: 1,
  };
  const report = selectReport(
    {
      schemaVersion: 2,
      days: { "2026-10-16": { pages: 2 } },
      hours: [row, { ...row, day: "2026-10-17" }],
      products: [row],
    },
    { snapshots: [] },
    new URLSearchParams("from=2026-10-16&to=2026-10-16"),
    Date.parse("2026-10-17T12:00:00+08:00"),
  );
  assert.deepEqual(report.hours, [row]);
  assert.deepEqual(report.products, [row]);
  assert.equal(report.trafficSchemaVersion, 2);
  assert.equal(
    selectReport(
      { days: {} },
      { snapshots: [] },
      new URLSearchParams(),
      Date.parse("2026-10-17T12:00:00+08:00"),
    ).trafficSchemaVersion,
    1,
  );
});

test("release filters preserve fixed cells, unknown legacy data and never recompute totals", () => {
  const usage = {
    snapshots: [
      {
        day: "2026-10-16",
        view: "releases",
        groups: [
          {
            platform: "windows",
            version: "1.2.3",
            channel: "stable",
            activeInstallationDays: 10,
            duration: null,
          },
          {
            platform: "windows",
            version: "1.2.4",
            channel: "preview",
            activeInstallationDays: null,
            duration: null,
          },
          {
            platform: "harmonyos",
            version: "1.2.3",
            channel: "stable",
            activeInstallationDays: null,
            duration: null,
          },
        ],
      },
      {
        day: "2026-10-15",
        view: "all",
        groups: [{ version: "全部版本", activeInstallationDays: 11, duration: null }],
      },
    ],
  };
  const run = (query) =>
    selectReport(
      { days: {} },
      usage,
      new URLSearchParams(query),
      Date.parse("2026-10-17T12:00:00+08:00"),
    );
  const filtered = run("platform=windows&version=1.2.3&channel=stable");
  assert.equal(filtered.usage.snapshots.length, 1);
  assert.deepEqual(filtered.usage.snapshots[0].groups, [usage.snapshots[0].groups[0]]);
  assert.deepEqual(filtered.usage.filterOptions.versions, ["1.2.3", "1.2.4", "unknown"]);
  assert.equal(run("platform=unknown").usage.snapshots[0].groups[0].platform, "unknown");
  assert.equal(run("platform=macos").usage.snapshots.length, 0);
  assert.throws(() => run("platform=linux"));
  assert.throws(() => run("version=arbitrary"));
  assert.equal(usage.snapshots[1].groups[0].platform, undefined);
});

test("authentication, CSRF, filtered exports, logout and expiration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcxzz-admin-test-"));
  const trafficPath = join(dir, "traffic.json");
  await writeFile(
    trafficPath,
    JSON.stringify({
      schemaVersion: 3,
      generatedAt: "2026-10-17T12:00:00+08:00",
      days: {
        "2026-10-16": {
          pages: 2,
          pageViews: 1,
          cachedPageViews: 0,
          cachedPages: 1,
          automatedPages: 1,
          unmarkedPages: 1,
          unknownPages: 0,
          downloads: 3,
          fullResponses: 1,
        },
        "2026-10-17": { pages: 4, downloads: 5, fullResponses: 2 },
      },
      pages: [
        {
          day: "2026-10-16",
          path: "/work/",
          count: 2,
          pageViews: 1,
          cachedPageViews: 0,
          cachedPages: 1,
          automatedPages: 1,
          unmarkedPages: 1,
          unknownPages: 0,
        },
      ],
      products: [{ day: "2026-10-16", product: "work", pages: 2 }],
      hours: [{ day: "2026-10-16", hour: "2026-10-16T01:00:00+08:00", pages: 2 }],
      downloads: [],
      statuses: [],
      quality: {},
    }),
  );
  let now = Date.parse("2026-10-17T12:00:00+08:00");
  const origin = "http://localhost";
  let usageData = { state: "waiting-release", snapshots: [] };
  const app = await createAdminServer({
    privateDirectory: dir,
    trafficPath,
    origin,
    secureCookies: false,
    clock: () => now,
    readUsage: () => usageData,
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.address().port + "/admin-statistics";
  const post = (path, body, headers = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(base + "/api/report")).status, 401);
    assert.equal(
      (
        await post("/api/setup", {
          token: "wrong",
          username: "owner",
          password: "test-password-123456",
        })
      ).status,
      403,
    );
    const token = (await import("node:fs/promises")).readFile(join(dir, "setup-token.txt"), "utf8");
    assert.equal(
      (
        await post("/api/setup", {
          token: (await token).trim(),
          username: "owner",
          password: "test-password-123456",
        })
      ).status,
      201,
    );
    assert.equal((await post("/api/setup", {})).status, 409);
    assert.equal((await post("/api/login", { username: "owner", password: "wrong" })).status, 401);
    assert.equal(
      (
        await post(
          "/api/login",
          { username: "owner", password: "test-password-123456" },
          { origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    const login = await post("/api/login", { username: "owner", password: "test-password-123456" });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const { csrf } = await login.json();
    const data = await (
      await fetch(base + "/api/report?from=2026-10-16&to=2026-10-16", { headers: { cookie } })
    ).json();
    assert.equal(data.totals.downloads, 3);
    assert.equal(data.totals.pageViews, 1);
    assert.equal(data.totals.pages, 2);
    assert.equal(data.days.length, 1);
    assert.equal(data.usage.state, "waiting-release");
    const csv = await (
      await fetch(base + "/api/export.csv?from=2026-10-16&to=2026-10-16", { headers: { cookie } })
    ).text();
    assert.match(csv, /2026-10-16/);
    assert.doesNotMatch(csv, /2026-10-17/);
    assert.match(csv, /缓存304页面/);
    assert.match(csv, /页面浏览（排除已识别自动化）/);
    const dailyRows = csv
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n")
      .map((line) => line.split(","));
    const visitsColumn = dailyRows[0].indexOf('"页面浏览（排除已识别自动化）"');
    assert.equal(dailyRows[1][visitsColumn], '"1"');
    for (const [view, expected] of [
      ["pages", "/work/"],
      ["products", "work"],
      ["hours", "2026-10-16T01:00:00+08:00"],
    ]) {
      assert.equal((await fetch(base + "/api/export.csv?trafficView=" + view)).status, 401);
      const response = await fetch(
        base + "/api/export.csv?from=2026-10-16&to=2026-10-16&trafficView=" + view,
        { headers: { cookie } },
      );
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(text.includes(expected));
      assert.match(text, /页面浏览（排除已识别自动化）/);
      assert.ok(!text.includes("2026-10-17"));
    }
    assert.equal(
      (await fetch(base + "/api/export.csv?trafficView=invalid", { headers: { cookie } })).status,
      400,
    );
    assert.equal(
      (await fetch(base + "/api/export-usage.csv", { headers: { cookie } })).status,
      200,
    );
    assert.equal((await fetch(base + "/api/report?from=bad", { headers: { cookie } })).status, 400);
    usageData = {
      state: "active",
      snapshots: [
        {
          day: "2026-10-16",
          view: "releases",
          groups: [
            {
              platform: "windows",
              version: "1.2.3",
              channel: "stable",
              activeInstallationDays: 10,
              duration: { labels: ["不足5分钟", "5分钟以上"], counts: [10, 0] },
            },
            {
              platform: "harmonyos",
              version: "1.2.3",
              channel: "preview",
              activeInstallationDays: null,
              duration: null,
            },
          ],
        },
      ],
    };
    const releaseCsv = await (
      await fetch(base + "/api/export-usage.csv?platform=harmonyos&version=1.2.3&channel=preview", {
        headers: { cookie },
      })
    ).text();
    assert.match(releaseCsv, /完整版本/);
    assert.match(releaseCsv, /"harmonyos","1.2.3","preview","样本不足"/);
    assert.doesNotMatch(releaseCsv, /windows/);
    const windowsCsv = await (
      await fetch(base + "/api/export-usage.csv?platform=windows", { headers: { cookie } })
    ).text();
    assert.equal((windowsCsv.match(/"windows","1\.2\.3","stable","10"/g) || []).length, 1);
    usageData.snapshots[0] = {
      ...usageData.snapshots[0],
      status: "provisional",
      asOf: "2026-10-17",
      finalizesOn: "2026-10-24",
      groups: [
        {
          platform: "windows",
          version: "1.2.3",
          channel: "stable",
          activeInstallationDays: null,
          duration: null,
          activeRange: [10, 19],
          durationRanges: {
            labels: ["不足30分钟", "30分钟及以上"],
            ranges: [
              [10, 19],
              [0, 0],
            ],
          },
        },
      ],
    };
    const provisionalCsv = await (
      await fetch(base + "/api/export-usage.csv?platform=windows", { headers: { cookie } })
    ).text();
    assert.match(provisionalCsv, /"10–19"/);
    assert.match(provisionalCsv, /"暂定","2026-10-17","2026-10-24"/);
    assert.equal((provisionalCsv.match(/"windows","1\.2\.3","stable","10–19"/g) || []).length, 1);

    assert.equal((await post("/api/logout", {}, { cookie })).status, 403);
    assert.equal((await post("/api/logout", {}, { cookie, "x-csrf-token": csrf })).status, 200);
    assert.equal((await fetch(base + "/api/report", { headers: { cookie } })).status, 401);
    const again = await post("/api/login", { username: "owner", password: "test-password-123456" });
    const expired = again.headers.get("set-cookie").split(";")[0];
    now += 31 * 60000;
    assert.equal((await fetch(base + "/api/report", { headers: { cookie: expired } })).status, 401);
    const concurrent = await Promise.all(
      Array.from({ length: 3 }, () =>
        post("/api/login", { username: "owner", password: "test-password-123456" }),
      ),
    );
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 200, 429]);
  } finally {
    await new Promise((r) => app.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

test("login attempts are bounded and no default credentials exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcxzz-auth-test-"));
  const app = await createAdminServer({
    privateDirectory: dir,
    trafficPath: join(dir, "missing"),
    origin: "http://localhost",
    secureCookies: false,
    readUsage: () => ({ state: "waiting-release", snapshots: [] }),
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + app.address().port + "/admin-statistics/api/login";
  try {
    let response;
    for (let n = 0; n < 11; n++)
      response = await fetch(url, {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: "{}",
      });
    assert.equal(response.status, 429);
  } finally {
    await new Promise((r) => app.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

test("unrelated pending dates cannot promise data for a closed historic query", () => {
  const report = selectReport(
    {},
    {
      state: "active",
      receiverReady: true,
      snapshots: [],
      releases: [{ platform: "windows", version: "1.1.2", channel: "preview" }],
      reception: {
        lastReceivedDay: "2026-10-18",
        pending: [{ day: "2026-10-17", publishOn: "2026-10-25" }],
      },
    },
    new URLSearchParams("from=2026-10-01&to=2026-10-03"),
    Date.parse("2026-10-18T12:00:00+08:00"),
  );
  assert.equal(report.usage.emptyReason, "no-matching-reports");
  assert.equal(report.usage.nextPublicationDay, null);
});

test("next-day reports default to yesterday; pending reasons respect release filters", () => {
  const result = selectReport(
    {},
    {
      state: "active",
      receiverReady: true,
      releases: [
        { platform: "windows", version: "1.1.2", channel: "preview" },
        { platform: "macos", version: "1.1.2", channel: "preview" },
      ],
      snapshots: [],
      reporting: {
        retryDays: 7,
        delayDays: 8,
        latestPublishableDay: "2026-10-10",
        latestAvailableDay: "2026-10-17",
      },
      reception: {
        lastReceivedDay: "2026-10-18",
        pending: [
          {
            day: "2026-10-17",
            publishOn: "2026-10-25",
            platform: "windows",
            version: "1.1.2",
            channel: "preview",
          },
        ],
      },
    },
    new URLSearchParams("from=2026-10-17&to=2026-10-17&platform=macos"),
    Date.parse("2026-10-18T12:00:00+08:00"),
  );
  assert.equal(result.usage.reporting.latestViewableDay, "2026-10-17");
  assert.equal(result.usage.emptyReason, "no-matching-reports");
  assert.equal(result.usage.nextPublicationDay, null);
});
