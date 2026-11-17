# 知产小栈Work Agent CLI 手册（协议 2）

Agent CLI 当前为实验功能。

本手册可交给有本地命令执行能力的 AI agent。CLI 在本机连接已运行的软件；不会启动软件或替用户扩大授权；AI 命令使用软件已配置的模型服务，其余现有命令在本机处理。软件设置中的“Agent CLI”默认关闭，授权随软件退出失效。具有用户完整文件权限的 agent 仍可能自行访问文件，CLI 的授权范围不是操作系统沙箱。

## 1. 启动与配对

Windows 安装包提供 `resources\cli\zxw.cmd`，附带 Node 运行时，用户无需安装 Node/npm。在 PowerShell 中用 `& "安装目录\resources\cli\zxw.cmd"` 调用，或自行把该目录加入 PATH。macOS 安装包入口为应用内的 `Contents/Resources/cli/zxw`，同样附带 Node 运行时；例如 `"/Applications/知产小栈Work.app/Contents/Resources/cli/zxw"`。开发构建入口为 `out/cli/zxw`。开发者也可运行 `npm run cli -- <命令>`。

先启动软件，在“设置 → Agent CLI”开启入口。

推荐点击“复制 Agent 接入指令”，连同任务要求一次发送给本机 Agent。指令包含本机 CLI 完整路径、配套手册读取命令、当前实例及连接目录，不需要配置 PATH、导出或另行发送手册。Agent 先执行 `manual --json` 阅读内置完整手册，再连接指定实例。

等待授权时，后台软件使用系统通知及 Dock／任务栏提醒，点击通知后打开中央授权弹窗。通知关闭、被系统屏蔽或未送达都不代表已授权；Agent 应明确提示用户切回软件处理。macOS 的 Electron 43 系统通知需要应用签名，未签名测试实例依靠 Dock 提醒。不要主动抢占其他应用的前台。

```sh
zxw instance list --json
zxw connect --instance <instanceId> --profile default --label 我的Agent --json
```

首次 connect 返回 pending，退出码 4，软件自动在窗口中央弹出授权请求，无需再进入设置。处理前其他软件界面和快捷操作被锁定，Esc 或点击外部不能跳过；用户可批准、拒绝或关闭软件。多个请求依次处理。用户一次选择专利范围：**完整权限 / 只读参考 / 无权限**；未选专利不可见。完整权限包含所有已开放的本专利操作，整书改写、删除正文、恢复历史和导出无需逐步批准。只读仅供读取和检查，不能准备修改、保存、同步、改变界面或导出。只有用户可调整范围，agent 不能自行扩权。

全局权限在同一弹窗的“全局设置授权”区域选择，可用“批量设置”一次选择全部无权限、全部只读或全部完整权限，再调整单项（不一致时显示自定义）：通用设置、默认模板、AI 模型配置、整库管理、独立文档。每项默认无权限，可授予只读或完整；专利完整权限不会隐含任何全局权限。授权一次后在所选域内连续操作。当前已开放的全局命令见第 10 节，其余功能以 capabilities 实际返回为准。

允许新建时每次固定 5 件，用户无需填写数量，单次授权不可超过 5 件；只给本任务实际新建的专利完整权限，不包含 GUI 或其他客户端新建项。名额与新专利一起提交，重试不重复消耗。连接结果和 doctor 的 JSON value 中包含 taskId、scope.patents、scope.createLimit、createdCount（本任务累计已新建）和 creationRemaining（本轮剩余额度），以及 scope.workspace.importDirectory / scope.workspace.exportDirectory；默认材料和成果目录由软件自动分配，首次授权不提前选择目录；自定义位置在实际导入/导出时按下方流程确认。

新建、DOCX 导入和原生专利导入共用本轮 5 件额度；移入回收站、删除或重试均不返还额度。额度不足时先停止新建，保留已有工作，再请求用户续授权：

```text
zxw pair renew-create --json
zxw pair poll --id <上一步返回的pairId> --json
```

两个命令均须带原连接的 --home、--instance、--profile。续授权 pending 返回退出码 4，说明需用户在中央弹窗确认；每 3 秒查询同一 pairId，不要重复申请。用户同意后，poll 返回 authorized 和 creationRemaining；再运行 doctor 核对本轮剩余额度，使用新的 requestId 继续之前失败的新建操作。新一轮固定 5 件，替代旧的剩余额度，不累计；原 taskId、连接令牌、已授权专利、全局权限及目录不变。拒绝、过期或软件关闭时停止等待，不自动重发；已有专利权限不因拒绝续授权而丢失。刚获批且尚未使用的新建额度不允许重复续授权。专利包每批不得超过可用额度，不能用一次续授权突破 5 件上限。

连接时应根据用户任务通过 `--input` 提交本次申请，主弹窗展示请求的新建权限和已选专利数量；具体专利及申请权限提示在“从专利库选择”窗口中查看和调整。申请并非实际授权，新建请求以“新建专利（控制）权限”卡片显示，无需切换开关；用户可点击须知阅读，勾选“我已阅读并同意”后直接授权。其他专利和全局权限仍由用户选择后授予；不能将 requested 当作已获得的 scope。专利名称重复时由用户在按月份分组的专利库中选择。旧客户端不提交 requested 时，从空选择开始，不显示整库列表。

例如 `connect-request.json`：
```json
{"label":"专利撰写助手","requested":{"task":"新建一件测试专利并参考已有专利","createLimit":1,"patents":[{"name":"一种节能控制装置","access":"read"}],"global":{}}}
```
```sh
zxw connect --instance <instanceId> --input connect-request.json --json
```
requested.patents 可使用真实 patentId 或完整名称，access 为 read/full；requested.createLimit 只描述任务希望新建的数量（最多 100），并不是实际授权额度；实际每轮始终最多 5 件。global 的键为 settings/templates/models/library/documents/transfer，值 read/full。不存在或回收站专利不会自动进入授权。获批后以 connect/doctor 返回的 scope 为准。

### 实际导入、导出时选择位置

先询问用户要导入的文件、导出格式、文件名及保存位置；如需使用独立工作区之外的位置，再执行：
```json
{"kind":"export","directory":"用户提出的保存目录绝对路径"}
```
将此内容保存为 `location.json`，导入则 kind 为 import。directory 只是原生选择窗口的初始位置，不是权限。然后：
```sh
zxw workspace select --input location.json --timeout 600000 --json
```
明确提示用户切回软件，在原生文件夹选择窗口确认位置。返回 selected 后使用返回的 directory 拼接具体文件名，或者导入其中用户指定的文件；原有专利/全局权限仍必须满足。返回 cancelled（退出码 1，表示用户取消）时停止该文件操作，不自动重发；软件关闭/授权撤销会失败且不扩大权限。BUSY 时先等待正在执行的任务或已有目录窗口，不重复弹窗。

该命令仅确认本任务的导入或导出目录，不创建/读取文件，也不进入写入操作账本。位置选择未完成前不要执行实际导入/导出；不要因客户端等待超时自动重复申请。确认只影响所选的一种目录，其他目录不变，未确认路径仍会被拒绝。采用默认独立工作区时无需位置窗口，但要向用户说明成果的真实位置。所有后续命令沿用相同 CLI 完整路径、--home、--instance 和 --profile。

