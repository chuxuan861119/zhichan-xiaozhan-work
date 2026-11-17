# 鸿蒙关键依赖验证阶段记录

更新时间：2026-10-02。

## 范围与执行顺序

目标：在无鸿蒙电脑条件下准备工具和独立诊断程序，先建立 Mac 对照，再检查鸿蒙运行能力。保留现有 Windows 发布链和正式文档库；不直接迁移全部产品，不改变首版功能范围。

1. 检查已有工具，补充缺少的鸿蒙打包工具。
2. 确认官方 Electron 运行包、SDK、电脑模拟器镜像的配套版本。
3. 验证最小鸿蒙应用和源码模块探针。
4. 按 SQLite、图片、PDF 顺序处理运行失败；目标环境不具备时明确保留待验证，不凭宿主机结果确认鸿蒙支持。
5. 取得电脑后补真机、权限、字体、打印和异常恢复验收。

## 已核实环境与操作

- 宿主机：macOS ARM64。
- 复用已安装的 DevEco Studio 26.0.0.461，内置 SDK 26.0.0.23 Beta1、JBR 21.0.8、Hvigor 6.26.1。
- 独立目录安装 `@electron-ohos/electron-builder@26.8.5`，使用固定版本及独立锁文件，禁用安装脚本；CLI `--version` 已实际返回 26.8.5。未修改主项目依赖。
- 已安装 MateBook Pro ARM64 电脑镜像 HarmonyOS 7.0.0 Beta1，版本 7.0.0.23（SP41）、API 26，位置为 `/Users/huxiulong/Library/Huawei/Sdk/system-image/HarmonyOS-7.0.0-B1/pc_all_arm`。DevEco 安装向导明确显示安装完成。
- 用户已完成华为云登录并下载官方 `electron37-release` 分支的 `v37.2.3.20260917.1-release.zip`。ZIP 校验记录 SHA-256：`8ddac153018f6bdbd02ac65c832b03a380f69585b4d05068c11a6e5abab99e66`；此哈希用于复现标识，未与发布方签名/校验清单比对。
- 已在仓库外独立目录解压 296 个归档路径，保留原始下载与模板。包内含 ARM64 `libelectron.so`、`libadapter.so`、`libffmpeg.so` 和完整 `ohos_hap` 工程。
- 运行库静态字符串显示 Electron 37.2.0、Node 22.17.0 及 `node:sqlite` 模块标记；发布包版本 37.2.3 与上游内核标识不同。后续模拟器实测确认上述版本，但 `node:sqlite` 实际返回 `No such binding: sqlite`；字符串存在不能证明原生绑定可用。
- 浏览器控制在内置浏览器及 Chrome 多次超时，下载由用户完成；后续解压、依赖安装和命令行构建已执行。
- `ohpm` 首次因代理协议 `socks5h:` 不支持而失败；仅对当前命令移除代理环境变量后安装成功，未关闭 TLS 验证，未修改全局代理配置。
- 官方模板和接入诊断程序后的独立工程均通过 Hvigor 构建。使用 `ohpm`/`hvigorw` 直接构建；未运行会传入 `--strict_ssl false` 的已安装打包器流程。

## 实际验证

| 环境 | 检查结果 | 证据边界 |
| --- | --- | --- |
| Mac Node 24.15.0 | SQLite 文档库、SQLite Worker、原子保存、图片导入，共 4 项通过 | 非鸿蒙；PDF/密钥存储未执行 |
| Mac Electron 43.2.0 / Node 24.18.0 | 上述 4 项及隐藏窗口 PDF、虚构密钥加解密，共 6 项通过 | 非鸿蒙；PDF 为接口烟雾检查，未验收版式及打印 |
| Mac Electron，HAP 入口对照 | 沙箱报告入口运行结束，SQLite/Worker/原子保存/PDF/虚构密钥共 5 项通过；sharp 缺原生库，1 项明确失败 | 验证入口及缺依赖时的报告行为；非鸿蒙，不能替代图片兼容性验证 |
| Mac 上交叉构建 HAP | 官方原始模板及独立诊断包均 `BUILD SUCCESSFUL` | 构建阶段仅证明工具链能组装 ArkTS/资源/预编译运行库；安装及运行另行记录 |
| HarmonyOS 电脑模拟器 | HAP 安装成功，已执行分项检查，结果见下表 | API 26 Beta1 / ARM64；非真机，不能代表正式版系统与物理设备 |

