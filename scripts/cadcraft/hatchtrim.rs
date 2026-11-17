//! Trim fill regions, never the displayed pattern strokes. Keep native HATCH styling.
use cadcraft_doc::{EntityKind, Hatch, HatchLoop};
use cadcraft_geom::{Bounds2, PolyVertex, Segment, Vec2, point_in_polygon, region};
use crate::{EngineError, Result};

pub(super) fn contains(h: &Hatch, p: Vec2, tol: f64) -> bool {
    cadcraft_render::fill_loops(h,tol.max(1e-8)).iter().filter(|lp| point_in_polygon(lp,p)).count()%2==1
}

/// Filled areas are selectable throughout their interior, including a fence wholly inside.
pub(super) fn fence_points(h: &Hatch, path: &[Vec2], cut: &[Segment], tol: f64) -> Vec<Vec2> {
    let loops=cadcraft_render::fill_loops(h,tol.max(1e-6));
    let mut lines:Vec<_>=loops.iter().flat_map(|lp| lp.iter().zip(lp.iter().cycle().skip(1)).take(lp.len()).map(|(&a,&b)|cadcraft_geom::Line::new(a,b))).collect();
    for seg in cut { let mut pts=Vec::new(); seg.tessellate(tol.max(1e-6),&mut pts); lines.extend(pts.windows(2).map(|p|cadcraft_geom::Line::new(p[0],p[1]))); }
    let mut result=Vec::new();
    for w in path.windows(2) {
        let ln=cadcraft_geom::Line::new(w[0],w[1]);
        let mut ts=vec![0.0,1.0];
        ts.extend(lines.iter().filter_map(|edge|cadcraft_geom::line_line(&ln,edge)).map(|p|ln.param_of(p).clamp(0.0,1.0)));
        ts.sort_by(f64::total_cmp); ts.dedup_by(|a,b|(*a-*b).abs()<1e-9);
        for pair in ts.windows(2) {
            let p=ln.at((pair[0]+pair[1])*0.5);
            if loops.iter().filter(|lp|point_in_polygon(lp,p)).count()%2==1 {result.push(p);}
        }
    }
    result
}

pub(super) fn trim(h: &Hatch, cut: &[Segment], pick: Vec2) -> Result<Vec<EntityKind>> {
    let bounds = Bounds2::from_points(h.loops.iter().flat_map(|l| cadcraft_geom::Polyline { vertices:l.vertices.clone(),closed:true }.segments().into_iter().flat_map(|s| [s.bounds().min,s.bounds().max])));
    let size = bounds.width().max(bounds.height()).max(1e-6);
    let tol = (size * 1e-8).max(1e-9);
    let filled = cadcraft_render::fill_loops(h, size * 1e-5);
    let original_edges: Vec<_> = filled.iter().flat_map(|lp| lp.iter().zip(lp.iter().cycle().skip(1)).take(lp.len()).map(|(&a,&b)|cadcraft_geom::Line::new(a,b))).collect();
    let inside = |p| filled.iter().filter(|lp| point_in_polygon(lp,p)).count() % 2 == 1;
    if !inside(pick) { return Err(EngineError::Other("Pick a point inside the hatch, outside its holes.".into())); }
    let mut polys = filled.clone();
    for lp in &mut polys {
        if let Some(&first) = lp.first() { if lp.last() != Some(&first) { lp.push(first); } }
    }
    // Limit long implied edges to the local bounding box before graph construction.
    let bb = bounds.expand(size * 0.01);
    for seg in cut {
        let mut ps = Vec::new();
        seg.tessellate(size * 1e-5, &mut ps);
        for pair in ps.windows(2) {
            let (a,b) = (pair[0],pair[1]);
            let d = b-a;
            let (mut lo,mut hi) = (0.0_f64,1.0_f64);
            for (p,q) in [(-d.x,a.x-bb.min.x),(d.x,bb.max.x-a.x),(-d.y,a.y-bb.min.y),(d.y,bb.max.y-a.y)] {
                if p.abs() < 1e-15 { if q < 0.0 { hi = -1.0; } }
                else if p < 0.0 { lo = lo.max(q/p); } else { hi = hi.min(q/p); }
            }
            if lo < hi { polys.push(vec![a+d*lo,a+d*hi]); }
        }
    }
    let faces = region::trim_faces(&polys,tol).ok_or_else(|| EngineError::Other("Hatch boundary is too complex to trim safely.".into()))?;
    let mut kept = Vec::new();
    let mut removed = false;
    let mut area_removed = 0.0;
    for (face,probe) in faces {
        if !inside(probe) { continue; }
        if point_in_polygon(&face.outer,pick) && !face.islands.iter().any(|i| point_in_polygon(&i.outline,pick)) {
            let new_boundary = std::iter::once(&face.outer).chain(face.islands.iter().map(|i|&i.outline)).any(|lp|
                lp.iter().zip(lp.iter().cycle().skip(1)).take(lp.len()).any(|(&a,&b)| {
                    let mid=(a+b)*0.5;
                    original_edges.iter().all(|edge|edge.dist(mid)>tol*8.0)
                }));
            if !new_boundary { return Err(EngineError::Other("Object does not intersect a cutting edge.".into())); }
            removed = true;
            area_removed += cadcraft_geom::shoelace(&face.outer).abs() - face.islands.iter().map(|i| cadcraft_geom::shoelace(&i.outline).abs()).sum::<f64>();
            continue;
        }
        let mut next = h.clone();
        next.style = 0;
        // Old boundary associations would regenerate the removed fill on a later edit.
        next.associative = false;
        next.loops = std::iter::once((face.outer,true)).chain(face.islands.into_iter().map(|i|(i.outline,false)))
            .map(|(ps,outer)| HatchLoop { vertices: ps.into_iter().map(PolyVertex::new).collect(),outer,sources:Vec::new() }).collect();
        kept.push(EntityKind::Hatch(next));
    }
    if !removed || area_removed <= tol*tol || kept.is_empty() {
        return Err(EngineError::Other("Object does not intersect a cutting edge.".into()));
    }
    Ok(kept)
}