批准后再次执行同一 connect，后续命令复用同一 profile。有效授权下重连和方案过期不再弹授权；用户可直接调整已授权客户端的专利范围。应用退出、关闭入口、切库或用户撤销时授权失效。不要让用户提供密码、令牌或配置文件；CLI 保存私有凭据，stdout 不输出凭据。协议 1 与协议 2 不兼容，出现 PROTOCOL_MISMATCH 时使用当前软件附带的 CLI，旧局部写授权不会静默升级。

```sh
zxw doctor --json
zxw capabilities --json
zxw manual --output agent-cli-manual.md
```

version 返回 CLI 产品版本和协议版本；instance list 的 version 是运行中软件的产品版本，两者兼容性以协议及 capabilities 为准。实例发现会探测连接，忽略损坏或已退出的实例记录。manual 可离线导出且不覆盖已有文件。capabilities 返回实际命令及操作 JSON Schema。`--profile` 可用于不同 agent；每个命令应使用同一 profile。不同实例并行工作时使用不同 profile，避免更新同一连接绑定。

等待授权时使用 `zxw pair poll --instance <instanceId> --json` 查询已有请求；保持与 connect 相同的 `--home` 和 `--profile`，每 3 秒查询一次即可。不要反复发起新授权。拒绝、到期或软件关闭后停止；只有获批后才再次 connect 保存连接信息。

## 2. 创建、读取与检查

```sh
zxw patent create --patent-type invention --name 一种节能控制装置 --request-id create-001 --json
zxw patent list --limit 50 --offset 0 --json
zxw patent read --patent-id <patentId> --json
zxw patent inspect --patent-id <patentId> --json
```

patentType 为 invention / utility-model。create 使用软件当前默认模板，保留模板题目字段及默认红字。返回值在 JSON 的 value 内；有副作用的命令返回操作账本，创建结果在 value.result。保存 patentId 和 revision，后续命令必须使用实际读取的 ID，不要猜测。创建和专利导入成功后，软件自动打开新专利并刷新专利库；已打开专利的正文提交通过保存屏障即时同步，其他专利草稿保留。

完整权限下 read 默认要求界面没有未保存编辑，返回 `value.patent`、持久化修订和 GUI 状态。使用 `--sync` 要求界面先保存；输入法组合、未提交弹窗、保存失败或超时会拒绝。`--persisted` 明确接受已保存版本，可能不包含界面最新编辑。只读参考默认返回已保存版本及 GUI 的 dirty/unknown 状态，不触发保存；只读调用 --sync 或 patent sync 会返回 SCOPE_DENIED。支持 `--book-kind`，或通过 input JSON 的 blockIds 缩小返回范围。正文只包含指定书册/块；范围读取不返回辅助文档，所有 read 结果均省略内部 editorState，不应直接作为原生专利文件导入。

`zxw template list --json` 返回模板选择、槽位元数据、修订和 hasContent；`zxw template describe --patent-type invention --json` 返回当前创建模板的 kind、templateId 和 slots（每项为 slot、fields）。这两个查询不返回模板正文或资源文件；新建专利后按获准 patentId 读取生成的正文。

书册标识：claims、description、description-drawings、abstract、abstract-drawing。inspect 调用软件检查引擎；检查结果不能作为法律判断或人工复核的替代。`patent show --patent-id <ID>` 是用户明确需要显示时才调用的界面操作。

## 3. 准备与应用修改

准备 UTF-8 文件 change.json，示例是在摘要末尾插入段落（afterBlockId 应取 read 返回的真实末块 ID）：

```json
{
  "patentId": "实际专利UUID",
  "expectedRevision": 0,
  "operations": [
    {
      "type": "insertParagraph",
      "bookKind": "abstract",
      "afterBlockId": "实际末块UUID",
      "text": "本装置通过温度反馈调整能耗。"
    }
  ]
}
```

afterBlockId 为 null 表示插入书册开头。operations 支持多书一次提交：

| type | 必须字段及说明 |
| --- | --- |
| insertParagraph | bookKind、afterBlockId（UUID/null）、text；可选 marks |
| replaceText | bookKind、blockId、expectedText、text；可选 start/end UTF-16 区间 |
| setTextMarks | bookKind、blockId、expectedText、marks；可选 start/end |
| deleteBlock | bookKind、blockId；完整权限内直接执行，保留风险提示 |
| setMetadata | name 和/或 customer，长度最多 100，可为 null |
| attachFigure | assetId（本授权导入的素材），可选 widthMm、explanation |
| selectAbstractFigure | figureId（实际附图 ID 或 null） |
| replaceBookContent | bookKind、content（canonical 块数组，支持表格、列表、公式、图片及化学结构） |
| insertBlock | bookKind、afterBlockId（UUID/null）、block |
| replaceBlock | bookKind、blockId、block；替换块必须保留原 id |
| moveBlock | bookKind、blockId、afterBlockId（UUID/null） |
| setParagraphAttributes | bookKind、blockId、attrs（段落属性补丁） |
| setBookPage | bookKind、page（完整页面尺寸和边距） |
| useAsset | assetId；将本客户端对此专利暂存的图片加入文档资源，可与结构化编辑一起提交 |
| setPatentType | patentType；改为 utility-model 时自动恢复附图书册 |
| setDrawingBooksEnabled | enabled；仅发明专利可关闭附图书册，关闭会清空附图书内容和附图标记 |
| createAuxiliary | title、content；可选 page；新 ID 由软件分配，在 prepare 的 diff 中返回 |
| editAuxiliary | auxiliaryDocumentId、content；可选 page |
| renameAuxiliary | auxiliaryDocumentId、title |
| moveAuxiliary | auxiliaryDocumentId、direction（up/down） |
| deleteAuxiliary | auxiliaryDocumentId |
| moveFigure | figureId、targetIndex（从 0 开始） |
| deleteFigure | figureId；同时清除指向该图的摘要图选择，正文图注独立保留 |
| resizeFigure | figureId、widthMm |
| rotateFigure | figureId、rotationDeg（0/90/180/270） |
| assignReferenceMark | keyword；可选 number、interruptedKeywordDecision、bodyNumberConflictDecision |
| updateReferenceMark | referenceMarkId、keyword、number |
| cancelReferenceMark / removeReferenceMark | referenceMarkId；前者取消编号，后者仅移除登记，沿用软件规则 |
| reorderReferenceMarks | ids（完整有序的 referenceMarkId 列表） |
| fillReferenceMarks | 将当前标记填入说明书 |
| supplementReferenceNumbers | bookKind（claims/description）；claims 可选 referenceMarkId |

文字操作不提供区间时要求目标块全为普通文字；混合公式等内容应选取纯文字子区间，expectedText 必须匹配。不要用文字替换破坏表格、公式、图片等节点。marks 格式以 capabilities.operationSchema 为准，例如 `[{"type":"color","value":"#FF0000"}]`；不要猜测格式。

```sh
zxw change prepare --input change.json --json
zxw change inspect --change-id <changeId> --json
```

prepare 返回不可变差异、风险和 changeId，有效期 30 分钟。完整权限下直接 apply，不需要用户逐步批准；risk.requireApproval 为 false，reasons 仅描述影响。方案过期时重新 prepare 即可，专利授权仍有效。每次写入前保存恢复点，失败不修改正文；版本冲突、GUI 待保存或资源缺失仍须处理。随后执行：

```sh
zxw change apply --patent-id <patentId> --change-id <changeId> --request-id apply-001 --json
```

