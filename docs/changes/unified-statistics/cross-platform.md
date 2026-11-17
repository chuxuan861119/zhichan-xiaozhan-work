# 三端软件统计协议升级

日期：2026-10-17。复用 `codex/website-hero-refresh`；不合并 main，不推送，不替换当前公开的历史预览包。主工作区既有背景改动不纳入。

## 设计与范围

升级固定粗汇总为协议 2，增加受限枚举的平台（windows、macos、harmonyos）、完整三段版本和发行渠道（stable、preview、internal）。平台取实际运行时，鸿蒙别名 ohos/openharmony 统一；渠道来自随包配置，不接受环境变量任意覆盖。接收端按完整发行元组白名单校验，未知或未发行的组合拒绝。旧协议继续受原版本组白名单控制，不推断缺失字段。

客户端仍只累计前台可见时长并在次日尝试一次，不添加身份标识、文档字段或精确时长。同日升级沿用首次产生计数时的发行元组，避免把既有计数改标成新版本；本地旧状态只保留选择及发送水位，丢弃不能可靠标注平台/完整版本的未发送计数，重新确认新版告知后再采集。关闭选择不自动恢复。

Windows/macOS 保留现有电源/锁屏适配，异常状态失败关闭。鸿蒙通过固定 ArkTS 绑定读取 `power.isActive()` 和公开 `screenLock.isScreenLocked()`，结合自身窗口焦点，不调用该 Electron 端尚不支持的锁屏/空闲 API。查询超时、返回异常、迟到回调和退出竞态均不能恢复计时。鸿蒙状态查询最多沿用既有 30 秒检查节奏，不新增常驻高频轮询；分桶统计不承诺瞬时准确性。

服务器增加独立协议 2 聚合表，保留旧表与冻结快照。新日报固定发行元组视图，不提供可反推小样本的总量或重算维度组合；每组不足 10 时同时隐藏活跃贡献和时长分布。平台/版本/渠道筛选与 CSV 只过滤相同的冻结叶子组，不重新聚合。旧快照仍冻结，平台、完整版本与渠道显示未知。迁移和备份验证使用仓库外夹具，生产不写合成贡献。

## 实施与验收

- [x] 协议、发行白名单、配置与告知：先测试合法三端/版本/渠道和严格拒绝未知字段。
- [x] 客户端持久化升级：测试旧选择、旧未发送计数、同日/跨日升级、失败与关闭竞态；真实 TLS 只发送规定字段。
- [x] 平台活动：测试 Windows/macOS 回归和鸿蒙原生桥的活动/锁定/熄屏/失败/迟到结果；壳工程绑定纳入构建检查。
- [x] SQLite 兼容、接收、固定日报：测试三端独立、完整版本/渠道独立、事务失败、旧数据与快照保持、D+2 与小样本边界。
- [x] 后台筛选及 CSV：使用隔离数据验证三端和未知来源，不读取任何生产凭据。
- [x] 类型检查、相关回归、客户端/接收服务构建；部署服务端兼容升级并保留回退版本，不开放未经设备验收的发行元组。
- [x] 交付记录区分自动化、Windows 实例和未具备条件的 Mac/鸿蒙真机与最终包验证。

## 官方接口依据

- Electron 37.2.0 powerMonitor：https://github.com/electron/electron/blob/v37.2.0/docs/api/power-monitor.md
- 鸿蒙 Electron 支持表：https://gitcode.com/CPF-Electron/Electron/blob/main/docs%2Fapi/powerMonitor/README.md（锁屏事件与空闲状态不支持）
- OpenHarmony power：https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-basic-services-kit/js-apis-power.md
- OpenHarmony screenLock：https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-basic-services-kit/js-apis-screen-lock.md（第三方公开查询仍为 deprecated API，不能替换成系统应用专用接口）

## 2026-10-17 实际验收

- Vitest：13 个文件、69 项通过，涵盖协议 2、发行白名单、旧状态迁移、同日版本锁定、关闭/失败竞态、真实 TLS、活动适配、SQLite 事务及固定日报。
- Node：29 项通过，涵盖后台认证/筛选/CSV、鸿蒙壳绑定与构建边界、官网发布页面；Python：备份 1 项、网站聚合 3 项通过。
- Windows 隐藏 Electron E2E 1 项通过：未开放渠道不能采集、关闭偏好重启保留、离线新建/保存/PATDOC 导出、测试窗口不抢焦点。未执行真实前台切换、锁屏与休眠验收。
- 管理服务、独立接收服务、Electron 应用与官网构建通过。全量类型检查仍被 HEAD 中已有的两处测试错误阻断：`tests/e2e/cad-preview-regression.spec.ts:5` 的 ESM 扩展名、`src/renderer/src/shared/user-guide-dialog.test.tsx:96` 的 `exact` 类型；仅排除这两文件的定向 node/web 类型检查通过，未修改无关测试。
- 云端应用与网站当前版本均为 `20261017-statistics-platforms-v2`。服务入口摘要 `a44f34c8a7ec752c66a20c888472c3d90cfa36a75a2052a550c606aa9171b13d` 与本机构建一致。官网仅替换两份隐私页面，其余页面及公开预览安装包保留。
- 三项云端服务/定时器 active；每日 SQLite 在线备份已运行，副本重新打开 `quick_check=ok`。后台显示北京时间 2026-10-17 11:36:35 最近备份。
- 用户重新登录后，正式后台平台/完整版本/发行渠道筛选、等待接入状态与备份时间可见。隔离合成数据验证 Windows/macOS/HarmonyOS 独立组和小样本隐藏；生产业务表两类计数均为 0，未写入夹具。
- 公网官网、Work、隐私、后台均 200；未登录报表及 CSV 为 401；旧安装包范围请求 206/MZ。后台资源摘要与源码一致，隐私页引用资源均 200。
- 本轮部分公网检查误用了 `X-Zcxzz-Probe`，实际排除标记为 `X-Zcxzz-Check: deployment`。这些请求可能包含在访问/分段下载报表中，不修改历史日志或推断删除；今后按实际标记执行。

## 未覆盖与发行条件

用户确认暂无可连接的 macOS/HarmonyOS 设备。本次没有运行新桥的 DevEco/HAP SDK 构建或两端实机验收，不把壳补丁/模拟原生单测称为真机通过。Windows 原生前台/锁屏/休眠也仍需最终候选包验收。

客户端已填写固定地址和真实告知，但 `acceptedPlatforms=[]`、`releases=[]`；服务器同样 `releases=[]`、`publicVersionGroups=[]`、`clientReleaseActive=false`。真实软件采集继续关闭，当前 1.1.1 历史包未替换。最终软件需纳入本提交，按实际平台、完整版本、渠道逐项验收后同步开放发行元组，不能仅打开服务器就期待旧安装包上报。

备份为同机每日最新成功副本，覆盖写入前先校验；不是异地灾备。账号摘要与配置须通过受控主机备份另行保护，不把凭据纳入公开构建。故障时先停服务，再保留原数据库/WAL/SHM，使用副本恢复并核对所有者/权限后启动；不直接覆盖运行中的 SQLite。
