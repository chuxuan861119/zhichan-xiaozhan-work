import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { z } from "zod";
import type { AutomationLedger, OperationRecord } from "./ledger.js";
import { allowedPath } from "./paths.js";

const evidenceSchema = z
  .object({
    phase: z.literal("publishing"),
    target: z.string().max(32768),
    temp: z.string().max(32768),
    hash: z.string().regex(/^[a-f0-9]{64}$/u),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    device: z.union([
      z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/u),
      z.number().int().nonnegative(),
    ]),
    inode: z.union([z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/u), z.number().int().nonnegative()]),
    revision: z.number().int().nonnegative(),
    format: z.enum([
      "docx",
      "pdf",
      "patdoc",
      "png",
      "jpg",
      "jpeg",
      "bmp",
      "tif",
      "tiff",
      "svg",
      "dwg",
      "drawio",
      "zip",
      "zxwbackup",
    ]),
    warnings: z.array(z.unknown()).max(10000),
  })
  .strict();

/** Run only under a fresh grant and the library operation gate. Never retry publication. */
export async function recoverPublication(
  ledger: AutomationLedger,
  record: OperationRecord,
  roots: string[],
  assertAuthorized: () => void,
): Promise<void> {
  const parsed = evidenceSchema.safeParse(record.evidence);
  // An old, lossy Windows numeric identity cannot prove publication. Fail closed;
  // keep the receipt uncertain rather than republishing or inventing a file identity.
  if (!parsed.success) return;
  const evidence = parsed.data;
  let target: string;
  try {
    target = allowedPath(evidence.target, roots, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const info = await lstat(target, { bigint: true });
  if (
    info.size !== BigInt(evidence.size) ||
    info.dev !== BigInt(evidence.device) ||
    info.ino !== BigInt(evidence.inode)
  )
    return;
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (
      before.size !== BigInt(evidence.size) ||
      before.dev !== BigInt(evidence.device) ||
      before.ino !== BigInt(evidence.inode)
    )
      return;
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (;;) {
      assertAuthorized();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > evidence.size) return;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(allowedPath(target, roots, false), { bigint: true });
    if (
      size !== evidence.size ||
      hash.digest("hex") !== evidence.hash ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.size !== before.size ||
      current.mtimeNs !== before.mtimeNs ||
      current.ctimeNs !== before.ctimeNs
    )
      return;
  } finally {
    await handle.close();
  }
  assertAuthorized();
  ledger.update(
    record,
    "committed",
    {
      path: target,
      revision: evidence.revision,
      format: evidence.format,
      sha256: evidence.hash,
      warnings: evidence.warnings,
    },
    evidence,
  );
}
