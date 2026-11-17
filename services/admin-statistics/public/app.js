const releaseFilters = { platform: "", version: "", channel: "" };
const platformLabel = (value) =>
  ({ windows: "Windows", macos: "macOS", harmonyos: "HarmonyOS", unknown: "未知（旧数据）" })[
    value
  ] || "未知（旧数据）";
const channelLabel = (value) =>
  ({ stable: "正式版", preview: "预览版", internal: "内部版", unknown: "未知（旧数据）" })[value] ||
  "未知（旧数据）";
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const num = (value) =>
  value === null || value === undefined ? "—" : Number(value).toLocaleString("zh-CN");
const size = (value) =>
  value === null || value === undefined
    ? "—"
    : value >= 1073741824
      ? (value / 1073741824).toFixed(2) + " GB"
      : value >= 1048576
        ? (value / 1048576).toFixed(1) + " MB"
        : num(value) + " B";
const time = (value) =>
  value
    ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
    : "尚不可用";
const api = "/admin-statistics/api/";
let csrf = "",
  setup = false,
  report = null,
  tab = "overview",
  loadId = 0;
let usageGroup = "";
const dateScopes = { website: null, usage: null };
const names = {
  overview: "统计总览",
  traffic: "网站访问",
  downloads: "软件下载",
  usage: "软件使用",
  sources: "数据与运行状态",
};
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
function dates(days, end = today()) {
  $("to").value = end;
  $("from").value = new Date(Date.parse(end + "T00:00:00Z") - (days - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
}
function message(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}
async function request(path, options = {}) {
  const response = await fetch(api + path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error("服务暂不可用，请稍后重试。");
  }
  if (!response.ok) {
    if (response.status === 401 && path !== "login") showAuth(false);
    throw Error(data.error || "请求未完成。");
  }
  return data;
}
function showAuth(required) {
  setup = required;
  $("auth").hidden = false;
  $("dashboard").hidden = true;
  $("auth-title").textContent = setup ? "设置管理员" : "管理员登录";
  $("auth-intro").textContent = setup
    ? "首次初始化。设置后仅此管理员可读取统计。"
    : "网站访问、软件下载与软件使用统计。";
  $("token-label").hidden = !setup;
  $("confirmation-label").hidden = !setup;
  $("password").autocomplete = setup ? "new-password" : "current-password";
  $("password").minLength = setup ? 14 : 1;
  $("auth-submit").textContent = setup ? "设置并前往登录" : "登录";
}
function showDashboard(username) {
  $("auth").hidden = true;
  $("dashboard").hidden = false;
  $("account-name").textContent = username;
  $("password").value = "";
  $("confirmation").value = "";
  $("token").value = "";
  load();
}
$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("auth-message").textContent = "";
  if (setup && $("password").value !== $("confirmation").value) {
    $("auth-message").textContent = "两次密码不一致。";
    return;
  }
  $("auth-submit").disabled = true;
  try {
    const data = await request(setup ? "setup" : "login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: $("username").value,
        password: $("password").value,
        ...(setup ? { token: $("token").value.trim() } : {}),
      }),
    });
    if (setup) {
      showAuth(false);
      $("password").value = "";
      $("confirmation").value = "";
      $("token").value = "";
      $("auth-message").textContent = "管理员已设置，请使用刚才的用户名和密码登录。";
    } else {
      csrf = data.csrf;
      showDashboard(data.username);
    }
  } catch (error) {
    $("auth-message").textContent = error.message;
  } finally {
    $("auth-submit").disabled = false;
  }
});
$("logout").onclick = async () => {
  try {
    await request("logout", { method: "POST", headers: { "X-CSRF-Token": csrf } });
    report = null;
    csrf = "";
    showAuth(false);
  } catch (e) {
    message(e.message);
  }
};
$("mobile-logout").onclick = $("logout").onclick;
document.querySelectorAll("[data-tab]").forEach((button) => {
  button.onclick = () => {
    const previousScope = tab === "usage" ? "usage" : "website";
    tab = button.dataset.tab;
    const nextScope = tab === "usage" ? "usage" : "website";
    if (previousScope !== nextScope) {
      dateScopes[previousScope] = { from: $("from").value, to: $("to").value };
      const saved = dateScopes[nextScope];
      if (saved) {
        $("from").value = saved.from;
        $("to").value = saved.to;
      } else dates(7, report?.usage?.reporting?.latestViewableDay || today());
    }
    document.querySelectorAll("[data-tab]").forEach((b) => {
      b.classList.toggle("active", b === button);
    });
    $("page-title").textContent = names[tab];
    if (previousScope !== nextScope) load();
    else if (report) render();
  };
});
document.querySelectorAll("[data-days]").forEach((button) => {
  button.onclick = () => {
    dates(
      Number(button.dataset.days),
      tab === "usage" ? report.usage.reporting.latestViewableDay : today(),
    );
    document.querySelectorAll("[data-days]").forEach((b) => {
      b.classList.toggle("selected", b === button);
    });
    load();
  };
});
$("apply").onclick = () => {
  document.querySelectorAll("[data-days]").forEach((b) => {
    b.classList.remove("selected");
  });
  load();
};
$("refresh").onclick = load;
async function load() {
  const id = ++loadId;
  message("");
  $("refresh").disabled = true;
  try {
    const next = await request(
      "report?" +
        new URLSearchParams({ from: $("from").value, to: $("to").value, ...releaseFilters }),
    );
    if (id !== loadId) return;
    report = next;
    $("freshness").textContent =
      tab === "usage"
        ? `昨日及更早日报可查看 · 暂定区间每日更新，D+8固定`
        : "网站汇总更新于 " + time(report.generatedAt);
    $("export").href =
      api + "export.csv?" + new URLSearchParams({ from: report.from, to: report.to });
    message(
      tab !== "usage" && report.stale
        ? "网站汇总超过 15 分钟未更新。当前显示的是上次成功数据，请查看汇总服务。"
        : "",
    );
    render();
  } catch (e) {
    if (id === loadId) {
      message(e.message);
      if (report) {
        $("from").value = report.from;
        $("to").value = report.to;
        Object.assign(
          releaseFilters,
          report.usage.filters || { platform: "", version: "", channel: "" },
        );
        render();
      }
    }
  } finally {
    if (id === loadId) $("refresh").disabled = false;
  }
}
const metric = (label, value, note, badge = "") =>
  `<article class="metric"><div class="metric-label">${esc(label)}${badge ? `<span class="badge">${esc(badge)}</span>` : ""}</div><div class="metric-value ${/[\u4e00-\u9fff]/.test(String(value)) ? "textual" : ""}">${esc(value)}</div><p class="metric-note">${esc(note)}</p></article>`;
