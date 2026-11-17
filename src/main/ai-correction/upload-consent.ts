import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

const ReceiptSchema = z
  .object({ version: z.literal(1), origins: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(200) })
  .strict();

/** Ask at the actual transport destination, never rely on renderer uploadConfirmed flags. */
export class AiUploadConsent {
  #pending: Promise<void> = Promise.resolve();
  constructor(private readonly userData: string) {}
  ensure(
    endpoint: URL,
    ask: (origin: string) => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (endpoint.origin === "http://127.0.0.1:11434") {
      signal?.throwIfAborted();
      return Promise.resolve();
    }
    const result = this.#pending.then(async () => {
      signal?.throwIfAborted();
      const path = join(this.userData, "ai-upload-consent.json");
      const digest = createHash("sha256").update(endpoint.origin).digest("hex");
      let origins: string[] = [];
      try {
        origins = ReceiptSchema.parse(JSON.parse(await readFile(path, "utf8"))).origins;
      } catch {
        /* Missing or damaged receipts require a fresh explicit decision. */
      }
      if (origins.includes(digest)) return;
      if (!(await ask(endpoint.origin)))
        throw Object.assign(new Error("已取消向 AI 服务发送内容。"), {
          code: "AI_UPLOAD_CANCELLED",
        });
      signal?.throwIfAborted();
      await writeFileAtomic(
        path,
        `${JSON.stringify({ version: 1, origins: [...origins.slice(-199), digest] })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    });
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
