import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const random = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const equal = (a, b) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const PREFIX = "/admin-statistics";
const day = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const today = (now) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const csvCell = (value) =>
  '"' +
  String(value ?? "")
    .replace(/^[=+@\-\t\r]/, "'$&")
    .replaceAll('"', '""') +
  '"';

export function selectReport(traffic, usage, params, now) {
  const end = params.get("to") || today(now);
  const start =
    params.get("from") ||
    new Date(Date.parse(end + "T00:00:00Z") - 29 * 86400000).toISOString().slice(0, 10);
  const oldest = new Date(today(now) + "T00:00:00Z");
  const targetDay = oldest.getUTCDate();
  oldest.setUTCDate(1);
  oldest.setUTCMonth(oldest.getUTCMonth() - 18);
  oldest.setUTCDate(
    Math.min(
      targetDay,
      new Date(Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth() + 1, 0)).getUTCDate(),
    ),
  );
  if (
    !day(start) ||
    !day(end) ||
    start > end ||
    end > today(now) ||
    Date.parse(start) < oldest.getTime()
  )
    throw Error("invalid range");
  const days = Object.entries(traffic.days || {})
    .filter(([d]) => d >= start && d <= end)
    .map(([date, v]) => ({ date, ...v }));
  const totals = {};
  for (const row of days)
    for (const [key, value] of Object.entries(row))
      if (typeof value === "number") totals[key] = (totals[key] || 0) + value;
  const filter = (rows) => (rows || []).filter((r) => r.day >= start && r.day <= end);
  const filters = {
    platform: params.get("platform") || "",
    version: params.get("version") || "",
    channel: params.get("channel") || "",
  };
  if (
    (filters.platform &&
      !["windows", "macos", "harmonyos", "unknown"].includes(filters.platform)) ||
    (filters.channel && !["stable", "preview", "internal", "unknown"].includes(filters.channel)) ||
    (filters.version &&
      filters.version !== "unknown" &&
      !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(filters.version))
  )
    throw Error("invalid release filter");
  const allSnapshots = (usage.snapshots || []).map((s) => ({
    ...s,
    groups: s.groups.map((g) => ({
      ...g,
      platform: g.platform || "unknown",
      channel: g.channel || "unknown",
      version:
        s.view === "releases"
          ? g.version
          : `未知（${s.view === "versions" ? "版本组 " : ""}${g.version}）`,
    })),
  }));
  const snapshots = filter(allSnapshots);
  const versions = [
    ...new Set([
      ...(usage.releases || []).map((r) => r.version),
      ...allSnapshots.flatMap((s) =>
        s.groups.map((g) => (g.platform === "unknown" ? "unknown" : g.version)),
      ),
    ]),
  ].sort();
  const selectedSnapshots = snapshots
    .map((s) => ({
      ...s,
      groups: s.groups.filter(
        (g) =>
          (!filters.platform || g.platform === filters.platform) &&
          (!filters.channel || g.channel === filters.channel) &&
          (!filters.version ||
            (g.platform === "unknown" ? "unknown" : g.version) === filters.version),
      ),
    }))
    .filter((s) => s.groups.length);
  const reporting = usage.reporting || {
    retryDays: 7,
    delayDays: 8,
    latestPublishableDay: new Date(Date.parse(today(now) + "T00:00:00Z") - 8 * 86400000)
      .toISOString()
      .slice(0, 10),
  };
  const latestViewableDay = [
    reporting.latestAvailableDay || reporting.latestPublishableDay,
    ...allSnapshots.map((s) => s.day),
  ]
    .sort()
    .at(-1);
  const availableGroups = [
    ...(usage.releases || []).map((r) => ({
      platform: r.platform,
      version: r.version,
      channel: r.channel,
    })),
    ...allSnapshots.flatMap((s) => s.groups),
  ];
  const groupMatches = (g) =>
    (!filters.platform || g.platform === filters.platform) &&
    (!filters.channel || g.channel === filters.channel) &&
    (!filters.version || (g.platform === "unknown" ? "unknown" : g.version) === filters.version);
  const pending = (usage.reception?.pending || []).filter(
    (row) => row.day >= start && row.day <= end && groupMatches(row),
  );
  const emptyReason =
    usage.state === "error" || usage.receiverReady === false
      ? "receiver-error"
      : usage.state === "waiting-release"
        ? "release-not-open"
        : Object.values(filters).some(Boolean) && !availableGroups.some(groupMatches)
          ? "release-not-open"
          : selectedSnapshots.length
            ? "ready"
            : start > latestViewableDay
              ? "waiting-publication"
              : pending.length
                ? "waiting-publication"
                : !usage.reception?.lastReceivedDay && !allSnapshots.length
                  ? "waiting-contribution"
                  : "no-matching-reports";
  return {
    from: start,
    to: end,
    timezone: "Asia/Shanghai",
    generatedAt: traffic.generatedAt || null,
    stale: !traffic.generatedAt || now - Date.parse(traffic.generatedAt) > 15 * 60000,
    quality: traffic.quality || {},
    trafficSchemaVersion: traffic.schemaVersion || 1,
    days,
    totals,
    pages: filter(traffic.pages),
    products: filter(traffic.products),
    hours: filter(traffic.hours),
    downloads: filter(traffic.downloads),
    statuses: filter(traffic.statuses),
    usage: {
      ...usage,
      snapshots: selectedSnapshots,
      filters,
      filterOptions: { versions },
      reporting: { ...reporting, latestViewableDay },
      emptyReason,
      nextPublicationDay: pending.map((item) => item.publishOn).sort()[0] || null,
      latestFinalDay:
        allSnapshots
          .filter((s) => s.status !== "provisional" && s.groups.some(groupMatches))
          .map((s) => s.day)
          .sort()
          .at(-1) || null,
      latestReportDay:
        allSnapshots
          .filter((s) => s.groups.some(groupMatches))
          .map((s) => s.day)
          .sort()
          .at(-1) || null,
    },
    definitions: {
      pages:
        "页面浏览仅统计正式公开页面 GET 的 200/304，排除已识别自动化、更新检查、上报接口、监控、后台、预览页与未知地址；含刷新，不等于真人或独立访客。本地缓存且未请求服务器的访问不可见。全部页面请求仅供诊断。",
      automation: "页面按已识别自动化、未命中特征、旧日志缺少标记分类；后两者不等于已验证真人。",
      products:
        "规范页面路径后按品牌、四个产品、Work 文档及帮助/政策归组，不把文档流量混入产品介绍。",
      downloads: "安装包成功的 200 或 206 请求次数，重复与断点续传分别计数。",
      fullResponses:
        "新日志中 200 响应正常完成且实际字节等于文件响应长度的次数；不是独立下载人数或安装量。",
      usage:
        "协议4次日展示暂定区间，每日更新一次，7天内补发、D+8固定。协议3仍仅固定后展示。样本不足隐藏；贡献不是去重人数，时长是每次运行在该日的前台累计区间次数。",
    },
  };
}

