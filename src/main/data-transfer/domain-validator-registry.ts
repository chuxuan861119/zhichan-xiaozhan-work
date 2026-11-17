import type { TransferManifest } from "../../shared/data-transfer/model.js";
import type { LibraryRuntime } from "../library/library-runtime.js";

export type DataTransferDomainValidator = {
  id: string;
  ownedTables: readonly string[];
  validate(runtime: LibraryRuntime, manifest: TransferManifest): Promise<void>;
};

export const CORE_DATA_TRANSFER_TABLES = Object.freeze([
  "assets",
  "automation_operations",
  "document_assets",
  "document_edit_log",
  "document_snapshots",
  "documents",
  "edit_log",
  "library_state",
  "patent_assets",
  "patent_auxiliary_documents",
  "patent_books",
  "patent_figures",
  "patent_import_reports",
  "patent_template_auxiliary",
  "patent_template_preferences",
  "patent_template_slots",
  "patents",
  "snapshot_assets",
  "snapshots",
  "template_assets",
] as const);

export const FLOWCHART_DATA_TRANSFER_TABLES = Object.freeze([
  "edit_log_flowchart_revisions",
  "patent_flowchart_source_revisions",
  "patent_flowcharts",
  "snapshot_flowchart_revisions",
] as const);

export class DataTransferDomainRegistryError extends Error {
  override readonly name = "DataTransferDomainRegistryError";

  constructor() {
    super("Data-transfer domain ownership is incomplete.");
    delete this.stack;
  }
}

export class DataTransferDomainValidatorRegistry {
  readonly #validators: readonly DataTransferDomainValidator[];

  constructor(validators: readonly DataTransferDomainValidator[]) {
    this.#validators = Object.freeze([...validators]);
  }

  assertExactTableOwnership(actualTables: readonly string[]): string[] {
    const actual = [...actualTables].sort();
    if (new Set(actual).size !== actual.length) throw new DataTransferDomainRegistryError();
    const owners = new Map<string, string>();
    const validatorIds = new Set<string>();
    for (const validator of this.#validators) {
      if (!validator.id || validatorIds.has(validator.id)) {
        throw new DataTransferDomainRegistryError();
      }
      validatorIds.add(validator.id);
      for (const table of validator.ownedTables) {
        if (!table || owners.has(table)) throw new DataTransferDomainRegistryError();
        owners.set(table, validator.id);
      }
    }
    const owned = [...owners.keys()].sort();
    if (actual.length !== owned.length || actual.some((table, index) => table !== owned[index])) {
      throw new DataTransferDomainRegistryError();
    }
    return actual;
  }

  async validateAll(runtime: LibraryRuntime, manifest: TransferManifest): Promise<void> {
    const tables = runtime.database.read((database) =>
      (
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
             ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    this.assertExactTableOwnership(tables);
    for (const validator of this.#validators) await validator.validate(runtime, manifest);
  }
}
