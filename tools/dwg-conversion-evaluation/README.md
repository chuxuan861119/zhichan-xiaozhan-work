# DWG 转换路线实测

开发验证工具，不接入正式应用，不添加生产依赖。所有转换均本地执行；下载依赖属于开发准备阶段。

## 固定环境与运行

- Windows x64、.NET SDK 8.0.425 / net8.0。
- ACadSharp 3.7.1（官方 NuGet；源码 d7dc111023477d8a9fffc2153139459c95b4f345）。
- ACadSharp.Pdf 0.1.5-beta（官方 NuGet；源码 1c053e2de431489b38000ccce1f875bef97e234f）。
- Python 3.11、ezdxf 1.4.4；Python 依赖见 requirements.txt，NuGet 依赖见 packages.lock.json。

在工作树根目录执行；将示例输入替换为本地图纸，输出目录必须尚不存在：

```powershell
dotnet restore tools/dwg-conversion-evaluation/ConversionProbe.csproj --locked-mode
dotnet build tools/dwg-conversion-evaluation/ConversionProbe.csproj --no-restore
python -m venv out-conversion-python
./out-conversion-python/Scripts/python.exe -m pip install -r tools/dwg-conversion-evaluation/requirements.txt
dotnet tools/dwg-conversion-evaluation/bin/Debug/net8.0/ConversionProbe.dll 'C:/test/example.dwg' out-results/official
./out-conversion-python/Scripts/python.exe tools/dwg-conversion-evaluation/render_svg.py out-results/official/drawing.dxf out-results/svg
pdfinfo out-results/official/direct.pdf
pdftoppm -scale-to 2400 -singlefile -png out-results/official/direct.pdf out-results/official/direct
```

读取器保留未知图形诊断；分别尝试 PDF 和 DXF 输出，并保存各阶段告警及耗时。源文件只读锁保持到比较前后摘要结束；第三方读取器使用独立内存流。输出路径防覆盖。程序返回成功仅表示转换调用完成及原文件未变，不表示图形保真通过。必须检查 `reader-report.json`、SVG 的 `render-report.json`、PDF 渲染标准错误与实际画面。

私有 DWG、DXF、SVG、PDF、截图及完整诊断只能保存在忽略目录 `out-*` 中，不能加入 Git。程序异常可能留下失败产物，不自动删除。工具没有生产级输入大小限制、取消或进程隔离，不能直接当作正式导入服务。

## 已有适配补丁对照

本轮只对照已有提交 `7057e090` 的只读恢复器，没有复制其他任务的未提交修改，也没有将该恢复器并入本工具或正式应用。该提交属于独立 CAD 只读试验的历史；重现实验需要本地保留该提交。

```powershell
New-Item -ItemType Directory out-adapted-snapshot
git archive 7057e090 tools/cad-readonly | tar -xf - -C out-adapted-snapshot
python out-adapted-snapshot/tools/cad-readonly/prepare_reader_source.py
dotnet build out-adapted-snapshot/tools/cad-readonly/reader/CadReader.csproj
dotnet out-adapted-snapshot/tools/cad-readonly/reader/bin/Debug/net8.0/CadReader.dll 'C:/test/example.dwg' out-results/adapted-reader
./out-conversion-python/Scripts/python.exe tools/dwg-conversion-evaluation/render_svg.py out-results/adapted-reader/drawing.dxf out-results/adapted-svg
```

`prepare_reader_source.py` 可通过 `--archives` 使用本地缓存的固定源码包；本轮采用此方式。补丁针对 AC1032 的 `ACIDBLOCKREFERENCE` 基本 INSERT 引用，只恢复显示几何，不表示支持完整对象语义或 DWG 写回。

## 许可证核对范围

- 本轮所用 ACadSharp、ACadSharp.Pdf、ezdxf 核心许可为 MIT。
- ACadSharp.Pdf 的传递依赖 Svg 3.4.7 是 MS-PL，并非整个依赖树均为 MIT；ExCSS 4.2.3 为 MIT，另含 Microsoft System.Drawing 等依赖。
- MS-PL 不等于禁止商用，仍需按实际分发方式履行声明及源代码分发条件。这里仅记录包元数据，没有完成商业安装包的完整许可审计。
- Poppler 和 sharp 仅用于本地试验结果渲染，未添加到产品依赖中；没有使用 PyMuPDF 后端或引入 GPL DWG 转换器。

实测结果、通过项和失败边界见 `../../docs/changes/dwg-conversion-evaluation/acceptance.md`。
