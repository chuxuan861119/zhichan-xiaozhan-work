# 鸿蒙关键依赖验证

基础诊断程序复用项目的 `LibraryDatabase` 和图片导入模块，检查运行时能力。新增适配实验及完整工作台启动检查仍使用独立应用标识和测试库，不读取正式文档库，不代表完整产品迁移或验收。

## 准备与运行

在仓库根目录执行，输出目录必须尚不存在，父目录须先准备好：

```sh
node tools/harmony-probe/prepare.mjs "$LAB_DIR/probe"
```

生成目录包含入口、打包后的两个源码模块以及依赖清单。Mac 基线可在生成目录中建立指向本仓库 `node_modules` 的链接；该链接只用于宿主机测试，不得放入鸿蒙应用包。鸿蒙运行需要另行准备目标平台适用的 `sharp` 原生模块及其底层库，不能复制 Mac/Windows 二进制冒充兼容。

无界面的 Node 基线：

```sh
node "$LAB_DIR/probe/main.cjs" --output "$LAB_DIR/node-result"
```

Mac Electron 基线以非激活方式启动，测试窗口始终隐藏：

```sh
env -u ELECTRON_RUN_AS_NODE open -g -n -a "$REPO_DIR/node_modules/electron/dist/Electron.app" --args "$LAB_DIR/probe/main.cjs" --output "$LAB_DIR/electron-result"
```

`open` 命令返回不代表验证结束。必须检查 `report.json` 存在 `finishedAt`，逐项读取 `checks`，并确认对应诊断进程退出。Node 模式不执行 PDF 或密钥存储测试。每次运行使用新目录；程序拒绝覆盖已有目录。所有输入均为程序生成的公开测试字符串、图片和临时数据库。

若某项导致原生进程退出，可用 `--only atomic-file` 或 `--only sharp-image-import,credential-storage` 隔离检查；合法名称见下方检查列表及 `main.cjs` 的 `checkNames`。未选项目明确记为 `not-run`。每项运行前持久化 `activeCheck`，完成后清空；报告缺少 `finishedAt` 时不得称为整轮完成，也不能把最后一个运行项直接认定为已通过。HAP 可在独立工程添加入口包装文件，将 `--only` 加入 `process.argv` 后加载 `ohos-entry.cjs`，完成隔离后恢复原入口。

鸿蒙包使用 `ohos-entry.cjs` 作为入口。它在应用自己的 `userData/dependency-probe-reports/<随机标识>` 下创建新报告目录，不依赖 HAP 启动参数；显式传入 `--output` 会被拒绝。报告的最终位置会输出到控制台。该入口已在隔离的 Mac Electron 及 API 26 鸿蒙电脑模拟器运行验证；模拟器报告可通过 `hdc file recv -b com.zhichan.harmonyprobe <日志中的完整沙箱路径>/report.json <本地新路径>` 取回。

## 鸿蒙工程组装与构建

专利标签与系统窗口三键共用一行时，构建前运行 `node tools/harmony-probe/patch-window-decoration.mjs <hap-project>`。当前 Electron 37 官方模板在隐藏标题栏时会将最大化、最小化、关闭权限全部置为 false；该脚本保留原权限，将三键区域高度设置为 38vp，并保留模板已有的三键区域变化回调。原生边框切换和权限更新接口也必须与三键显隐解耦；首个 Ability 默认权限为 false，应用主窗口通过 `initializeWindowControls` 显式开启。源码窗口配置使用隐藏标题栏与 overlay，页面继续使用标签栏拖动区域及右侧 138px 预留空间。脚本只接受已核对的模板锚点，遇到供应商模板变化会停止，不能直接跳过后继续发布。每个运行包都需要应用此适配，单独更新 JavaScript 不足以恢复按钮。

