import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

const LocationSchema = z
  .object({
    version: z.literal(1),
    baseRoot: z.string(),
    active: z.object({ path: z.string(), id: z.string().uuid() }).nullable(),
    pending: z
      .object({
        source: z.string(),
        target: z.string(),
        id: z.string().uuid(),
        approved: z.boolean(),
      })
      .nullable(),
  })
  .strict();
type LocationState = z.infer<typeof LocationSchema>;
export class LibraryLocationError extends Error {}

function inside(parent: string, child: string) {
  const path = relative(parent, child);
  return !path || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
async function hash(path: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function inventory(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error("文档库包含链接，不能安全迁移");
    if (entry.isDirectory()) result.push(`${name}${sep}`, ...(await inventory(root, name)));
    else if (entry.isFile()) result.push(name);
    else throw new Error("文档库包含不支持的文件");
  }
  return result.sort();
}

/** Location changes are executed before opening any library runtime. Sources are never deleted. */
export class LibraryLocation {
  private busy = false;
  constructor(
    private readonly file: string,
    private readonly baseRoot: string,
  ) {}
  private async read(): Promise<LocationState> {
    try {
      const state = LocationSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
      if (resolve(state.baseRoot) !== resolve(this.baseRoot)) throw new Error("不同实例的位置记录");
      if (state.active && !isAbsolute(state.active.path)) throw new Error("无效路径");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, baseRoot: this.baseRoot, active: null, pending: null };
      throw new LibraryLocationError(
        "文档库位置记录损坏或与当前实例不符。请保留原文档库和备份文件，确认原库位置与访问权限；软件不会创建空库。",
      );
    }
  }
  private async save(state: LocationState) {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify(state), { fsync: true });
  }
  private async activeRoot(state: LocationState) {
    if (!state.active) return this.baseRoot;
    try {
      const root = await realpath(state.active.path);
      if (root !== resolve(state.active.path)) throw new Error("链接路径");
      if ((await readFile(`${root}.location-id`, "utf8")) !== state.active.id)
        throw new Error("身份不符");
      if (!(await lstat(join(root, "library.sqlite3"))).isFile()) throw new Error("数据库缺失");
      return root;
    } catch {
      throw new LibraryLocationError(
        `文档库位置不可用：${state.active.path}。请连接原磁盘并确认文件夹仍在原位置；软件不会创建空库或切换到旧副本。`,
      );
    }
  }
  async status() {
    const state = await this.read();
    return { activeRoot: await this.activeRoot(state), pending: state.pending };
  }

  async activateRecovered(root: string): Promise<void> {
    if (this.busy) throw new Error("正在处理文档库位置，请稍后重试。");
    this.busy = true;
    try {
      const state = await this.read();
      const source = await realpath(await this.activeRoot(state));
      const target = await realpath(root);
      if (inside(source, target) || inside(target, source) || inside(target, this.file))
        throw new Error("恢复库必须独立于原文档库和应用设置目录。");
      const database = new DatabaseSync(join(target, "library.sqlite3"), { readOnly: true });
      try {
        const rows = database.prepare("PRAGMA integrity_check").all();
        if (rows.length !== 1 || rows[0]?.integrity_check !== "ok")
          throw new Error("恢复库完整性检查失败。");
      } finally {
        database.close();
      }
      let id: string = randomUUID();
      try {
        await writeFile(`${target}.location-id`, id, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        id = z
          .string()
          .uuid()
          .parse(await readFile(`${target}.location-id`, "utf8"));
      }
      const marker = await open(`${target}.location-id`, "r+");
      try {
        await marker.sync();
      } finally {
        await marker.close();
      }
      await this.save({ ...state, active: { path: target, id }, pending: null });
    } finally {
      this.busy = false;
    }
  }

  async schedule(parent: string): Promise<string> {
    if (this.busy) throw new Error("正在处理文档库迁移，请稍后重试");
    this.busy = true;
    try {
      const state = await this.read();
      if (state.pending) throw new Error("已有待执行的迁移，请先完成或取消退出操作");
      const source = await realpath(await this.activeRoot(state));
      if (inside(source, this.file)) throw new Error("文档库与应用设置目录重叠，不能自动迁移");
      const destinationParent = await realpath(parent);
      if (inside(source, destinationParent)) throw new Error("请选择与当前文档库独立的文件夹");
      // Keep the bootstrap location outside the relocated tree.
      const id = randomUUID();
      const target = join(destinationParent, `知产小栈文档库-${id.slice(0, 8)}`);
      if (inside(target, this.file)) throw new Error("不能选择应用设置所在的目录");
      const probe = join(destinationParent, `.library-write-test-${id}`);
      const handle = await open(probe, "wx");
      await handle.close();
      const { unlink } = await import("node:fs/promises");
      await unlink(probe);
      await this.save({ ...state, pending: { source, target, id, approved: false } });
      return target;
    } finally {
      this.busy = false;
    }
  }
  async cancel(): Promise<void> {
    const state = await this.read();
    if (state.pending) await this.save({ ...state, pending: null });
  }
  async approveAfterShutdown(): Promise<void> {
    const state = await this.read();
    if (state.pending) await this.save({ ...state, pending: { ...state.pending, approved: true } });
  }
  async resolveStartup(
    onProgress?: (completed: number, total: number) => void,
  ): Promise<{ root: string; notice?: string }> {
    const state = await this.read();
    const root = await this.activeRoot(state);
    const pending = state.pending;
    if (!pending) return { root };
    onProgress?.(0, 0);
    try {
      if (!pending.approved) throw new Error("上次未正常退出或已取消迁移，请重新选择迁移");
      if ((await realpath(root)) !== pending.source) throw new Error("原文档库位置已改变");
      const shutdown = JSON.parse(await readFile(join(root, "last-run-state.json"), "utf8"));
      if (shutdown.cleanShutdown !== true) throw new Error("上次未正常退出，请完成恢复后重新迁移");
      if (
        !isAbsolute(pending.target) ||
        inside(root, pending.target) ||
        inside(pending.target, root)
      )
        throw new Error("迁移路径无效");
      await mkdir(pending.target); // Exclusive destination. Never merge into another library.
      if ((await realpath(pending.target)) !== resolve(pending.target))
        throw new Error("迁移目标不能使用链接");
      const files = await inventory(root);
      let completed = 0;
      onProgress?.(0, files.length);
      for (const name of files) {
        const source = join(root, name),
          target = join(pending.target, name);
        if (name.endsWith(sep)) {
          await mkdir(target, { recursive: true });
          onProgress?.(++completed, files.length);
          continue;
        }
        await mkdir(dirname(target), { recursive: true });
        const before = await hash(source);
        const info = await stat(source);
        await copyFile(source, target, constants.COPYFILE_EXCL);
        if ((await hash(target)) !== before || (await hash(source)) !== before)
          throw new Error("文件复制校验失败");
        await utimes(target, info.atime, info.mtime);
        const handle = await open(target, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        onProgress?.(++completed, files.length);
      }
      if (JSON.stringify(await inventory(root)) !== JSON.stringify(files))
        throw new Error("迁移期间原文档库发生变化");
      const database = new DatabaseSync(join(pending.target, "library.sqlite3"), {
        readOnly: true,
      });
      try {
        const rows = database.prepare("PRAGMA integrity_check").all();
        if (rows.length !== 1 || rows[0]?.integrity_check !== "ok")
          throw new Error("数据库校验失败");
      } finally {
        database.close();
      }
      // A sibling marker survives the supported whole-library import/swap operation.
      await writeFile(`${pending.target}.location-id`, pending.id, { flag: "wx" });
      const marker = await open(`${pending.target}.location-id`, "r+");
      try {
        await marker.sync();
      } finally {
        await marker.close();
      }
      await this.save({
        ...state,
        active: { path: pending.target, id: pending.id },
        pending: null,
      });
      return {
        root: pending.target,
        notice: `文档库已迁移至 ${pending.target}。原文档库保留为安全副本，不再用于编辑。`,
      };
    } catch (error) {
      await this.save({ ...state, pending: null });
      return {
        root,
        notice: `迁移未完成，继续使用原文档库。${error instanceof Error ? error.message : "请检查目标磁盘"}。原文件未删除，已复制的目标副本也予以保留。`,
      };
    }
  }
}
