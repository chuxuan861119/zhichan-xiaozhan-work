# Mac 构建与迁移验收

日期：2026-10-02。本次采用共享源码、按平台构建原生组件；没有增加 Mac 专用的文档格式或独立业务分支。

## 开发与构建

使用目标架构的 Mac、Node/npm、.NET 8 SDK、原生 Python 3.12、macOS SDK/Command Line Tools。当前验证架构为 arm64；Intel 构建必须在 x64 环境重新生成 CAD/Python 和文件组件。禁止把另一架构的 resources 目录直接混入安装包。

1. 正常安装项目依赖。打包工作树需要真实的本地 node_modules；外部目录符号链接会使 electron-builder 的依赖收集遗漏传递依赖。不要为打包改动其他工作树共用的依赖。
2. 建立 Python 构建环境，安装 `tools/drawing-converter/requirements-macos.txt` 中固定版本。
3. 运行 `python tools/drawing-converter/prepare_runtime.py --target osx-arm64 --python <构建Python> --dotnet <dotnet>`。Intel 使用 osx-x64。既有运行库不会被自动覆盖；重建时使用 `--output` 指定新的空目录，验证后再替换本平台构建材料。
4. 运行 `npm run vendor:mac-tools`。如系统默认 Xcode 尚未就绪，可将 DEVELOPER_DIR 指向已配置的 Command Line Tools；脚本通过 xcrun 查找 SDK。
5. `npm run verify:mac` 运行迁移相关测试。`PATENT_DWG_TEST_FILE` 可指定本地只读 DWG；未指定时，依赖真实 DWG 的单测会明确跳过。
6. `npm run dist:mac:local` 生成本机架构的本地验收 DMG/ZIP，使用临时签名，不做 Apple 公证。`npm run dist:mac` 是正式分发入口，要求 CSC_NAME、APPLE_KEYCHAIN_PROFILE，并执行全量构建检查；凭据仅置于环境/钥匙串。
7. 正式发布前，在对应架构上运行完整自动化和真机离线安装验证、Developer ID 签名/公证及 Gatekeeper 检查。当前全量测试仍有失败，不能把本地验收包作为正式发布合格证据。

应用用户无需安装 Python、.NET、编译器或其他 CAD 软件。最低系统版本设为 macOS 14.0；当前实际运行验证机器不是最低版本机器。

Windows 继续使用原来的运行库准备及 `dist:win`。任何共享业务修改同时进入 main；平台差异集中在运行组件选择、系统路径、菜单/快捷键、系统能力和打包层。发布产物各自构建、各自验收。

## 本次已经取得的证据

- 迁移验证入口：32 个测试文件通过，329 项通过；2 项按条件跳过（Windows 专属许可实包检查、未设置真实 DWG 的导入用例）。另外 9 项脚本检查通过。迁移提交的类型检查通过。合入并行设置动画提交后，其测试文件出现 5 处数组元素可能为空的类型错误；相关文件仍被其他任务修改，本次未改写。
- 实际 DWG 导入单独设置公开样本执行，5 项测试全部通过；另从已签名 `.app` 中调用 CAD 读取器和绘图器，连同快照测试共 31 项通过。
- 后台 Electron 验收：Finder 文件事件、Mac 原生菜单、字体样式加载、隐藏窗口状态和退出通过；PDF 打印预览通过。
- 后台业务链路 6 项通过：取消导入保留原工作稿、标注/裁切/插入/重开、DWG 原生导入、矢量底图片段移动、DWG 局部放大导出、中文 PATDOC 导出再导入。
- Mac 文件组件实际验证了并发竞争只有一个成功、已有目录/文件绝不覆盖、中文及换行路径；完整 CAD 工程备份恢复与迁移提交协调器测试通过。
- Mac 本地 `.app`、DMG 和 ZIP 已完成构建；应用临时签名通过 `codesign --verify --deep --strict`，原生 sharp/libvips 可从安装包加载。该证据不等同于正式 Developer ID 公证或另一台 Mac 的安装验收。
- Windows/Intel Mac 仅具备构建目标、对应清单和共用代码；本次没有在这两个环境上实际运行。

所有应用验证使用独立测试目录。后台 Electron 测试通过测试副本拦截显示、激活、最大化等动作，没有以可见自动化窗口替代后台验证。未重启用户原有实例。

## 公开 CAD 样本

使用固定 ACadSharp 源码提交 `d7dc111023477d8a9fffc2153139459c95b4f345` 中的 sample_AC1014、AC1015、AC1018、AC1021、AC1024、AC1027、AC1032，共 7 个版本文件；每份都生成 SVG，读取器未知实体数 0，DXF 审计错误 0。

这些样本每份都有 4 个绘制跳过对象：3 个 TOLERANCE 和 1 个 PDFUNDERLAY。这是当前渲染链路的已知能力边界，不能将其解释为图纸完整还原。Mac 保留原有告警，不静默掩盖缺图。

尚缺用户实际 DWG 和 Windows 对照产物；没有验证中文/SHX 字体、特殊对象、外部引用和两端打印分页的逐项一致性。历史文档的已保存 SVG/标注不会在另一端打开时自动重绘；新导入仍需要核对原图。

## 发布前待完成

- 全量测试曾得到 6482 通过、163 失败、42 跳过；其中 4 项为本次适配/测试材料问题，已修复并定向复验通过。剩余 159 项在原 main 的相同测试上复现（包括 DOCX Windows 路径夹具、旧恢复夹具、界面/模板断言），需要单独核查并达到发行检查要求。未重跑整个全量套件，不将修复后的推算数当作全量通过结果。
- Windows x64、Intel Mac、macOS 14 实机回归；同一 PATDOC/CAD 工程在两端互开。
- Developer ID 签名、公证和离线 Gatekeeper 验收；实际 Finder 双击文件关联、登录项、桌面入口、系统打印机与实体打印机验证。
- 真实 CAD 样本及一致字体条件下的两端视觉对照。正文使用 Mac 字体别名，保留存储中的 Windows 字体名称；不保证系统字体替代后分页逐像素相同。

上面的“通过”仅限列出的代码/环境/行为，正式发行状态仍为待验收。

## 本地交付位置

任务工作树 `release/` 保存带构建时间和提交标识的 arm64 DMG/ZIP；`release/mac-arm64/知产小栈Work.app` 是对应应用目录。当前 main 的同一源码可继续双端开发，资源目录中的本机 CAD 和原子文件组件是忽略的构建材料；其他机器须按上述步骤生成。运行中的旧实例未热更新或重启。

合并验收补充：迁移实现提交 `dcc3e12c`，随后合入并行的设置动画提交；main 上重新执行迁移专项测试。合并后的全量类型检查受 `tests/e2e/spatial-floating-motion.spec.ts` 的 5 项错误阻塞，所以标准 `dist:mac:local` 在类型门槛处停止。交付包使用相同打包配置和打包前后审计直接构建，属于本地功能验收包，不能视为标准发行流程全通过。main 中正在进行的其他任务修改及未跟踪目录均保留。
