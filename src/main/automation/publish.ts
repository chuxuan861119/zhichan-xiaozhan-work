import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { AutomationError } from "../../shared/automation/protocol.js";
import type { AutomationExportContext, PublicationEvidence } from "./export.js";
import { allowedPath, publishNewFile } from "./paths.js";

/** Publish a privately generated large file without buffering the complete package in memory. */
export async function publishAutomationFile(
  source: string,
  output: string,
  format: string,
  revision: number,
  context: AutomationExportContext,
  warnings: unknown[] = [],
): Promise<unknown> {
  if (extname(output).toLowerCase() !== `.${format}`)
    throw new AutomationError("INVALID_PATH", `输出文件扩展名必须是 .${format}。`);
  context.assertAuthorized();
  const roots = [context.grant.workspace.exportDirectory];
  const target = allowedPath(output, roots, true);
  const temp = join(dirname(target), `.zxw-${context.record.operationId}-${randomUUID()}.tmp`);
  let published = false;
  try {
    const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let size = 0;
    const hash = createHash("sha256");
    try {
      const before = await input.stat({ bigint: true });
      if (!before.isFile()) throw new AutomationError("UNSAFE_PATH", "导出源文件无效。");
      const outputHandle = await open(temp, "wx", 0o600);
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        for (;;) {
          context.assertAuthorized();
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          size += bytesRead;
          if (BigInt(size) > before.size)
            throw new AutomationError("UNSAFE_PATH", "导出源文件已变化。");
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          await outputHandle.writeFile(chunk);
        }
        await outputHandle.sync();
      } finally {
        await outputHandle.close();
      }
      const after = await input.stat({ bigint: true });
      if (
        BigInt(size) !== before.size ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        throw new AutomationError("UNSAFE_PATH", "导出源文件已变化。");
    } finally {
      await input.close();
    }
    const info = await stat(temp, { bigint: true });
    const digest = hash.digest("hex");
    const evidence: PublicationEvidence = {
      phase: "publishing",
      target,
      temp,
      hash: digest,
      size,
      device: info.dev.toString(),
      inode: info.ino.toString(),
      revision,
      format,
      warnings,
    };
    context.assertAuthorized();
    context.ledger.update(context.record, "running", null, evidence);
    publishNewFile(temp, target, roots);
    published = true;
    const result = { path: target, revision, format, sha256: digest, warnings };
    context.ledger.update(context.record, "committed", result, evidence);
    return result;
  } catch (error) {
    if (!published) context.ledger.update(context.record, "running", null, null);
    throw error;
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Publish immutable bytes using the same no-overwrite and receipt recovery contract as documents. */
export async function publishAutomationBytes(
  bytes: Uint8Array,
  output: string,
  format: string,
  revision: number,
  context: AutomationExportContext,
  warnings: unknown[] = [],
): Promise<unknown> {
  if (extname(output).toLowerCase() !== `.${format}`)
    throw new AutomationError("INVALID_PATH", `输出文件扩展名必须是 .${format}。`);
  context.assertAuthorized();
  const roots = [context.grant.workspace.exportDirectory];
  const target = allowedPath(output, roots, true);
  const temp = join(dirname(target), `.zxw-${context.record.operationId}-${randomUUID()}.tmp`);
  let published = false;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const saved = await readFile(temp);
    const info = await stat(temp, { bigint: true });
    const hash = createHash("sha256").update(saved).digest("hex");
    const evidence: PublicationEvidence = {
      phase: "publishing",
      target,
      temp,
      hash,
      size: saved.length,
      device: info.dev.toString(),
      inode: info.ino.toString(),
      revision,
      format,
      warnings,
    };
    context.assertAuthorized();
    context.ledger.update(context.record, "running", null, evidence);
    publishNewFile(temp, target, roots);
    published = true;
    const result = { path: target, revision, format, sha256: hash, warnings };
    context.ledger.update(context.record, "committed", result, evidence);
    return result;
  } catch (error) {
    if (!published) context.ledger.update(context.record, "running", null, null);
    throw error;
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
