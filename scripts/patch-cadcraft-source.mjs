// Local fixes for the pinned MIT-licensed Cadcraft source. Keep selection's
// generous hit boxes separate from the actual geometry used by hatch tracing.
await import("./patch-cadcraft-explode.mjs");
await import("./patch-cadcraft-text.mjs");
await import("./patch-cadcraft-trim.mjs");
await import("./patch-cadcraft-performance.mjs");
await import("./patch-cadcraft-appearance.mjs");
await import("./patch-cadcraft-hatch-hover.mjs");
await import("./patch-cadcraft-hatch-edit.mjs");
await import("./patch-cadcraft-harmony-codec.mjs");
import { readFile, writeFile } from "node:fs/promises";
const file = new URL(
  "../out-cadcraft-archive/storytold-cadcraft-00c7613/crates/engine/src/cmd/hatch.rs",
  import.meta.url,
);
const original = "    let mut polys = crate::select::hit_polylines(d, e, tol);";
const replacement = `    // Patent Workbench: an INSERT's pick box is not a hatch boundary.
    let mut polys = if matches!(e.kind, EntityKind::Insert(_)) {
        let list = cadcraft_render::build_entities(
            d, std::iter::once(e),
            &cadcraft_render::Options { tolerance: tol, text: false, ..Default::default() },
        );
        list.prims.iter()
            .filter(|p| matches!(p.kind, cadcraft_render::Kind::Polyline))
            .map(|p| list.points(p).to_vec()).collect()
    } else {
        crate::select::hit_polylines(d, e, tol)
    };`;
const source = await readFile(file, "utf8");
if (!source.includes(replacement)) {
  if (source.split(original).length !== 2)
    throw new Error("Cadcraft hatch patch no longer matches the pinned source");
  await writeFile(file, source.replace(original, replacement));
}

// AutoCAD TRIM: resolve ambiguous Crossing picks clockwise from the first corner,
// not by Euclidean distance to that corner (which can trim the opposite branch).
const trimFile = new URL("../out-cadcraft-archive/storytold-cadcraft-00c7613/crates/engine/src/cmd/trimextend.rs", import.meta.url);
let trimSource = await readFile(trimFile, "utf8");
const rankMarker = "    // Patent Workbench: clockwise crossing priority.";
if (!trimSource.includes(rankMarker)) {
  const insertion = "    let inside = |p: Vec2| bx.expand(tol).contains(p);";
  const oldCompare = "if best.is_none_or(|b| c.dist(a) < b.dist(a))";
  if (trimSource.split(insertion).length !== 2 || trimSource.split(oldCompare).length !== 2)
    throw new Error("Cadcraft trim patch no longer matches the pinned source");
  trimSource = trimSource.replace(insertion, `${insertion}
${rankMarker}
    let width = bx.max.x - bx.min.x;
    let height = bx.max.y - bx.min.y;
    let perimeter = 2.0 * (width + height);
    let position = |p: Vec2| -> Option<f64> {
        if (p.x - bx.min.x).abs() <= tol { Some(p.y - bx.min.y) }
        else if (p.y - bx.max.y).abs() <= tol { Some(height + p.x - bx.min.x) }
        else if (p.x - bx.max.x).abs() <= tol { Some(height + width + bx.max.y - p.y) }
        else if (p.y - bx.min.y).abs() <= tol { Some(2.0 * height + width + bx.max.x - p.x) }
        else { None }
    };
    let start = position(a).unwrap_or(0.0);
    let rank = |p: Vec2| -> f64 {
        if perimeter <= tol { return p.dist(a); }
        position(p).map(|at| (at - start).rem_euclid(perimeter))
            .unwrap_or(perimeter + p.dist(a))
    };`).replace(oldCompare, "if best.is_none_or(|b| rank(c) < rank(b))");
  await writeFile(trimFile, trimSource);
}
