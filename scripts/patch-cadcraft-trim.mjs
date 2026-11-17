// Durable, idempotent fixes against the pinned MIT Cadcraft source.
import { readFile, writeFile } from "node:fs/promises";
const root = new URL("../out-cadcraft-archive/storytold-cadcraft-00c7613/crates/", import.meta.url);
async function writeChanged(path, text) {
  if (
    (await readFile(path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    })) !== text
  )
    await writeFile(path, text);
}
async function replace(file, from, to) {
  const path = new URL(file, root),
    source = await readFile(path, "utf8");
  if (source.includes(to)) return;
  if (source.split(from).length !== 2) throw new Error(`Cadcraft trim patch mismatch: ${file}`);
  await writeFile(path, source.replace(from, to));
}
// Upgrade an already patched archive before applying the current templates.
const interactionFile = new URL("engine/src/cmd/trimextend.rs", root);
let interaction = await readFile(interactionFile, "utf8");
const candidate =
  "d.is_visible(e) && matches!(e.kind,EntityKind::Hatch(_)) && !candidates.contains(&e.handle)";
const cuts = "let cut=super::modify::edge_segments(s,edges,h)?;";
if (interaction.includes(candidate)) {
  if (interaction.split(candidate).length !== 3)
    throw Error("Cadcraft hatch candidate upgrade mismatch");
  interaction = interaction.replace(
    candidate,
    "d.is_visible(e) && matches!(e.kind,EntityKind::Hatch(_)) && cadcraft_doc::entity_bounds(d,e,0).intersects(&fb.expand(tol)) && !candidates.contains(&e.handle)",
  );
  interaction = interaction.replace(
    candidate,
    "d.is_visible(e) && matches!(e.kind,EntityKind::Hatch(_)) && cadcraft_doc::entity_bounds(d,e,0).intersects(&bx.expand(tol)) && !candidates.contains(&e.handle)",
  );
}
if (interaction.includes(cuts)) {
  if (interaction.split(cuts).length !== 3) throw Error("Cadcraft hatch query upgrade mismatch");
  interaction = interaction.replace(
    cuts,
    "let cut=super::modify::edge_segments_in(s,edges,h,Some(fb.expand(tol)))?;",
  );
  interaction = interaction.replace(
    cuts,
    "let cut=super::modify::edge_segments_in(s,edges,h,Some(bx.expand(tol)))?;",
  );
}
await writeChanged(interactionFile, interaction);
// A failed hatch partition must never erase disconnected fill far from the pick.
// Preserve Quick mode's established erase behavior for ordinary curves.
await replace(
  "engine/src/cmd/trimextend.rs",
  "Err(e) if quick && misses_edges(&e) => {",
  "Err(e) if quick && misses_edges(&e) && !matches!(s.doc()?.entity(h).map(|e| &e.kind), Some(EntityKind::Hatch(_))) => {",
);
await replace("engine/src/cmd/mod.rs", "mod trimextend;", "mod trimextend;\nmod hatchtrim;");
await writeChanged(
  new URL("engine/src/cmd/hatchtrim.rs", root),
  await readFile(new URL("cadcraft/hatchtrim.rs", import.meta.url), "utf8"),
);
await replace("render/src/hatch.rs", "pub(crate) fn fill_loops", "pub fn fill_loops");
await replace(
  "render/src/lib.rs",
  "pub use hatch::pattern_swatch;",
  "pub use hatch::{pattern_swatch, fill_loops};",
);
const region = new URL("geom/src/region.rs", root);
let source = await readFile(region, "utf8");
const marker = "// Patent Workbench: bounded planar face partition.";
source = source.split(marker)[0];
await writeChanged(
  region,
  `${source}${marker}\n${await readFile(new URL("cadcraft/trim-regions.rs", import.meta.url), "utf8")}`,
);
const selection = new URL("engine/src/select.rs", root);
const selectionMarker = "// Patent Workbench: hatch region TRIM picking.";
const selectionSource = (await readFile(selection, "utf8")).split(selectionMarker)[0];
await writeChanged(selection, `${selectionSource}${selectionMarker}\n${await readFile(new URL("cadcraft/trim-pick.rs", import.meta.url), "utf8")}`);
await replace(
  "engine/src/cmd/modify.rs",
  "fn edge_segments(s: &Session",
  "pub(crate) fn edge_segments(s: &Session",
);
await replace(
  "engine/src/cmd/trimextend.rs",
  "    for h in crate::select::select_fence(d, &space, pts) {",
  `    let mut candidates=crate::select::select_fence(d, &space, pts);
    if !extending { if let Some(store)=d.space(&space) { for e in store.iter() {
        if d.is_visible(e) && matches!(e.kind,EntityKind::Hatch(_)) && cadcraft_doc::entity_bounds(d,e,0).intersects(&fb.expand(tol)) && !candidates.contains(&e.handle) { candidates.push(e.handle); }
    } } }
    for h in candidates {`,
);
await replace(
  "engine/src/cmd/trimextend.rs",
  "        let polys = crate::select::hit_polylines(d, e, tol);",
  `        if !extending { if let EntityKind::Hatch(hatch)=&e.kind {
            let cut=super::modify::edge_segments_in(s,edges,h,Some(fb.expand(tol)))?;
            work.push((h,super::hatchtrim::fence_points(hatch,pts,&cut,tol)));
            continue;
        } }
        let polys = crate::select::hit_polylines(d, e, tol);`,
);
await replace(
  "engine/src/cmd/trimextend.rs",
  "    for h in crate::select::select_window(d, &space, bx, true) {",
  `    let mut candidates=crate::select::select_window(d, &space, bx, true);
    if !extending { if let Some(store)=d.space(&space) { for e in store.iter() {
        if d.is_visible(e) && matches!(e.kind,EntityKind::Hatch(_)) && cadcraft_doc::entity_bounds(d,e,0).intersects(&bx.expand(tol)) && !candidates.contains(&e.handle) { candidates.push(e.handle); }
    } } }
    for h in candidates {`,
);
await replace(
  "engine/src/cmd/trimextend.rs",
  "        let mut best: Option<Vec2> = None;",
  `        if !extending { if let EntityKind::Hatch(hatch)=&e.kind {
            let path=[a,Vec2::new(a.x,b.y),b,Vec2::new(b.x,a.y),a];
            let cut=super::modify::edge_segments_in(s,edges,h,Some(bx.expand(tol)))?;
            if let Some(p)=super::hatchtrim::fence_points(hatch,&path,&cut,tol).first() { work.push((h,vec![*p])); continue; }
        } }
        let mut best: Option<Vec2> = None;`,
);
await replace(
  "engine/src/cmd/trimextend.rs",
  "crate::select::entity_distance(d, e, x, tol)",
  "if matches!(&e.kind, EntityKind::Hatch(h) if super::hatchtrim::contains(h,x,tol)) { 0.0 } else { crate::select::entity_distance(d, e, x, tol) }",
);
if (
  !(await readFile(new URL("engine/src/cmd/modify.rs", root), "utf8")).includes(
    "EntityKind::Hatch(h) => super::hatchtrim::trim(h, &cut, pick)?,",
  )
)
  await replace(
    "engine/src/cmd/modify.rs",
    "        EntityKind::LwPolyline(p) => trim_polyline(p, &cut, pick)?,",
    "        EntityKind::Hatch(h) => super::hatchtrim::trim(h, &cut, pick)?,\n        EntityKind::LwPolyline(p) => trim_polyline(p, &cut, pick)?,",
  );