探针直接打包并调用本项目的 `LibraryDatabase`、`importImage`。Mac PDF 检查记录 `visible=false`；后台诊断窗口不供用户人工验收。

2026-10-02 安装后补充：用户完成 DevEco 登录并接受 SDK 协议，约 2.56 GB 官方电脑镜像下载、解压安装成功。直接无窗口启动未获得此 Beta 镜像的登录状态；经用户授权显示模拟器后，从 DevEco 的“运行 → 选择设备 → MateBook Pro”选择设备并运行工程，成功开机并建立 `127.0.0.1:5555` 调试连接。设备返回系统 `OpenHarmony-7.0.0.23`、类型 `2in1`。初次启动应用因模拟器锁屏失败，用户手动解锁后成功启动。未签名 HAP 在此模拟器安装成功，不代表真机免签名或 ACL 申请通过。

独立工程打开后出现空 `targetSdkVersion`，已备份该工程配置并移除空字段，恢复模板的默认目标版本选择；重新构建 `BUILD SUCCESSFUL in 4 s 623 ms`。日志位于验证根目录的 `hap-probe-37-rebuild.log`。此项仅修改仓库外诊断工程。

验证程序首轮曾因 ESM 包装缺少 CommonJS 加载器而失败，已修复打包入口；首轮 Electron 诊断在关闭隐藏窗口后过早退出，已增加窗口全部关闭事件处理。后续完整报告记录了上述通过结果。两项均为探针问题，不据此判断产品或鸿蒙失败。

验证工具自身已通过 Node 语法检查、限定到本次工具目录的 Biome 检查及 diff 空白检查。故意缺少图片依赖时，报告将图片检查记为失败并保留 SQLite 独立通过结果；传入已存在的输出目录时拒绝执行，原报告 SHA-256 保持不变。

## 鸿蒙模拟器分项实测

运行时：`process.platform=openharmony`、ARM64、Electron 37.2.0、Node 22.17.0。第一份报告将该平台误标为 `host-baseline-only`，已保留原始报告并修正诊断程序识别；后续报告明确标为 `harmony-runtime`。新增 `--only` 分项运行及运行前 `activeCheck` 留痕，避免原生崩溃遮蔽其余检查。Mac 上单项/多项选择、非法名称拒绝、语法和 Biome 检查通过。

| 检查 | 实际结果 | 含义与限制 |
| --- | --- | --- |
| SQLite 文档库 | 失败：`ERR_INVALID_MODULE: No such binding: sqlite` | 当前预编译运行包缺少可用的内置 SQLite 绑定；需更换/补编运行时或验证数据库适配方案 |
| Worker 内 SQLite | 同样失败：缺 SQLite 绑定 | 不能据此认定普通 Worker 不支持 |
| 普通 Worker 最小对照 | 通过：线程返回 42 并正常退出 | 仅基础线程能力；化学编辑器、WASM 未验证 |
| 现有 `write-file-atomic` 保存 | 原生进程退出，未完成 | 单项复现；跟踪停在 `signal-exit` 注册 `SIGHUP`，独立 `process.on('SIGHUP', ...)` 也导致进程退出；未进入文件写入。需要平台适配，不能直接交付 |
| 底层文件保存最小对照 | 中文文件写入、fsync、close、rename、替换后读回通过 | 未验证崩溃恢复、掉电持久性、生产保存协议或目录同步 |
| sharp 图片导入 | 失败：不能加载 `openharmony-arm64` 原生模块 | 当前包缺 sharp/libvips 鸿蒙原生组件；尚不能判断补齐组件后的兼容性 |
| 隐藏窗口 PDF | 通过：生成 52,578 字节 PDF，`visible=false` | 接口、文件头和大小检查通过；字体、分页、版式和实际打印仍未验收 |
| safeStorage | 虚构值加密/解密通过 | 未验证跨重启持久性、真实凭据迁移或正式设备安全属性 |

