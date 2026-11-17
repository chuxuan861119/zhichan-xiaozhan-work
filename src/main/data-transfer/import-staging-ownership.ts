import { lstat, mkdir, open, readFile, realpath, rename, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { hasUnresolvedDataImport } from "./data-import-journal.js";
import { type OwnedPathIdentity, removeOwnedPath } from "./owned-path-cleanup.js";

export const IMPORT_STAGING_OWNERSHIP_FILE = "data-import-staging.json";
export const ImportStagingOwnershipSchema = z
  .object({
    version: z.literal(1),
    operationId: z.uuid(),
    libraryRoot: z.string(),
    userDataRoot: z.string(),
    roots: z
      .array(
        z
          .object({
            path: z.string(),
            identity: z
              .object({ device: z.string(), inode: z.string(), birthtimeNs: z.string() })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .length(2),
  })
  .strict();
type Record = z.infer<typeof ImportStagingOwnershipSchema>;
type Options = {
  applicationDataRoot: string;
  libraryRoot: string;
  userDataRoot: string;
  renameReceipt?: typeof rename;
};

export class ImportStagingOwnership {
  readonly #path: string;
  readonly #options: Options;
  #record: Record | undefined;
  #partialIdentity: OwnedPathIdentity | undefined;
  constructor(options: Options) {
    this.#options = {
      ...options,
      applicationDataRoot: resolve(options.applicationDataRoot),
      libraryRoot: resolve(options.libraryRoot),
      userDataRoot: resolve(options.userDataRoot),
    };
    this.#path = join(this.#options.applicationDataRoot, IMPORT_STAGING_OWNERSHIP_FILE);
  }
  get hasOwnedPreparation(): boolean {
    return this.#record !== undefined;
  }
  async begin(operationId: string): Promise<void> {
    z.uuid().parse(operationId);
    if ((await this.#exists(this.#path)) || (await this.#exists(`${this.#path}.partial`)))
      throw new Error("Unfinished import preparation");
    this.#record = {
      version: 1,
      operationId,
      libraryRoot: this.#options.libraryRoot,
      userDataRoot: this.#options.userDataRoot,
      roots: [
        {
          path: join(dirname(this.#options.libraryRoot), `.import-staging-${operationId}`),
          identity: null,
        },
        {
          path: join(dirname(this.#options.userDataRoot), `.import-user-data-${operationId}`),
          identity: null,
        },
      ],
    };
    await this.#save();
  }
  async register(path: string, identity: OwnedPathIdentity): Promise<void> {
    if (!this.#record) throw new Error("Missing preparation ownership");
    const root = this.#record.roots.find((root) => root.path === path);
    if (!root) throw new Error("Unexpected staging root");
    root.identity = { ...identity };
    await this.#save();
  }
  async finish(): Promise<void> {
    if (this.#partialIdentity) {
      await removeOwnedPath(`${this.#path}.partial`, this.#partialIdentity);
      this.#partialIdentity = undefined;
    }
    const info = await lstat(this.#path, { bigint: true }).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info) {
      const receipt = await this.#read(this.#path);
      if (!this.#record || receipt.operationId !== this.#record.operationId)
        throw new Error("Preparation owner changed");
      await removeOwnedPath(this.#path, {
        device: String(info.dev),
        inode: String(info.ino),
        birthtimeNs: String(info.birthtimeNs),
      });
    }
    this.#record = undefined;
  }
  async #save(): Promise<void> {
    await mkdir(this.#options.applicationDataRoot, { recursive: true });
    const partial = `${this.#path}.partial`;
    const handle = await open(partial, "wx", 0o600);
    try {
      const info = await handle.stat({ bigint: true });
      this.#partialIdentity = {
        device: String(info.dev),
        inode: String(info.ino),
        birthtimeNs: String(info.birthtimeNs),
      };
      await handle.writeFile(`${JSON.stringify(this.#record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await (this.#options.renameReceipt ?? rename)(partial, this.#path);
    this.#partialIdentity = undefined;
    await this.#sync();
  }
  async #sync(): Promise<void> {
    // Windows flushes each receipt file; directory handles cannot be fsynced by Node there.
    if (process.platform === "win32") return;
    const dir = await open(this.#options.applicationDataRoot, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  async #exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async #read(path: string): Promise<Record> {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 8192 ||
      (await realpath(path)).toLowerCase() !== path.toLowerCase()
    )
      throw new Error("Unsafe preparation receipt");
    const record = ImportStagingOwnershipSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const expected = [
      join(dirname(this.#options.libraryRoot), `.import-staging-${record.operationId}`),
      join(dirname(this.#options.userDataRoot), `.import-user-data-${record.operationId}`),
    ];
    if (
      record.libraryRoot !== this.#options.libraryRoot ||
      record.userDataRoot !== this.#options.userDataRoot ||
      record.roots.some((root, index) => root.path !== expected[index])
    )
      throw new Error("Preparation anchors changed");
    return record;
  }
  async recover(options: { exclusiveStartup: true }): Promise<void> {
    if (!options.exclusiveStartup) throw new Error("Startup ownership required");
    if (await hasUnresolvedDataImport(this.#options.applicationDataRoot)) return;
    const partial = `${this.#path}.partial`;
    if (await this.#exists(partial)) {
      // A complete interrupted replacement has newer root identities. It cannot
      // install anything: this receipt authorizes staging cleanup only.
      let candidate: Record | undefined;
      try {
        candidate = await this.#read(partial);
      } catch {
        // begin() must publish its receipt before creating any staging root.
        // A truncated first write therefore owns only this partial file.
        const info = await lstat(partial, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink() || (await realpath(partial)) !== partial)
          throw new Error("Unsafe partial receipt");
        await removeOwnedPath(partial, {
          device: String(info.dev),
          inode: String(info.ino),
          birthtimeNs: String(info.birthtimeNs),
        });
        if (await this.#exists(this.#path)) candidate = await this.#read(this.#path);
      }
      if (!candidate) return;
      if (await this.#exists(partial)) {
        if (await this.#exists(this.#path)) {
          const previous = await this.#read(this.#path);
          if (previous.operationId !== candidate.operationId)
            throw new Error("Preparation operation changed");
        }
        // Publish the newer identities before deleting anything. If cleanup
        // is interrupted again, the same durable receipt still owns the roots.
        await rename(partial, this.#path);
        await this.#sync();
      }
      this.#record = candidate;
    } else if (await this.#exists(this.#path)) this.#record = await this.#read(this.#path);
    else return;
    for (const root of this.#record.roots) {
      if (!(await this.#exists(root.path))) continue;
      if (root.identity) await removeOwnedPath(root.path, root.identity);
      else {
        const info = await lstat(root.path);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (await realpath(root.path)) !== root.path
        )
          throw new Error("Unknown preparation root");
        await rmdir(root.path); // No identity was recorded: remove empty intent only, never contents.
      }
    }
    await this.finish();
    await this.#sync();
  }
}
