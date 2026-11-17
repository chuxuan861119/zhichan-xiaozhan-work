# 统一统计后台

管理入口：`https://zcxzz.cn/admin-statistics/`。公开官网没有后台导航或注册入口。首次设置使用服务器私有目录中的一次性初始化凭据，管理员本人填写用户名和至少 14 字符的密码。凭据文件与摘要不提交 Git。

## 可查看的内容

2026-10-26 页面口径升级为 schema 3：总览、页面排行、产品和小时趋势优先展示正式公开页面的浏览次数，排除已识别自动化。更新检查、软件上报、后台、API、监控与证书检查请求完全排除；预览页、未知地址和资源不算页面浏览。全部页面请求和资源流量只作诊断，CSV 同时提供浏览及诊断列。含刷新与无法识别的自动化，不宣称真人、完整 PV 或独立访客。保留日志重算后历史数字可能下降；未升级报表不补造过滤结果。

新增正式公开页面时同步维护两套汇总脚本的 `PUBLIC_PAGES` 与别名映射；默认不将新接口或未知地址当作页面。线上使用 `upgrade-page-filter.py` 的受控补丁保留已有访客估算和软件接收模块，不用旧分支的完整后台覆盖运行版本。

- 总览：页面请求、安装包请求、可核验的完整文件响应、软件接入状态、逐日趋势、主要访问页面。
- 网站访问：HTML GET 的 200/304 页面请求、缓存验证访问、自动化分类、产品分布、最近 72 小时趋势及规范地址排行；页面、产品、小时明细 CSV 共用日期范围。
- 软件下载：完整 200 响应、206 分段请求、历史日志无法核验的请求、未完成/未知响应、下载错误、字节数与文件路径。
- 软件使用：已开放平台、完整软件版本、发行渠道、协议4次日暂定区间与 D+8 固定日报、活跃安装贡献与时长分布；样本不足显示空值，不显示可反推的原始计数。筛选及 CSV 只过滤同一固定分组，不重新聚合。
- 数据与运行状态：来源、更新时间、增强日志起点、最早/最近观察到的请求、无效日志行、内部请求排除、错误状态分布、接收设施状态与统计口径。
- 网站 CSV 与软件日报 CSV 随当前日期范围导出。软件 CSV 每组活跃贡献只写在首行，避免按时间桶重复相加。缺失日期不补为零。

## 准确性的范围

日志是服务器观察到的请求，不能证明独立访客、安装人数或文件在用户磁盘上保存成功。200 完整响应要求 Nginx `request_completion=OK`、实际正文长度与响应长度一致；206 请求不能在没有下载会话 ID 的情况下去重合并。旧日志没有这些字段，不追溯推断。固定下载地址替换软件后，旧日志也无法还原准确版本。

网站汇总每次从约 190 天的保留日志重建，重复执行不会累计重复数字。排除管理员入口、软件接收接口、回环地址与标记的部署检查。已知自动化请求仅作为诊断计数，不能承诺识别全部机器人；上线后的历史外部验收请求可能包含在旧数据中。

页面请求包括 HTML GET 的 200 和 304，排除 404 页面、跳转、HEAD 和静态资源。纯本地缓存且没有请求服务器的访问不可见，不称为完整 PV 或独立访客。已识别自动化、未命中特征、旧日志无标记分别保留，后两者不等于真人；旧别名与 index.html 规范合并。产品介绍与 Work 文档分组独立。小时图仅显示所选范围最近 72 小时（截至最后页面记录），缺失小时不补零，完整小时可导出。详情及部署证据见 `docs/changes/unified-statistics/website-visits.md`。

软件端不使用稳定设备 ID，不计算 UV、精确 DAU/MAU、留存或精确时长。协议3支持7天退避补发，同份随机凭据幂等计入一次；超过窗口、关闭或本机存储故障仍会漏记，客户端重置或伪造新凭据仍可能重复；数据不能用于计费或审计。协议4贡献次日展示按10份宽度的暂定区间，同日缓存不变，第8天固定；协议3贡献只进入固定日报。不组合跨组总量和互补版本视图。暂定时长采用固定两档，非零档不足10时整体隐藏。

## 构建与测试

```powershell
node scripts/build-admin-statistics.mjs
node --test services/admin-statistics/server.test.mjs
python services/admin-statistics/traffic.test.py
node node_modules/vitest/vitest.mjs run services/usage-statistics/server.test.ts --pool=forks --maxWorkers=1
```

服务端使用官方 Node 24.22.0、内建 SQLite 与 Python 3.11。构建产物 `out-admin-statistics/` 独立于 Electron 与公开静态网页，不把测试数据或测试账号带入部署包。

## 服务器运行与排查

| 对象 | 位置或命令 |
| --- | --- |
| 控制台与接收服务 | `systemctl status zcxzz-statistics` |
| 网站汇总定时器 | `systemctl status zcxzz-statistics-collector.timer` |
| 手动刷新汇总 | `systemctl start zcxzz-statistics-collector.service` |
| 服务日志 | `journalctl -u zcxzz-statistics -n 50 --no-pager` |
| 汇总日志 | `journalctl -u zcxzz-statistics-collector -n 30 --no-pager` |
| 运营配置 | `/etc/zcxzz/statistics.json` |
| 安全私有目录 | `/var/lib/zcxzz-admin/`，服务账号独占 |
| 账号摘要 | `/var/lib/zcxzz-admin/administrator.json`，0600 |
| 初始化凭据 | `/var/lib/zcxzz-admin/setup-token.txt`，0600；账号创建后失效 |
| IP 已移除的报表 | `/var/lib/zcxzz-admin/traffic.json` |
| 软件汇总数据库 | `/var/lib/zcxzz-admin/usage.sqlite`，含 WAL/SHM，不能逐个在线复制冒充一致备份 |
| 原始网站日志 | `/var/log/zcxzz/access.jsonl*`，后台服务无权读取 |
| 应用版本 | `/opt/zcxzz-statistics/current` |
| Nginx 变更前配置 | `/etc/zcxzz/nginx.before-statistics-20261017.conf` |