原始证据均位于 `/Users/huxiulong/Developer/zhichan-harmony-lab-20261002`：`harmony-first-report.json`、`harmony-files-first-two-runs/dependency-probe-reports/bf39c91d-12c2-4e41-8f7d-7f32be75703e/report.json`、`harmony-image-credentials-report.json`、`harmony-pdf-result/report.json` 与 `sample.pdf`、`harmony-capability-detail-report.json`。保存崩溃的最小复现为 `capability-detail-repro.cjs`，相关运行日志为 `probe-harmony-first-launch.log`。缺少 `finishedAt` 的崩溃报告仅证明此前完成的检查和最后运行位置，不代表整轮通过。

## 原始依赖阶段的产物与限制

原始依赖阶段的独立诊断 HAP 位于 `/Users/huxiulong/Developer/zhichan-harmony-lab-20261002/hap-probe-37/electron/build/default/outputs/default/electron-default-unsigned.hap`，当时约 203 MiB。该阶段恢复完整入口后的构建日志为同一验证根目录的 `hap-probe-final-build.log`，构建通过且重新安装成功；未重复触发已确认的崩溃。当时包内含诊断入口、源码模块、纯 JavaScript 依赖及 ARM64 Electron 运行库，没有 `.node` 原生扩展。应用标识为 `com.zhichan.harmonyprobe`。此路径后来用于下述适配工作台构建，当前产物不再是原始探针。

产物元数据：编译 SDK `26.0.0.23 Beta1`，最低 API 20、目标 API 26。保留模板默认的目标版本选择，本次不据最低 API 声明承诺可在 HarmonyOS 6 上运行。构建保留了官方模板的 ArkTS/资源警告，签名明确跳过；安装所需权限及 ACL 尚待核实。

上述结果描述未适配的原始依赖。它们不能直接用于产品迁移交付；三个阻塞的后续适配结果见下节。真机测试签名、ACL、正式版系统及物理设备验证仍待准备；需要登录/许可/签名时由用户在官方界面操作，凭据不得写入仓库。

## 适配原型与实际工作台联调（2026-10-02 晚）

用户授权自主选择方案，以 Windows 的功能和体验作为验收基准。本阶段保留正式源码、主项目依赖及 Windows/Mac 发布链；适配只注入仓库外的诊断构建。新增脚本位于 `tools/harmony-probe`，依赖版本和锁文件单独保存。所有数据均为虚构样例，未读取正式文档库。

| 原阻塞 | 已执行的方案 | 实际验证及边界 |
| --- | --- | --- |
| 内置 SQLite 缺绑定 | better-sqlite3 13.0.3 + 官方 Electron NAPI shim；DevEco SDK 交叉编译 ARM64 扩展，适配项目使用的 Node SQLite API 子集 | 模拟器主线程/Worker、WAL/FULL、事务回滚、备份重开、实际 V14 schema/约束、安全整数检查通过；不是完整 Node SQLite API 替代 |
| signal-exit 导致保存前崩溃 | 仅替换退出监听，保留 write-file-atomic 的写入、fsync、rename 和串行队列 | 同步/异步、20 次排队写入、失败保留旧内容通过；rename 前主动中止后旧文件完整、rename 后主动中止后新文件完整；不等同掉电试验，突然终止可能遗留临时文件 |
| sharp 缺鸿蒙原生库 | sharp WASM；SVG 文字先由 resvg WASM 与项目自带思源宋体转轮廓 | 实际图片导入、旋转、缩放、公式及中英文 SVG 样例通过。未适配时 SVG 文字会静默丢失；已对比暗像素并查看中文和公式图片。完整字体、复杂图形、内存与性能仍待验收 |

最终依赖报告 `compat-v6-report.json` 的 7 项均通过且有 `finishedAt`。数据库往返：宿主原生 Node SQLite 创建 V14 库，鸿蒙修改并备份，取回后宿主原生读取修改内容且完整性检查通过，证据为 `exchange-return-verification.json`。这不是 Windows 真机验收。

