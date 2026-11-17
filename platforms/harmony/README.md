# 鸿蒙电脑构建

Windows、Mac、鸿蒙共用根目录 `src` 和产品版本。Windows/Mac 原入口不变；鸿蒙使用本目录项目配置及启动入口，配合固定版本的官方壳工程。官方 Electron 的 ArkTS 壳和二进制不复制进 Git，由校验后的发布包在每次组装时取得。

每次组装应用仓库内 `patch-window-decoration.mjs` 的窗口按钮补丁，保留隐藏标题栏时的鸿蒙原生关闭/最小化/最大化能力；模板不匹配时停止，不忽略补丁失败。整库导入与恢复使用 SDK 交叉编译的 ARM64 NAPI 原子移动扩展，调用 renameat2(RENAME_NOREPLACE)，已有目标和不支持该能力时均失败并保留源数据，不降级为可覆盖移动。设置 `HARMONY_NATIVE_SDK` 可指定原生 SDK 路径；Mac 默认使用上述 DevEco 安装中的 native 目录。扩展在进程内调用，不使用鸿蒙运行库不兼容的子进程启动。构建从固定官方归档提取 NAPI 头文件及 shim，校验 shim 并确认扩展字节进入 HAP。

原生 SQLite 扩展保持已验收字节，不在 HAP 打包时剥离符号，包内校验可以直接与固定组件比对。

## 本地组件

构建机安装 Node/npm、Git、DevEco Studio（已验证 Mac、SDK 26 Beta1）。设置以下变量，值指向仓库外组件；可以保存在自己的终端配置中，不提交个人配置。

| 变量 | 输入及准备方式 |
| --- | --- |
| `HARMONY_ELECTRON_TAR` | 官方 `v37.2.3.20260917.1-release.zip` 内的 `libelectron_138.tar.gz`；来源和 ZIP/TAR 校验值见 `runtime-pins.json`。发行版本名与内核 Electron 37.2.0/Node 22.17.0 不同。SHA-256 用于固定复现，不替代发布方签名认证。 |
| `HARMONY_SQLITE_ADDON` | `tools/harmony-probe/build-sqlite.mjs` 交叉编译的 ARM64 `better_sqlite3.node`；版本、shim、编译指令见 `tools/harmony-probe/README.md`。脚本校验已复现产物哈希。 |
| `HARMONY_CAD_WASM_ROOT` | `tools/harmony-probe/cad-wasm/README.md` 所述离线运行目录；所有文件须与 `cad-runtime-pins.json` 一致，不能夹带客户图纸。 |
| `DEVECO_STUDIO_HOME` | DevEco 工具所在目录；Mac 默认 `/Applications/DevEco-Studio.app/Contents`。其他构建机需显式设置，尚未实测。 |
| `DEVECO_SDK_HOME` / `JAVA_HOME` | 需要使用其他 SDK/JBR 时设置；Mac 可使用 DevEco 自带组件。 |

JavaScript/WASM 依赖从已入库的 `tools/harmony-probe/compat-dependencies/package-lock.json` 重新执行 `npm ci --ignore-scripts --omit=optional`，保留版本和下载完整性校验。首次构建需要能访问 npm 与 ohpm；准备好缓存后可按包管理器配置离线构建。脚本不安装宿主机可选原生 sharp，也不把 Mac/Windows 原生扩展带入鸿蒙。

## 构建入口

新版 CAD 编辑与 DWG 转换使用同源 Rust 的专用 WASM Worker，不使用 Windows/Mac
原生子进程。准备固定的 Cadcraft 源码归档及 Rust `wasm32-unknown-unknown` 目标后，
运行 `node scripts/build-harmony-cadcraft.mjs`；`HARMONY_WASM_BINDGEN` 可指定
版本为 0.2.108 的 wasm-bindgen。该步骤同时重建浏览器编辑组件与独立转换组件。
首次准备仍需按 CAD 组件说明提供许可证和对应源代码。打包会检查生成清单和文件哈希，
缺失或不一致时停止，不复制宿主转换程序。WASM 运行仍需在目标系统验证。

```sh
npm run dist:harmony:local
```

本地模拟器使用软件渲染时：

```sh
npm run dist:harmony:local -- --emulator
```

每次构建输出到新的 `release/harmony/<构建标识>-<随机标识>/`。可用 `--output <新目录>` 指定仓库外位置；已有目录会被拒绝，不自动删除或覆盖。目录包含可在 DevEco 打开的 `project`、HAP、源码快照、`build-report.json` 和 `companion-sources`。失败会返回非零状态并保留现场。HAP 所用提交、版本、dirty 状态和校验值均记录在报告中；未提交源码不会冒充干净提交。

如需核对应用市场分发结构，可使用 `npm run dist:harmony:local -- --app`，生成未签名 APP，仅供本地校验，不可用于商店上传。正式入口自动组装签名 APP。报告的 `appPackage` 包含路径、大小、摘要和内嵌资源核验结果；校验拒绝身份或版本不符、额外模块、重复条目及资源内容不符的分发包。APP 组装会重打包 HAP，因此校验实际内嵌资源，不假定它与单独 HAP 的整包摘要相同。

普通本地包沿用 `com.zhichan.harmonyprobe` 和沙箱 `workbench-interactive-v1`，可在保存并退出旧体验应用后覆盖安装以保留库。**脚本只构建，不自动安装、卸载或重启。** 原生窗口装饰由共享源码控制；本地包的其他功能与三端共用 `src` 一同更新。

自动启动检查可增加 `--smoke`：应用标识改为 `com.zhichan.workbuildcheck`，使用独立测试库和隐藏窗口，在测试数据目录的 `Cache/harmony-diagnostics/harmony-startup.json` 留下结果后退出。它不读取旧体验库，也不证明手动交互、打印机和真机验收通过；如果平台原生启动阶段无法后台运行，应按项目共享控制规则取得授权后执行。