const panel = (title, description, content) =>
  `<section class="panel"><div class="panel-head"><div><h2>${esc(title)}</h2>${description ? `<p class="description">${esc(description)}</p>` : ""}</div></div>${content}</section>`;
const empty = (title, detail) =>
  `<div class="empty"><strong>${esc(title)}</strong>${esc(detail)}</div>`;
function table(headers, rows) {
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr>${headers.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
    : empty("所选日期暂无记录", "未观察到记录不等于已确认没有访问；请结合覆盖时间与服务状态。");
}
function chart(rows, keys, hourly = false, caption = "页面浏览趋势；缺少记录不连线") {
  if (!rows.length) return empty("暂无可绘制的趋势", "网站数据将在汇总任务完成后显示。");
  const start = Date.parse(hourly ? rows[0].date : report.from),
    end = Date.parse(hourly ? rows[rows.length - 1].date : report.to);
  const interval = hourly ? 3600000 : 86400000;
  const label = (value) => (hourly ? value.slice(5, 16).replace("T", " ") : value);
  const width = 800,
    height = 210,
    left = 38,
    bottom = 180;
  const max = Math.max(1, ...rows.flatMap((r) => keys.map((k) => r[k] || 0)));
  const x = (r) =>
    left + ((Date.parse(r.date) - start) / Math.max(interval, end - start)) * (width - left - 12);
  const y = (v) => bottom - (v / max) * 145;
  const colors = ["#3894ee", "#77bdb2"];
  let svg = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${hourly ? "按小时" : "按日"}统计趋势 · ${esc(caption)}"><title>${esc(caption)}</title>`;
  for (let n = 0; n <= 4; n++) {
    const v = (max * n) / 4;
    svg += `<line x1="${left}" y1="${y(v)}" x2="790" y2="${y(v)}"/><text x="${left - 8}" y="${y(v) + 3}" text-anchor="end">${num(Math.round(v))}</text>`;
  }
  keys.forEach((k, i) => {
    rows.forEach((r, j) => {
      if (j && Date.parse(r.date) - Date.parse(rows[j - 1].date) === interval)
        svg += `<line x1="${x(rows[j - 1])}" y1="${y(rows[j - 1][k] || 0)}" x2="${x(r)}" y2="${y(r[k] || 0)}" style="stroke:${colors[i]};stroke-width:2.5"/>`;
      svg += `<circle cx="${x(r)}" cy="${y(r[k] || 0)}" r="3" fill="${colors[i]}"><title>${esc(r.date)} ${esc(k === "active" ? "上报活跃贡献（非去重人数）" : k === "pageViews" ? "页面浏览" : k === "pages" ? "页面请求" : k === "downloads" ? "安装包请求" : k === "automatedPages" ? "已识别自动化页面" : "完整文件响应")}：${num(r[k] || 0)}</title></circle>`;
    });
  });
  svg += `<text x="38" y="204">${esc(label(hourly ? rows[0].date : report.from))}</text><text x="790" y="204" text-anchor="end">${esc(label(hourly ? rows[rows.length - 1].date : report.to))}</text></svg>`;
  return svg;
}
function bars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return rows.length
    ? rows
        .map(
          (r) =>
            `<div class="bar-row"><span>${esc(r.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${(r.count / max) * 100}%"></div></div><span>${num(r.count)}</span></div>`,
        )
        .join("")
    : empty("暂无记录", "所选日期内没有可展示的数据。");
}
function pageRows() {
  const counts = new Map();
  if (report.trafficSchemaVersion < 3) return [];
  for (const r of report.pages) counts.set(r.path, (counts.get(r.path) || 0) + r.pageViews);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([path, count]) => [path, num(count)]);
}
function usageState() {
  const u = report.usage;
  if (u.state === "error" || u.receiverReady === false) return "接收服务待检查";
  if (u.state !== "active") return "接收尚未开放";
  if (u.latestFinalDay) return "已有固定日报";
  if (u.snapshots?.some((s) => s.status === "provisional")) return "已有暂定日报";
  return u.reception?.lastReceivedDay ? "已收到贡献，等待结算" : "等待首份有效上报";
}
const productNames = {
  brand: "品牌首页",
  work: "Work · 产品介绍",
  search: "Search · 产品介绍",
  ai: "AI · 产品介绍",
  manage: "Manage · 产品介绍",
  "work-docs": "Work · 使用文档",
  support: "帮助与政策",
  other: "其他页面",
};
function trafficExportLink(view) {
  return `<a class="button" href="${api}export.csv?${esc(new URLSearchParams({ from: report.from, to: report.to, trafficView: view }))}">导出${{ pages: "页面", products: "产品", hours: "小时" }[view]}明细 CSV ↗</a>`;
}
function trafficGroups(rows, key, countKey) {
  const groups = new Map();
  for (const row of rows) {
    const value = groups.get(row[key]) || {
      count: 0,
      pageRequests: 0,
      cachedPageViews: 0,
      cachedPages: 0,
      automatedPages: 0,
      unmarkedPages: 0,
      unknownPages: 0,
    };
    value.count += row[countKey] || 0;
    value.pageRequests += row.count ?? row.pages ?? 0;
    for (const name of [
      "cachedPageViews",
      "cachedPages",
      "automatedPages",
      "unmarkedPages",
      "unknownPages",
    ])
      value[name] += row[name] || 0;
    groups.set(row[key], value);
  }
  return [...groups].sort((a, b) => b[1].count - a[1].count);
}
function trafficView() {
  if (report.trafficSchemaVersion < 3)
    return empty(
      "等待新版网站报表",
      "汇总任务尚未更新为公开页面过滤口径；不把旧报表当作已过滤的浏览数据。",
    );
  const t = report.totals,
    known = report.days.length > 0;
  const products = new Map(trafficGroups(report.products, "product", "pageViews"));
  const productRows = Object.entries(productNames).map(([key, label]) => {
    const v = products.get(key);
    return [
      label,
      num(v?.count),
      num(v?.cachedPageViews),
      num(v?.pageRequests),
      num(v?.automatedPages),
      num(v ? v.unmarkedPages + v.unknownPages : undefined),
    ];
  });
  const hours = report.hours
    .map((r) => ({ ...r, date: r.hour }))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const last = hours.length ? Date.parse(hours[hours.length - 1].date) : 0;
  const recent = hours.filter((r) => Date.parse(r.date) > last - 72 * 3600000);
  return `<div class="metrics">${metric("页面浏览", num(known ? t.pageViews : undefined), "正式公开页面；排除已识别自动化与更新检查")}${metric("缓存验证浏览", num(known ? t.cachedPageViews : undefined), "304 响应；纯本地缓存访问仍不可见")}${metric("已排除自动化页面", num(known ? t.automatedPages : undefined), "单独诊断，不计入页面浏览；无法识别全部机器人")}${metric("标记缺失的历史浏览", num(known ? t.unknownPages : undefined), "可能包含未知机器人，不等于真人或独立访客")}</div>${panel("按小时访问趋势", "所选范围内最近 72 小时（截至最后一条页面记录），北京时间；缺失小时不补零。", '<div class="legend"><span>页面浏览</span><span>已识别自动化页面</span></div>' + chart(recent, ["pageViews", "automatedPages"], true, "公开页面浏览；排除已识别自动化") + trafficExportLink("hours"))}${panel("产品与服务页面分布", "产品介绍、Work 文档、帮助与政策分开汇总；更新检查、接口、预览页及未知地址不计入。", table(["产品 / 页面组", "页面浏览", "浏览中缓存304", "全部页面请求（诊断）", "已识别自动化", "未识别为自动化"], productRows) + trafficExportLink("products"))}${panel(
    "页面访问排行",
    "按排除已识别自动化后的浏览次数排序；含刷新和重复浏览，未知机器人仍可能混入。显示前 20 项，CSV 导出全部明细。",
    table(
      [
        "规范页面路径",
        "页面浏览",
        "浏览中缓存304",
        "全部页面请求（诊断）",
        "已识别自动化",
        "未命中特征",
        "旧日志标记未知",
      ],
      trafficGroups(report.pages, "path", "pageViews")
        .slice(0, 20)
        .map(([path, v]) => [
          path,
          num(v.count),
          num(v.cachedPageViews),
          num(v.pageRequests),
          num(v.automatedPages),
          num(v.unmarkedPages),
          num(v.unknownPages),
        ]),
    ) + trafficExportLink("pages"),
  )}`;
}
function overview() {
  const t = report.totals;
  const known = report.days.length > 0;
  return `<div class="metrics">${metric("页面浏览", num(known && report.trafficSchemaVersion >= 3 ? t.pageViews : undefined), "公开页面；排除更新检查、接口与已识别自动化")}${metric("安装包请求", num(known ? t.downloads : undefined), "包含重复下载和断点续传", "200 / 206")}${metric("完整文件响应", num(report.quality.enhancedSince ? t.fullResponses : undefined), "仅新日志验证的 200 完整传输", "传输完成")}${metric("软件使用统计", usageState(), report.usage.state === "active" ? "仅包含成功接收的贡献，非全部用户" : "当前下载的历史预览包尚未接入")}</div><div class="grid-two">${panel("网站访问与下载趋势", "按北京时间自然日统计，缺失日期不补为零。", '<div class="legend"><span>页面浏览</span><span>安装包请求</span></div>' + chart(report.trafficSchemaVersion >= 3 ? report.days : [], ["pageViews", "downloads"], false, "公开页面浏览与安装包请求；排除技术检查"))}${panel(
    "下载响应构成",
    "请求次数不能直接推导下载人数。",
    bars([
      { label: "完整 200 响应", count: t.fullResponses || 0 },
      { label: "206 分段请求", count: t.rangeRequests || 0 },
      { label: "旧日志未验证", count: t.legacyDownloads || 0 },
      { label: "200 未完成 / 未知", count: t.incompleteResponses || 0 },
    ]),
  )}</div>${panel("主要访问页面", "排除已识别自动化；同一路径刷新和重复浏览分别计数，未知机器人仍可能混入。", table(["页面路径", "页面浏览"], pageRows()))}`;
}
function downloadsView() {
  const t = report.totals;
  const known = report.days.length > 0;
  return `<div class="metrics">${metric("安装包请求", num(known ? t.downloads : undefined), "200 与 206 请求合计")}${metric("完整 200 响应", num(report.quality.enhancedSince ? t.fullResponses : undefined), "仅代表服务器完成文件响应")}${metric("分段 / 续传请求", num(known ? t.rangeRequests : undefined), "206 响应，不能合并为去重下载")}${metric("安装包传输流量", size(known ? t.downloadBytes : undefined), "含重复与分段传输")}</div>${panel(
    "每日下载记录",
    "旧日志未验证数和新日志未完成数分开呈现。",
    table(
      ["日期", "安装包请求", "完整 200", "分段 206", "旧日志未验证", "200 未完成/未知", "下载错误"],
      report.days.map((r) => [
        r.date,
        num(r.downloads),
        num(r.fullResponses),
        num(r.rangeRequests),
        num(r.legacyDownloads),
        num(r.incompleteResponses),
        num(r.downloadErrors),
      ]),
    ),
  )}${panel(
    "安装包路径",
    "固定地址替换安装包时，现有日志不能识别旧包的精确版本。",
    table(
      ["日期", "文件路径", "请求", "完整 200", "分段 206", "流量"],
      report.downloads.map((r) => [
        r.day,
        r.path,
        num(r.requests),
        num(r.fullResponses),
        num(r.rangeRequests),
        size(r.bytes),
      ]),
    ),
  )}${panel("下载口径", "", `<div class="definition-list"><p><strong>准确记录：</strong>服务器观察到的成功请求、响应字节和完整 200 响应。</p><p><strong>无法推断：</strong>唯一下载人数、已安装人数、断点续传最终成功人数。当前没有设备标识、安装回执或下载会话 ID。</p><p><strong>历史限制：</strong>增强日志启用于 ${esc(time(report.quality.enhancedSince))}。此前下载及部署验收请求可能计入，不能追溯拆分。</p></div>`)}`;
}
const usageReasons = {
  "receiver-error": [
    "接收服务需要检查",
    "接收或维护出现异常，请查看接收诊断；这不代表使用量为零。",
  ],
  "release-not-open": [
    "所选发行分组尚未开放",
    "请改选已开放的平台、完整版本或渠道。旧安装包不会因后台升级自动开始上报。",
  ],
  "waiting-contribution": [
    "等待首份有效上报",
    "接收配置已开放，但尚未观察到成功贡献。请先发布接入统计的新版安装包，并在软件中确认现行协议。",
  ],
  "waiting-publication": [
    "正在等待补发窗口结束",
    "新版次日可看暂定区间，D+8 固定；旧协议仍等到窗口结束。尚未展示不等于没有使用。",
  ],
  "no-matching-reports": [
    "所选范围没有匹配的日报",
    "请调整日期或发行分组。没有记录、尚未上报与零使用量不能画等号。",
  ],
};
const rangeText = (value) =>
  value ? (value[0] === value[1] ? String(value[0]) : value.join("–")) : "样本不足（<10）";