后台空白优先检查服务；显示“汇总更新延迟”检查定时器和文件权限。计数偏差先核对日期、响应口径、覆盖范围与请求排除，不修改原始日志或生产数据库来调整数字。

密码只保存 scrypt 摘要；会话 Cookie 为 Secure/HttpOnly/SameSite=Strict，空闲 30 分钟或累计 8 小时过期；服务重启使所有会话失效。连续失败触发 15 分钟限制，Nginx 另设登录来源限流。

## 最终软件包接入

2026-10-18 已开放服务器发行元组 `windows / 1.1.2 / preview`，`clientReleaseActive=true`、`publicVersionGroups=[]`、`snapshotView=releases`；客户端已同步 Windows 配置。旧协议、1.1.1 及未验收的 macOS/HarmonyOS 不接受上报。当前固定地址的 1.1.1 历史预览包不替换；最终包须从合并后的 main 构建。示例配置默认关闭，不代表线上状态。

固定 HTTPS 地址 `https://zcxzz.cn/v1/usage/daily-aggregate` 与真实告知已填写。最终包发布时，在 `resources/usage-statistics-channel.json` 中仅开放已验收的 `acceptedPlatforms`，并与服务器同步 `releases` 中的 `{platform, version, channel}`；服务器 `clientReleaseActive` 必须与开放发行组一致。渠道来自随包配置，不按环境变量覆盖。先完成真实客户端前台/锁屏/断网/次日上报和关闭开关验证，再发布该包。单独部署后台不会让旧软件自动开始统计。

## 备份与恢复

网站报表可从保留日志重建。软件接收已开放；2026-10-18核验时尚无真实软件贡献。已部署每日 SQLite 在线备份，位置 `/var/backups/zcxzz-statistics/usage-latest.sqlite`，目录 0700、文件 0600；仅保留最新成功副本，写入前校验，失败保留前次副本。后台读取私有 `backup-status.json` 展示完成时间。此为同机备份，不涵盖主机灾难或凭据/配置备份。配置、管理员摘要和数据库备份应置于受限目录或受控云快照，不放入网站目录，不通过聊天传递。

忘记管理员密码时，由拥有服务器权限的管理员停服务、将原摘要文件改名保留，再启动服务进入初始化；重新设置后重启使旧会话失效。此操作不得交给没有主机权限的访客，也不通过公开“找回密码”接口实施。

回退本功能时恢复变更前 Nginx 配置，通过 `nginx -t -c /etc/zcxzz/nginx.conf` 后加载；停止两个统计服务与定时器即可。保留所有版本、数据库和私有文件，不自动删除历史目录，不影响静态官网和下载。

## 协议 2 运维

新增 `release_activity` / `release_duration` 表，事务写入并保留旧表与冻结快照。新 `releases` 日报分开平台、完整版本、渠道；旧数据缺失字段显示未知，不按服务器系统或现有版本猜测。无接入或无匹配数据不补零。

`upgrade.py` 用于现有主机受控升级：校验旧入口与补丁摘要、先备份、保留旧应用与配置、原子切换、检测账号保留，应用阶段失败自动回退；升级不开放发行版。当前版本 `20261017-statistics-platforms-v2`，证据见 `docs/changes/unified-statistics/cross-platform.md`。

```sh
systemctl status zcxzz-statistics-backup.timer
systemctl start zcxzz-statistics-backup.service
journalctl -u zcxzz-statistics-backup -n 30 --no-pager
```

恢复前停统计服务并保留原数据库、WAL/SHM，使用校验后的副本恢复，核对服务账号所有者与权限后再启动；不覆盖运行中的 SQLite。回退旧应用前须核对协议 2 数据与快照兼容，不只切换二进制就认定完成。

部署探测标记是 `X-Zcxzz-Check: deployment`。误标记或更早的检查可能计入访问/下载请求，不改写历史日志调整数字。

## 协议4运营界面（2026-10-18）

软件页默认查看截至昨日的最近7个业务日，网站页的今天/近7天/近30天独立保留。软件页展示配置开放、实际接收日、最新可发布业务日及最近匹配日报；无数据按未开放、等待首份贡献、等待结算、筛选无匹配或接收异常解释。版本选项包含已开放版本，不依赖所选范围已存在日报。趋势仅绘制一个固定发行分组，不跨组相加，小样本和缺失日期不连线、不补零。

时长图与CSV使用“每次运行在该日累计前台时长区间次数”，不是每人每日总时长。同一天两次各10分钟记为5–15分钟2次。接入技术信息折叠；近30天接收诊断只显示结果类别，不显示实时计数、凭据或来源IP。边缘代理提前限流的请求需看独立安全日志。

次日暂定升级与时间异常恢复的实施、验收和限制见 `docs/changes/unified-statistics/next-day-reports.md`。CSV新增状态、截至日期和固定日期；暂定值保留区间，不当作精确数值绘图。
