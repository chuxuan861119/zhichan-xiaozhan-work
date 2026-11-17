import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { StableIdSchema } from "../../shared/ipc/primitives.js";
import { LibraryDocumentIdSchema } from "../../shared/library/model.js";

const ImportedDraftRecordSchema = z
  .object({
    draftId: StableIdSchema,
    libraryDocumentId: LibraryDocumentIdSchema,
    importedAt: z.string().datetime(),
  })
  .strict();

const LegacyDraftMigrationStateSchema = z
  .object({
    formatVersion: z.literal(1),
    importedDrafts: z.array(ImportedDraftRecordSchema).max(100_000),
  })
  .strict();

type LegacyDraftMigrationState = z.infer<typeof LegacyDraftMigrationStateSchema>;
type AtomicWriter = (
  filename: string,
  data: string | Buffer,
  options?: { encoding?: BufferEncoding },
) => Promise<void>;

function emptyState(): LegacyDraftMigrationState {
  return { formatVersion: 1, importedDrafts: [] };
}

export class LegacyDraftMigrationStateFile {
  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
    private readonly writeAtomic: AtomicWriter = writeFileAtomic,
  ) {}

  async isImported(draftIdInput: string): Promise<boolean> {
    const draftId = StableIdSchema.parse(draftIdInput);
    const state = await this.read();
    return state.importedDrafts.some((record) => record.draftId === draftId);
  }

  async markImported(draftIdInput: string, libraryDocumentIdInput: string): Promise<void> {
    const draftId = StableIdSchema.parse(draftIdInput);
    const libraryDocumentId = LibraryDocumentIdSchema.parse(libraryDocumentIdInput);
    const state = await this.read();
    const importedAt = this.now().toISOString();
    const existing = state.importedDrafts.find((record) => record.draftId === draftId);
    if (existing) {
      existing.libraryDocumentId = libraryDocumentId;
      existing.importedAt = importedAt;
    } else {
      state.importedDrafts.push({ draftId, libraryDocumentId, importedAt });
    }
    await mkdir(dirname(this.path), { recursive: true });
    await this.writeAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
    });
  }

  private async read(): Promise<LegacyDraftMigrationState> {
    try {
      return LegacyDraftMigrationStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      return emptyState();
    }
  }
}
