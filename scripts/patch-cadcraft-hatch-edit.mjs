// Preserve external HATCH definitions when the UI submits the current name.
// The importer retains those lines even for names the bundled library knows.
import { readFile, writeFile } from "node:fs/promises";

const file = new URL(
  "../out-cadcraft-archive/storytold-cadcraft-00c7613/crates/engine/src/cmd/hatch/edit.rs",
  import.meta.url,
);
let source = await readFile(file, "utf8");
const changes = [
  [
    "        h.pattern = v.to_ascii_uppercase();",
    "        let pattern_changed = !h.pattern.eq_ignore_ascii_case(v);\n        h.pattern = v.to_ascii_uppercase();",
  ],
  [
    "            if cadcraft_doc::library::pattern(&h.pattern).is_some() {",
    "            if pattern_changed && cadcraft_doc::library::pattern(&h.pattern).is_some() {",
  ],
  [
    "            } else if let Some(user) = super::patfile::user_pattern(&h.pattern) {",
    "            } else if let Some(user) = super::patfile::user_pattern(&h.pattern).filter(|_| pattern_changed) {",
  ],
];
const original = source;
for (const [before, after] of changes) {
  if (source.includes(after)) continue;
  if (source.split(before).length !== 2) {
    throw new Error("Cadcraft hatch edit patch no longer matches the pinned source");
  }
  source = source.replace(before, after);
}
if (source !== original) await writeFile(file, source);
