/// TRIM addresses the filled hatch region, even between sparse pattern strokes.
/// Ordinary curves under the pickbox retain priority over a fill underneath them.
pub fn pick_trim(d: &Drawing, space: &Space, p: Vec2, aperture: f64) -> Option<Handle> {
    let ix = spatial::index(d, space);
    let probe = Bounds2::new(p, p).expand(aperture);
    let mut stroke = None;
    let mut fill = None;
    for (e, known) in candidates(d, space, &ix, &probe, true, true)? {
        if !selectable(d, e) { continue; }
        let bounds = bounds_of(d, e, known);
        if let EntityKind::Hatch(hatch) = &e.kind {
            if fill.is_none() && bounds.contains(p) {
                let tol = bounds.width().max(bounds.height()).max(1e-6) * 1e-5;
                let loops = cadcraft_render::fill_loops(hatch, tol);
                if loops.iter().filter(|lp| point_in_polygon(lp, p)).count() % 2 == 1 { fill = Some(e.handle); }
            }
            continue;
        }
        if !is_infinite(e) && !bounds.expand(aperture).contains(p) { continue; }
        let distance = entity_distance(d, e, p, aperture / 4.0);
        if distance <= aperture && stroke.is_none_or(|(best, _)| distance < best - 1e-12) {
            if distance == 0.0 { return Some(e.handle); }
            stroke = Some((distance, e.handle));
        }
    }
    stroke.map(|(_, handle)| handle).or(fill)
}
