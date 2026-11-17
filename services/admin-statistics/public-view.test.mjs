import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
function view(report) {
  const scope = vm.createContext({
    URLSearchParams,
    fixture: report,
    document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] },
  });
  vm.runInContext(source.slice(0, source.lastIndexOf("dates(7);")), scope);
  return vm.runInContext("report=fixture; trafficView()", scope);
}
function usageView(report) {
  const scope = vm.createContext({
    URLSearchParams,
    fixture: report,
    document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] },
  });
  vm.runInContext(source.slice(0, source.lastIndexOf("dates(7);")), scope);
  return vm.runInContext("report=fixture; usageView()", scope);
}
test("usage interface leads with reporting status, precise units and an expandable technical section", () => {
  const html = usageView({
    usage: {
      state: "active",
      receiverReady: true,
      releases: [{ platform: "windows", version: "1.1.2", channel: "preview" }],
      snapshots: [],
      filterOptions: { versions: ["1.1.2"] },
      reporting: { retryDays: 7, delayDays: 8, latestPublishableDay: "2026-10-10" },
      emptyReason: "waiting-contribution",
      reception: { lastReceivedDay: null, pending: [], outcomes: [] },
    },
  });
  assert.match(html, /等待首份有效上报/);
  assert.match(html, /2026-10-10/);
  assert.match(html, /D\+8/);
  assert.match(html, /<details/);
  assert.match(html, /累计前台时长/);
  assert.doesNotMatch(html, /已接入发行版/);
});
test("traffic UI preserves unknown coverage, escapes paths and exports the selected range", () => {
  assert.match(view({ trafficSchemaVersion: 1 }), /等待新版网站报表/);
  const html = view({
    trafficSchemaVersion: 3,
    from: "2026-10-16",
    to: "2026-10-17",
    days: [{}],
    totals: {
      pages: 3,
      pageViews: 2,
      cachedPageViews: 1,
      cachedPages: 1,
      automatedPages: 1,
      unmarkedPages: 1,
      unknownPages: 1,
    },
    products: [{ product: "work", pages: 3, pageViews: 2 }],
    pages: [{ path: "/<script>", count: 3, pageViews: 2 }],
    hours: [{ hour: "2026-10-17T01:00:00+08:00", pages: 3, pageViews: 2, automatedPages: 1 }],
  });
  assert.match(html, /Work · 产品介绍/);
  assert.match(html, /不等于真人或独立访客/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /trafficView=products/);
  assert.match(html, /from=2026-10-16&amp;to=2026-10-17/);
  assert.match(html, /按小时统计趋势/);
  assert.match(html, /旧日志标记未知/);
  assert.match(html, /页面浏览/);
  assert.match(html, /更新检查/);
  assert.match(html, /排除已识别自动化/);
});

test("provisional detail renders ranges and fixed date without plotting them as exact values", () => {
  const elements = new Map();
  const scope = vm.createContext({
    URLSearchParams,
    fixture: {
      from: "2026-10-16",
      to: "2026-10-16",
      usage: {
        snapshots: [
          {
            day: "2026-10-16",
            view: "releases",
            status: "provisional",
            asOf: "2026-10-17",
            finalizesOn: "2026-10-24",
            groups: [
              {
                platform: "windows",
                version: "1.1.2",
                channel: "preview",
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
          },
        ],
      },
    },
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, { addEventListener() {}, innerHTML: "" });
        return elements.get(id);
      },
      querySelectorAll: () => [],
    },
  });
  vm.runInContext(source.slice(0, source.lastIndexOf("dates(7);")), scope);
  vm.runInContext(
    'report=fixture;usageGroup="windows|1.1.2|preview";renderUsage("2026-10-16")',
    scope,
  );
  assert.match(elements.get("usage-detail").innerHTML, /暂定日报/);
  assert.match(elements.get("usage-detail").innerHTML, /10–19/);
  assert.match(elements.get("usage-detail").innerHTML, /2026-10-24/);
  assert.doesNotMatch(elements.get("usage-trend").innerHTML, /<circle/);
});