扩展使用 Electron 37.2.0 头文件和官方指南 shim，shim SHA-256 为 `6c8b3134b858c505b1741fd182f921dd092774558addabc8848d71287edf5d52`；构建脚本拒绝其他 shim 及已存在的输出目录。静态链接 C++ 运行库并隐藏 NAPI 符号，修复最初缺少 `libc++_shared.so` 的失败。`build-sqlite.mjs` 已重新执行成功，ELF 动态依赖仅 `libc.so`，日志 `native-sqlite-repro.log`。实际设备所用扩展与脚本复现产物的 SHA-256 完全相同，均为 `b886248d236fb8de4450a250d9962ae21b4659e31b1de9e8fc0e0a2510260d7f`。数据库样例生成和工作台组装脚本也已重新执行成功。

### 真实工作台核心路径

使用明确提交 `9ac734e1bb70c971c7254e18d85827f54ddb9282` 的独立源码快照，执行 electron-vite 构建并组装到 HAP；未混入当时工作区改动。快照无 `.git`，原构建信息内的提交显示 unknown，准确来源另记于 `workbench-source.json`，不得把它表述为应用内已显示该 SHA。适配入口为 `workbench-smoke.cjs`，使用现有测试模式、隔离库和隐藏窗口。

- 鸿蒙实际加载工作台主界面、预加载桥及真实文档库 IPC，通过。
- 通过渲染层公开的 IPC 桥新建虚构发明专利、追加正文、保存、释放会话，通过。此项没有模拟鼠标键盘在编辑器内输入，编辑交互仍待验收。
- 进程退出后再次启动，原专利及正文仍存在；后台正文搜索命中，通过。
- 实际业务导出 PATDOC 6,778 字节、DOCX 17,712 字节、PDF 236,477 字节，通过。原生保存对话框由诊断脚本替换为固定沙箱路径，不能据此确认系统文件授权或选择框可用。
- PATDOC 取回后由桌面端原有读取器成功解析，保存正文存在；DOCX 的 `word/document.xml` 包含正文。没有在 Windows Word 内检查排版。
- PDF 共 5 页，逐页渲染查看，中文、标题、正文、页码可见，无明显遮挡或乱码；模板空白书册仍为空白。正文文本提取忽略自动插入的空白后匹配。不代表与 Windows 字体轮廓、分页或实际打印完全一致。

证据均在验证根目录：`workbench-build.log`、`workbench-smoke-report-02.json`、`workbench-flow-report-01.json`、`workbench-export-report-01.json`、`workbench-export-host-verification.json`、`workbench-pdf-verification.json`，以及 `workbench-export.patdoc/.docx/.pdf`。主窗口和打印窗口报告均为 `visible=false`，未抢占用户输入。

当前 HAP 含完整工作台资源、ARM64 SQLite 扩展及实验依赖，约 549 MB；已构建、安装并运行。构建日志 `hap-workbench-export-build.log`。这是未签名诊断产物，不能作为正式安装包分发。

### 回归结果

Mac 宿主使用适配层执行库、数据交换、PATDOC、草稿和恢复相关测试：857 通过、7 失败、15 跳过。7 个失败均位于 `data-import-recovery-service.test.ts`；使用未适配的原实现对照运行，同样 7 个失败，另 15 个通过。失败表现为预期 recovered/rolled-back，实际 manual-safe-recovery，未修改这些背景问题。日志为 `compat-storage-regression.log` 与 `storage-original-baseline.log`。这组回归不是全部通过，也不替代鸿蒙完整回归。

### 尚未完成的验收

仍需正式平台接入与打包、键盘/鼠标编辑和快捷键、多窗口/对话框、原生文件授权、完整 PATDOC/DOCX 双向业务流程、复杂图表/化学编辑器、CAD 离线转换、密钥跨重启、异常恢复与掉电、性能、大文件、Windows 输出对照、打印机及正式版系统真机验证。原有 CAD Windows 进程不能据本次结果称为鸿蒙可运行；不得静默关闭 CAD 或改为联网服务以冒充离线功能一致。

正式发行前还需完成第三方许可、WASM 所含 LGPL 组件的对应材料及签名/ACL。详细外部准备条件见 `docs/future-preparation-checklist.md`。本阶段结论是核心流程适配原型成立，尚未达到与 Windows 完整一致的交付标准。

## 人工体验实例（2026-10-03）