2026-10-03 在 API 26 PC 模拟器通过设备端 UI 输入验证：系统三键与专利标签共用一行；双击标签栏空白处最大化、点击最大化按钮还原；拖动后按钮区域从 `[2683,128]` 移至 `[2613,178]`；最小化后窗口消失，再启动可恢复；关闭按钮使窗口退出。33 项窗口单元测试及 3 项模板转换测试通过。该运行检查使用专利库页面及测试数据，未覆盖未保存正文的关闭确认、真机窗口行为和更多屏幕缩放比例。

已验证官方 `v37.2.3.20260917.1-release.zip` 内的 `libelectron/ohos_hap` 可用本机 DevEco 26 工具生成未签名 HAP。复现时使用仓库外的新目录：

1. 解压官方运行包，复制 `ohos_hap` 为独立测试工程，保留原始模板。
2. 运行上述 `prepare.mjs` 生成新的诊断目录。在生成目录运行 `npm install --ignore-scripts --omit=optional`，将生成的 `package.json` 的 `main` 改为 `ohos-entry.cjs`。这只装配 JavaScript 依赖；**该阶段没有 sharp 鸿蒙原生库，图片检查预期失败，不能据此宣称图片功能兼容或不兼容鸿蒙**。
3. 将生成目录内容复制进测试工程的 `web_engine/src/main/resources/resfile/resources/app/`，包括纯 JavaScript 的 `node_modules`。不得使用指向主仓库的模块软链接，不得携带 Mac/Windows 原生二进制。
4. 将测试工程的 `AppScope/app.json5` 中 `bundleName` 设为 `com.zhichan.harmonyprobe`，使用独立测试应用标识；正式产品的标识、数据及签名不参与本次验证。
5. 在测试工程运行官方 `ohpm install --all`，然后设置 `DEVECO_SDK_HOME` 为 DevEco 的 `Contents/sdk`、`JAVA_HOME` 为内置 `Contents/jbr/Contents/Home`，运行官方 `hvigorw --mode module -p product=default -p module=electron@default assembleHap --no-daemon`。遇到 `socks5h:` 不支持时，仅为本次命令移除代理环境变量，保持 TLS 证书验证开启。
6. 输出为 `electron/build/default/outputs/default/electron-default-unsigned.hap`。这是未签名的依赖诊断包；补齐适用的测试签名、电脑模拟器或真机后，再安装和运行，并通过 hdc 取回报告。

本次实际产物使用 SDK `26.0.0.23 Beta1`，最低 API 20、目标 API 26。最低版本声明不代表已在 HarmonyOS 6 设备上通过。模板原有 ArkTS/资源警告及权限申请仍需在安装阶段核实。实际运行前后均须核对报告的 `process.platform`、Node/Electron 版本，构建成功不能替代鸿蒙运行验证。

## 检查内容与边界

- 数据库：调用真实 `LibraryDatabase`，检查事务提交/回滚、WAL、FULL 同步、备份、检查点、只读重开与完整性。
- Worker：独立线程中调用 SQLite，并确认线程正常退出。
- 文件：使用项目依赖 `write-file-atomic` 检查中文文件名和内容替换。
- 图片：SVG 栅格化、真实图片导入函数、原图字节保留、旋转和缩放。
- PDF：隐藏且隔离的 Electron 窗口生成中文表格样例；仅检查生成接口、PDF 文件头和基本大小，不自动证明字体、分页或实际打印正确。
- 密钥：用虚构值检查加解密，不读取已有密钥；未覆盖跨进程重启后的解密。

`evidence=host-baseline-only` 表示宿主机基线；实际鸿蒙运行包返回的平台名为 `openharmony`，与 `ohos` 一并识别为 `harmony-runtime`。仍须结合实际连接的设备确认模拟器或真机，不能仅凭平台字段证明真机验证。缺失依赖记为失败，未执行的检查记为 `not-run`；部分通过不代表全部通过。真机、打印机、崩溃恢复、DWG、PATDOC/DOCX 双向交换、化学编辑器和版式视觉检查另行验收。

## 官方资料

