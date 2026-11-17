import additional from "../renderer/src/legislation/assets/additional.json" with { type: "json" };
import law from "../renderer/src/legislation/assets/law.json" with { type: "json" };
import rules from "../renderer/src/legislation/assets/rules.json" with { type: "json" };
import type { LegislationId } from "./legislation.js";

const text: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  [law, rules, ...additional].map((document) => [document.id, document.paragraphs]),
);

export function legislationParagraphs(id: LegislationId): readonly string[] {
  const paragraphs = text[id];
  if (!paragraphs) throw new Error(`Bundled legislation text missing: ${id}`);
  return paragraphs;
}