apply 会冻结并排空目标 GUI 保存队列、建立修改前快照、多书原子提交一次修订，再同步界面。版本冲突时重新 read/prepare；不能强制覆盖。若返回 committed 且 uiSync 为 failed/pending，写入已成功，**不要重复修改**；用户在文档界面的同步异常提示中点击“重新同步已保存版本”，旧视图保持只读直到安全同步。丢失响应时先按原 requestId 查询。

```sh
zxw change discard --change-id <changeId> --json
```

仅放弃未应用方案，不撤销已提交修改。编辑器旧撤销历史在外部修改后重置，防止覆盖新版本。

## 4. 图片与历史

```sh
zxw asset import --patent-id <patentId> --path /任务材料目录/附图.png --request-id asset-001 --json
```

材料放到 connect/doctor 返回的 scope.workspace.importDirectory 中。读取已授权参考专利的附图时，可用：

```sh
zxw asset read --patent-id <patentId> --asset-id <assetId> --json
```

assetId 必须来自该专利，默认返回预览的 Base64 数据及描述；--variant original 读取原图，--revision 指定该专利的历史版本。大于通道容量的原图返回 RESULT_TOO_LARGE，可读取预览。只读不会修改参考专利，但已读内容可能被外部 agent 保存，CLI 不能从外部 agent 收回它。

导入图片后返回 assetHandle、assetId 和到期时间，并未插入专利。用 attachFigure prepare/apply 插入；素材只属于当前授权和专利。需要摘要附图时读取提交后的 figureId，再用 selectAbstractFigure。未使用的素材可释放：

```sh
zxw asset discard --asset-handle <assetHandle> --json
```

若有待应用方案引用，先 discard 方案。过期、放弃、撤销授权会释放无引用租约；不会删除已提交素材。存在待处理素材时全库导出/迁移会提示先处理，用户也可在设置中放弃全部暂存素材。

```sh
zxw history list --patent-id <patentId> --json
zxw history preview --patent-id <patentId> --revision <历史修订> --json
zxw change restore-prepare --patent-id <patentId> --expected-revision <当前修订> --revision <历史修订> --json
```

完整权限下历史恢复生成差异方案，直接应用，无需再批准，再用 change apply 形成新修订；不回退账本或直接改文件。

## 5. 导出

export.json 示例：

```json
{
  "patentId": "实际专利UUID",
  "expectedRevision": 1,
  "format": "docx",
  "output": "/任务成果目录/专利稿.docx",
  "acceptWarnings": []
}
```

output 使用 connect/doctor 返回的 scope.workspace.exportDirectory 下的绝对路径，无需再申请目录授权。format 支持 docx/pdf/patdoc，扩展名须一致；docx/pdf 可加 bookKind 导出单书，patdoc 包含完整专利和历史。所有输出均拒绝覆盖已有文件和链接跳转。

```sh
zxw patent export --input export.json --request-id export-001 --json
zxw operation status --request-id export-001 --command patent.export --json
```

export 返回 accepted/running 时还没完成，需查询至 committed；结果包含路径、来源修订和 SHA-256。导出返回的结构/转换警告会阻止导出；patent inspect 的撰写检查提示属于另一组结果，不会自动变成导出阻断条件。agent 可根据 EXPORT_WARNINGS 中的错误详情，在 acceptWarnings 中逐个列出接受的 code；这是机器参数处理，不需要用户在设置中批准。然后使用新的 requestId 提交修正请求；不能盲目接受全部警告。导出错误不修改原专利或已有输出。PDF 后台生成，不抢占用户窗口。

## 6. 重试、取消与退出码

输入文件用 `--input 文件.json`，也可通过 `--input -` 从 stdin 传入。输入必须为 UTF-8 JSON 对象，可带 UTF-8 BOM，文件与 stdin 的上限均为 16 MiB；无效编码会拒绝。请求封装后的通道帧也须在 16 MiB 内。除 help/manual 的文本模式外，stdout 只输出一份 JSON，诊断与 requestId 提示在 stderr。成功形状为 `{ "ok": true, "protocolVersion": 2, "value": ... }`，错误为 `{ "ok": false, "error": { "code": "...", "message": "..." } }`。

create/apply/import/export 必须保存唯一 requestId（不提供时 CLI 生成并提示）。同一客户端、库和命令的同一 ID、相同输入最多执行一次；不同输入返回 IDEMPOTENCY_CONFLICT。失败请求不会因重复同 ID 自动重新执行。**WAIT_TIMEOUT / CONNECTION_LOST 不代表失败**：

```sh
zxw operation status --request-id apply-001 --command change.apply --json
zxw operation status --id <operationId> --json
zxw operation cancel --id <operationId> --json
```

not_received 时仍使用原 ID、原输入重试，避免与仍在途请求重复。committed 直接使用结果。cancelRequested 仅表示信号已发送，继续查询至 cancelled 或 committed。alreadyCommitted 表示不可撤销；Ctrl+C 只停止客户端等待，不会取消服务端任务。recovery_required 表示发布结果待核对，软件仍在运行时直接查询；软件重启后，在下一次授权中选择对应专利和原成果目录，再查询；目标文件不存在、身份/散列不符或库处于只读恢复时仍保留该状态，不会重新发布，禁止猜测成功或另起请求覆盖。应用重启需重新 connect 并授权；账本保留，旧方案和素材句柄不能继续使用。

退出码：0 成功或任务已接收；1 任务 failed/cancelled/recovery_required 或其他服务端失败；2 输入或连接建立错误；4 待授权/授权撤销/入口关闭；5 修订或请求冲突、编辑器待保存或变化、全库操作占用；6 范围拒绝/不安全路径/只读恢复禁止写入；7 等待超时/连接中断/无效响应。请求发出后的 socket 错误属于结果未知，应按原 requestId 查询。agent 必须同时检查 ok、status 及检查/导出 issues，不只看退出码。

## 7. 支持范围与交付验证

当前已开放专利结构化编辑、辅助文档、附图属性、附图标记、流程图源管理与渲染、素材生成、图纸工作稿与区域取图、检索、原生文件/专利包/DOCX 导入、导出、打印、恢复点、回收站、AI 校对/润色/生成及多轮会话历史。单独授权的全局管理包含通用设置、模板、模型配置与连接测试、备份与恢复、独立文档、完整包导入导出和文档库搬迁。各命令的输入、权限和完成状态见对应章节。表格、公式、化学结构使用 canonical 结构编辑。整库导入最终切换支持 Windows 和 macOS，以 capabilities.platformSupport.transferImportCommit 为准；DWG 转换使用对应平台的内置转换组件。功能接入不代表各平台安装版综合验收完成。CLI 不执行任意脚本。

开发版本的 macOS 本机测试不代表 Windows 安装/升级、管道/ACL 和 console 验收完成。正式发给 Windows 用户前按 `docs/changes/agent-cli/acceptance.md` 的待验证项完成验收。

## 8. macOS 开发分支试用

本节用于当前隔离工作树。完成 npm run build:app 后，在工作树根目录执行：

```sh
CLI_TEST_ROOT="$(mktemp -d /private/tmp/zxw-cli.XXXXXX)"
export ZXW_HOME="$CLI_TEST_ROOT/home"
echo "$ZXW_HOME"
PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES=1 \
PATENT_WORKBENCH_LIBRARY_ROOT="$CLI_TEST_ROOT/library" \
./node_modules/.bin/electron ./out/main/index.js \
  --user-data-dir="$CLI_TEST_ROOT/user-data"
```

