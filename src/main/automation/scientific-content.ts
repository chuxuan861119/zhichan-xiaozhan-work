import { AutomationError } from "../../shared/automation/protocol.js";
import type { BlockNode, ChemicalStructureNode } from "../../shared/document/model.js";
import { MAX_KET_SOURCE_BYTES } from "../../shared/document/model.js";
import { readChemicalStructureSource } from "../chemistry/structure-source.js";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate new CLI input only: historical documents remain readable/restorable. */
export function assertAutomationChemicalSource(source: string): void {
  const invalid = () =>
    new AutomationError(
      "INVALID_CHEMICAL_SOURCE",
      "化学结构源码必须是有效、非空的 KET JSON，且不能引用不存在的结构。",
    );
  if (Buffer.byteLength(source, "utf8") > MAX_KET_SOURCE_BYTES) throw invalid();
  let ket: unknown;
  try {
    ket = JSON.parse(source);
  } catch {
    throw invalid();
  }
  if (!object(ket) || !object(ket.root) || !Array.isArray(ket.root.nodes) || !ket.root.nodes.length)
    throw invalid();
  const pending: unknown[] = [ket];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) {
      for (const child of item) pending.push(child);
      continue;
    }
    if (!object(item)) continue;
    if (
      "$ref" in item &&
      (typeof item.$ref !== "string" || !Object.hasOwn(ket, item.$ref) || !object(ket[item.$ref]))
    )
      throw invalid();
    for (const child of Object.values(item))
      if (typeof child === "object" && child !== null) pending.push(child);
  }
  for (const node of ket.root.nodes) {
    if (!object(node)) throw invalid();
    const target = typeof node.$ref === "string" ? ket[node.$ref] : node;
    if (!object(target) || typeof target.type !== "string" || !target.type) throw invalid();
  }
}

type AssetReader = (assetId: string) => Promise<{ original: Uint8Array }>;

export async function validateAutomationChemicalChanges(
  before: readonly BlockNode[],
  after: readonly BlockNode[],
  readAsset: AssetReader,
): Promise<void> {
  const previous = new Map(
    before
      .filter((node): node is ChemicalStructureNode => node.type === "chemical-structure")
      .map((node) => [node.id, node]),
  );
  for (const node of after) {
    if (node.type !== "chemical-structure") continue;
    const prior = previous.get(node.id);
    if (
      prior &&
      prior.ketSource === node.ketSource &&
      prior.previewAssetId === node.previewAssetId &&
      (prior.editorMode ?? "molecule") === (node.editorMode ?? "molecule")
    )
      continue;
    assertAutomationChemicalSource(node.ketSource);
    const asset = await readAsset(node.previewAssetId);
    const source = readChemicalStructureSource(Buffer.from(asset.original).toString("utf8"));
    if (
      !source ||
      source.ketSource !== node.ketSource ||
      (source.editorMode ?? "molecule") !== (node.editorMode ?? "molecule")
    )
      throw new AutomationError(
        "CHEMICAL_PREVIEW_MISMATCH",
        "结构源码与预览不匹配。请先使用 asset.render-chemistry 同时提供 svg 和 source，再引用生成的素材。",
      );
  }
}