完整流程检查使用 `--emulator --acceptance`，仅本地入口接受该参数，并自动启用 smoke。
它通过正式 renderer bridge 操作合成测试数据，覆盖文字/公式/表格保存重开、CAD、
图片、流程图、PATDOC/DOCX/PDF/专利包导出再导入、取消、搜索与加密备份。
普通阶段替换文件选择器，输出到独立沙箱；这不等于原生选择器或公开目录已通过。
每轮结果保存在 `Cache/harmony-diagnostics/acceptance-<UUID>/report.json`，最近一轮另写
`harmony-acceptance.json`；任一阶段失败会使启动检查记录错误。

可在此测试应用原始 files 根目录放置 `acceptance-control.json`，仅接受
`{"mode":"standard"}`、`{"mode":"restore"}` 或 `{"mode":"native"}`。
standard 使用 `workbench-buildcheck-v1`；restore 使用独立的 `workbench-restore-v3`，
从同一 files 根目录的 `acceptance-transfers/latest.json` 指向的合成备份执行错误密码、
取消、正式恢复及自动重启后验证。恢复目标已有数据时只做重开校验，绝不自动清空。
native 保留真实系统保存窗口，需在设备内完成选择；不要将隐藏主窗口误认为没有系统交互。
所有控制文件、固定测试密码和测试夹具仅用于本地验收包，正式包不携带这些测试脚本。

鸿蒙公开目录导出使用验证后的沙箱临时文件，再以禁止覆盖方式安装目标文件。
已有文件会提示更换文件名并保留原文件；不通过截断旧文件实现覆盖。
恢复清理对 Linux/鸿蒙祖先目录使用只获取路径身份的描述符，避免请求受限系统目录的
列举权限；待清理目录仍核验设备号、inode 和所有权，拒绝符号链接和未知目录。

## 正式发行

```sh
npm run dist:harmony
```

正式入口要求干净 Git 源码，执行原有完整构建门禁，并要求：

- `HARMONY_RELEASE_BUNDLE_NAME`：已确定的正式应用标识，不允许使用体验/自动验收标识。
- `HARMONY_SIGNING_CONFIG`：仓库外 JSON 文件，格式为 DevEco 的单个 `signingConfigs` 对象（`name`、`type`、`material`）。证书、私钥、密码均不得入库。路径和权限按 DevEco 签名要求配置。
- `HARMONY_ELECTRON_NOTICES`：官方运行库及其依赖的完整版权/许可材料文件。当前所取得运行压缩包未提供完整材料，正式分发前须向发布方确认，不能用 npm/Electron 宿主版本声明替代。
- `HARMONY_ACCEPTANCE_REPORT`：仓库外真机验收 JSON。记录 `sourceCommit`、`runtimeRelease`、`bundleName`、`testedAt`、`systemVersion`，以及 `physicalDevice: true`、`stableSystem: true`。每个 `scripts/harmony-build.mjs` 中的 `HARMONY_DEVICE_CHECKS` 项目须在 `checks` 中有 `status: "passed"` 和非空 `evidence` 记录路径或引用。开发测试签名可先在 DevEco 工程中生成；正式分发须绑定同一源码和运行库的稳定版真机证据。报告不得含设备序列号、密钥或客户文档。

缺少以上材料、门禁失败或没有实际生成并核验签名 HAP 和 APP 时，正式入口失败；不会以未签名包替代。正式权限/ACL仍须完成分发方审核。组装时移除未使用的定位、录音、摄像头、传感器、蓝牙、屏幕录制、浏览器扩展和跨设备同步权限；文件、剪贴板的使用场景对应实际 EntryAbility。

鸿蒙开机启动由系统设置管理，应用展示实际状态；本地测试实例不能注册启动项。用户通过系统文件管理器打开 PATDOC 时，冷启动和已运行实例均复用共享导入校验。原生选择器完成文件授权后才返回成功；重启时逐项恢复既有授权，失效位置需重新选择。框架日志的消息内容使用系统私密字段，避免默认公开文件路径或剪贴板内容。

思源宋体原始文件、完整 OFL 1.1 和版权声明同时进入 HAP。系统字体仅本机引用。对应源码归档位于 `companion-sources`；本地空间优化不免除正式分发时附带对应源码/履行许可要求。

## 同时开发三端

共同功能修改 `src`；平台差异通过集中适配边界处理。分别运行 `dist:win`、`dist:mac`/`dist:mac:local`、`dist:harmony`/`dist:harmony:local`，记录同一源码提交并在相应系统验收。鸿蒙运行包、SQLite 或 CAD 固定组件升级时，须重新构建、验收后更新 pins；不要直接改哈希绕过失败。

## 使用统计的原生状态桥

`arkts/WorkbenchUsageActivity.ets` 在组装时通过固定 `Workbench.ReadUsageActivity` 绑定接入，读取 `power.isActive()` 和公开 `screenLock.isScreenLocked()`，再结合自身窗口可见/焦点状态。该 Electron 运行库不以桌面端锁屏事件或空闲查询替代；异常、超时、锁定、迟到结果和关闭期间均不计时。查询失败也丢弃未确认的前一采样区间，宁可漏记，不把未知状态算成活动。

本次已验证绑定幂等与模拟原生调用，尚未用 DevEco SDK 编译新桥或连接设备验收。正式开放统计前需用最终 HAP 检查前台、最小化、隐藏、锁屏、休眠、原生模态窗口、弱网和次日上报，并将对应完整发行元组加入两侧白名单；当前配置保持关闭。详见 `docs/changes/unified-statistics/cross-platform.md`。
