import { createHash, randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { privateDirectory } from "../main/automation/paths.js";
import {
  AUTOMATION_COMMANDS,
  AUTOMATION_PROTOCOL_VERSION,
  type AutomationDescriptor,
  AutomationError,
  type AutomationResponse,
  MAX_AUTOMATION_FRAME,
} from "../shared/automation/protocol.js";

declare const __AUTOMATION_MANUAL__: string;
declare const __CLI_VERSION__: string;
export function automationHome(): string {
  return (
    process.env.ZXW_HOME ??
    join(
      process.platform === "win32"
        ? (process.env.APPDATA ?? homedir())
        : process.platform === "darwin"
          ? join(homedir(), "Library", "Application Support")
          : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")),
      "zxw",
    )
  );
}
type Profile = z.infer<typeof ProfileSchema>;
export async function discover(home: string): Promise<AutomationDescriptor[]> {
  let files: string[];
  try {
    files = await readdir(join(home, "instances"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const descriptors: AutomationDescriptor[] = [];
  for (const file of files.filter((f) => /^[a-f0-9-]{36}\.json$/u.test(f))) {
    try {
      const raw = await readFile(join(home, "instances", file));
      if (raw.length > 65536) continue;
      const descriptor = z
        .object({
          instanceId: z.string().uuid(),
          libraryId: z.string().uuid(),
          accessKey: z.string().min(32).max(128),
          endpoint: z.string().min(1).max(32768),
          protocolVersion: z.number().int().positive(),
          version: z.string().max(100),
          label: z.string().max(200),
          pid: z.number().int().positive(),
        })
        .strict()
        .parse(JSON.parse(raw.toString("utf8")));
      if (file !== descriptor.instanceId + ".json") continue;
      const response = await send(
        descriptor,
        "version",
        {},
        { clientProof: randomBytes(32).toString("hex") },
        randomUUID(),
        500,
      ).catch((error) => {
        if (error instanceof AutomationError && error.code === "PROTOCOL_MISMATCH")
          return { ok: true as const };
        throw error;
      });
      if (response.ok) descriptors.push(descriptor as AutomationDescriptor);
    } catch {
      // A crashed instance or incomplete registry write must not hide other live instances.
    }
  }
  return descriptors;
}
export function send(
  descriptor: AutomationDescriptor,
  command: string,
  payload: Record<string, unknown>,
  profile: Profile,
  requestId: string,
  timeoutMs: number,
): Promise<AutomationResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(descriptor.endpoint);
    let bytes = Buffer.alloc(0);
    let sent = false;
    socket.setTimeout(timeoutMs, () =>
      socket.destroy(
        new AutomationError("WAIT_TIMEOUT", "等待超时；任务可能仍在执行，请按原 requestId 查询。", {
          requestId,
          command,
        }),
      ),
    );
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      reject(
        error instanceof AutomationError
          ? error
          : sent
            ? new AutomationError(
                "CONNECTION_LOST",
                "连接中断；任务结果未知，请按原 requestId 查询。",
                { command, requestId },
              )
            : error,
      );
    });
    socket.once("connect", () => {
      const body = Buffer.from(
        JSON.stringify({
          protocolVersion: AUTOMATION_PROTOCOL_VERSION,
          instanceId: descriptor.instanceId,
          libraryId: descriptor.libraryId,
          accessKey: descriptor.accessKey,
          command,
          requestId,
          ...(profile.token ? { token: profile.token } : {}),
          clientProof: profile.clientProof,
          payload,
        }),
      );
      if (body.byteLength > MAX_AUTOMATION_FRAME) {
        socket.destroy(new AutomationError("TOO_LARGE", "请求过大，请缩小输入。"));
        return;
      }
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      sent = true;
      socket.write(Buffer.concat([header, body]));
    });
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (bytes.length > MAX_AUTOMATION_FRAME + 4) {
        socket.destroy(new AutomationError("INVALID_RESPONSE", "结果大小无效。"));
        return;
      }
      if (bytes.length < 4) return;
      const length = bytes.readUInt32BE(0);
      if (length > MAX_AUTOMATION_FRAME) {
        socket.destroy(new AutomationError("INVALID_RESPONSE", "结果大小无效。"));
        return;
      }
      if (bytes.length < length + 4) return;
      try {
        const value = JSON.parse(bytes.subarray(4, length + 4).toString("utf8"));
        socket.end();
        if (value.protocolVersion !== AUTOMATION_PROTOCOL_VERSION)
          throw new AutomationError(
            "PROTOCOL_MISMATCH",
            "CLI 与软件协议不兼容，请使用当前软件附带的 CLI。",
          );
        resolve(value);
      } catch (error) {
        socket.destroy(
          error instanceof AutomationError
            ? error
            : new AutomationError("INVALID_RESPONSE", "软件返回的结果无效。"),
        );
      }
    });
    socket.once("end", () => {
      if (bytes.length < 4 || bytes.length < bytes.readUInt32BE(0) + 4)
        reject(
          new AutomationError("CONNECTION_LOST", "连接中断；请按原 requestId 查询操作状态。", {
            command,
            requestId,
          }),
        );
    });
  });
}
const HELP = `zxw — 知产小栈Work 本地 agent CLI\n
先在软件 设置 → Agent CLI 中开启入口，再执行 zxw connect 并在软件中批准。\n
zxw instance list --json\n
zxw connect --instance <instance-id> --profile default --json\n
zxw capabilities --json\n
zxw patent list --json\n
zxw patent create --input create.json --request-id <唯一ID> --json\n
zxw patent read --patent-id <ID> --json\n
zxw change prepare --input change.json --json\n
zxw change apply --patent-id <ID> --change-id <ID> --request-id <唯一ID> --json\n
zxw operation status --request-id <原ID> --command change.apply --json\n
zxw patent export --input export.json --request-id <唯一ID> --json\n
zxw manual --output agent-cli-manual.md\n
输入文件为 UTF-8 JSON；--input - 读取 stdin。普通命令 stdout 始终返回一个 JSON 对象。\n
Ctrl+C 仅停止客户端等待；取消任务请使用 operation cancel。应用关闭后需重新 connect。`;
const strings = [
  "profile",
  "instance",
  "home",
  "input",
  "request-id",
  "timeout",
  "label",
  "patent-id",
  "patent-type",
  "name",
  "customer",
  "book-kind",
  "change-id",
  "asset-handle",
  "asset-id",
  "session-id",
  "variant",
  "path",
  "output",
  "format",
  "id",
  "command",
  "action",
  "file-name",
  "expected-hash",
  "expected-state",
  "document-id",
  "title",
  "scope",
];
const numbers = ["expected-revision", "revision", "offset", "limit"];
const booleans = ["json", "persisted", "sync", "help"];
const keys: Record<string, string> = {
  "document-id": "documentId",
  "file-name": "fileName",
  "expected-hash": "expectedHash",
  "expected-state": "expectedState",
  "patent-id": "patentId",
  "patent-type": "patentType",
  "book-kind": "bookKind",
  "change-id": "changeId",
  "asset-handle": "assetHandle",
  "asset-id": "assetId",
  "session-id": "sessionId",
  "expected-revision": "expectedRevision",
};
const READ_ONLY_COMMANDS = new Set([
  "version",
  "capabilities",
  "doctor",
  "pair.begin",
  "pair.poll",
  "pair.renew-create",
  "patent.list",
  "patent.search",
  "patent.read",
  "patent.inspect",
  "docx.preview",
  "docx.preview-asset",
  "flowchart.list",
  "flowchart.read",
  "template.list",
  "template.describe",
  "change.inspect",
  "asset.read",
  "asset.preview",
  "patent.printers",
  "operation.status",
  "history.list",
  "history.preview",
  "manual",
]);
const SIDE_EFFECTS: ReadonlySet<string> = new Set(
  AUTOMATION_COMMANDS.filter(
    (command) =>
      command !== "workspace.select" &&
      !READ_ONLY_COMMANDS.has(command) &&
      !command.endsWith(".read"),
  ),
);
export type CliIo = { stdout(value: string): void; stderr(value: string): void };
export async function runCli(
  argv: string[],
  io: CliIo = { stdout: (v) => process.stdout.write(v), stderr: (v) => process.stderr.write(v) },
): Promise<number> {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        ...Object.fromEntries(
          [...strings, ...numbers].map((key) => [key, { type: "string" as const }]),
        ),
        ...Object.fromEntries(booleans.map((key) => [key, { type: "boolean" as const }])),
      },
    });
    const values = parsed.values as Record<string, string | boolean | undefined>;
    const command = parsed.positionals.join(".");
    const output = (value: unknown) => io.stdout(`${JSON.stringify(value)}\n`);
    if (!command || command === "help" || values.help) {
      if (values.json)
        output({ ok: true, value: { help: HELP }, protocolVersion: AUTOMATION_PROTOCOL_VERSION });
      else io.stdout(`${HELP}\n`);
      return 0;
    }
    if (command === "version") {
      output({
        ok: true,
        value: {
          version: typeof __CLI_VERSION__ === "undefined" ? "development" : __CLI_VERSION__,
          protocolVersion: AUTOMATION_PROTOCOL_VERSION,
        },
        protocolVersion: AUTOMATION_PROTOCOL_VERSION,
      });
      return 0;
    }
    if (command === "manual") {
      const manual = typeof __AUTOMATION_MANUAL__ === "undefined" ? HELP : __AUTOMATION_MANUAL__;
      if (typeof values.output === "string") {
        await writeFile(values.output, manual, { flag: "wx", mode: 0o600 });
        output({
          ok: true,
          value: { path: values.output },
          protocolVersion: AUTOMATION_PROTOCOL_VERSION,
        });
      } else if (values.json)
        output({
          ok: true,
          value: { markdown: manual },
          protocolVersion: AUTOMATION_PROTOCOL_VERSION,
        });
      else io.stdout(manual);
      return 0;
    }
    const home = typeof values.home === "string" ? values.home : automationHome();
    const descriptors = await discover(home);
    if (command === "instance.list") {
      output({
        ok: true,
        value: { instances: descriptors.map(({ accessKey: _, ...d }) => d) },
        protocolVersion: AUTOMATION_PROTOCOL_VERSION,
      });
      return 0;
    }
    const profileName = typeof values.profile === "string" ? values.profile : "default";
    if (!/^[a-zA-Z0-9_-]{1,60}$/u.test(profileName))
      throw new AutomationError("INVALID_PROFILE", "profile 仅允许字母、数字、下划线或短横线。");
    const profileDirectory = await privateDirectory(join(home, "profiles"));
    const profilePath = join(profileDirectory, `${profileName}.json`);
    let profile = await loadOrCreateProfile(profilePath);
    const descriptor =
      typeof values.instance === "string"
        ? descriptors.find((d) => d.instanceId === values.instance)
        : command === "connect"
          ? descriptors.length === 1 &&
            (!profile.libraryId || descriptors[0]?.libraryId === profile.libraryId)
            ? descriptors[0]
            : undefined
          : descriptors.find(
              (d) => d.instanceId === profile.instanceId && d.libraryId === profile.libraryId,
            );
    if (!descriptor) {
      if (descriptors.length > 1 || (descriptors.length && command === "connect"))
        throw new AutomationError(
          "INSTANCE_REQUIRED",
          "请用 instance list 查看实例，并通过 --instance 明确选择。",
        );
      throw new AutomationError(
        "APP_NOT_RUNNING",
        "未找到已绑定实例；请启动软件、开启Agent CLI并执行 connect。",
      );
    }
    let payload: Record<string, unknown> = {};
    if (typeof values.input === "string") {
      let bytes: Buffer;
      if (values.input === "-") {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of process.stdin) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          length += buffer.length;
          if (length > MAX_AUTOMATION_FRAME) throw new AutomationError("TOO_LARGE", "输入过大。");
          chunks.push(buffer);
        }
        bytes = Buffer.concat(chunks);
      } else {
        const handle = await open(values.input, "r");
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > MAX_AUTOMATION_FRAME)
            throw new AutomationError("TOO_LARGE", "输入文件不是普通文件或超出大小限制。");
          const chunks: Buffer[] = [];
          let total = 0;
          for (;;) {
            const chunk = Buffer.allocUnsafe(65536);
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            total += bytesRead;
            if (total > MAX_AUTOMATION_FRAME) throw new AutomationError("TOO_LARGE", "输入过大。");
            chunks.push(chunk.subarray(0, bytesRead));
          }
          bytes = Buffer.concat(chunks, total);
        } finally {
          await handle.close();
        }
      }
      if (bytes.length > MAX_AUTOMATION_FRAME) throw new AutomationError("TOO_LARGE", "输入过大。");
      const input: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ""),
      );
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new AutomationError("INVALID_INPUT", "输入必须为 JSON 对象。");
      payload = input as Record<string, unknown>;
    }
    for (const key of [...strings, ...numbers, "persisted", "sync"]) {
      if (["profile", "instance", "home", "input", "request-id", "timeout"].includes(key)) continue;
      const value = values[key];
      if (value === undefined) continue;
      payload[keys[key] ?? key] = numbers.includes(key) ? Number(value) : value;
    }
    if (
      (command === "operation.status" || command === "operation.cancel") &&
      typeof values["request-id"] === "string"
    )
      payload.requestId = values["request-id"];
    const requestId =
      typeof values["request-id"] === "string" && command !== "operation.status"
        ? values["request-id"]
        : randomUUID();
    const timeout = Number(values.timeout ?? 30000);
    if (!Number.isFinite(timeout) || timeout < 100 || timeout > 600000)
      throw new AutomationError("INVALID_TIMEOUT", "timeout 必须在 100 到 600000 毫秒之间。");
    if (SIDE_EFFECTS.has(command)) {
      const journalDirectory = join(profileDirectory, "requests");
      await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(journalDirectory, `${createHashId(command, requestId)}.json`),
        JSON.stringify({
          requestId,
          command,
          instanceId: descriptor.instanceId,
          libraryId: descriptor.libraryId,
          recordedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      io.stderr(`requestId=${requestId} command=${command}\n`);
    }
    if (descriptor.protocolVersion !== AUTOMATION_PROTOCOL_VERSION)
      throw new AutomationError(
        "PROTOCOL_MISMATCH",
        "CLI 与软件协议不兼容，请使用当前软件附带的 CLI。",
      );
    const response = await send(
      descriptor,
      command === "connect" ? "pair.begin" : command,
      payload,
      profile,
      requestId,
      timeout,
    );
    if (
      command === "connect" &&
      response.ok &&
      typeof response.value === "object" &&
      response.value !== null
    ) {
      const value = response.value as { status: string; token?: string };
      if (value.status === "authorized" && value.token) {
        profile = {
          ...profile,
          token: value.token,
          instanceId: descriptor.instanceId,
          libraryId: descriptor.libraryId,
        };
        await writeFileAtomic(profilePath, JSON.stringify(profile), { mode: 0o600 });
        output({ ...response, value: { ...value, token: undefined } });
        return 0;
      }
      output(response);
      return 4;
    }
    const publicResponse =
      response.ok &&
      response.value &&
      typeof response.value === "object" &&
      "token" in response.value
        ? { ...response, value: { ...response.value, token: undefined } }
        : response;
    output(publicResponse);
    if (!response.ok) return errorExitCode(response.error.code, 1);
    const result = response.value as {
      status?: string;
      result?: { error?: { code?: string } };
    } | null;
    if (result?.status === "pending") return 4;
    if (result?.status === "failed") return errorExitCode(result.result?.error?.code ?? "", 1);
    return result?.status === "cancelled" || result?.status === "recovery_required" ? 1 : 0;
  } catch (error) {
    const nativeCode = (error as NodeJS.ErrnoException).code;
    const failure =
      error instanceof AutomationError
        ? error
        : new AutomationError(
            nativeCode === "ECONNREFUSED" || nativeCode === "ENOENT"
              ? "APP_NOT_RUNNING"
              : "INVALID_INPUT",
            nativeCode === "ECONNREFUSED" || nativeCode === "ENOENT"
              ? "软件未运行或文件不存在。"
              : "参数、输入文件或连接无效。",
          );
    io.stdout(
      `${JSON.stringify({
        ok: false,
        protocolVersion: AUTOMATION_PROTOCOL_VERSION,
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.details === undefined ? {} : { details: failure.details }),
        },
      })}\n`,
    );
    return errorExitCode(failure.code, 2);
  }
}
function createHashId(command: string, requestId: string): string {
  return createHash("sha256").update(`${command}\0${requestId}`).digest("hex");
}

