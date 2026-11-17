// Patent Workbench: immutable entity geometry is shared by TRIM/EXTEND targets.
type EdgeGeometry = std::sync::Arc<(Vec<Segment>, cadcraft_geom::Bounds2)>;
#[derive(Default)]
struct EdgeCache {
    entries: std::collections::HashMap<(Handle, bool), (std::sync::Arc<Entity>, EdgeGeometry)>,
    segments: usize,
}
std::thread_local! {
    static EDGE_CACHE: std::cell::RefCell<EdgeCache> = Default::default();
}
fn cached_edge_geometry(entity: &std::sync::Arc<Entity>, implied: bool) -> EdgeGeometry {
    EDGE_CACHE.with(|cell| {
        let mut cache = cell.borrow_mut();
        let key = (entity.handle, implied);
        if let Some((old, geometry)) = cache.entries.get(&key) {
            if std::sync::Arc::ptr_eq(old, entity) { return geometry.clone(); }
        }
        let segments = if implied {
            implied_edge(&entity.kind).unwrap_or_else(|| entity.kind.prims().iter().flat_map(prim_to_segments).collect())
        } else { entity.kind.prims().iter().flat_map(prim_to_segments).collect() };
        let bounds = segments.iter().fold(cadcraft_geom::Bounds2::EMPTY, |b, s| b.union(&s.bounds()));
        let geometry = std::sync::Arc::new((segments, bounds));
        if let Some((_, old)) = cache.entries.remove(&key) { cache.segments -= old.0.len(); }
        if cache.entries.len() >= 16_384 || cache.segments + geometry.0.len() > 1_000_000 {
            cache.entries.clear(); cache.segments = 0;
        }
        if geometry.0.len() <= 1_000_000 {
            cache.segments += geometry.0.len();
            cache.entries.insert(key, (entity.clone(), geometry.clone()));
        }
        geometry
    })
}
pub(crate) fn edge_segments_in(s: &Session, edges: Edges, exclude: Handle, query: Option<cadcraft_geom::Bounds2>) -> Result<Vec<Segment>> {
    let d = s.doc()?;
    let store = d.space(&s.space()).ok_or(EngineError::NoDocument)?;
    let mut out = Vec::new();
    for e in store.iter() {
        if e.handle == exclude || !d.is_visible(e) || edges.only.is_some_and(|hs| !hs.contains(&e.handle)) { continue; }
        let geometry = cached_edge_geometry(e, edges.implied);
        if query.is_some_and(|q| !geometry.1.intersects(&q)) { continue; }
        out.extend(geometry.0.iter().filter(|segment| query.is_none_or(|q| segment.bounds().intersects(&q))).copied());
    }
    Ok(out)
}
fn extension_query(kind: &EntityKind, pick: Vec2) -> Option<cadcraft_geom::Bounds2> {
    let (fixed, end) = match kind {
        EntityKind::Line(line) => {
            let (a,b) = (line.a.xy(),line.b.xy());
            if pick.dist(b) < pick.dist(a) {(a,b)} else {(b,a)}
        }
        EntityKind::LwPolyline(p) if !p.closed && p.vertices.len() >= 2 => {
            let from_end = pick.dist(p.vertices.last()?.p) < pick.dist(p.vertices.first()?.p);
            let n = p.vertices.len();
            if from_end {(p.vertices.get(n-2)?.p,p.vertices.last()?.p)} else {(p.vertices.get(1)?.p,p.vertices.first()?.p)}
        }
        EntityKind::Arc(a) => return Some(cadcraft_geom::Bounds2::new(
            a.center.xy()-Vec2::new(a.radius,a.radius),a.center.xy()+Vec2::new(a.radius,a.radius)).expand(a.radius.max(1.0)*1e-9)),
        _ => return None,
    };
    Some(cadcraft_geom::Bounds2::new(end,end+(end-fixed).normalized()*1e8).expand(1e-7))
}
