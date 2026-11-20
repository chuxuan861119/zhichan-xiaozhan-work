import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, type FileHandle, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** COPYFILE_EXCL prevents racing another export from overwriting an existing file. */
export async function writeTemporaryImageExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.image-export-${randomUUID()}.tmp`);
  let created = false,
    file: FileHandle | undefined;
  try {
    file = await open(temporary, "wx");
    created = true;
    await file.writeFile(bytes);
    await file.close();
    file = undefined;
    await copyFile(temporary, path, constants.COPYFILE_EXCL);
  } finally {
    // Only this operation's private scratch file is removed; never the destination.
    await file?.close().catch(() => {});
    if (created) await unlink(temporary).catch(() => {});
  }
}
