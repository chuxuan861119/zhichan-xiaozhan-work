/// Partition a bounded curve network once, retaining disconnected holes. Limits are errors,
/// never silently truncated results: a partial partition could discard a user's geometry.
pub fn trim_faces(polys: &[Vec<Vec2>], tol: f64) -> Option<Vec<(Boundary, Vec2)>> {
    let g = prune(&build(polys, tol)?);
    let mut seen = std::collections::HashSet::new();
    let mut faces = Vec::new();
    let steps = g.adj.iter().map(Vec::len).sum::<usize>() + 4;
    if steps > 120_000 { return None; }
    for (u, ns) in g.adj.iter().enumerate() {
        for &v in ns {
            if seen.contains(&(u, v)) { continue; }
            let ids = trace(&g, u, v, steps)?;
            for (&a, &b) in ids.iter().zip(ids.iter().cycle().skip(1)) { seen.insert((a,b)); }
            let outer = points(&g, &ids)?;
            if outer.len() < 3 || shoelace(&outer) <= tol * tol { continue; }
            if faces.len() >= 512 { return None; }
            // A left-of-edge probe belongs to this face even when its centroid is in a hole.
            let probe = outer.iter().zip(outer.iter().cycle().skip(1)).find_map(|(&a,&b)| {
                let d = b-a;
                if d.len() <= tol * 8.0 { return None; }
                let q = (a+b)*0.5 + Vec2::new(-d.y,d.x).normalized() * (tol * 4.0);
                point_in_polygon(&outer,q).then_some(q)
            })?;
            let mut holes = islands(&g, &ids, probe);
            // Only immediate islands: deeper faces are enumerated separately.
            let outlines: Vec<_> = holes.iter().map(|h| h.outline.clone()).collect();
            holes.retain(|h| !outlines.iter().any(|other| other != &h.outline && point_in_polygon(other,h.outline[0])));
            faces.push((Boundary { outer, islands: holes, outer_sources: Vec::new() }, probe));
        }
    }
    Some(faces)
}