用户请求在模拟器手动测试。基于启动准备时最新 main 提交 `0fd6da42e4f007fdfe7aece3547dffecb647730b` 创建独立源码快照并构建；未包含同时进行的其他任务未提交改动。以 `workbench-interactive.cjs` 替换自动诊断入口，保留适配层。数据位于本应用沙箱 `workbench-interactive-v1`，不复用自动诊断库；恢复真实文件对话框，取消自动业务操作和定时退出，供用户持续手动测试。

首轮 DOM 已加载、原生句柄非零且 visible=true，但设备截图为白屏；设备日志持续出现 GPU context lost 和 GPU process restart，证明这些启动标志不能替代视觉证据。仅对本模拟器体验入口禁用硬件加速，重新构建安装后，设备截图确认专利库、菜单、新建按钮及恢复提示正常显示。该软件渲染配置不代表真机最优设置或性能结论。

实际构建通过、安装成功。启动报告 `interactive-startup-report-02.json` 记录 platform=openharmony、窗口标题“知产小栈Work · 鸿蒙体验版”、visible=true、nativeHandle=01000000、readyAt 且 errors 为空；设备截图为 `harmony-interactive-software.jpeg`，日志为 `interactive-build-0fd6da42.log` 和 `hap-interactive-software-build.log`，均在上述验证根目录。模拟器窗口已显示到用户前台，保留运行，不自行关闭或重启。

白屏实例启动失败且测试库为空，核对 bundle/PID 后仅停止该诊断应用；再次启动显示“文档恢复检查完成，未发现待恢复编辑”提示。用户尚未反馈本轮人工测试结果，不能称为人工验收通过。CAD、打印、系统文件选择等完整功能边界仍适用。

## 流程图与 CAD 故障修复（2026-10-03）

本节补充用户在上述人工实例反馈的实际故障，不把先前核心链路通过当作完整迁移完成。

### 根因及修复

1. 鸿蒙官方 Electron 安装后仍报告 `app.isPackaged=false`、`cwd=/`。流程图和 IPC 数据中心按开发路径查找资源，流程图 `adapter.html` 实际返回 404。新增集中资源布局判断；CAD 和第三方声明入口使用同一判断。
2. 本运行时逐次调用 `registerSchemesAsPrivileged` 后，后一次注册覆盖了前面协议的安全/fetch 属性。实际子进程只带 `patent-ipc` 的 secure/fetch scheme，早期页面 `isSecureContext=false`。四个协议现在一次性注册，保留各自权限定义。
3. CAD 转换器仅有 Windows/Mac 原生执行分支，鸿蒙在选择组件时直接拒绝。新增仅限 Harmony 的离线 WASM Worker：使用相同 ACadSharp 读取代码和 detail-reference 补丁、相同 ezdxf 绘图脚本。取消或超时终止独立 Worker，不转发原图到外部服务；保留原 DWG、SVG 底图、PNG 预览及原有对象缺失提醒。构建与资源校验入口见 `tools/harmony-probe/cad-wasm/README.md`。

### 已执行验证

- 回归：7 个测试文件、28 项通过、1 项需显式本地原图环境变量的原生转换测试跳过；覆盖协议资源、安全属性合并、Windows/Mac 组件选择、Harmony 导入分支、原始字节保留、取消、转换进程失败及无效结果。代码格式检查与 diff 检查通过。
- 整仓 Node 类型检查仍有背景错误，均在未修改的 `tests/e2e/dropdown-motion.spec.ts`、`formula-focus.spec.ts`、`spatial-floating-motion.spec.ts`；不能称全仓类型检查通过。
- 独立鸿蒙诊断应用加载真实 draw.io iframe，收到 ready；带中文节点的图完成 request-save，返回源 XML；request-export 返回包含该节点的 SVG。实际 app/diagram 页面均为安全上下文。`combined-ohos-02.json` 保存证据。
- 用户提供的 DWG 仅在本机与模拟器处理。WASM 读取和渲染在模拟器运行约 18 秒，SVG 3,009,821 字节，未报告跳过图元；与本地原转换器对照，图元计数、绘图范围一致。文字轮廓因字体回退而不同，不据此宣称视觉完全一致。
- 完整工作台的真实预加载 IPC 桥执行 CAD 导入、暂存、原图取回、预览取回，通过；PNG 预览 2000×1265，原图逐字节一致，报告 errors 为空、finishedAt 存在、主窗口 visible=false。证据 `full-cad-ohos-01.json`。这不替代用户点击系统文件选择框的验收。
- .NET WASM 读取器已按仓库新项目配置重新构建，0 错误、0 警告；Python/WASM 资源使用固定版本和 SHA-256 校验，组件只在仓库外构建，不提交客户图纸或二进制运行包。

