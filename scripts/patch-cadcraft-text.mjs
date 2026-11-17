import { readFile, writeFile, copyFile } from "node:fs/promises";
const root = new URL(
  "../out-cadcraft-archive/storytold-cadcraft-00c7613/crates/render/src/",
  import.meta.url,
);
await copyFile(
  new URL("cadcraft/plain-text-layout.rs", import.meta.url),
  new URL("patent_plain_text.rs", root),
);
const file = new URL("lib.rs", root);
let source = await readFile(file, "utf8");
const marker =
  "pub fn layout_mtext_entity(d: &Drawing, t: &cadcraft_doc::MText) -> cadcraft_fonts::MTextLayout {";
const replacement = `${marker}
    if t.style == "Patent Workbench Text" { return patent_plain_text::layout_plain_text(t); }`;
if (!source.includes(replacement)) {
  if (source.split(marker).length !== 2)
    throw new Error("CAD text layout patch does not match pinned source");
  source = source.replace(marker, replacement);
  source += "\nmod patent_plain_text;\n";
  await writeFile(file, source);
}