function errorExitCode(code: string, fallback: number): number {
  if (code === "INVALID_INPUT") return 2;
  if (["AUTH_REQUIRED", "AUTH_REVOKED", "AUTH_CHANGED", "AUTOMATION_DISABLED"].includes(code))
    return 4;
  if (["SCOPE_DENIED", "READ_ONLY_RECOVERY", "UNSAFE_PATH"].includes(code)) return 6;
  if (
    [
      "REVISION_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
      "EDITOR_DIRTY",
      "EDITOR_CHANGED",
      "EDITOR_OPEN",
      "EDITOR_BUSY",
      "OPERATION_IN_PROGRESS",
    ].includes(code)
  )
    return 5;
  if (["WAIT_TIMEOUT", "CONNECTION_LOST", "INVALID_RESPONSE", "EDITOR_TIMEOUT"].includes(code))
    return 7;
  return fallback;
}
const ProfileSchema = z
  .object({
    clientProof: z.string().regex(/^[a-f0-9]{64}$/u),
    token: z.string().min(32).max(128).optional(),
    instanceId: z.string().uuid().optional(),
    libraryId: z.string().uuid().optional(),
  })
  .strict();
async function loadOrCreateProfile(path: string): Promise<Profile> {
  try {
    return ProfileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const candidate = { clientProof: randomBytes(32).toString("hex") };
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    await writeFileAtomic(temp, JSON.stringify(candidate), { mode: 0o600 });
    try {
      await link(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return ProfileSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