await replace(
  "engine/src/cmd/modify.rs",
  "    let mk = |vs: Vec<PolyVertex>| lwpoly(vs, false);",
  `    let mk = |mut vs: Vec<PolyVertex>| {
        let pieces = Polyline { vertices: vs.clone(), closed: false }.segments();
        for (i, piece) in pieces.iter().enumerate() {
            let mid = piece.at(0.5);
            if let Some((j, original)) = segs.iter().enumerate().find(|(_, s)| s.closest(mid).near(mid, 1e-8)) {
                if let (Some(source), Some(target)) = (p.vertices.get(j), vs.get_mut(i)) {
                    let width = |t:f64| source.start_width + (source.end_width-source.start_width)*t;
                    target.start_width = width(param_on(original,piece.at(0.0)));
                    target.end_width = width(param_on(original,piece.at(1.0)));
                }
            }
        }
        let mut kept = p.clone(); kept.vertices = vs; kept.closed = false;
        EntityKind::LwPolyline(kept)
    };`,
);
await replace(
  "engine/src/cmd/modify.rs",
  "    ts.retain(|t| *t > 1e-9 && *t < total - 1e-9);\n    ts.sort_by(f64::total_cmp);\n    if ts.is_empty() {",
  `    // Closed curves have no endpoint: the seam is a valid cutting intersection.
    if p.closed && total > 1e-9 {
        for t in &mut ts { *t = t.rem_euclid(total); if total - *t < 1e-9 { *t = 0.0; } }
    } else { ts.retain(|t| *t > 1e-9 && *t < total - 1e-9); }
    ts.sort_by(f64::total_cmp);
    ts.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    if ts.is_empty() || (p.closed && ts.len() < 2) {`,
);
// A selected polyline supplies its own segment boundaries, but an explicitly
// restricted external boundary set must retain its original trim semantics.
await replace(
  "engine/src/cmd/modify.rs",
  "EntityKind::LwPolyline(p) => trim_polyline(p, &cut, pick)?,",
  "EntityKind::LwPolyline(p) => trim_polyline(p, &cut, pick, edges.only.is_none_or(|hs| hs.contains(&h)))?,",
);
await replace(
  "engine/src/cmd/modify.rs",
  "fn trim_polyline(p: &cadcraft_doc::LwPolyline, cut: &[Segment], pick: Vec2)",
  "fn trim_polyline(p: &cadcraft_doc::LwPolyline, cut: &[Segment], pick: Vec2, self_boundary: bool)",
);
await replace(
  "engine/src/cmd/modify.rs",
  "    for s in &segs {\n        let len = s.len();\n        for x in cut.iter().flat_map(|c| intersect_ext(s, c, false)) {",
  `    for s in &segs {
        let len = s.len();
        if self_boundary && segs.len() > 1 {
            // Adjacent segments bound each picked edge, including collinear joins.
            // Keep this linear in vertex count; do not compare coincident segments.
            ts.push(acc);
            ts.push(acc + len);
        }
        for x in cut.iter().flat_map(|c| intersect_ext(s, c, false)) {`,
);
