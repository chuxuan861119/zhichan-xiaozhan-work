import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";

/** Atomic publication of files or directories, never replacing an existing target. */
export async function movePathNoReplace(source: string, target: string): Promise<void> {
  for (const path of [source, target]) {
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("Invalid absolute move path");
  }
  if (process.platform === "darwin") return moveNoReplaceMac(source, target);
  if (["openharmony", "ohos"].includes(process.platform))
    return moveNoReplaceHarmony(source, target);
  if (process.platform !== "win32") throw new Error("Unsupported atomic move platform");
  const script = `
$ErrorActionPreference='Stop'
$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))
$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))
try {
  if([IO.Directory]::Exists($s)){[IO.Directory]::Move($s,$t)}else{[IO.File]::Move($s,$t)}
  [Console]::Write('OK')
} catch {
  if([IO.File]::Exists($t) -or [IO.Directory]::Exists($t)){[Console]::Write('EEXIST')}
  elseif(($_.Exception.HResult -band 0xFFFF) -eq 112){[Console]::Write('ENOSPC')}
  else{[Console]::Write('EIO')}
  exit 1
}`;
  await new Promise<void>((done, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], timeout: 10_000 },
    );
    let output = "";
    child.stdout.on("data", (bytes) => {
      output += String(bytes);
      if (output.length > 128) child.kill();
    });
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.once("close", (code) =>
      code === 0 && output === "OK"
        ? done()
        : reject(Object.assign(new Error("Atomic move failed"), { code: output || "EIO" })),
    );
    child.stdin.end(
      `${Buffer.from(resolve(source), "utf8").toString("base64")}\n${Buffer.from(resolve(target), "utf8").toString("base64")}\n`,
    );
  });
}

export function macMoveExecutable(): string {
  const base =
    process.versions.electron && !process.defaultApp ? process.resourcesPath : process.cwd();
  return join(base, "resources", "platform-tools", "move-no-replace");
}

export async function moveNoReplaceMac(source: string, target: string): Promise<void> {
  return runMoveHelper(macMoveExecutable(), source, target);
}

export async function moveNoReplaceHarmony(source: string, target: string): Promise<void> {
  for (const path of [source, target]) {
    if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path) > 32768)
      throw new Error("Invalid absolute move path");
  }
  const native = createRequire(import.meta.url)(
    "/data/storage/el1/bundle/libs/arm64/move_no_replace.node",
  ) as {
    moveNoReplace(source: string, target: string): string;
  };
  const result = native.moveNoReplace(resolve(source), resolve(target));
  if (result !== "OK") throw Object.assign(new Error("Atomic move failed"), { code: result });
}

async function runMoveHelper(executable: string, source: string, target: string): Promise<void> {
  const fields = [source, target].map((path) => {
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("Invalid absolute move path");
    const data = Buffer.from(resolve(path), "utf8");
    if (!data.length || data.length > 32768) throw new Error("Invalid move path length");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(data.length);
    return Buffer.concat([length, data]);
  });
  const result = await new Promise<string>((resolveResult, reject) => {
    const child = spawn(executable, [], {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 10_000,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.length > 128) child.kill();
    });
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.once("close", (code, signal) =>
      resolveResult(
        code === 0 && !signal && output === "OK" ? "OK" : output === "OK" ? "EIO" : output || "EIO",
      ),
    );
    child.stdin.end(Buffer.concat(fields));
  });
  if (result !== "OK")
    throw Object.assign(new Error("Atomic move failed"), {
      code: ["EEXIST", "EXDEV", "ENOSPC", "EACCES", "ENOENT", "UNSUPPORTED_ATOMIC_SWAP"].includes(
        result,
      )
        ? result
        : "EIO",
    });
}
