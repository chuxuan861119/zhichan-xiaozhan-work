import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  type DraftSummary,
  DraftSummarySchema,
  StableIdSchema,
} from "../../shared/ipc/contract.js";
import { AppOperationError } from "../app-operation-error.js";
import { FileService } from "../documents/file-service.js";
import type { PatdocPayload } from "../documents/patdoc-format.js";

const MetadataSchema = DraftSummarySchema.extend({
  fileName: z.string().regex(/^[0-9-]+\.patdoc$/u),
});
type Metadata = z.infer<typeof MetadataSchema>;

export type SaveDraftInput = {
  documentId: string;
  displayName: string;
  originalPath: string | null;
  payload: PatdocPayload;
};

function timestamp(date: Date): string {
  const part = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${part(date.getFullYear(), 4)}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

export class DraftService {
  readonly #inFlight = new Map<string, Promise<DraftSummary>>();
  readonly #saveFailures = new Map<string, number>();
  #saveEpoch = 0;
  #saveVersion = 0;

  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
    private readonly fileService: FileService = new FileService(),
    private readonly removeDraft: (path: string) => Promise<void> = async (path) =>
      await rm(path, { recursive: true, force: true }),
  ) {}

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  save(input: SaveDraftInput): Promise<DraftSummary> {
    const documentId = StableIdSchema.parse(input.documentId);
    const existing = this.#inFlight.get(documentId);
    if (existing) return existing;
    const saveVersion = ++this.#saveVersion;
    this.#saveEpoch += 1;
    const operation = this.#save({ ...input, documentId })
      .then(
        (summary) => {
          this.#saveFailures.delete(documentId);
          return summary;
        },
        (error: unknown) => {
          this.#saveFailures.set(documentId, saveVersion);
          throw error;
        },
      )
      .finally(() => {
        if (this.#inFlight.get(documentId) === operation) this.#inFlight.delete(documentId);
        this.#saveEpoch += 1;
      });
    this.#inFlight.set(documentId, operation);
    return operation;
  }

  async waitForIdle(): Promise<void> {
    while (true) {
      const observedEpoch = this.#saveEpoch;
      await Promise.allSettled([...this.#inFlight.values()]);
      if (this.#inFlight.size === 0 && observedEpoch === this.#saveEpoch) break;
    }
    if (this.#saveFailures.size !== 0) {
      throw new AppOperationError({ code: "SOURCE_SAVE_FAILED", message: "normalized" });
    }
  }

  async #save(input: SaveDraftInput): Promise<DraftSummary> {
    if (input.documentId !== input.payload.document.documentId) {
      throw new Error("草稿文档编号不一致。");
    }
    const date = this.now();
    const stamp = timestamp(date);
    const directory = join(this.root, input.documentId);
    const fileName = `${stamp}.patdoc`;
    const path = join(directory, fileName);
    await mkdir(directory, { recursive: true });
    const result = await this.fileService.saveDocument(path, input.payload);
    if (!result.ok) throw new AppOperationError(result.error);
    const summary: DraftSummary = {
      draftId: input.documentId,
      documentId: input.documentId,
      displayName: input.originalPath ? input.displayName : `未命名-${stamp}`,
      originalPath: input.originalPath,
      savedAt: date.toISOString(),
    };
    const metadata: Metadata = { ...summary, fileName };
    await writeFileAtomic(join(directory, "draft.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
    });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".patdoc") && entry.name !== fileName) {
        await unlink(join(directory, entry.name)).catch(() => undefined);
      }
    }
    return summary;
  }

  async list(): Promise<DraftSummary[]> {
    const drafts: DraftSummary[] = [];
    let entries: Dirent<string>[];
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return drafts;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !StableIdSchema.safeParse(entry.name).success) continue;
      try {
        const metadata = MetadataSchema.parse(
          JSON.parse(await readFile(join(this.root, entry.name, "draft.json"), "utf8")),
        );
        drafts.push(DraftSummarySchema.parse(metadata));
      } catch {
        // A damaged draft remains on disk for manual inspection but is not offered as valid.
      }
    }
    return drafts.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }

  async open(draftIdInput: string): Promise<PatdocPayload> {
    const draftId = StableIdSchema.parse(draftIdInput);
    const metadata = MetadataSchema.parse(
      JSON.parse(await readFile(join(this.root, draftId, "draft.json"), "utf8")),
    );
    const result = await this.fileService.openDocument(join(this.root, draftId, metadata.fileName));
    if (!result.ok) throw new AppOperationError(result.error);
    return result.value;
  }

  async delete(draftIdInput: string): Promise<void> {
    const draftId = StableIdSchema.parse(draftIdInput);
    await this.#inFlight.get(draftId)?.catch(() => undefined);
    const failedSaveVersion = this.#saveFailures.get(draftId);
    await this.removeDraft(join(this.root, draftId));
    if (failedSaveVersion !== undefined && this.#saveFailures.get(draftId) === failedSaveVersion) {
      this.#saveFailures.delete(draftId);
    }
  }
}
