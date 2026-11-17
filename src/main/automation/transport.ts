import { randomBytes } from "node:crypto";
import { chmod, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { ZodError } from "zod";
import {
  AUTOMATION_PROTOCOL_VERSION,
  type AutomationDescriptor,
  AutomationError,
  type AutomationRequest,
  AutomationRequestSchema,
  type AutomationResponse,
  MAX_AUTOMATION_FRAME,
} from "../../shared/automation/protocol.js";
import { privateDirectory } from "./paths.js";

export function errorResponse(error: unknown): AutomationResponse {
  const code =
    error instanceof AutomationError
      ? error.code
      : error instanceof ZodError
        ? "INVALID_INPUT"
        : ((error as { code?: string })?.code ?? "INTERNAL");
  const message =
    error instanceof AutomationError
      ? error.message
      : code === "INVALID_INPUT"
        ? "命令参数不符合要求，请按 capabilities 的输入结构或手册示例重试。"
        : code === "OPERATION_IN_PROGRESS"
          ? "正在执行全库操作，请稍后重试。"
          : code === "REVISION_CONFLICT"
            ? "文档版本已变化，请重新读取并生成方案。"
            : code === "ENOSPC"
              ? "磁盘空间不足。"
              : code === "EEXIST"
                ? "输出文件已存在，请换名。"
                : code === "EACCES" || code === "EPERM"
                  ? "文件访问权限不足。"
                  : "操作失败，请检查软件状态。";
  return {
    ok: false,
    protocolVersion: AUTOMATION_PROTOCOL_VERSION,
    error: {
      code,
      message,
      ...(error instanceof AutomationError && error.details !== undefined
        ? { details: error.details }
        : {}),
    },
  };
}

export class AutomationTransport {
  #server: Server | undefined;
  #lifecycle: Promise<void> = Promise.resolve();
  #sockets = new Set<Socket>();
  #file: string | undefined;
  descriptor: AutomationDescriptor | null = null;
  constructor(
    private readonly home: string,
    private readonly identity: Omit<AutomationDescriptor, "accessKey" | "endpoint">,
    private readonly execute: (request: AutomationRequest) => Promise<unknown>,
    private readonly authorizeResponse?: (request: AutomationRequest, value: unknown) => void,
    private readonly responseSent?: (request: AutomationRequest, value: unknown) => void,
  ) {}

  start(): Promise<void> {
    return this.#serialize(() => this.#start());
  }
  #serialize(task: () => Promise<void>): Promise<void> {
    const result = this.#lifecycle.then(task);
    this.#lifecycle = result.catch(() => undefined);
    return result;
  }
  async #start(): Promise<void> {
    if (this.#server) return;
    const root = await privateDirectory(this.home);
    const registry = await privateDirectory(join(root, "instances"));
    const accessKey = randomBytes(32).toString("hex");
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\zxw-${process.pid}-${accessKey.slice(0, 24)}`
        : join(root, `s-${accessKey.slice(0, 16)}.sock`);
    if (process.platform !== "win32" && Buffer.byteLength(endpoint) > 100)
      throw new AutomationError(
        "SOCKET_PATH_TOO_LONG",
        "自动化目录路径过长，请使用更短的 ZXW_HOME。",
      );
    const descriptor = { ...this.identity, endpoint, accessKey };
    const server = createServer((socket) => {
      if (this.#sockets.size >= 32) {
        socket.destroy();
        return;
      }
      this.#sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => this.#sockets.delete(socket));
      socket.setTimeout(15000, () => socket.destroy());
      let bytes = Buffer.alloc(0);
      let responding = false;
      socket.on("data", (chunk) => {
        if (responding) return;
        bytes = Buffer.concat([bytes, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
        if (bytes.length > MAX_AUTOMATION_FRAME + 4) {
          socket.destroy();
          return;
        }
        if (bytes.length < 4) return;
        const length = bytes.readUInt32BE(0);
        if (length > MAX_AUTOMATION_FRAME || length === 0) {
          socket.destroy();
          return;
        }
        if (bytes.length < length + 4) return;
        responding = true;
        // The frame idle timeout must not interrupt an admitted request. The client bounds its wait.
        socket.setTimeout(0);
        void (async () => {
          let response: AutomationResponse;
          let admittedRequest: AutomationRequest | undefined;
          try {
            const raw: unknown = JSON.parse(bytes.subarray(4, length + 4).toString("utf8"));
            if (
              !raw ||
              typeof raw !== "object" ||
              !("accessKey" in raw) ||
              raw.accessKey !== accessKey
            )
              throw new AutomationError("AUTH_REQUIRED", "连接未获授权。");
            if (!("protocolVersion" in raw) || raw.protocolVersion !== AUTOMATION_PROTOCOL_VERSION)
              throw new AutomationError(
                "PROTOCOL_MISMATCH",
                "CLI 与软件协议不兼容，请使用当前软件附带的 CLI。",
              );
            const parsed = AutomationRequestSchema.safeParse(raw);
            if (!parsed.success)
              throw new AutomationError("INVALID_INPUT", "请求格式或协议版本无效。");
            const request = parsed.data;
            if (
              request.instanceId !== descriptor.instanceId ||
              request.libraryId !== descriptor.libraryId
            )
              throw new AutomationError("INSTANCE_CHANGED", "实例或文档库已变化，请重新连接。");
            const value = await this.execute(request);
            this.authorizeResponse?.(request, value);
            response = { ok: true, protocolVersion: AUTOMATION_PROTOCOL_VERSION, value };
            admittedRequest = request;
          } catch (error) {
            response = errorResponse(error);
          }
          const body = Buffer.from(JSON.stringify(response));
          if (body.length > MAX_AUTOMATION_FRAME) {
            response = errorResponse(
              new AutomationError("RESULT_TOO_LARGE", "结果过大，请缩小读取范围。"),
            );
          }
          const output = Buffer.from(JSON.stringify(response));
          const header = Buffer.alloc(4);
          header.writeUInt32BE(output.length);
          const sent = response;
          socket.end(Buffer.concat([header, output]), () => {
            if (sent.ok && admittedRequest && !socket.destroyed)
              this.responseSent?.(admittedRequest, sent.value);
          });
        })();
      });
    });
    // Error listener stays attached after listen, so a runtime socket failure cannot crash the app.
    server.on("error", () => {
      for (const socket of this.#sockets) socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.#server = server;
    try {
      if (process.platform !== "win32") await chmod(endpoint, 0o600);
      this.#file = join(registry, `${descriptor.instanceId}.json`);
      await writeFile(this.#file, JSON.stringify(descriptor), { flag: "wx", mode: 0o600 });
      this.descriptor = descriptor;
    } catch (error) {
      await this.#close();
      throw error;
    }
  }
  close(): Promise<void> {
    return this.#serialize(() => this.#close());
  }
  async #close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.descriptor = null;
    for (const socket of this.#sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.#file) {
      await unlink(this.#file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      this.#file = undefined;
    }
  }
}
