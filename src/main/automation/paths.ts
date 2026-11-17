import { execFileSync } from "node:child_process";
import { constants, linkSync, lstatSync, realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AutomationError } from "../../shared/automation/protocol.js";

export async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink())
    throw new AutomationError("UNSAFE_DIRECTORY", "自动化配置目录不安全。");
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
$directory = New-Object System.IO.DirectoryInfo($env:ZXW_PRIVATE_DIRECTORY)
$directory.SetAccessControl($acl)`;
    // Only the DACL is modified; Set-Acl can request audit privileges on repeat calls.
    // Windows PowerShell must not inherit PowerShell 7's incompatible module lookup paths.
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"),
    );
    execFileSync(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        stdio: "ignore",
        timeout: 15000,
        env: { ...environment, ZXW_PRIVATE_DIRECTORY: path },
      },
    );
  } else await chmod(path, 0o700);
  return realpath(path);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Authorize receipt disclosure without reading the output or requiring it to still exist. */
export function assertOutputReceiptScope(path: string, roots: readonly string[]): void {
  if (!isAbsolute(path) || !roots.some((root) => inside(root, resolve(path))))
    throw new AutomationError("SCOPE_DENIED", "输出结果不在当前获准目录内。");
}

export function allowedPath(path: string, roots: readonly string[], output: boolean): string {
  if (!isAbsolute(path)) throw new AutomationError("INVALID_PATH", "请使用绝对路径。");
  const absolute = resolve(path);
  const candidate = output ? dirname(absolute) : absolute;
  const root = roots.find((r) => inside(r, absolute));
  if (!root) throw new AutomationError("SCOPE_DENIED", "路径不在获准目录内。");
  if (realpathSync(root) !== root) throw new AutomationError("SCOPE_DENIED", "授权目录已变化。");
  let current = root;
  for (const component of relative(root, candidate).split(sep).filter(Boolean)) {
    current = resolve(current, component);
    if (lstatSync(current).isSymbolicLink())
      throw new AutomationError("UNSAFE_PATH", "不能通过链接访问授权目录。");
  }
  if (realpathSync(candidate) !== candidate || !inside(root, candidate))
    throw new AutomationError("UNSAFE_PATH", "路径的实际目标已变化。");
  if (output) {
    try {
      lstatSync(absolute);
      throw new AutomationError("OUTPUT_EXISTS", "输出文件已存在，请换名。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } else if (!statSync(absolute).isFile())
    throw new AutomationError("INVALID_PATH", "输入必须是普通文件。");
  return absolute;
}

export async function readAllowedFile(
  path: string,
  roots: readonly string[],
  maxBytes: number,
): Promise<Uint8Array> {
  const absolute = allowedPath(path, roots, false);
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes)
      throw new AutomationError("TOO_LARGE", "输入文件超出允许范围。");
    const current = statSync(allowedPath(absolute, roots, false));
    if (before.dev !== current.dev || before.ino !== current.ino)
      throw new AutomationError("UNSAFE_PATH", "输入文件已被替换。");
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes)
      throw new AutomationError("TOO_LARGE", "输入文件超出允许范围。");
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Same-volume hard link provides atomic publication with no overwrite. */
export function publishNewFile(temp: string, target: string, roots: readonly string[]): void {
  allowedPath(target, roots, true);
  linkSync(temp, target);
}