独立测试数据位于这次生成的目录。macOS 的 ZXW_HOME 必须较短，避免 Unix socket 路径超限；不要放到很长的中文项目路径下。

另一终端进入同一工作树，将 ZXW_HOME 设置为上一步打印的实际路径，再运行：

```sh
export ZXW_HOME="/private/tmp/zxw-cli.实际生成的后缀/home"
./out/cli/zxw instance list --json
./out/cli/zxw connect --instance <instanceId> --json
```

在窗口中开启本地 agent 入口并完成本次专利范围授权后，复用这个 profile 和 ZXW_HOME 执行后续命令。用户已有临时实例的旧副本不会随着源代码构建自动升级，协议必须与所运行的实例一致。


## 9. 辅助文档、全文检索与流程图

辅助文档支持与主书册在一次 change.apply 中共同提交。所有 content/page 字段使用 capabilities 返回的 schema；读取当前结构后编辑，不能省略必需属性或重复节点 ID。内容替换会改变指定范围的全部内容，必须先核对 diff。

通过 `patent export --input export.json` 导出辅助文档；JSON 与主专利导出相同，额外提供 `auxiliaryDocumentId`，format 为 docx/pdf，不能同时提供 bookKind。专利原生 patdoc 始终包含全部辅助文档。

```sh
zxw patent search --input search.json --json
zxw flowchart list --patent-id <ID> --json
zxw flowchart read --input read-flowchart.json --json
zxw flowchart write --input flowchart.json --request-id flowchart-001 --json
```

search.json：`{"query":"检索关键词","limit":50,"caseSensitive":false}`；可选 patentIds 缩小范围。仅检索获准且已保存的专利正文、题目、客户及辅助文档；返回匹配块 ID、摘要和修订，hasMore 表示达到上限。不触发只读专利保存，也不返回未授权专利的数量。

read-flowchart.json：`{"patentId":"实际UUID","projectId":"实际工程UUID"}`，返回元数据和 UTF-8 draw.io source。

flowchart.write 的 JSON 必须含 patentId、expectedRevision、action。create 需要 name/source；save 需要 projectId/expectedProjectRevision/source；rename 需要 projectId/expectedProjectRevision/name；duplicate 需要 projectId/name；delete 需要 projectId。source 为完整 draw.io mxfile XML，按软件现有导入安全规则检查，拒绝脚本及远程资源。写入前保存恢复点，版本检查、数据修改、操作回执与 GUI 同步沿用专利保存机制。工程删除保留已生成的静态附图。工程渲染及提交为附图见第 23 节。

## 10. 独立全局权限

```sh
zxw global models read --json
zxw global models update --input models.json --request-id models-001 --json
zxw global models set-key --input - --request-id model-key-001 --json
zxw global models clear-key --input clear-key.json --request-id clear-key-001 --json
zxw global settings read --json
zxw global settings update --input settings.json --request-id settings-001 --json
zxw global template read --json
zxw global template update --input templates.json --request-id templates-001 --json
```

通用设置使用 scope.global.settings，模板使用 scope.global.templates。read 允许只读/完整授权，update 必须完整授权。未授权返回 SCOPE_DENIED，不能通过某个专利的权限代替。调整或撤销后旧回执也受当前权限约束。

settings read 返回 settings 和 hash；settings.json 为 `{"expectedHash":"刚读取的hash","patch":{"reducedMotion":true}}`。允许字段见 capabilities.inputSchema.generalSettingsPatch。模型、模板、备份和路径不属于此通用补丁，不能混入修改。设置保存后由界面下次读取生效。文件写入中断会保留 recovery_required 回执；先重新读取实际设置，确认差异后以新 hash 和新 requestId 补救，不盲目重发。

template read 返回 catalog 和 auxiliary；templates.json 包含 expectedRevision（刚读取的 catalog.revision）、编辑后的完整 catalog 和 auxiliary。必须保留槽位身份，软件检查模板字段和章节。模板保存和操作回执同一事务提交，旧修订拒绝覆盖。模板权限不能用于引用其他未授权专利的资源；当前仅可保留已有模板的化学预览资源。


模型设置使用独立的 scope.global.models，通用 settings 权限不能代替。models read 返回 settings、hash、credentialProfileIds（已设密钥的模型 ID），不返回密钥。models update 使用 expectedHash/patch，patch 可含 aiCorrection（完整模型配置，保留已有 profiles）或 aiConnectionsEnabled；字段见 capabilities.inputSchema.modelSettingsPatch。关闭联网会取消当前软件 AI 连接。改变配置不执行网络请求。

models set-key 的标准输入 JSON 为 `{"profileId":"实际模型UUID","apiKey":"用户提供的密钥"}`；不要把真实密钥写进手册、命令行参数或操作日志。clear-key.json 只含 profileId。两种写操作均要求 models 完整权限，密钥由软件既有加密存储保存；只返回 hasApiKey 状态，账本不存明文。设置/密钥文件写入中断时保留 recovery_required，不能推断已经完成，应核对配置或由用户重新提供密钥后使用新请求 ID。


## 11. 软件内 AI 校对、润色与生成

`ai correct` 和 `ai polish` 要求目标专利完整权限；models 权限只用于管理配置，不能替代专利授权。使用当前模型与既有密钥，遵守软件 AI 联网开关。处理内容会发送给已配置的模型服务；只读参考权限不能调用这些入口。一次专利完整授权内无需逐次批准。

```sh
zxw ai correct --input correction.json --request-id ai-check-001 --json
zxw ai polish --input polish.json --request-id ai-polish-001 --json
zxw operation status --id <operationId> --json
zxw operation cancel --id <operationId> --json
```

correction.json 示例：`{"patentId":"实际UUID","expectedRevision":0,"scope":{"kind":"current-book","bookKind":"description"},"thinkingEnabled":false}`。支持 current-book 或带文本摘要与块区间的 selection，完整结构见 capabilities.inputSchema.aiCorrection。

polish.json 示例：`{"patentId":"实际UUID","expectedRevision":0,"scope":{"kind":"generation","bookKind":"description"},"requirement":"根据以下技术内容起草实施方式：……"}`。selection 模式用于润色，见 capabilities.inputSchema.aiPolish；生成模式必须明确提供需求和技术内容，不会自行读取其他专利。

AI 任务后台运行，operation.status 返回阶段和终态结果；校对结果包含 issues 及原文定位，润色结果包含锚点和候选文字，生成结果包含 generatedText。任务绑定发起时的已保存修订，不直接改写文档。收到结果后核对建议，通过 change.prepare/apply 提交；界面已产生新修订时重新读取核对。撤销或缩小权限会取消在途任务，同一 requestId 不重复发起模型调用。模型服务失败只返回通用错误，避免回传第三方响应中的敏感信息。

## 12. 公式、化学预览与素材文件

```sh
zxw asset render-formula --input formula.json --request-id formula-001 --json
zxw asset render-chemistry --input chemical.json --request-id chemical-001 --json
zxw asset preview --input preview.json --json
zxw asset export --input asset-export.json --request-id asset-export-001 --json
zxw flowchart export --input flowchart-export.json --request-id flowchart-export-001 --json
```