export async function createAdminServer(options) {
  const { privateDirectory, trafficPath, origin, readUsage } = options;
  const now = options.clock || Date.now;
  const secure = options.secureCookies !== false;
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const credentialPath = join(privateDirectory, "administrator.json");
  const tokenPath = join(privateDirectory, "setup-token.txt");
  let credential = null;
  try {
    credential = JSON.parse(await readFile(credentialPath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let setupToken = "";
  if (!credential) {
    try {
      setupToken = (await readFile(tokenPath, "utf8")).trim();
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      setupToken = random();
      await writeFile(tokenPath, setupToken + "\n", { mode: 0o600, flag: "wx" });
    }
  }
  const sessions = new Map();
  const attempts = new Map();
  let pending = false;
  let hashing = 0;
  async function passwordHash(password, salt) {
    if (hashing >= 2) return null;
    hashing++;
    try {
      return (await derive(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 })).toString(
        "hex",
      );
    } finally {
      hashing--;
    }
  }
  const cookie = (value, age) =>
    `zcxzz_admin=${value}; Path=${PREFIX}/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`;
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  function respond(res, status, value, extra = {}) {
    res.writeHead(status, {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      ...extra,
    });
    res.end(typeof value === "string" ? value : JSON.stringify(value));
  }
  function session(req) {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("zcxzz_admin="))
      ?.slice(12);
    if (!token) return null;
    const key = digest(token);
    const value = sessions.get(key);
    if (!value) return null;
    if (now() - value.created > 8 * 3600000 || now() - value.seen > 30 * 60000) {
      sessions.delete(key);
      return null;
    }
    value.seen = now();
    return { ...value, key };
  }
  function budget(req) {
    const ip = req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";
    const t = now();
    for (const [key, v] of attempts) if (t - v.start > 900000) attempts.delete(key);
    if (attempts.size > 10000) return false;
    const record = attempts.get(ip) || { start: t, count: 0 };
    record.count++;
    attempts.set(ip, record);
    return record.count <= 10;
  }
  async function body(req) {
    let bytes = 0;
    const parts = [];
    for await (const part of req) {
      bytes += part.length;
      if (bytes > 4096) throw Error("large");
      parts.push(part);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  }
  const assets = options.assetsDirectory || new URL("./public/", import.meta.url);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      if (
        req.method === "GET" &&
        [PREFIX + "/", PREFIX + "/app.js", PREFIX + "/app.css"].includes(path)
      ) {
        const file = path.endsWith("/") ? "index.html" : path.split("/").pop();
        const data = await readFile(
          typeof assets === "string" ? join(assets, file) : new URL(file, assets),
        );
        return respond(res, 200, data.toString(), {
          "Content-Type": file.endsWith(".html")
            ? "text/html; charset=utf-8"
            : file.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : "text/css; charset=utf-8",
        });
      }
      if (req.method === "GET" && path === PREFIX + "/api/session") {
        const current = session(req);
        return respond(res, 200, {
          authenticated: !!current,
          setupRequired: !credential,
          username: current?.username,
          csrf: current?.csrf,
        });
      }
      if (req.method === "POST" && [PREFIX + "/api/login", PREFIX + "/api/setup"].includes(path)) {
        if (req.headers.origin !== origin) return respond(res, 403, { error: "请求来源不正确。" });
        if (!budget(req)) return respond(res, 429, { error: "尝试次数过多，请 15 分钟后重试。" });
        if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
          return respond(res, 400, { error: "请求格式不正确。" });
        const input = await body(req);
        if (path.endsWith("/setup")) {
          if (credential) return respond(res, 409, { error: "管理员已经设置，请登录。" });
          if (pending || typeof input.token !== "string" || !equal(input.token, setupToken))
            return respond(res, 403, { error: "初始化凭据不正确。" });
          if (
            !/^[A-Za-z0-9_-]{3,40}$/.test(input.username || "") ||
            typeof input.password !== "string" ||
            input.password.length < 14 ||
            input.password.length > 128
          )
            return respond(res, 400, {
              error: "用户名需为 3–40 位字母、数字、下划线；密码需为 14–128 个字符。",
            });
          pending = true;
          try {
            const salt = randomBytes(16).toString("hex");
            const hash = await passwordHash(input.password, salt);
            if (!hash) return respond(res, 429, { error: "服务繁忙，请稍后重试。" });
            const record = { username: input.username, salt, hash };
            await writeFile(credentialPath, JSON.stringify(record), { mode: 0o600, flag: "wx" });
            credential = record;
            setupToken = "";
            return respond(res, 201, { ok: true });
          } finally {
            pending = false;
          }
        }
        if (
          !credential ||
          typeof input.password !== "string" ||
          input.password.length > 128 ||
          input.username !== credential.username
        )
          return respond(res, 401, { error: "用户名或密码不正确。" });
        const hash = await passwordHash(input.password, credential.salt);
        if (!hash) return respond(res, 429, { error: "服务繁忙，请稍后重试。" });
        if (!equal(hash, credential.hash))
          return respond(res, 401, { error: "用户名或密码不正确。" });
        for (const [key, value] of sessions)
          if (now() - value.created > 8 * 3600000 || now() - value.seen > 30 * 60000)
            sessions.delete(key);
        if (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
        const token = random();
        const csrf = random();
        sessions.set(digest(token), {
          created: now(),
          seen: now(),
          username: credential.username,
          csrf,
        });
        return respond(
          res,
          200,
          { ok: true, csrf, username: credential.username },
          { "Set-Cookie": cookie(token, 8 * 3600) },
        );
      }
      const current = session(req);
      if (!current) return respond(res, 401, { error: "请先登录。" });
      if (req.method === "POST" && path === PREFIX + "/api/logout") {
        if (
          req.headers.origin !== origin ||
          !equal(req.headers["x-csrf-token"] || "", current.csrf)
        )
          return respond(res, 403, { error: "请求已失效，请刷新。" });
        sessions.delete(current.key);
        return respond(res, 200, { ok: true }, { "Set-Cookie": cookie("", 0) });
      }
      if (
        req.method === "GET" &&
        [
          PREFIX + "/api/report",
          PREFIX + "/api/export.csv",
          PREFIX + "/api/export-usage.csv",
        ].includes(path)
      ) {
        let traffic;
        try {
          traffic = JSON.parse(await readFile(trafficPath, "utf8"));
        } catch {
          return respond(res, 503, { error: "网站数据尚未生成或暂不可读，请查看汇总服务。" });
        }
        let usage;
        try {
          usage = await readUsage();
        } catch {
          usage = { state: "error", receiverReady: false, snapshots: [] };
        }
        let report;
        try {
          report = selectReport(traffic, usage, url.searchParams, now());
        } catch {
          return respond(res, 400, {
            error: "日期或发行筛选无效；最多查看保留期内的 18 个月，结束日期不能晚于今天。",
          });
        }
        if (path.endsWith(".csv")) {
          const trafficView = url.searchParams.get("trafficView") || "daily";
          if (
            !path.endsWith("export-usage.csv") &&
            !["daily", "pages", "products", "hours"].includes(trafficView)
          )
            return respond(res, 400, { error: "网站导出类型无效。" });
          const fields = [
            "date",
            "requests",
            "pageViews",
            "pages",
            "cachedPageViews",
            "cachedPages",
            "automatedPages",
            "unmarkedPages",
            "unknownPages",
            "downloads",
            "fullResponses",
            "rangeRequests",
            "legacyDownloads",
            "incompleteResponses",
            "downloadErrors",
            "bytes",
          ];
          const title = [
            "日期",
            "内容与资源请求（诊断）",
            "页面浏览（排除已识别自动化）",
            "全部页面请求（诊断）",
            "浏览中缓存304",
            "缓存304页面",
            "已识别自动化页面",
            "未命中特征页面",
            "旧日志标记未知页面",
            "安装包请求",
            "完整200响应",
            "分段206请求",
            "旧日志未验证请求",
            "未完成200响应",
            "下载错误",
            "传输字节",
          ];
          const usageExport = path.endsWith("export-usage.csv");
          let lines = usageExport
            ? [
                [
                  "日期（UTC+8）",
                  "视图",
                  "平台",
                  "完整版本（旧数据未知）",
                  "发行渠道",
                  "上报活跃贡献（非去重人数；每组首行）",
                  "每次运行在该日累计前台时长区间",
                  "运行次数或暂定区间（不是人数）",
                  "日报状态",
                  "暂定更新日",
                  "预计固定日",
                ],
                ...report.usage.snapshots.flatMap((s) =>
                  s.groups.flatMap((g) => {
                    const rangeText = (value) =>
                      value
                        ? value[0] === value[1]
                          ? String(value[0])
                          : value.join("–")
                        : "样本不足";
                    const provisional = s.status === "provisional";
                    const active = provisional
                      ? rangeText(g.activeRange)
                      : (g.activeInstallationDays ?? "样本不足");
                    const dist = provisional ? g.durationRanges : g.duration;
                    const rows = dist
                      ? dist.labels.map((label, i) => [
                          label,
                          provisional ? rangeText(dist.ranges[i]) : dist.counts[i],
                        ])
                      : [["未展示", ""]];
                    return rows.map(([label, count], i) => [
                      s.day,
                      s.view,
                      g.platform,
                      g.version,
                      g.channel,
                      i === 0 ? active : "",
                      label,
                      count,
                      provisional ? "暂定" : "固定",
                      s.asOf || "",
                      s.finalizesOn || "",
                    ]);
                  }),
                ),
              ]
            : [title, ...report.days.map((r) => fields.map((k) => r[k] ?? ""))];
          if (!usageExport && trafficView !== "daily") {
            const dimensions = {
              pages: ["path", "规范页面路径", "count"],
              products: ["product", "产品分组", "pages"],
              hours: ["hour", "小时（UTC+8）", "pages"],
            };
            const [dimension, label, count] = dimensions[trafficView];
            lines = [
              [
                "日期（UTC+8）",
                label,
                "页面浏览（排除已识别自动化）",
                "全部页面请求（200/304，诊断）",
                "浏览中缓存304",
                "缓存304页面",
                "已识别自动化页面",
                "未命中特征页面",
                "旧日志标记未知页面",
              ],
              ...report[trafficView].map((r) => [
                r.day,
                r[dimension],
                r.pageViews ?? "",
                r[count],
                r.cachedPageViews ?? "",
                r.cachedPages ?? "",
                r.automatedPages ?? "",
                r.unmarkedPages ?? "",
                r.unknownPages ?? "",
              ]),
            ];
          }
          return respond(
            res,
            200,
            "\uFEFF" + lines.map((row) => row.map(csvCell).join(",")).join("\r\n"),
            {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="zcxzz-${usageExport ? "usage" : "traffic-" + trafficView}.csv"`,
            },
          );
        }
        return respond(res, 200, report);
      }
      respond(res, 404, { error: "页面不存在。" });
    } catch {
      if (!res.headersSent) respond(res, 400, { error: "请求无法处理。" });
      else res.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 40;
  return server;
}
