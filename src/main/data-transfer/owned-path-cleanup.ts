import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { parse, resolve } from "node:path";
import { macMoveExecutable } from "../platform/move-no-replace.js";

export type OwnedPathIdentity = Readonly<{ device: string; inode: string; birthtimeNs: string }>;

// Handles omit FILE_SHARE_DELETE: neither the root nor any opened ancestor can
// be replaced while descendants are visited. Reparse points are never traversed.
const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OwnedTreeCleanup {
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public FileTime Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool Delete; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h, int kind, ref Disposition info, uint size);
  static SafeFileHandle Open(string path, bool delete, out Info info) {
    var h = CreateFile(path, 0x80u | (delete ? 0x10000u : 0u), 3u, IntPtr.Zero, 3u, 0x02200000u, IntPtr.Zero);
    if (h.IsInvalid) { h.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    if (!GetFileInformationByHandle(h, out info) || (info.Attributes & 0x400u) != 0) {
      h.Dispose(); throw new IOException("Unsafe cleanup path");
    }
    return h;
  }
  static void Remove(string path, string inode, string birth) {
    Info info;
    using (var h = Open(path, true, out info)) {
      ulong id = ((ulong)info.IndexHigh << 32) | info.IndexLow;
      ulong ticks = ((ulong)info.Creation.High << 32) | info.Creation.Low;
      ulong nanos = (ticks - 116444736000000000UL) * 100UL;
      if (inode != null && (id.ToString() != inode || nanos.ToString() != birth)) throw new IOException("Cleanup ownership changed");
      if ((info.Attributes & 0x10u) != 0) {
        foreach (string child in Directory.GetFileSystemEntries(path)) Remove(child, null, null);
      }
      var disposition = new Disposition { Delete = true };
      if (!SetFileInformationByHandle(h, 4, ref disposition, 4)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
  public static void Run(string path, string inode, string birth) {
    path = Path.GetFullPath(path);
    string volume = Path.GetPathRoot(path);
    if (path == volume) throw new IOException("Cleanup root is a volume");
    var ancestors = new List<SafeFileHandle>();
    try {
      string parent = Path.GetDirectoryName(path);
      var paths = new Stack<string>();
      while (!String.IsNullOrEmpty(parent)) { paths.Push(parent); parent = Path.GetDirectoryName(parent); }
      foreach (string item in paths) { Info info; ancestors.Add(Open(item, false, out info)); }
      Remove(path, inode, birth);
    } finally { foreach (var h in ancestors) h.Dispose(); }
  }
}
'@
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  [OwnedTreeCleanup]::Run($request.path, $request.inode, $request.birthtimeNs)
  [Console]::Write('OK')
} catch { [Console]::Write('FAILED'); exit 1 }
`;

export async function removeOwnedPath(path: string, expected: OwnedPathIdentity): Promise<void> {
  const absolute = resolve(path);
  if (absolute === parse(absolute).root || absolute.includes("\0"))
    throw new Error("Unsafe cleanup root");
  const info = await lstat(absolute, { bigint: true }).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return; // Idempotent retry after deletion, before journal update.
  if (
    info.isSymbolicLink() ||
    String(info.dev) !== expected.device ||
    String(info.ino) !== expected.inode ||
    String(info.birthtimeNs) !== expected.birthtimeNs ||
    (await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()
  )
    throw new Error("Cleanup ownership changed");
  if (process.platform === "win32") {
    await new Promise<void>((resolveResult, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(windowsScript, "utf16le").toString("base64"),
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 },
      );
      let result = "";
      child.stdout.on("data", (chunk) => {
        result += String(chunk);
        if (result.length > 128) child.kill();
      });
      child.stderr.resume();
      child.once("error", reject);
      child.stdin.on("error", reject);
      child.once("close", (code) =>
        code === 0 && result === "OK" ? resolveResult() : reject(new Error("Owned cleanup failed")),
      );
      child.stdin.end(`${JSON.stringify({ path: absolute, ...expected })}\n`);
    });
    return;
  }
  if (["openharmony", "ohos"].includes(process.platform)) {
    const native = createRequire(import.meta.url)(
      "/data/storage/el1/bundle/libs/arm64/move_no_replace.node",
    ) as {
      removeOwned(path: string, device: string, inode: string, birth: string): string;
    };
    if (
      native.removeOwned(absolute, expected.device, expected.inode, expected.birthtimeNs) !== "OK"
    )
      throw new Error("Owned cleanup failed");
    return;
  }
  if (process.platform !== "darwin") throw new Error("Unsupported owned cleanup platform");
  const fields = [absolute, expected.device, expected.inode, expected.birthtimeNs].map((field) => {
    const bytes = Buffer.from(field, "utf8"),
      length = Buffer.alloc(4);
    if (!bytes.length || bytes.length > 32768 || field.includes("\0"))
      throw new Error("Unsafe cleanup field");
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  });
  await new Promise<void>((done, reject) => {
    const child = spawn(macMoveExecutable(), ["--remove-owned"], {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 120_000,
    });
    let result = "";
    child.stdout.on("data", (chunk) => {
      result += String(chunk);
      if (result.length > 128) child.kill();
    });
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.once("close", (code) =>
      code === 0 && result === "OK" ? done() : reject(new Error("Owned cleanup failed")),
    );
    child.stdin.end(Buffer.concat(fields));
  });
}
