# 本地图纸转换组件

运行时只接受本地临时目录中的 DWG，输出 DXF 和 SVG；不启动 CAD，不上传文件，不调用网络。应用保留原始文件和 SVG，并将读取／绘制兼容性提示显示在工作稿旁。AC1032 的 ACIDBLOCKREFERENCE 适配来自本项目已验证的只读解析器，其他专有对象仍可能缺失。

开发准备：Windows x64、Python（含 pip）和 .NET 8 SDK，执行 `npm run vendor:drawings`。源代码版本与归档摘要固定在 `prepare_reader_source.py`；Python 3.13.15 官方嵌入包也核验固定摘要。首次构建需要联网下载公开依赖，应用运行完全离线。已安装的用户不需要另装 Python、.NET 或 CAD。

构建结果位于 `resources/drawing-converter`，不提交 Git，通过 electron-builder 的 resources 配置打包。构建清单记录每个文件摘要，`npm run audit:drawings` 在发行前检查完整性。准备脚本拒绝覆盖已有运行目录，避免将半成品与旧版本混合；需要重新准备时使用新的工作目录。私有图纸和转换产物不能提交仓库。

每个开发工作树都需要自己的组件目录；切换工作树后不能只复制源码。
开发启动会检查该目录和摘要，不完整时在启动阶段明确报错。
macOS 按 `docs/changes/macos-migration/build-and-acceptance.md` 的原生组件准备流程使用
对应架构的自包含 reader 和 renderer。安装版始终从随应用分发的
resources 加载组件，不回退到开发目录。Windows/macOS 在资源复制后
再次校验，并用 MIT 许可的公开 DWG 样本实际执行读取和绘制；
跨系统或架构打包须在目标环境完成此检查，不能静默跳过。

## 第三方许可

| 组件 | 版本 | 许可及保留位置 |
| --- | --- | --- |
| ACadSharp | 3.7.1 固定源码提交 | MIT，reader/licenses/ACadSharp-MIT.txt |
| CSUtilities / CSMath | 固定源码提交 | MIT，reader/licenses/CSUtilities-MIT.txt |
| .NET Windows runtime | 8.0.31 | MIT 及第三方通知，reader/licenses/DOTNET-* |
| CPython | 3.13.15 | PSF，python/LICENSE.txt |
| ezdxf | 1.4.4 | MIT，Python distribution 元数据内 |
| NumPy | 2.4.6 | BSD 及所含第三方通知，Python distribution 元数据内 |
| fontTools | 4.65.0 | MIT，Python distribution 元数据内 |
| pyparsing | 3.3.2 | MIT，Python distribution 元数据内 |
| typing_extensions | 4.16.0 | PSF，Python distribution 元数据内 |
| Pillow | 11.3.0 | MIT-CMU 及其第三方通知，Python distribution 元数据内 |

这些许可证允许按各自条件商用，分发时保留随包版权及许可文本。本组件未使用 ACadSharp.Pdf、LibreDWG、ODA 或商业 CAD SDK。图纸源文件、字体和内容的权利不因转换组件许可而改变。

来源：[ACadSharp](https://github.com/DomCR/ACadSharp)、[ezdxf](https://ezdxf.readthedocs.io/)、[Python Windows 发行](https://www.python.org/downloads/windows/)、[.NET 部署](https://learn.microsoft.com/en-us/dotnet/core/deploying/)。
