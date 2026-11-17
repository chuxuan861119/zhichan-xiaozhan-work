import { randomUUID } from "node:crypto";
import {
  type Dirent,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  type TextPolishConversationSnapshot,
  TextPolishConversationSnapshotSchema,
  type TextPolishInputDraft,
  TextPolishInputDraftSchema,
  type TextPolishWorkspace,
} from "../../shared/ai-correction/text-polish-contract.js";
import {
  stripTextPolishReasoning,
  textPolishHistoryPathPattern,
} from "../../shared/data-transfer/text-polish-history.js";

const recordSchema = z
  .object({
    updatedAt: z.string(),
    title: z.string().trim().min(1).max(80).optional(),
    snapshot: TextPolishConversationSnapshotSchema,
  })
  .strict();
const activeSchema = z.object({ conversationId: z.uuid().nullable() }).strict();

export class TextPolishHistoryStore {
  private readonly metadata = new Map<
    string,
    { stamp: string; item: TextPolishWorkspace["history"][number] }
  >();
  private readonly draftMetadata = new Map<string, string>();
  private readonly draftWrites = new Map<string, Promise<void>>();
  private readonly migrationFailures = new Map<string, Error>();
  private readonly sessionReasoning = new Map<
    string,
    TextPolishConversationSnapshot["reasoningByTurn"]
  >();
  constructor(private readonly root: string) {
    // Migrate inactive histories too. Never follow links or overwrite unreadable JSON.
    let directories: Dirent[];
    try {
      if (!lstatSync(root).isDirectory()) return;
      directories = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.recordMigrationFailure(root, error);
      return;
    }
    for (const directory of directories) {
      if (!directory.isDirectory() || !z.uuid().safeParse(directory.name).success) continue;
      const path = join(root, directory.name);
      let files: Dirent[];
      try {
        files = readdirSync(path, { withFileTypes: true });
      } catch (error) {
        this.recordMigrationFailure(path, error);
        continue;
      }
      for (const file of files) {
        if (
          !file.isFile() ||
          !textPolishHistoryPathPattern.test(`text-polish-history/${directory.name}/${file.name}`)
        )
          continue;
        const filePath = join(path, file.name);
        try {
          const bytes = readFileSync(filePath);
          const stripped = stripTextPolishReasoning(bytes);
          if (stripped !== bytes) this.writeBytes(directory.name, file.name, stripped);
        } catch (error) {
          this.recordMigrationFailure(filePath, error);
        }
      }
    }
  }
  private recordMigrationFailure(path: string, cause: unknown) {
    this.migrationFailures.set(
      path,
      new Error("历史思考过程清理失败，原文件已保留。请检查磁盘空间与目录权限后重启软件。", {
        cause,
      }),
    );
  }
  private assertMigrated(path: string) {
    const error =
      this.migrationFailures.get(path) ??
      this.migrationFailures.get(dirname(path)) ??
      this.migrationFailures.get(this.root);
    if (error) throw error;
  }
  private directory(patentId: string) {
    return join(this.root, z.uuid().parse(patentId));
  }
  private read<T>(path: string, schema: z.ZodType<T>): T | null {
    this.assertMigrated(path);
    try {
      return schema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("小栈AI助手历史或草稿读取失败，原文件已保留，请勿继续覆盖。", {
        cause: error,
      });
    }
  }
  private write(patentId: string, name: string, value: unknown) {
    this.writeBytes(patentId, name, JSON.stringify(value));
  }
  private writeBytes(patentId: string, name: string, value: string | Uint8Array) {
    const dir = this.directory(patentId);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileAtomic.sync(
        join(dir, name),
        typeof value === "string" ? value : Buffer.from(value),
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
    } catch (error) {
      throw new Error("小栈AI助手保存失败，请检查磁盘空间与目录权限。", { cause: error });
    }
  }
  draft(patentId: string, conversationId: string | null): TextPolishInputDraft {
    const id = conversationId === null ? "new" : z.uuid().parse(conversationId);
    return (
      this.read(join(this.directory(patentId), `draft-${id}.json`), TextPolishInputDraftSchema) ?? {
        text: "",
        presets: [],
      }
    );
  }
  saveDraft(patentId: string, conversationId: string | null, draft: TextPolishInputDraft) {
    this.draft(patentId, conversationId);
    this.write(
      patentId,
      `draft-${conversationId ?? "new"}.json`,
      TextPolishInputDraftSchema.parse(draft),
    );
  }
  saveDraftAsync(
    patentId: string,
    conversationId: string | null,
    draft: TextPolishInputDraft,
  ): Promise<void> {
    const id = conversationId === null ? "new" : z.uuid().parse(conversationId);
    const dir = this.directory(patentId);
    const path = join(dir, `draft-${id}.json`);
    const bytes = JSON.stringify(TextPolishInputDraftSchema.parse(draft));
    const write = (this.draftWrites.get(path) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        this.assertMigrated(path);
        try {
          TextPolishInputDraftSchema.parse(JSON.parse(await readFile(path, "utf8")));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw new Error("小栈AI助手历史或草稿读取失败，原文件已保留，请勿继续覆盖。", {
              cause: error,
            });
        }
        try {
          await mkdir(dir, { recursive: true });
          await writeFileAtomic(path, bytes, { encoding: "utf8", mode: 0o600 });
        } catch (error) {
          throw new Error("小栈AI助手保存失败，请检查磁盘空间与目录权限。", { cause: error });
        }
      });
    this.draftWrites.set(path, write);
    const release = () => {
      if (this.draftWrites.get(path) === write) this.draftWrites.delete(path);
    };
    void write.then(release, release);
    return write;
  }
  async waitForDraftWrites(patentId: string): Promise<void> {
    const prefix = `${this.directory(patentId)}${sep}`;
    while (true) {
      const writes = [...this.draftWrites]
        .filter(([path]) => path.startsWith(prefix))
        .map(([, write]) => write);
      if (writes.length === 0) return;
      await Promise.allSettled(writes);
    }
  }
  active(patentId: string) {
    return (
      this.read(join(this.directory(patentId), "active.json"), activeSchema)?.conversationId ?? null
    );
  }
  activate(patentId: string, conversationId: string | null) {
    this.active(patentId);
    this.write(patentId, "active.json", activeSchema.parse({ conversationId }));
  }
  // Invoked only by the user's recovery action. Never discard unreadable bytes.
  recoverState(patentId: string, conversationId?: string | null) {
    const preserveInvalid = (name: string, schema: z.ZodType) => {
      const path = join(this.directory(patentId), name);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      try {
        schema.parse(JSON.parse(text));
        return;
      } catch {
        /* Preserve invalid content below. */
      }
      renameSync(path, `${path}.unreadable-${randomUUID()}`);
    };
    preserveInvalid("active.json", activeSchema);
    const id = conversationId ?? this.active(patentId);
    if (id !== null) {
      preserveInvalid(
        `conversation-${z.uuid().parse(id)}.json`,
        recordSchema.refine(
          (record) =>
            record.snapshot.patentId === patentId && record.snapshot.conversationId === id,
        ),
      );
    }
    preserveInvalid(
      `draft-${id === null ? "new" : z.uuid().parse(id)}.json`,
      TextPolishInputDraftSchema,
    );
  }
  snapshot(
    patentId: string,
    conversationId: string,
    options: { readOnly?: boolean } = {},
  ): TextPolishConversationSnapshot | null {
    const record = this.read(
      join(this.directory(patentId), `conversation-${z.uuid().parse(conversationId)}.json`),
      recordSchema,
    );
    if (
      record &&
      (record.snapshot.patentId !== patentId || record.snapshot.conversationId !== conversationId)
    )
      throw new Error("历史对话所属专利不一致。");
    if (!record) return null;
    // Old backups imported during this run must not revive earlier-session reasoning either.
    const { reasoningByTurn: legacyReasoning, ...snapshot } = record.snapshot;
    if (legacyReasoning !== undefined && !options.readOnly) {
      this.write(patentId, `conversation-${conversationId}.json`, { ...record, snapshot });
    }
    const reasoningByTurn = this.sessionReasoning.get(`${patentId}/${conversationId}`);
    return reasoningByTurn
      ? { ...snapshot, reasoningByTurn: structuredClone(reasoningByTurn) }
      : snapshot;
  }
  save(snapshot: TextPolishConversationSnapshot) {
    this.snapshot(snapshot.patentId, snapshot.conversationId);
    const title = this.read(
      join(this.directory(snapshot.patentId), `conversation-${snapshot.conversationId}.json`),
      recordSchema,
    )?.title;
    const { reasoningByTurn, ...persistentSnapshot } =
      TextPolishConversationSnapshotSchema.parse(snapshot);
    this.write(
      snapshot.patentId,
      `conversation-${snapshot.conversationId}.json`,
      recordSchema.parse({
        snapshot: persistentSnapshot,
        title,
        updatedAt: new Date().toISOString(),
      }),
    );
    const key = `${snapshot.patentId}/${snapshot.conversationId}`;
    if (reasoningByTurn) this.sessionReasoning.set(key, structuredClone(reasoningByTurn));
    else this.sessionReasoning.delete(key);
  }
  rename(patentId: string, conversationId: string, title: string) {
    const name = `conversation-${z.uuid().parse(conversationId)}.json`;
    this.snapshot(patentId, conversationId);
    const record = this.read(join(this.directory(patentId), name), recordSchema);
    if (!record) throw new Error("未找到历史对话。");
    this.write(patentId, name, recordSchema.parse({ ...record, title }));
  }
  remove(patentId: string, conversationId: string) {
    const id = z.uuid().parse(conversationId);
    if (!this.snapshot(patentId, id)) throw new Error("未找到历史对话。");
    const dir = this.directory(patentId);
    const draftPath = join(dir, `draft-${id}.json`);
    const draft = this.read(draftPath, TextPolishInputDraftSchema);
    const active = this.active(patentId);
    try {
      if (active === id) this.activate(patentId, null);
      rmSync(draftPath, { force: true });
      rmSync(join(dir, `conversation-${id}.json`));
    } catch (error) {
      if (draft) this.write(patentId, `draft-${id}.json`, draft);
      if (active === id) this.activate(patentId, id);
      throw new Error("删除失败，原记录未删除，请检查目录权限。", { cause: error });
    }
    this.sessionReasoning.delete(`${patentId}/${id}`);
    this.metadata.delete(join(dir, `conversation-${id}.json`));
    this.draftMetadata.delete(draftPath);
  }
  // Cache only lightweight list metadata, never complete conversations or reasoning.
  // Filesystem reads are asynchronous; yield between cold records while building the index.
  async list(patentId: string): Promise<TextPolishWorkspace["history"]> {
    const dir = this.directory(patentId);
    this.assertMigrated(dir);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const items: TextPolishWorkspace["history"] = [];
    for (const name of files) {
      if (!/^conversation-[a-f0-9-]+\.json$/i.test(name)) continue;
      const id = name.slice(13, -5);
      if (!z.uuid().safeParse(id).success) continue;
      const path = join(dir, name);
      try {
        this.assertMigrated(path);
        const info = await stat(path);
        const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
        const cached = this.metadata.get(path);
        let item = cached?.stamp === stamp ? cached.item : null;
        if (!item) {
          const record = recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
          const snapshot = record.snapshot;
          if (snapshot.patentId !== patentId || snapshot.conversationId !== id)
            throw new Error("历史归属不一致");
          const first = snapshot.messages.find((message) => message.role === "user");
          item = {
            conversationId: id,
            title:
              record.title ?? (first?.role === "user" ? first.text.slice(0, 60) : "小栈AI助手"),
            updatedAt: record.updatedAt,
            status: snapshot.activeTurn
              ? "cancelled"
              : (snapshot.lastTurnOutcome?.status ?? "idle"),
          };
          this.metadata.set(path, { stamp, item });
        }
        const draftPath = join(dir, `draft-${id}.json`);
        try {
          const draftInfo = await stat(draftPath);
          const draftStamp = `${draftInfo.mtimeMs}:${draftInfo.ctimeMs}:${draftInfo.size}`;
          if (this.draftMetadata.get(draftPath) !== draftStamp) {
            TextPolishInputDraftSchema.parse(JSON.parse(await readFile(draftPath, "utf8")));
            this.draftMetadata.set(draftPath, draftStamp);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          this.draftMetadata.delete(draftPath);
        }
        items.push(item);
      } catch {
        items.push({
          conversationId: id,
          title: "无法读取的历史对话",
          updatedAt: "",
          error: "记录读取失败，原文件已保留。",
        });
      }
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  history(patentId: string, options: { readOnly?: boolean } = {}) {
    this.assertMigrated(this.directory(patentId));
    let files: string[];
    try {
      files = readdirSync(this.directory(patentId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return files
      .filter((name) => /^conversation-[a-f0-9-]+\.json$/i.test(name))
      .filter((name) => z.uuid().safeParse(name.slice(13, -5)).success)
      .map((name) => {
        const id = name.slice(13, -5);
        try {
          const snapshot = this.snapshot(patentId, id, options);
          const record = this.read(join(this.directory(patentId), name), recordSchema);
          if (!snapshot || !record) throw new Error("历史对话读取失败。");
          this.draft(patentId, id);
          const first = snapshot.messages.find((message) => message.role === "user");
          return {
            conversationId: id,
            title:
              record.title ?? (first?.role === "user" ? first.text.slice(0, 60) : "小栈AI助手"),
            updatedAt: record.updatedAt,
          };
        } catch {
          return {
            conversationId: id,
            title: "无法读取的历史对话",
            updatedAt: "",
            error:
              this.migrationFailures.get(join(this.directory(patentId), name))?.message ??
              "记录读取失败，原文件已保留。",
          };
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
