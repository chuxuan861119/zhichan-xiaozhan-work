import { readFile, writeFile } from "node:fs/promises";
const file = new URL(
  "../out-cadcraft-archive/storytold-cadcraft-00c7613/crates/engine/src/cmd/modify.rs",
  import.meta.url,
);
let source = await readFile(file, "utf8");
const marker = "// Patent Workbench: immutable entity geometry is shared by TRIM/EXTEND targets.";
if (!source.includes(marker)) {
  const start = source.indexOf("pub(crate) fn edge_segments(s: &Session");
  const end = source.indexOf("/// `k` as an implied edge", start);
  if (start < 0 || end < 0) throw Error("Cadcraft edge geometry patch mismatch");
  source =
    source.slice(0, start) +
    `pub(crate) fn edge_segments(s: &Session, edges: Edges, exclude: Handle) -> Result<Vec<Segment>> {
    edge_segments_in(s, edges, exclude, None)
}

` +
    source.slice(end);
  const old = "    let cut = edge_segments(s, edges, h)?;";
  if (source.split(old).length !== 3) throw Error("Cadcraft trim/extend query patch mismatch");
  source = source.replace(
    old,
    `    let bounds = cadcraft_doc::entity_bounds(s.doc()?, &e, 0);
    let margin = bounds.width().max(bounds.height()).max(1.0)*1e-9;
    let cut = edge_segments_in(s, edges, h, (!bounds.is_empty()).then(|| bounds.expand(margin)))?;`,
  );
  source = source.replace(
    old,
    "    let cut = edge_segments_in(s, edges, h, extension_query(&e.kind, pick))?;",
  );
}
source =
  source.split(marker)[0] +
  (await readFile(new URL("./cadcraft/edge-cache.rs", import.meta.url), "utf8"));
if ((await readFile(file, "utf8")) !== source) await writeFile(file, source);
