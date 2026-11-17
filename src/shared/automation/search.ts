import { z } from "zod";
import type { CanonicalPatent } from "../patent/model.js";

export const AutomationSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    patentIds: z.array(z.string().uuid()).max(10000).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    caseSensitive: z.boolean().default(false),
  })
  .strict();
export type AutomationSearchMatch = {
  patentId: string;
  revision: number;
  document: string;
  blockId: string | null;
  text: string;
};
export function searchPatent(
  patent: CanonicalPatent,
  query: string,
  caseSensitive: boolean,
  limit: number,
): AutomationSearchMatch[] {
  const matches: AutomationSearchMatch[] = [];
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const add = (document: string, blockId: string | null, text: string) => {
    if (matches.length >= limit) return;
    const at = (caseSensitive ? text : text.toLocaleLowerCase()).indexOf(needle);
    if (at < 0) return;
    matches.push({
      patentId: patent.patentId,
      revision: patent.revision,
      document,
      blockId,
      text: text.slice(Math.max(0, at - 80), at + query.length + 120),
    });
  };
  const textOf = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(textOf).join("");
    if (!value || typeof value !== "object") return "";
    const node = value as Record<string, unknown>;
    if (node.type === "text" && typeof node.text === "string") return node.text;
    if (
      (node.type === "inline-formula" || node.type === "block-formula") &&
      typeof node.source === "string"
    )
      return node.source;
    return ["content", "items", "rows", "cells"].map((key) => textOf(node[key])).join(" ");
  };
  add("metadata", null, `${patent.name ?? ""}\n${patent.customer ?? ""}`);
  for (const book of patent.books)
    for (const block of book.document.content) add(book.kind, block.id, textOf(block));
  for (const auxiliary of patent.auxiliaryDocuments) {
    add(`auxiliary:${auxiliary.auxiliaryDocumentId}`, null, auxiliary.title);
    for (const block of auxiliary.document.content)
      add(`auxiliary:${auxiliary.auxiliaryDocumentId}`, block.id, textOf(block));
  }
  return matches;
}
