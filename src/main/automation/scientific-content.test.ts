// @vitest-environment node
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { ChemicalStructureNode } from "../../shared/document/model.js";
import { embedChemicalStructureSource } from "../chemistry/structure-source.js";
import {
  assertAutomationChemicalSource,
  validateAutomationChemicalChanges,
} from "./scientific-content.js";

const ketSource =
  '{"root":{"nodes":[{"$ref":"mol0"}]},"mol0":{"type":"molecule","atoms":[{"label":"C"}],"bonds":[]}}';
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><path d="M0 0L50 50"/></svg>';
const node = (): ChemicalStructureNode => ({
  id: randomUUID(),
  type: "chemical-structure",
  ketSource,
  previewAssetId: randomUUID(),
  widthMm: 80,
  alignment: "center",
});

test.each([
  "not JSON",
  "null",
  "[]",
  "{}",
  '{"root":{"nodes":[]}}',
  '{"root":{"nodes":[{"$ref":"missing"}]}}',
  '{"root":{"nodes":[42]}}',
])("rejects unusable CLI structure source %s", (source) => {
  expect(() => assertAutomationChemicalSource(source)).toThrow(/KET/);
});
test("accepts molecule and macromolecule reference graphs without rewriting source", () => {
  expect(() => assertAutomationChemicalSource(ketSource)).not.toThrow();
  expect(() =>
    assertAutomationChemicalSource(
      '{"root":{"nodes":[{"$ref":"monomer0"}],"templates":[{"$ref":"template0"}]},"monomer0":{"type":"monomer","templateId":"A"},"template0":{"type":"monomerTemplate","id":"A"}}',
    ),
  ).not.toThrow();
});
test("validates new nodes against embedded source and rejects stale previews", async () => {
  const block = node();
  const read = async () => ({
    original: Buffer.from(embedChemicalStructureSource(svg, { ketSource })),
  });
  await expect(validateAutomationChemicalChanges([], [block], read)).resolves.toBeUndefined();
  await expect(
    validateAutomationChemicalChanges(
      [block],
      [{ ...block, ketSource: ketSource.replace('"C"', '"N"') }],
      read,
    ),
  ).rejects.toMatchObject({ code: "CHEMICAL_PREVIEW_MISMATCH" });
  await expect(
    validateAutomationChemicalChanges([], [block], async () => ({ original: Buffer.from(svg) })),
  ).rejects.toMatchObject({ code: "CHEMICAL_PREVIEW_MISMATCH" });
});
test("unchanged legacy sources still permit layout changes and removal", async () => {
  const block = { ...node(), ketSource: "legacy source" };
  const read = async () => {
    throw new Error("legacy assets must not be read for unrelated edits");
  };
  await expect(
    validateAutomationChemicalChanges(
      [block],
      [{ ...block, widthMm: 100, alignment: "left" }],
      read,
    ),
  ).resolves.toBeUndefined();
  await expect(validateAutomationChemicalChanges([block], [], read)).resolves.toBeUndefined();
});
