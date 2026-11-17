# 1.1.8 源码构建

本指南针对本仓库独立公开的 1.1.8。请先阅读 [公开范围](OPEN_SOURCE_RELEASE.md) 和 [使用手册](user-guide.md)。官网当前安装包可能包含更新功能，不是本次源码构建的验收依据。

## Windows 开发环境

- Windows 10 / 11 x64；建议使用 Node.js 24，package.json 要求至少 22.12.0。
- npm、Git、Python（带 pip），.NET 8 SDK。
- Rust stable、Cargo、MSVC C++ Build Tools 和 Windows SDK，用于 CAD 内核。
- CAD WASM 构建会准备 wasm32-unknown-unknown 和固定的 wasm-bindgen-cli 0.2.108。

首次准备需要网络下载锁定的公开依赖。安装版运行时无需用户另装 Python、.NET 或 CAD。macOS 与 HarmonyOS 的构建工具不同，见下文。

## 获取与安装依赖

```powershell
git clone https://github.com/chuxuan861119/zhichan-xiaozhan-work.git
cd zhichan-xiaozhan-work
git checkout v1.1.8
npm ci
node node_modules/electron/install.js
```

依赖版本以 package-lock.json 为准。上面的 install.js 准备 Electron 运行时，供开发启动和许可审计使用；已下载时可复用缓存。请不要为了消除 peer dependency 提示直接升级依赖；本版本的化学结构组件存在 React peer 范围提示，应结合实际验证判断。

## 准备本地组件

```powershell
npm run vendor:cad
npm run vendor:drawings
```

CAD 来源固定在 scripts/build-cadcraft.mjs、scripts/build-cadcraft.ps1 和配套补丁中。绘图转换器的来源、版本和摘要固定在 tools/drawing-converter 的准备脚本中。准备结果分别位于 resources/cadcraft 与 resources/drawing-converter，属于生成物，不提交仓库。

对应说明：[CAD bridge](../tools/cadcraft-bridge/README.md)、[绘图转换器](../tools/drawing-converter/README.md)。draw.io 运行资源已经随仓库提供；需更新时使用 npm run vendor:drawio，并执行对应审计。变更第三方组件后必须同步来源和许可材料。

绘图转换器准备脚本拒绝覆盖现有资源目录。首次准备失败留下半成品时，先核对其确为本次构建生成的目录，再使用新的工作目录重建。

若从 PowerShell 7 或其他工具启动 Windows PowerShell 时出现 Get-FileHash 不可用，先检查子进程是否误加载了不兼容的模块路径。可在当前构建终端设置，不修改系统环境：

```powershell
$env:PSModulePath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\Modules;$env:ProgramFiles\WindowsPowerShell\Modules"
npm run vendor:cad
```

## 检查、构建和启动

```powershell
npm run verify:source-release
npm run typecheck
npm run test:unit
npm run build:app
npm run dev
```

typecheck 与完整 CAD 测试需要先准备 CAD WASM。dev 还会核验本工作目录的 CAD 和绘图转换器资源，缺失时明确报错；不能仅运行 npm ci 后跳过组件准备。

build:app 生成 out/main、out/preload、out/renderer 及 CLI；它不安装软件、不替换官网包。开发启动会使用本机数据目录，建议通过测试数据和独立用户数据目录进行验收，勿直接操作正式业务文稿。

## 安装包与发行渠道

仓库保留了基线的 dist:win、dist:mac 等发行脚本。它们包含原官方发行的组件审计、签名和源码分发校验，不等同于通用的一键发布流程。

自行分发二进制时，除应用源码外，还需满足第三方组件的对应源码、声明及动态库替换等要求。原 build/open-source-distribution.cjs 会验证官方源码托管地址；自行改变组件后，该地址不会自动提供你的新材料，须为自己的发行配置对应源码托管及校验流程，不能把旧官网地址当作自有构建的源码证明。请勿仅关闭这些检查后分发。

本次 GitHub 发布是源码发布，不新增或替换官网二进制。完整构建材料与独立发行校验的改造，应针对具体发行目标另行完成。

## 更新与匿名统计

为区分源码自行构建与官网官方发行，本仓库默认：

- resources/update-channel.json 的 feedUrl 为空，不消费官方二进制更新源。
- resources/usage-statistics-channel.json 的 endpoint、acceptedPlatforms、releases 为空，不向官网生产统计汇入自行构建数据。
- 版本检测、统计客户端和匿名统计接收实现仍保留，可供研究或自行部署。

配置自有服务前，应更新主体、接收方、地域、保存期限和告知版本，并验证用户选择、TLS、发行分组及补发去重等行为。不要以其他发行主体继续使用官方服务披露。

## 其他平台

- macOS：阅读 [对应构建说明](changes/macos-migration/build-and-acceptance.md)。原生依赖与目标架构、签名、系统权限需在 macOS 上验证，不能通过 Windows 构建代替。
- HarmonyOS：阅读 [平台说明](../platforms/harmony/README.md)，使用相应工具链与设备完成验证。官方签名材料不在仓库中。

具体平台范围和本次实测结果见 [验证记录](releases/1.1.8-open-source.md)。