formula.json 为 `{"patentId":"实际UUID","latex":"x^2+y^2=z^2"}`；chemical.json 为 patentId 和 svg（自包含 SVG 字符串，拒绝脚本、外部引用）。输出与 asset.import 一致，包含 assetHandle、assetId、descriptor 和到期时间；生成仅暂存，不直接改文档。preview.json 为 `{"assetHandle":"返回的句柄UUID"}`；也可使用 `zxw asset preview --asset-handle <实际句柄UUID> --json`。预览只接收 assetHandle，不能额外传入 patentId、path、variant 等字段，素材归属由句柄绑定。参数无效返回 INVALID_INPUT，返回 Base64 PNG，限同一授权且未过期的素材。公式可通过 attachFigure 放入附图；化学预览用 useAsset 纳入修改方案，再在化学结构节点中引用其 assetId。更改仍需 change.prepare/apply。

两种渲染均支持 `outputWidthMm`（10–165），按目标宽度生成清晰预览；插入文档时仍需在节点或 attachFigure 中指定相应 widthMm。无法解析的公式返回 INVALID_FORMULA，不生成错误提示图片。化学方程式使用 `asset render-formula`，latex 为 `\\ce{…}`（JSON 中反斜杠需转义）。

需继续编辑的化学结构，应在 chemical.json 同时传入 `source:{"ketSource":"完整 KET JSON 字符串","editorMode":"molecule"}`；大分子使用 macromolecule。源码随 SVG 素材保存，附图及 PATDOC 往返不会丢弃此数据。未提供 source 的普通 SVG 只能作为静态图片，不能作为新化学结构节点的可编辑预览。新增或修改结构节点时，ketSource、editorMode 必须与该素材的内嵌源码一致；更改结构后先重新渲染，再更新 previewAssetId。主书册、辅助文档和独立文档更新均校验，未改变源码和预览的旧节点仍可调整布局、删除，历史文件读取和恢复不受此校验影响。此校验检查 KET 格式及引用，不替代结构编辑器的化学语义检查；SVG 图形与源码应由同一次结构编辑生成。

asset-export.json 为 `{"patentId":"实际UUID","expectedRevision":0,"assetId":"已保存素材UUID","variant":"preview","output":"授权输出目录/素材.png"}`。preview 输出 PNG；original 按 descriptor.extension 输出原文件。只输出该专利已保存版本拥有的资源，暂存素材使用 preview 检查。输出文件不能覆盖，操作中断可用 operation.status 查明状态。

流程图文件导入使用 flowchart.write，action 为 import，包含 patentId、expectedRevision、path（授权输入目录内的文件），可选 name。复用软件导入器读取 draw.io 文件及支持的内嵌工程格式，校验安全性后创建工程。flowchart-export.json 为 `{"patentId":"实际UUID","expectedRevision":0,"projectId":"实际UUID","output":"授权输出目录/流程图.drawio"}`。以上写入、渲染、文件输出命令均要求目标专利完整权限。

patent.inspect 可提供 mode（full/instant）和 ruleIds；规则清单及依据位于 capabilities.inspectionRules。省略 ruleIds 使用全部既有规则，指定空数组不执行规则；未知 ID 报错，不修改全局检查设置。只读专利可检查已保存内容。

## 13. 图纸工作稿

`drawing import` 的输入为 patentId、path（已授权目录内的 DWG、PDF 或图片），返回 assets 暂存句柄数组和 project 初始工作稿内容。DWG 要求对应平台的软件内置转换组件完整可用，Windows 和 macOS 均支持。PDF 自动生成指定页的预览，pageNumber 默认为 1；也可提供 previewPath，使用同一授权输入目录内、与该页面一致的 PNG 预览。

```sh
zxw drawing import --input drawing.json --request-id drawing-001 --json
```

收到素材后，在一次 change.prepare 中先对每个 assetId 执行 useAsset，再执行 `{"type":"createDrawingProject","project":返回的project}`。只有 change.apply 提交后才保存为专利工作稿，服务器分配 projectId，初始工程 revision 为 0。

patent.read 返回 drawingProjects；updateDrawingProject 使用 projectId、expectedProjectRevision 和完整 project 内容（不含 projectId/revision），可修改名称、标注、裁剪区域、局部放大、输出设置等现有字段。成功后工程 revision 加一；deleteDrawingProject 使用 projectId、expectedProjectRevision，保留已插入的静态附图。完整输入约束由 capabilities.operationSchema 提供。

工作稿的源图和底图必须已属于目标专利或通过本次 useAsset 引入，禁止引用未授权专利资源。PDF 以同一 PDF 素材作为源图和底图，与软件界面一致。工程数据、正文及回执同一事务保存，支持已有历史恢复和 GUI 同步。

```sh
zxw drawing render --input drawing-render.json --request-id drawing-render-001 --timeout 90000 --json
```

输入为 `{patentId,expectedRevision,projectId,expectedProjectRevision,regionId,widthMm,dpi,persisted?,autoAdjustLabelSize?,autoLabelScale?}`。widthMm 为 10–165，默认 150；dpi 为 300 或 600。autoLabelScale 为 0.5–2（50%–200%），省略时沿用界面保存的自动标号大小比例，仅在 autoAdjustLabelSize 为 true 时影响成图。regionId 来自已保存工程的 regions。后台复用软件的区域取图、标注和局部放大算法，按说明书附图页面限制确定实际尺寸，返回 JPEG 暂存素材、实际 outputWidthMm 及 renderedFrom 版本信息。自动放大引入新的标号重叠时会提示调整并停止成图；不会移动标号或直接改正文。

确认结果后，通过 change.prepare/apply 的 attachFigure 添加附图，widthMm 使用返回的 outputWidthMm，或 useAsset 加结构化正文操作插入书册/辅助文档；之后可用 asset.export 输出已经保存的成图。若工程或专利版本发生变化，重新读取再渲染。渲染窗口始终隐藏，取消会关闭对应后台渲染任务。

## 14. 原生专利和专利包导入

```sh
zxw patent import --input import.json --request-id import-001 --json
zxw operation status --id <operationId> --json
```

import.json 为 `{"path":"授权输入目录/专利.patdoc","format":"patdoc"}`；五书专利包使用 format 为 bundle 和相应 ZIP 文件。只允许创建新专利，必须有足够的新建额度；无需授权库中其他专利，也不会覆盖已有专利。成功结果 patents 数组含新 patentId 和 revision，每条新专利自动归属于本次任务完整权限。

patdoc 保留辅助文档、图纸工作稿、流程图原稿和历史快照；普通独立文档 patdoc 使用独立文档入口，不能混作专利导入。五书包按照原软件定义保留五书，不包含辅助文档；重复包默认报 DUPLICATE_IMPORT，确需另建副本时以新 requestId 设置 allowDuplicate 为 true，仍需足够额度。

每个请求限制还原内容 256 MiB、格式限制最多 100 条专利，实际每批新建不得超过本轮剩余的 5 件额度。全部文件先校验并暂存，导入数据、新建额度和操作回执同一事务提交；失败不会留下部分新专利。任务取消或撤销授权在提交前生效；同一 requestId 重试返回原结果。先查询终态，再使用新 ID 继续操作。

## 15. 显式恢复点管理

```sh
zxw history create --input snapshot.json --request-id snapshot-001 --json
zxw history delete --input delete-snapshot.json --request-id snapshot-delete-001 --json
```

snapshot.json 包含 patentId、expectedRevision；创建前同步 GUI，若因此产生新修订则返回 REVISION_CONFLICT，应重新读取后重试。相同修订已有健康快照时返回 already-exists；损坏快照不会被当作成功恢复点。delete-snapshot.json 额外包含 revision（待删除的快照版本）。两种命令均要求目标专利完整权限。