const groupKey = (g) => [g.platform || "unknown", g.version, g.channel || "unknown"].join("|");
const groupLabel = (g) =>
  `${platformLabel(g.platform)} · ${g.version} · ${channelLabel(g.channel)}`;
function usageGroups() {
  const groups = new Map();
  for (const s of report.usage.snapshots || [])
    for (const g of s.groups) groups.set(groupKey(g), g);
  return [...groups];
}
function usageView() {
  const u = report.usage,
    snapshots = u.snapshots || [],
    r = u.reporting || { retryDays: 7, delayDays: 8, latestPublishableDay: "尚不可用" };
  const groups = usageGroups();
  if (!groups.some(([key]) => key === usageGroup)) usageGroup = groups[0]?.[0] || "";
  const reason = usageReasons[u.emptyReason] || usageReasons["no-matching-reports"];
  const releases = (u.releases || []).map(groupLabel).join("；") || "尚未开放";
  const diagnostics = (u.reception?.outcomes || []).map((row) => [
    row.day,
    {
      accepted: "有效贡献已提交",
      duplicate: "重复上报已去重",
      conflict: "凭据内容冲突，已拒绝",
      invalid: "字段或格式不合法，已拒绝",
      legacy_rejected: "旧上报协议已拒绝",
      outside_window: "不在补发窗口，已拒绝",
      unreleased: "发行分组未开放，已拒绝",
      rate_limited: "已触发接收限流",
      closed: "日报已经冻结，已拒绝",
      storage_error: "存储失败，客户端可补发",
    }[row.outcome] || "接收异常",
    "已观察到",
  ]);
  return (
    `<div class="metrics usage-metrics">${metric("接收状态", usageState(), "配置开放不等于已经收到真实数据")}${metric("最近成功接收日", u.reception?.lastReceivedDay || "尚无记录", "最近30天内；只显示自然日")}${metric("可固定截至日期", r.latestPublishableDay, `允许补发 ${r.retryDays} 天，D+${r.delayDays} 固定发布`)}${metric("最近匹配日报", u.latestReportDay || "尚无日报", "贡献不是去重人数；缺失和小样本不补为零")}</div>` +
    panel(
      "使用日报",
      `昨天起可查看新版暂定区间，每日更新一次；允许补发 ${r.retryDays} 天，第 ${r.delayDays} 天（D+${r.delayDays}）形成固定日报。${u.nextPublicationDay ? `当前范围待结算日报预计 ${u.nextPublicationDay} 可查看。` : ""}`,
      `<div class="usage-filters">${usageSelect("platform", "平台", ["windows", "macos", "harmonyos", "unknown"], platformLabel)}${usageSelect("version", "完整版本", u.filterOptions?.versions || [], (x) => (x === "unknown" ? "未知（旧数据）" : x))}${usageSelect("channel", "发行渠道", ["stable", "preview", "internal", "unknown"], channelLabel)}</div>` +
        (snapshots.length
          ? `<div class="usage-report-selectors"><label>查看发行分组<select id="usage-group" aria-label="查看发行分组">${groups.map(([key, g]) => `<option value="${esc(key)}"${key === usageGroup ? " selected" : ""}>${esc(groupLabel(g))}</option>`).join("")}</select></label><label>日报日期<select id="usage-day" aria-label="日报日期">${snapshots.map((s) => `<option value="${esc(s.day)}">${esc(s.day)} · ${s.status === "provisional" ? "暂定" : "固定"}</option>`).join("")}</select></label></div><div id="usage-trend"></div><div id="usage-detail"></div>`
          : empty(reason[0], reason[1])) +
        `<p class="muted small">每个发行分组分别展示，不跨组相加。暂定值按10份宽度显示区间，当日刷新不会增加精度；不足10隐藏。固定后可展示符合规则的数值，缺少记录和样本不足均不代表零。</p>`,
    ) +
    panel(
      "时长与贡献如何理解",
      "",
      `<div class="definition-list"><p><strong>上报活跃贡献：</strong>成功收到的安装日贡献份数，不是去重人数。关闭统计、超过 7 天未运行、存储故障等仍可能漏记。</p><p><strong>累计前台时长的区间次数：</strong>每次进程运行在一个业务日内累计的前台时长，退出或跨日时归入一档。同一天分两次各使用 10 分钟，记为 5–15 分钟 2 次；不是 2 个人，也不是每日总时长。</p><p>切换后台、最小化、锁屏或休眠暂停；窗口留在前台但人已离开可能计入。匿名上报凭据只防同一份日报重放，不能证明不同凭据对应不同真人或安装。</p></div>`,
    ) +
    `<details class="panel usage-technical"><summary>接入配置与接收诊断</summary><dl class="source-list"><dt>接收接口</dt><dd>${esc(u.endpoint || "/v1/usage/daily-aggregate")}</dd><dt>已开放发行版</dt><dd>${esc(releases)}</dd><dt>可识别维度</dt><dd>Windows / macOS / HarmonyOS、完整版本、发行渠道；仅已验收并开放的组合可上报。</dd><dt>来源边界</dt><dd>暂定区间每日缓存；旧协议贡献仅固定后展示。随机日报凭据去重、严格字段与发行校验、来源及全局限流；无账号/设备证明，不声称真实安装认证。</dd><dt>诊断范围</dt><dd>最近 30 天服务实际处理过的结果。边缘代理提前拦截的请求不在这里；不展示可反推小样本的实时成功总数。</dd></dl>${diagnostics.length ? table(["接收自然日", "结果类型", "状态"], diagnostics) : empty("尚无服务接收诊断", "可先核对安装包、统计选择及接收服务；不把无诊断解释为零使用量。")}</details>`
  );
}
function usageSelect(key, label, values, display) {
  const choices = [...new Set([...values, ...(releaseFilters[key] ? [releaseFilters[key]] : [])])];
  return `<label>${esc(label)}<select id="usage-${key}" aria-label="${esc(label)}"><option value="">全部${esc(label)}</option>${choices.map((value) => `<option value="${esc(value)}"${releaseFilters[key] === value ? " selected" : ""}>${esc(display(value))}</option>`).join("")}</select></label>`;
}
function renderUsage(day) {
  const snapshots = report.usage.snapshots || [];
  const chosen = snapshots
    .find((s) => s.day === day)
    ?.groups.find((g) => groupKey(g) === usageGroup);
  const series = snapshots
    .flatMap((s) =>
      s.groups
        .filter((g) => groupKey(g) === usageGroup && typeof g.activeInstallationDays === "number")
        .map((g) => ({ date: s.day, active: g.activeInstallationDays })),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  $("usage-trend").innerHTML = panel(
    "上报活跃贡献趋势",
    "仅绘制固定日报的确定数值；暂定区间不画成精确点，小样本或缺失日期不连线、不补零。",
    series.length
      ? chart(series, ["active"], false, "上报活跃贡献趋势；非去重人数；小样本和缺失日期不连线")
      : empty("暂无满足展示条件的趋势", "该组可能仅有暂定或小样本日报，不能画成零使用量。"),
  );
  const snapshot = snapshots.find((s) => s.day === day);
  if (chosen && snapshot.status === "provisional") {
    $("usage-detail").innerHTML =
      `<div class="panel-head"><h3>${esc(groupLabel(chosen))}</h3><span class="badge">暂定日报 · ${esc(day)}</span></div><p class="muted">更新日 ${esc(snapshot.asOf)} · 预计 ${esc(snapshot.finalizesOn)} 固定；区间可能随补发变化，仅含确认新版告知的贡献。</p>` +
      table(["业务日期", "上报活跃贡献区间（非人数）"], [[day, rangeText(chosen.activeRange)]]) +
      `<h3 class="usage-duration-title">每次运行在该日的累计前台时长</h3>` +
      (chosen.durationRanges
        ? table(
            ["时长区间", "运行次数区间"],
            chosen.durationRanges.labels.map((label, i) => [
              label,
              rangeText(chosen.durationRanges.ranges[i]),
            ]),
          )
        : empty("时长区间暂未展示", "样本不足时整体隐藏；固定日报形成后再按规则展示。"));
    return;
  }
  $("usage-detail").innerHTML = chosen
    ? `<div class="panel-head"><h3>${esc(groupLabel(chosen))}</h3><span class="badge">固定日报 · ${esc(day)}</span></div>` +
      table(
        ["业务日期", "上报活跃贡献（非去重人数）"],
        [
          [
            day,
            chosen.activeInstallationDays === null
              ? "样本不足（<10）"
              : num(chosen.activeInstallationDays),
          ],
        ],
      ) +
      `<h3 class="usage-duration-title">每次运行在该日的累计前台时长分布</h3><p class="muted small">单位：运行次数，不是人数；同一安装可多次运行，区间次数之和可以大于活跃贡献。</p>` +
      (chosen.duration
        ? bars(
            chosen.duration.labels.map((label, i) => ({
              label: label + " · 次",
              count: chosen.duration.counts[i],
            })),
          )
        : empty("时长分布未展示", "小样本保护条件尚未满足，不反推次数，也不按零显示。"))
    : empty("该发行分组在此日没有固定日报", "请选择其他日报日期；没有记录不等于零使用量。");
}
function backupSummary() {
  const completed = report.usage.backup?.lastCompletedAt;
  if (!completed || !Number.isFinite(Date.parse(completed))) return "尚未完成备份，请检查备份任务";
  return (
    time(completed) +
    (Date.now() - Date.parse(completed) > 2 * 86400000 ? " · 更新延迟" : " · SQLite 一致性副本")
  );
}
function sources() {
  const q = report.quality,
    t = report.totals;
  return `<div class="metrics">${metric("内容与资源请求", num(t.requests), "仅作运行诊断；不等于页面浏览，已排除更新检查和接口")}${metric("网站流量", size(t.bytes), "服务器响应正文传输字节")}${metric("错误响应", num(t.errors), "HTTP 4xx 与 5xx")}${metric("被识别的自动化请求", num(t.automatedRequests), "仅新日志的已知特征，非完整机器人识别")}</div>${panel("数据来源与更新", "", `<dl class="source-list"><dt>网站数据源</dt><dd>Nginx 保留日志；不导出来源 IP 与查询参数。</dd><dt>网站最近汇总</dt><dd>${esc(time(report.generatedAt))} · ${report.stale ? "更新延迟" : "正常"}</dd><dt>观察到的最早请求</dt><dd>${esc(time(q.firstObserved))}</dd><dt>观察到的最近请求</dt><dd>${esc(time(q.lastObserved))}</dd><dt>增强日志起点</dt><dd>${esc(time(q.enhancedSince))}</dd><dt>日志源文件</dt><dd>${num(q.sourceFiles)} 份</dd><dt>无效或尾部未完成行</dt><dd>${num(q.invalidLines)} 行 · 未计入统计</dd><dt>排除的技术与内部请求</dt><dd>${num(q.excludedRequests)} 次 · 更新检查、接口、监控、后台及验收请求；其中技术端点 ${num(q.excludedTechnicalRequests)} 次</dd><dt>使用统计接收状态</dt><dd>${esc(report.usage.receiverReady ? "服务已部署" : "待检查")} · ${esc(usageState())}</dd><dt>最近一致性备份</dt><dd>${esc(backupSummary())}</dd><dt>业务数据保留</dt><dd>网站日志约 190 天；软件汇总最长 18 个月。</dd></dl>`)}${panel(
    "响应状态分布",
    "仅当前日期范围；4xx 可能包括扫描和不存在的链接。",
    (() => {
      const counts = new Map();
      for (const r of report.statuses) counts.set(r.status, (counts.get(r.status) || 0) + r.count);
      return table(
        ["HTTP 状态", "请求数"],
        [...counts].sort().map(([s, c]) => [s, num(c)]),
      );
    })(),
  )}${panel(
    "统计定义",
    "",
    `<div class="definition-list">${Object.entries(report.definitions)
      .map(
        ([k, v]) =>
          `<p><strong>${esc({ pages: "页面浏览与请求诊断", automation: "自动化分类", products: "产品分组", downloads: "安装包请求", fullResponses: "完整文件响应", usage: "软件使用" }[k] || k)}：</strong>${esc(v)}</p>`,
      )
      .join("")}</div>`,
  )}`;
}
function render() {
  const usageMode = tab === "usage";
  document.querySelectorAll("[data-days]").forEach((button) => {
    const days = Number(button.dataset.days);
    const end = usageMode ? report.usage.reporting.latestViewableDay : today();
    const span = (Date.parse(report.to) - Date.parse(report.from)) / 86400000 + 1;
    button.classList.toggle("selected", span === days && report.to === end);
    button.textContent = usageMode
      ? days === 1
        ? "昨日"
        : `近 ${days} 天（截至昨日）`
      : days === 1
        ? "今天"
        : `近 ${days} 天`;
  });
  $("from").max = $("to").max = usageMode ? report.usage.reporting.latestViewableDay : today();
  $("export").textContent = tab === "usage" ? "导出软件日报 CSV ↗" : "导出网站 CSV ↗";
  $("export").href =
    api +
    (tab === "usage" ? "export-usage.csv" : "export.csv") +
    "?" +
    new URLSearchParams({
      from: report.from,
      to: report.to,
      ...(tab === "usage" ? releaseFilters : {}),
    });
  $("content").innerHTML =
    tab === "overview"
      ? overview()
      : tab === "traffic"
        ? trafficView()
        : tab === "downloads"
          ? downloadsView()
          : tab === "usage"
            ? usageView()
            : sources();
  if (tab === "usage")
    for (const key of Object.keys(releaseFilters)) {
      $("usage-" + key).onchange = () => {
        releaseFilters[key] = $("usage-" + key).value;
        load();
      };
    }
  if (tab === "usage" && $("usage-day")) {
    $("usage-day").onchange = () => renderUsage($("usage-day").value);
    $("usage-group").onchange = () => {
      usageGroup = $("usage-group").value;
      renderUsage($("usage-day").value);
    };
    renderUsage($("usage-day").value);
  }
}
dates(7);
$("to").max = today();
$("from").max = today();
request("session")
  .then((state) => {
    csrf = state.csrf || "";
    if (state.authenticated) showDashboard(state.username);
    else showAuth(state.setupRequired);
  })
  .catch((e) => {
    showAuth(false);
    $("auth-message").textContent = e.message;
  });