以上证据位于前述本地验证根目录。测试应用 `com.zhichan.harmonyinvestigate` 与用户体验应用隔离。诊断包明确拒绝剪贴板请求，本轮未验收剪贴板。完整包更新时遇到模拟器可用安装空间不足，只移除本轮诊断应用，不卸载用户体验版。代码修复与用户当前运行实例更新是两个步骤，交付时须另核对实际版本。

### 字体方案（仅提案，未实施）

当前 Mac 渲染层和打印层才启用项目自带思源宋体映射；鸿蒙未命中该路径，缺少 SimSun 时发生系统回退。文档中存储的“宋体/SimSun”不能据此改写。

- 优先可落地方案：为鸿蒙屏幕与 PDF 同时接入自带思源宋体 CN；DOCX 和持久化文档仍保留宋体语义。可以获得稳定的宋体风格，但与 Windows SimSun 的字形、字宽、分页不完全相同，必须明示并对照样本。
- 若验收要求精确匹配 Windows：使用具有相应应用分发/嵌入授权的同一套宋体文件，统一屏幕和 PDF 渲染，再以 Windows 实机对照逐页分页、字形、换行、表格与打印。不能直接复制 Windows 字体进安装包；具体授权须由权利方许可范围确认。
- 全平台统一思源宋体能降低跨端差异，但会改变现有 Windows 外观，属于另一个需确认的产品选择，不在本次修复中实施。

依据：[Microsoft 字体使用与再分发说明](https://learn.microsoft.com/en-us/typography/fonts/font-faq)、[Adobe Source Han Serif 与 OFL 许可](https://github.com/adobe-fonts/source-han-serif)。本文未替用户取得字体分发授权；本次没有改正文默认字体或已有文档内容。CAD 内部字体回退仅用于转换图纸文字轮廓，与正文方案分开。

仍待：用户交互验收、复杂 CAD/字体保真、Windows 同图输出对照、正式版系统真机、性能与打印，以及新增 WASM 依赖的正式发行许可审计。不能将本次两项故障修复表述为全部迁移验收完成。

### 修复版体验包交付

用户确认“已保存并退出”后，以代码提交 `9b35bac3165974dd8053696e694c5a91bbaa692c` 的独立源码快照构建，electron-vite 与 HAP 构建通过。模拟器安装空间不足时，将不参与运行的 `sharp-libvips/sources` 源码归档移至同一宿主验证目录的 `interactive-9b35bac3-corresponding-sources`，许可证文本及运行组件保留在包内；此分离仅用于本地体验包，正式分发仍须交付对应源码材料。缩小后的 HAP 为 453,784,607 字节，保留数据的覆盖安装成功，没有卸载用户体验应用。

重新启动后，`interactive-startup-9b35bac3-01.json` 核对 source.commit 为上述提交，visible=true、nativeHandle=01000000、readyAt 存在、errors 为空；`interactive-fixed-9b35bac3.jpeg` 确认实际显示专利库，更新前的两项专利仍在。启动提示上次非正常退出，完整性检查已完成且未发现待恢复编辑；未据此声称完成全部故障恢复验收。保留实例供用户测试，不自行关闭。

最终包身份见 `interactive-hap-9b35bac3-compact.json`；包内不含用户 DWG 样本。新的读取器按可复现项目重新构建后，在宿主再次转换同一样本得到相同 SVG 大小和图元计数。WASM 与原生转换图的缩略图已并排检查，主要图形布局一致，字体轮廓差异仍保留为验收项。用户对更新后实际点击流程图、CAD 文件选择及编辑的验收尚待反馈。