最后一个能恢复当前内容的有效快照受软件保护，不能删除。删除和回执同一事务，资源整理失败会返回 cleanupError，已完成的删除不会重复执行。创建快照在落库后还需验证资源与执行保留策略；意外中断返回 recovery_required 时，先用 history.list 核对该版本的健康状态，再决定是否使用新请求 ID 补救。恢复正文继续使用 change.restore-prepare/apply。

## 16. 保存关闭与回收站

```sh
zxw patent close --patent-id <ID> --request-id close-001 --json
zxw patent trash --input trash.json --request-id trash-001 --json
```

这两个命令要求正常专利的完整权限。trash.json 包含 patentId、expectedRevision。移动前自动走 GUI 正常保存/关闭流程并创建恢复点；未提交编辑、保存失败、窗口超时或活动会话不能安全释放时停止，不提供放弃未保存内容的选项。若保存推进修订，重新读取后再操作。close 只保存关闭编辑标签，不退出软件、不删除专利。

回收站专利不出现在授权选项中，不能授予只读或完整权限。已授权专利移入回收站后立即停止 Agent 访问，包括读取、编辑、导出、历史操作、恢复和永久删除；回收站列表不向 Agent 返回专利。请由用户在软件界面恢复成正常专利，再按正常专利的授权范围操作。Agent 不能自行恢复或永久删除回收站专利，capabilities 不再公布 patent.restore/delete。

已完成操作的回执仍可查询，以确认移动是否成功；回执不恢复专利访问权限。单条数据修改和回执同一事务保存。取消关闭可能已有部分窗口完成保存关闭，但不会继续删除专利。

## 17. 批量专利包输出

`zxw patent export-bundle --input bundle.json --request-id bundle-001 --json` 生成 ZIP，随后用 `operation status` 查询结果。每个专利都需要完整权限。

```json
{"patents":[{"patentId":"专利 UUID","expectedRevision":3}],"format":"docx","output":"授权输出目录/交付包.zip","acceptWarnings":[]}
```

format 支持 patdoc/docx/pdf。原生包保留五书、绘图工程及历史；DOCX 包另含可还原的原生副本；PDF 包仅供阅读，不能重新导入。沿用软件五书专利包规则，辅助文档不进入专利包，需要另行导出。输出不覆盖已有文件；最多 100 个专利、256 MiB。若返回 EXPORT_WARNINGS，可读取提示后列出接受的代码，并用新的 request-id 重试。无需再次请求用户授权。

先核验全部专利权限和各自修订，再生成输出；任意一项失败不发布 ZIP。默认拒绝未保存编辑；可先 patent sync，或明确设置 persisted:true 导出已保存版本。结果中的 revision:0 是压缩包发布记录占位，不代表所有专利的修订；各专利版本以请求和包内原生内容为准。

## 18. DOCX 识别预览与导入

本任务需要新建额度。先准备输入 JSON，例如 `{"paths":["授权输入目录/权利要求书.docx","授权输入目录/说明书.docx"]}`：

```sh
zxw docx prepare --input word-files.json --json
zxw docx preview --session-id <sessionId> --json
zxw docx preview-asset --session-id <sessionId> --asset-id <assetId> --json
zxw docx commit --input word-commit.json --request-id word-import-001 --json
zxw docx discard --session-id <sessionId> --json
```

prepare 返回 sessionId、expiresAt、units 和 warnings。commit JSON 包含 sessionId、patentType、name、customer（可为 null）、assignments、acknowledgedWarningIds。assignments 每项使用预览返回的 unitId/title/target；附图单元还可以提供 drawingOrder 指定图片顺序。重要提示确认后将其 warningId 放入 acknowledgedWarningIds。软件按现有五书识别规则确定导入位置；未知文档或重复五书类型会拒绝整批导入，不能随意改成其他文档或追加到已有专利。

预览 30 分钟内有效，只能在当前授权中使用；撤销、重新授权或重启后须重新准备。最多同时保留 4 个预览；输入文件名不能重复，文件必须在授权输入目录内。图片预览返回 PNG 的 Base64 数据。放弃预览不删除输入文件。

成功导入消耗一个新建额度，返回新 patentId/revision，自动获得该专利完整权限。先预览不会预占额度，提交时再次检查；专利、额度归属和操作回执同时提交。超时或断线先查询原 request-id，避免另起请求重复导入。

## 19. 打印

```sh
zxw patent printers --patent-id <ID> --json
zxw patent print --input print.json --request-id print-001 --json
zxw operation status --request-id print-001 --command patent.print --json
```

需要目标专利完整权限。先读取打印机列表，使用返回的 deviceName，不能省略或让软件自动选择系统默认打印机。

```json
{"patentId":"专利 UUID","expectedRevision":3,"bookKind":"claims","layout":{"orientation":"portrait","paperSize":"A4","scalePercent":100,"margins":{"mode":"document"}},"output":{"printerDeviceName":"实际 deviceName","copies":1,"duplexMode":"simplex","color":false,"pagesPerSheet":1,"collate":true},"acceptWarnings":[]}
```

省略 bookKind 打印全部可用书册，也可提供 auxiliaryDocumentId 打印指定辅助文档，两者不能同时提供。layout 支持纸张、方向、缩放与页边距，output 支持份数、单双面、颜色、每张页数及 pageRanges；范围页码从 0 开始且含结束页，完整结构查看 capabilities。软件不会弹出系统打印选择框。警告通过 PRINT_WARNINGS 返回，阅读后在 acceptWarnings 中列出接受的代码，以新的请求 ID 重试。

submitted:true 表示系统接受了提交，不代表纸张已经打印完成。设备错误或提交后中断可能进入 recovery_required；先核对系统打印队列和实体输出，不要自动创建新 request-id 重印。取消、撤权只能阻止尚未提交的工作，不能撤回已经交给系统的打印任务。开发验证没有实际消耗打印纸，实体设备和 Windows 驱动仍待综合验收。

## 20. 单独授权的备份与快照设置

先在中央授权弹窗中授予“整库管理与备份恢复”。专利完整权限、通用设置权限及模型权限都不包含此权限；read 只允许读取，full 才能修改。

```sh
zxw global library read --json
zxw global library snapshot configure --input snapshot-settings.json --request-id snapshot-settings-001 --json
zxw global library backup configure --input backup-settings.json --request-id backup-settings-001 --json
```

read 返回 settings.backup、settings.snapshot 和 hash。修改 JSON 使用该 hash 作为 expectedHash：

```json
{"expectedHash":"刚读取的 hash","settings":{"enabled":true,"intervalMinutes":10}}
```

上例为快照设置。备份 settings 需要 enabled、folder（绝对目录或 null）、intervalMinutes，还可提供 migrateExisting、expectedSourceFolder。启用备份必须指定目录；新的目录必须已存在并位于授权输出目录内。可继续使用软件原来已配置的备份目录。迁移受管备份沿用软件的逐文件验证和保留原件策略，部分源文件无法安全移除时返回 retainedSourceCount。

配置保存后立即调整后台调度，不会为每次定时备份重新弹出授权；撤销 Agent 权限也不会撤销已经保存的软件设置。设置迁移跨越配置文件和备份文件，意外中断可能返回 recovery_required，此时先读取当前设置并核对文件，不要盲目重复迁移。

## 21. 备份文件管理