- [Electron 鸿蒙化说明与版本](https://gitcode.com/CPF-Electron/Electron/blob/main/README.md)
- [鸿蒙打包工具与运行包下载入口](https://gitcode.com/CPF-Electron/Electron/blob/main/docs/upgrade/README.md)
- [电脑应用适配与模拟器、远程真机验证](https://developer.huawei.com/consumer/cn/multidevice/pc/adapt/)

## 适配实验（2026-10-02）

`compat-dependencies` 固定实验依赖及锁文件。将两个 JSON 文件复制到仓库外独立目录后执行 `npm ci --ignore-scripts --no-audit --no-fund`；不得替换主项目依赖。

实验包括：

- `atomic-exit.cjs`：只替换 write-file-atomic 的退出清理注册，不监听引发崩溃的原生信号。突发终止可能留下本次临时文件，不能将其视为自动恢复实现。
- `sqlite-adapted.cjs`：适配项目当前使用的 Node SQLite 子集，保持同步查询、事务、备份及安全整数检查。并非 Node SQLite 全 API 实现；新用法需要增加对应契约测试。
- `sharp-adapted.cjs`：sharp WASM 处理图片；SVG 文字先通过 resvg WASM 与项目自带字体转为轮廓，避免无报错的文字丢失。仍需完整字体、图形与性能验收。

`prepare-compat.mjs <probe-app>` 生成适配后的实际业务模块及实验入口，只接受名为 `zhichan-harmony-dependency-probe` 的目录。随后将实验依赖的纯 JavaScript/WASM 资源放入该目录：sharp、@img/sharp-wasm32、@img/colour 及其实际依赖、@emnapi、@tybys、tslib、@resvg/resvg-wasm、better-sqlite3 的 lib/package.json/LICENSE。宿主平台原生预编译文件只能用于独立宿主测试目录。

SQLite 原生扩展构建：

```sh
node tools/harmony-probe/build-sqlite.mjs \
  "$SDK_NATIVE" "$COMPAT_NODE_MODULES" "$NODE_HEADERS" "$ELECTRON_SHIM" "$NEW_NATIVE_OUTPUT"
```

已验证输入：DevEco API 26 native SDK、better-sqlite3 13.0.3、Electron 37.2.0 的 `node_headers/include/node`，以及官方扩展指南的 `libshim.a`。构建脚本校验 shim SHA-256，输出目录必须不存在。使用隐藏 NAPI 符号和静态 C++ 运行库，避免误绑定 Ark NAPI 或缺少 libc++_shared.so。产物 `better_sqlite3.node` 放入 HAP 的 `electron/libs/arm64-v8a/`，运行时从 `/data/storage/el1/bundle/libs/arm64/` 加载。

- [Electron 37.2.0 头文件](https://artifacts.electronjs.org/headers/dist/v37.2.0/node-v37.2.0-headers.tar.gz)
- [官方 SQLite 扩展指南及 shim](https://gitcode.com/CPF-Electron/Electron/blob/main/docs/electron-loading-addon-guide/README.md)

`compat-main.cjs` 是适配检查入口。先用带内置 SQLite 的宿主 Node 执行 `node tools/harmony-probe/prepare-exchange.mjs "$NEW_FIXTURE_DIR"`，再将该目录的 `host-exchange.sqlite3` 复制到 probe-app 根目录。脚本使用项目当前 V14 schema，仅写虚构专利，拒绝覆盖已有目录。报告逐次使用 UUID，返回数据库需用宿主 Node SQLite 再次读取和完整性检查。

`atomic-interruption.cjs` 连续启动三次，分别在 rename 前、rename 后主动中止进程，最后逐字节核对旧/新文件。它只操作 `atomic-interruption-v1` 沙箱测试目录；不是掉电试验。重复完整试验须使用新的实验目录名，不删除既有证据。

宿主契约测试使用 `vitest.config.mts`，设置 `HARMONY_PROBE_APP` 指向准备好的独立宿主实验目录（含该平台 better-sqlite3 原生组件），设置 `TMPDIR` 为非符号链接的独立目录。此结果只证明适配 API 与业务测试兼容，不替代鸿蒙运行。

`prepare-workbench.mjs <source-snapshot> <electron-vite-output> <probe-app>` 组装完整工作台启动检查，要求先对明确提交的独立源码快照执行 electron-vite 构建。它仅转换测试包中的依赖和搜索线程入口；正式源码不受影响。源码转换锚点必须各出现一次，否则拒绝构建。`workbench-smoke.cjs` 启用已有测试开关和托盘启动参数，窗口隐藏、测试库隔离，记录界面加载及真实 IPC 文档库读取结果。图片适配初始化完成前不进入业务启动，但协议注册必须保持同步。

`workbench-flow.cjs` 经真实预加载桥执行新建/正文保存、重开、正文搜索及三种导出。第一轮创建固定名称的虚构专利，后续启动复用它验证正文持久化；重复新建试验应换用新的诊断数据目录。导出对话框仅在测试中替换为本次随机沙箱目录，原生选择框、鼠标键盘输入、打印机均未据此验收。报告要求有 `finishedAt`、无错误且包含预期业务结果；产物须取回再校验。报告固定路径会更新，下一轮前应将已有报告取回另存。

用户请求手动体验时，可在源码快照根目录放置 `harmony-source.json`（记录该快照的完整 `commit`），再给 `prepare-workbench.mjs` 增加第四个参数 `--interactive`。此模式使用 `workbench-interactive.cjs`：显示主窗口、使用真实文件对话框，不执行自动业务流程、不定时退出。独立数据目录为应用沙箱的 `workbench-interactive-v1`，与自动诊断隔离；下次启动保留试用数据。启动报告 `startup-report.json` 记录源码来源、窗口可见性、原生句柄及错误。只在用户明确请求可交互实例时使用此模式；没有 `readyAt`、非零句柄与可见界面证据时不能宣称启动成功。原生文件选择及完整功能仍由实际测试确认。

当前 Mac 宿主上的 API 26 PC 模拟器显示窗口时曾持续白屏，日志反复出现 GPU context lost / GPU process restart；虽然 DOM 已加载且窗口标记可见，实际屏幕仍为空白。因此人工体验入口在 app ready 前禁用硬件加速，限定使用软件渲染。该设置仅供本模拟器体验，不能代表真机最优配置或真实性能；启动验收还必须查看设备截图，不能只读 DOM/visible 标志。[Electron API 说明](https://www.electronjs.org/docs/latest/api/app#appdisablehardwareacceleration)。

鸿蒙 Electron 37.2.3 的调试截图不要使用 Playwright `page.screenshot()` / CDP `Page.captureScreenshot`：该路径请求显示唤醒锁，当前运行库的 `power_save_blocker_ohos.cc:47` 会触发原生致命断言。已有崩溃文件的 build ID 与随包的未剥离符号一致，可据此符号化核对。通过隔离测试包的主进程桥调用 `safe-page-capture.cjs`，明确使用 `capturePage(rect, { stayHidden: true, stayAwake: false })`；保存返回图片并确认非空、进程存活和窗口状态。该接口在 [Electron 37.2.3 文档](https://github.com/electron/electron/blob/v37.2.3/docs/api/browser-window.md#wincapturepagerect-opts) 中有定义。必要时用设备 `snapshot_display` 交叉检查实际显示，不在失败后重试危险 CDP 路径。此适配解决测试取证方式，不代表上游原生唤醒锁实现已修复；正式应用未使用此调试截图入口。

第三方资源沿用各自许可证：write-file-atomic ISC、better-sqlite3 MIT/SQLite public domain、sharp Apache-2.0、resvg-wasm MPL-2.0、思源宋体 OFL；sharp WASM 内含多项 LGPLv3 组件，完整清单见安装包 README/LICENSE。正式分发前须纳入第三方声明和相应源码/重链接材料，诊断通过不代表发布许可工作已完成。
