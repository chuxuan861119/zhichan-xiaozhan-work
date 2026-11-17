import { readFile, writeFile } from "node:fs/promises";

const file = new URL(
  "../out-cadcraft-archive/storytold-cadcraft-00c7613/crates/geom/src/region.rs",
  import.meta.url,
);
const source = await readFile(file, "utf8");
const marker = "/// The graph of the curves with gaps of up to `gap` between open ends bridged:";
const addition = `/// Open boundary ends after splitting intersections; diagnostics only.
pub fn boundary_open_ends(polys: &[Vec<Vec2>], tol: f64) -> Vec<Vec2> {
    let Some(g) = build(polys, tol) else { return Vec::new(); };
    g.pts.iter().zip(&g.adj).filter_map(|(p,a)| (a.len()==1).then_some(*p)).take(2048).collect()
}

`;
if (!source.includes("pub fn boundary_open_ends(")) {
  if (!source.includes(marker)) throw new Error("Hatch diagnostics patch mismatch");
  await writeFile(file, source.replace(marker, addition + marker));
}

// Dense drawings share coarse grid cells even when their segments cannot meet.
// Reject those pairs before allocating entries in the intersection dedup set.
const current = await readFile(file, "utf8");
const markerBounds = "// Patent Workbench: conservative segment bounds before pair allocation.";
if (!current.includes(markerBounds)) {
  const anchor = "    let mut tested = std::collections::HashSet::new();";
  const pair = "                if i == j || !tested.insert((i.min(j), i.max(j))) {";
  if (current.split(anchor).length !== 2 || current.split(pair).length !== 2)
    throw new Error("Hatch intersection bounds patch mismatch");
  await writeFile(
    file,
    current
      .replace(
        anchor,
        `    ${markerBounds}
    // line_line accepts parameters within 1e-9 of either endpoint.
    let bounds: Vec<_> = segs.iter().map(|(a,b)| {
        let padding = (*b-*a).len()*1e-9 + tol;
        Bounds2::from_points([*a,*b]).expand(padding)
    }).collect();
${anchor}`,
      )
      .replace(
        pair,
        `                if i == j || !bounds[i].intersects(&bounds[j]) || !tested.insert((i.min(j), i.max(j))) {`,
      ),
  );
}