```sh
zxw global library backup read --action status --json
zxw global library backup read --action list --offset 0 --limit 50 --json
zxw global library backup read --action inspect --file-name "列表返回的 fileName" --json
zxw global library backup run --expected-hash "global library read 返回的 hash" --request-id backup-001 --json
zxw global library backup delete --file-name "列表返回的 fileName" --expected-state "inspect 返回的 state" --request-id delete-backup-001 --json
```

读取需要 library 的 read 或 full 权限。run/delete 需要 full；run 返回操作回执，通过 operation status 查询完成情况。备份必须已启用并配置目录，未启用时返回零处理数。复用软件备份规则，跳过已有健康版本，保留每份文档最近三个受管版本；结果中的 failures 必须逐项检查，操作结束不等于每份文件均成功。

文件名必须原样使用列表值（可能含月份子目录），只能删除本软件创建的受管备份。inspect 返回的 state 用于确认待删除文件没有变化。撤权或取消会阻止后续文件发布和清理，但不会撤回已经完成的文件工作。中断后若为 recovery_required，先核对文件和运行状态，不要改用新请求自动重复。

恢复同样需要单独的 library 完整权限，使用文件状态防止选中的备份被替换：

```sh
zxw global library backup restore --file-name "列表返回的 fileName" --expected-state "inspect 返回的 state" --request-id restore-backup-001 --json
```

始终另建恢复副本，保留原有对象。专利恢复返回 patents 数组，新专利自动归当前任务完整授权，不占普通新建额度；原有其他专利的授权保持不变。独立文档恢复返回 documentType、documentId 和 revision，后续管理遵循 documents 单独授权。资源引用、恢复归属和成功回执与对象共同提交，原 request-id 重试只返回原结果。完整包导入和文档库搬迁见第 27、28 节。

## 22. 独立文档

需要单独授予 documents 权限。此域管理普通独立文档，不包含任何专利。read 只允许查询，full 可创建、编辑、导入导出、添加图片和管理回收站。

```sh
zxw global documents read --action list --scope active --json
zxw global documents read --action get --document-id <文档ID> --json
zxw global documents create --title "技术交底记录" --request-id document-001 --json
zxw global documents update --input document-edit.json --request-id document-edit-001 --json
zxw global documents asset-import --input document-image.json --request-id document-image-001 --json
zxw global documents read --action asset --document-id <文档ID> --asset-id <素材ID> --variant preview --json
zxw global documents import --path /授权输入目录/文档.patdoc --request-id document-import-001 --json
zxw global documents export --input document-export.json --request-id document-export-001 --json
zxw global documents trash --input document-state.json --request-id document-trash-001 --json
zxw global documents restore --input document-state.json --request-id document-restore-001 --json
zxw global documents delete --input document-state.json --request-id document-delete-001 --json
```

- update 输入为 `{documentId,expectedRevision,document}`。document 使用 get 返回的完整结构，只修改题目、页面、正文或素材列表；不能修改其身份、创建时间或旧 patentType 标记。支持现有段落、表格、公式、图片和化学结构，素材描述必须与该文档的已导入素材一致。
- asset-import 输入为 `{documentId,expectedRevision,path}`，图片路径限定授权输入目录。返回 descriptor；将它加入 document.assets，并以其 assetId 创建 figure/inline-figure，再 update。添加素材本身不修改正文修订。
- export 输入为 `{documentId,expectedRevision,format,output,persisted?,acceptWarnings?}`，format 为 patdoc/docx/pdf。输出限定授权目录且不覆盖文件。import 只接受独立文档 patdoc，创建新 ID 并保留图片；专利 patdoc 使用 patent import。
- 回收站操作输入为 `{documentId,expectedRevision,expectedDeletedAt}`，expectedDeletedAt 使用 get 最新结果；活动文档为 null。delete 只允许回收站文档，永久删除不可撤销。

列表包含 CLI 创建的空白文档，支持 offset/limit。get 不创建编辑会话或清理空白文档。文档正在编辑时拒绝写入；可加 persisted:true 明确读取或导出已保存版本。长导入导出返回操作回执，使用 operation status 查询。创建、编辑、回收站状态和成功回执共同保存；超时先查原 request-id。独立文档不会消耗专利新建额度。

## 23. 流程图自动成图

`flowchart render --input render.json` 从已保存工程生成黑白 SVG 与 PNG 预览。需要目标专利完整权限；`render.json` 包含 `patentId`、`expectedRevision`、`projectId`、`expectedProjectRevision`，可选 `pageIndex`（从 0 开始，默认 0）、`selectedCellIds`（省略或空数组为整页）、`borderMm`（0–20，默认 0）、`outputWidthMm`（10–165）。对象 ID 来自 `flowchart read` 返回的源 XML；不存在的对象会失败，不会改为整页导出。开发模式也使用已构建的离线渲染页面，更新渲染代码后需运行 `npm run build:app`。

返回 `assetId`、`assetHandle`、`flowchartLink`、`outputWidthMm` 和 `warnings`。用 `asset preview --asset-handle <实际句柄UUID> --json` 检查预览（等价于 `asset preview --input preview.json --json`，其中 JSON 仅包含 assetHandle），再在 `change.prepare` 的 `operations` 中提交：

```json
{
  "type": "attachFlowchartFigure",
  "assetId": "返回的资源ID",
  "link": "替换为返回的完整 flowchartLink 对象",
  "widthMm": 80
}
```

可选 `replaceFigureId` 替换已有附图并保留其编号身份。工程版本或源文件 hash 与 `link` 不匹配时拒绝插入，需要重新生成；最终仍通过 `change.apply` 原子保存。生成过程不修改正文、不打开编辑器窗口、不请求中途二次授权。保存后可用 `asset export` 输出 SVG 原图或 PNG 预览。

## 24. AI 连续对话与历史

`ai conversation read --patent-id <ID>` 分页读取历史摘要，同时返回新对话输入草稿及 `draftHash`。用 JSON 输入增加 `conversationId` 可读取指定对话及其草稿。只读专利授权可调用，不调用模型、不创建会话、不重写历史；不会返回模型密钥或思考过程。

`ai conversation run --input conversation.json` 需要目标专利完整权限，返回后台操作回执。通过 `operation status --id <operationId>` 获取进度与完成结果，`operation cancel` 停止当前模型处理。所有动作均填写 `patentId`、`expectedRevision`（当前专利修订），可选 `persisted: true` 明确使用已保存版本。

| action | 额外字段 | 用途 |
| --- | --- | --- |
| start | `scope`、`instruction` | 新建对话并生成首轮；scope 与单次润色相同，支持已校验选区或 generation |
| send | `conversationId`、`expectedConversationRevision`、`instruction` | 续聊 |
| retry | `conversationId`、`expectedConversationRevision`、`turnId` | 重试未完成轮次 |
| change-model | `conversationId`、`expectedConversationRevision`、`targetModel` | 沿用界面规则切换已配置模型；目前限 DeepSeek 配置 |
| reset | `conversationId`、`expectedConversationRevision` | 切换到新对话状态，保留历史 |
| draft | `conversationId`（新对话填 null）、`expectedDraftHash`、`draft: {text, presets}` | 保存输入草稿，拒绝覆盖已变化的草稿 |
| recover | `conversationId`（可为 null） | 复用历史恢复机制，保留损坏原件；恢复中断轮次后重新读取对话修订 |

示例首轮输入：

