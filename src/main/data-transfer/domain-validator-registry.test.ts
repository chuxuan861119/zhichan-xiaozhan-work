import { DatabaseSync } from "node:sqlite";
import { describe, expect, test, vi } from "vitest";
import { V15_SCHEMA_STATEMENTS } from "../library/schema.js";
import {
  CORE_DATA_TRANSFER_TABLES,
  DataTransferDomainValidatorRegistry,
  FLOWCHART_DATA_TRANSFER_TABLES,
} from "./domain-validator-registry.js";

function businessTables(): string[] {
  const database = new DatabaseSync(":memory:");
  try {
    for (const statement of V15_SCHEMA_STATEMENTS) database.exec(statement);
    return (
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    database.close();
  }
}

describe("DataTransferDomainValidatorRegistry", () => {
  test("assigns every V15 business table to exactly one domain", () => {
    const registry = new DataTransferDomainValidatorRegistry([
      { id: "core", ownedTables: CORE_DATA_TRANSFER_TABLES, validate: vi.fn() },
      { id: "flowchart", ownedTables: FLOWCHART_DATA_TRANSFER_TABLES, validate: vi.fn() },
    ]);
    expect(registry.assertExactTableOwnership(businessTables())).toEqual(businessTables());
  });

  test("fails closed for missing, duplicate, or newly introduced tables", () => {
    const noOwners = new DataTransferDomainValidatorRegistry([]);
    expect(() => noOwners.assertExactTableOwnership(["patents"])).toThrow();

    const duplicate = new DataTransferDomainValidatorRegistry([
      { id: "a", ownedTables: ["patents"], validate: vi.fn() },
      { id: "b", ownedTables: ["patents"], validate: vi.fn() },
    ]);
    expect(() => duplicate.assertExactTableOwnership(["patents"])).toThrow();

    const exact = new DataTransferDomainValidatorRegistry([
      { id: "a", ownedTables: ["patents"], validate: vi.fn() },
    ]);
    expect(() => exact.assertExactTableOwnership(["patents", "future_cad"])).toThrow();
  });
});
