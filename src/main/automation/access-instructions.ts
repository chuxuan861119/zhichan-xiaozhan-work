import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AutomationError } from "../../shared/automation/protocol.js";

export type AgentAccessOptions = {
  platform: NodeJS.Platform;
  cliPath: string;
  instanceId: string;
  home: string;
};

export function formatAgentAccessInstructions(options: AgentAccessOptions): string {
  const quote = (value: string) =>
    options.platform === "win32"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", `'"'"'`)}'`;
  const cli = `${options.platform === "win32" ? "& " : ""}${quote(options.cliPath)}`;
  const target = `--instance ${options.instanceId} --home ${quote(options.home)} --json`;
  return `请通过以下本机 CLI 操作知产小栈Work（Agent CLI 为实验功能）。先阅读完整手册，再连接软件，最后按我提供的任务要求工作。

读取手册（完整手册直接返回，无需导出或上传文件）：
${cli} manual --json

连接当前软件实例（根据下方任务先准备本次授权申请 JSON，通过 --input 传入；格式见手册 requested 字段，不可将申请当作已获授权）：
${cli} connect ${target}

首次连接返回 pending、退出码 4，表示正在等待用户授权，并非运行失败。请明确告诉用户：需要点击系统授权通知，或切换到知产小栈Work，在中央弹窗中选择授权范围。
等待期间，每 3 秒查询已有请求，不要新建另一条授权请求：
${cli} pair poll ${target}

如果请求被拒绝、到期或软件关闭，停止等待并告知用户，不要自动重发。获批后再次执行连接命令，保存连接信息，再读取 capabilities 并仅在获准范围内工作。其他专利不可访问，全局权限需用户单独授予，禁止自行扩权。

新建授权每次固定最多 5 件。额度不足时停止新建，按手册 pair renew-create 请求用户续授权，并用返回的 pairId 执行 pair poll --id 查询；拒绝或到期后停止，不自动重发。续授权不改变已有专利权限。

后续每一条命令都必须使用上方 CLI 的完整路径，以及同一 --home、--instance 和 --profile；不要切换到默认连接目录。需要导入或导出时，先询问用户材料/保存位置，再按手册 workspace.select 让用户在软件中确认；取消时停止该文件操作，不得自行扩展路径权限。

我的任务要求：`;
}

export async function resolveAgentCliEntry(options: {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  platform: NodeJS.Platform;
}): Promise<string> {
  const entry = options.platform === "win32" ? "zxw.cmd" : "zxw";
  const roots = options.isPackaged
    ? [join(options.resourcesPath, "cli")]
    : [
        join(options.appPath, "cli"),
        join(options.appPath, "out", "cli"),
        join(dirname(options.appPath), "cli"),
      ];
  for (const root of roots) {
    const files = [
      join(root, entry),
      join(root, "index.cjs"),
      join(root, "runtime", options.platform === "win32" ? "node.exe" : "node"),
    ];
    if (
      await Promise.all(
        files.map((file) =>
          stat(file)
            .then((s) => s.isFile())
            .catch(() => false),
        ),
      ).then((found) => found.every(Boolean))
    )
      return join(root, entry);
  }
  throw new AutomationError("UNAVAILABLE", "CLI 入口未就绪，请使用包含 CLI 的安装包或先构建 CLI。");
}