```json
{
  "patentId": "目标专利ID",
  "expectedRevision": 3,
  "action": "start",
  "scope": { "kind": "generation", "bookKind": "description" },
  "instruction": "根据已说明的结构撰写一段具体实施方式"
}
```

结果中的 `snapshot.conversationId` 和 `snapshot.conversationRevision` 用于后续动作。`snapshot.lastTurnOutcome` 表示模型本轮完成、失败或取消；操作回执 committed 表示本轮记录已保存，不保证模型回复成功。候选内容不会自动改正文，应用时仍使用 `change.prepare/apply`。

续聊使用该会话已冻结的选区及历史；需要新的正文上下文时重新 start。界面占用的同一对话拒绝被 CLI 接管，也不能由 CLI 改写其草稿。recover 涉及该专利共享的活动对话指针，须先关闭该专利的界面编辑会话；不同对话的普通续聊仍可分别处理。联网关闭时拒绝 start/send/retry。跨历史文件和操作账本的中断保留 `recovery_required`，先读取历史核对，再用新请求继续，原请求不会重复发送。

## 25. 遗留附图标记核对

`change.prepare` 支持 `completeReferenceMarkReview` 操作，填写 `referenceMarkId`。默认只有正文核对通过才清除遗留待核对状态；明确填写 `acceptCurrentDocument: true` 表示保留现有正文并完成核对，不替换正文。目标来自 `patent read` 的 `referenceMarkSettings.pendingReview`。

`setReferenceMarkSync` 操作填写 `enabled: false` 可关闭遗留跨文档同步状态。当前软件已暂停开启跨文档自动同步，`enabled: true` 会按现有业务规则返回 `SYNC_PAUSED`，CLI 不绕过该限制。这些操作随其他修改一起通过 `change.apply` 保存，需要目标专利完整权限。

## 26. 完整数据包导出

授权弹窗增加“完整数据迁移（全部专利、文档、对话与设置）”，对应 `global.transfer`。它默认关闭，不由任何专利权限或其他全局权限推导；启用完整权限即允许处理整库内容，请按实际任务选择。

`global transfer read` 需要 transfer 只读或完整权限，返回整库数量及是否满足空库导入条件。

`global transfer export --input export-all.json` 需要 transfer 完整权限。输入填写授权成果目录内的绝对 `output`（扩展名 `.zxwbackup`）、至少 12 字符的 `password`、`passwordRecorded: true`、`persisted: true`；可选 `passwordHint`。`persisted: true` 明确导出已保存的数据截面，界面中未保存的编辑不在保证范围内。应先完成需要交付的保存。

通过 `operation status` 查询后台进度，完成后返回文件路径和 SHA-256；操作可取消，重用同一请求 ID 不重复生成。导出沿用软件完整数据包的加密、内容自检和迁移规则，不覆盖已有文件。文件发布后回执中断可核对原文件恢复结果。密码不写入操作回执；请使用受保护的输入文件或标准输入，勿将密码放入命令行或版本库。

此权限包含全部专利、独立文档、对话历史和可迁移设置，适用于整库备份/迁移；单个专利交付继续使用 patent export 或 export-bundle。

## 27. 完整包导入与重启回执

需要单独授予 `transfer: full`，并将数据包放入本次连接的 `scope.workspace.importDirectory`。先运行 `global transfer read`，检查 `empty`、`blockers` 和 `importCommitSupported`。有专利、独立文档、自定义设置或未处理恢复数据的库不能被覆盖。

```text
zxw global transfer import prepare --input import.json --request-id full-import-001 --json
zxw operation status --id <operationId> --json
zxw global transfer import read --input preview.json --json
zxw global transfer import discard --input preview.json --json
zxw global transfer import commit --input commit.json --request-id full-commit-001 --json
```

- `import.json`：`{"path":"获准目录中的绝对路径.zxwbackup","password":"数据包密码"}`。也可通过 `--input -` 从标准输入传入，避免把密码写入命令行历史。成功准备的操作结果给出 `importId`、验证后的预览和过期时间。
- `preview.json`：`{"importId":"准备结果中的ID"}`。预览属于当次完整授权，30 分钟过期，撤权或调整授权后不能继续使用。
- `commit.json`：`{"importId":"准备结果中的ID","restart":true}`。最终切换支持 Windows 和 macOS；其他尚未开放的平台提前返回 `UNSUPPORTED_PLATFORM`，不关闭原库。
- `discard` 放弃当前导入，回执中的 `retainedDirectories` 是本次准备数据的隔离留存位置。保留副本以避免不安全的递归删除，允许重新准备；软件不会自动删除这些留存副本。授权过期清退也采用隔离留存。

同一份预览只能处理一个状态转换。安排切换或放弃预览期间，不得并行提交、放弃或重新安排；返回 `OPERATION_IN_PROGRESS` 时等待原操作结束，再查询其回执。

提交回执的 `phase: scheduled`、`restartPending: true` 只表示已安排切换。软件发出回执后执行切换并重启；重新连接、授权后运行 `global transfer read`，核对 `lastImport.importId` 以及 `lastImport.phase`。只有 `committed` 表示启动验证成功；`rolled-back` 表示恢复原库，`recovery-required` 表示需保留原数据包并检查恢复状态。不要在状态不明时重复导入。新实例不继承旧专利授权。

## 28. 文档库搬迁

需要 `transfer: full`。目标父目录必须位于当前获准输出目录内；软件自动建立独立的新库子目录，保留原库副本。先保存并关闭正在编辑的专利、独立文档或模板，否则返回 `EDITOR_OPEN`。

```text
zxw global transfer relocate --input relocate.json --request-id move-library-001 --json
```

`relocate.json`：`{"parent":"获准输出目录中的绝对目录","restart":true}`。回执返回 `target` 和 `phase: scheduled`。重启后重新连接并运行 `global transfer read`，确认 `location.activeRoot` 等于 `target`、`location.pending` 为 `null`；这些条件满足才算搬迁完成。该操作沿用软件的复制、校验、正常退出和启动恢复流程。

## 29. 旧草稿与独立文档打印

`global documents legacy read` 用 documents 只读或完整权限列出尚未迁入的旧草稿；`global documents legacy import --input legacy.json` 需要完整权限，输入 `{"draftId":"列表返回的ID"}`。文档、素材、迁入标记和操作回执一起提交，重复请求不产生重复副本；原草稿保留。已迁入的草稿不会再次出现在 GUI 或 CLI 的待迁入列表。

`global documents printers read` 查询打印设备。`global documents print --input print.json` 需要 documents 完整权限，输入包含 `documentId`、`expectedRevision`、`layout`、`output`、可选 `persisted` 和 `acceptWarnings`。打印设置与第 19 节专利打印一致；必须明确 `output.printerDeviceName`。`submitted:true` 只代表交给系统打印队列，中断结果不明时先检查打印队列，不自动重印。

## 30. 模型连接测试和模型列表

`global models test-connection --input model.json` 和 `global models discover --input model.json` 均需要 `models: full`，以及软件 AI 联网开关已开启。`model.json` 为 `{"profileId":"global models read 返回的模型配置ID"}`。它们使用现有配置和安全存储的密钥，不返回密钥；连接测试只发送固定“测试”文字，模型发现只请求提供商模型列表，不发送专利正文。结果通过 `operation status` 读取；这些属于外部服务调用，中断后不自动重复。发现接口不受提供商支持时明确失败，可继续使用软件预设模型。
