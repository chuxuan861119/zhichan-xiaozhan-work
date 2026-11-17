//! Patent CAD hatch adaptation. Work on a disposable document until validation
//! succeeds, then publish one undoable operation, including boundary edits.
use cadcraft_engine::{
    Session, Snapshot,
    doc::{Drawing, EntityKind, Handle, Hatch, HatchLoop, entity_bounds, library},
    geom::{Bounds2, PolyVertex, Polyline, Vec2},
    render,
};
use serde_json::{Value, json};

fn handles(p: &Value, key: &str) -> Vec<Handle> {
    p[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|h| h.as_str().and_then(Handle::parse_hex))
        .collect()
}

/// Automatic repair is deliberately small in model space, never in pixels.
/// A permissive first trace only locates the local face; the final trace uses
/// 0.1% of its smallest boundary object's span, capped at 0.05 drawing units.
/// Distant large or tiny objects cannot enlarge or disable that local limit.
fn automatic_gap(d: &Drawing, p: &Value) -> f64 {
    const CAP: f64 = 0.05;
    let candidates: Vec<_> = d
        .model
        .iter()
        .filter(|e| {
            d.is_visible(e)
                && matches!(
                    e.kind,
                    EntityKind::Line(_)
                        | EntityKind::Arc(_)
                        | EntityKind::Circle(_)
                        | EntityKind::Ellipse(_)
                        | EntityKind::LwPolyline(_)
                        | EntityKind::Polyline3d(_)
                        | EntityKind::Spline(_)
                        | EntityKind::Insert(_)
                )
        })
        .collect();
    let ext = d.extents(&cadcraft_engine::doc::Space::Model);
    let size = (ext.width() + ext.height()).max(1e-6);
    let polys: Vec<_> = candidates
        .iter()
        .flat_map(|e| {
            if matches!(e.kind, EntityKind::Insert(_)) {
                let list = render::build_entities(
                    d,
                    std::iter::once(e.as_ref()),
                    &render::Options {
                        tolerance: size / 20_000.0,
                        text: false,
                        ..Default::default()
                    },
                );
                list.prims
                    .iter()
                    .filter(|p| matches!(p.kind, render::Kind::Polyline))
                    .map(|p| list.points(p).to_vec())
                    .collect::<Vec<_>>()
            } else {
                cadcraft_engine::select::hit_polylines(d, e, size / 20_000.0)
            }
        })
        .collect();
    let points = p["points"]
        .as_array()
        .or_else(|| p["boundaryPoints"].as_array());
    let selected = handles(p, "handles");
    let added = handles(p, "boundaryAdd");
    let mut local = Vec::new();
    if let Some(points) = points {
        for point in points {
            let Some((x, y)) = point[0].as_f64().zip(point[1].as_f64()) else {
                continue;
            };
            if let Some(boundary) =
                cadcraft_engine::geom::region::boundary_at_gap(&polys, Vec2::new(x, y), 1e-9, CAP)
            {
                local.push(Bounds2::from_points(boundary.outer));
            }
        }
    }
    candidates
        .iter()
        .filter(|e| {
            selected.contains(&e.handle)
                || added.contains(&e.handle)
                || local
                    .iter()
                    .any(|bounds| bounds.intersects(&entity_bounds(d, e, 0)))
        })
        .map(|e| {
            let b = entity_bounds(d, e, 0);
            b.width().max(b.height())
        })
        .filter(|span| span.is_finite() && *span > 1e-9)
        .map(|span| span * 0.001)
        .fold(CAP, f64::min)
}

/// Potential small gaps, not a claim that every open outline can be repaired.
/// Use the same split-intersection graph as boundary tracing (T junctions are not gaps).
pub(crate) fn gap_points(d: &Drawing, p: &Value) -> Value {
    let Some(point) = p["points"].as_array().and_then(|ps| ps.last()) else {
        return json!([]);
    };
    let Some((x, y)) = point[0].as_f64().zip(point[1].as_f64()) else {
        return json!([]);
    };
    let point = Vec2::new(x, y);
    let ext = d.extents(&cadcraft_engine::doc::Space::Model);
    let size = (ext.width() + ext.height()).max(1e-6);
    let tol = (size * 1e-9).max(1e-9);
    let mut polys = Vec::new();
    for e in d.model.iter().filter(|e| d.is_visible(e)) {
        if matches!(
            e.kind,
            EntityKind::Hatch(_)
                | EntityKind::Text(_)
                | EntityKind::MText(_)
                | EntityKind::Dimension(_)
                | EntityKind::Image(_)
                | EntityKind::Wipeout(_)
        ) {
            continue;
        }
        if matches!(e.kind, EntityKind::Insert(_)) {
            let list = render::build_entities(
                d,
                std::iter::once(e.as_ref()),
                &render::Options {
                    tolerance: size / 20_000.0,
                    text: false,
                    ..Default::default()
                },
            );
            polys.extend(
                list.prims
                    .iter()
                    .filter(|p| matches!(p.kind, render::Kind::Polyline))
                    .map(|p| list.points(p).to_vec()),
            );
        } else {
            polys.extend(cadcraft_engine::select::hit_polylines(
                d,
                e,
                size / 20_000.0,
            ));
        }
    }
    let ends = cadcraft_engine::geom::region::boundary_open_ends(&polys, tol);
    let max_gap = p["gapTolerance"].as_f64().unwrap_or(0.0).max(size * 0.02);
    let mut pairs = Vec::new();
    let mut budget = 200_000usize;
    for (i, a) in ends.iter().enumerate() {
        for (j, b) in ends.iter().enumerate().skip(i + 1) {
            if budget == 0 {
                break;
            }
            budget -= 1;
            let distance = a.dist(*b);
            if distance > tol && distance <= max_gap {
                pairs.push((a.mid(*b).dist(point), i, j));
            }
        }
        if budget == 0 {
            break;
        }
    }
    pairs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut used = std::collections::HashSet::new();
    let mut markers = Vec::new();
    for (_, i, j) in pairs {
        if used.contains(&i) || used.contains(&j) {
            continue;
        }
        used.insert(i);
        used.insert(j);
        markers.extend([[ends[i].x, ends[i].y], [ends[j].x, ends[j].y]]);
        if markers.len() >= 8 {
            break;
        }
    }
    json!(markers)
}

pub fn swatches(s: &mut Session) -> Result<Value, String> {
    let catalog = s
        .execute("hatch.patterns", &json!({}))
        .map_err(|e| e.to_string())?;
    let names = catalog["standard"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    let d = s.doc().map_err(|e| e.to_string())?;
    Ok(json!(names.map(|name| {
        let lines = library::pattern_for(d, name).map(|p| render::pattern_swatch(&p.lines, 64.0)).unwrap_or_default();
        json!({"name":name,"solid":name == "SOLID","lines":lines.iter().map(|line|line.iter().map(|p|[p.x,p.y]).collect::<Vec<_>>()).collect::<Vec<_>>()})
    }).collect::<Vec<_>>()))
}

// The upstream region tracer tessellates ellipses with a different tolerance
// from its association verifier. Only recover a full ellipse whose vertices
// lie on that exact curve; overlapping or partial outlines are not adopted.
fn repair_ellipse(d: &Drawing, h: &mut Hatch) {
    for l in &mut h.loops {
        if !l.sources.is_empty() {
            continue;
        }
        for e in d.model.iter().filter(|e| d.is_visible(e)) {
            // A failed outer-loop verification also clears otherwise valid
            // island sources. Recover their exact analytic boundaries too.
            if let EntityKind::Circle(c) = &e.kind {
                if l.vertices.len() == 2
                    && l.vertices
                        .iter()
                        .all(|v| (v.bulge.abs() - 1.0).abs() < 1e-9)
                    && l.vertices[0]
                        .p
                        .mid(l.vertices[1].p)
                        .near(c.center.xy(), 1e-7)
                    && (l.vertices[0].p.dist(c.center.xy()) - c.radius).abs() < 1e-7
                {
                    l.sources = vec![e.handle];
                    break;
                }
            }
            if let EntityKind::LwPolyline(p) = &e.kind {
                let n = l.vertices.len();
                if p.closed
                    && n == p.vertices.len()
                    && (0..n).any(|offset| {
                        (0..n).all(|i| {
                            l.vertices[i].p.near(p.vertices[(i + offset) % n].p, 1e-7)
                                && (l.vertices[i].bulge - p.vertices[(i + offset) % n].bulge).abs()
                                    < 1e-9
                        })
                    })
                {
                    l.sources = vec![e.handle];
                    break;
                }
            }
            if l.vertices.len() < 12 {
                continue;
            }
            let EntityKind::Ellipse(el) = &e.kind else {
                continue;
            };
            let curve = cadcraft_engine::geom::Ellipse {
                center: el.center.xy(),
                major: el.major.xy(),
                ratio: el.ratio,
                start: el.start,
                end: el.end,
            };
            if !curve.is_full() {
                continue;
            }
            let a = el.major.xy().len();
            if a <= 0.0 || el.ratio <= 0.0 {
                continue;
            }
            let u = el.major.xy() / a;
            let normal: Vec<Vec2> = l
                .vertices
                .iter()
                .map(|v| {
                    let q = v.p - el.center.xy();
                    Vec2::new(
                        (q.x * u.x + q.y * u.y) / a,
                        (-q.x * u.y + q.y * u.x) / (a * el.ratio),
                    )
                })
                .collect();
            if normal.iter().all(|p| (p.len2() - 1.0).abs() < 1e-4)
                && cadcraft_engine::geom::shoelace(&normal).abs() > 3.10
            {
                let mut points = Vec::new();
                curve.tessellate(a * 1e-3, &mut points);
                points.pop();
                l.vertices = points.into_iter().map(PolyVertex::new).collect();
                l.sources = vec![e.handle];
                break;
            }
        }
    }
    h.associative = h.loops.iter().all(|l| !l.sources.is_empty());
}

pub(crate) fn density(d: &Drawing, h: &Hatch) -> Result<(), String> {
    if h.solid {
        return Ok(());
    }
    let bounds = Bounds2::from_points(h.loops.iter().flat_map(|l| {
        Polyline {
            vertices: l.vertices.clone(),
            closed: true,
        }
        .tessellate(1e-3)
    }));
    let lines = if h.pattern_lines.is_empty() {
        library::pattern_for(d, &h.pattern)
            .map(|p| p.lines)
            .unwrap_or_default()
    } else {
        h.pattern_lines.clone()
    };
    let mut estimated = 0.0;
    for line in lines {
        let pitch = line.delta.1.abs() * h.scale;
        if pitch <= 0.0 {
            continue;
        }
        let angle = line.angle.to_radians() + h.angle;
        let span = bounds.width() * angle.sin().abs() + bounds.height() * angle.cos().abs();
        let families = span / pitch;
        // Match the renderer's finite full-document family budget. Otherwise
        // it silently skips a too-dense family and exports an empty fill.
        if families > 19_998.0 {
            return Err("剖面线过密，请增大填充比例或缩小填充区域。".into());
        }
        let dash = line.dashes.iter().map(|d| d.abs()).sum::<f64>() * h.scale;
        let runs = if dash > 0.0 {
            (bounds.width() + bounds.height()) / dash * (line.dashes.len().max(1) as f64)
        } else {
            1.0
        };
        estimated += (families + 2.0) * runs.max(1.0);
    }
    if estimated > 200_000.0 {
        return Err("剖面线过密，请增大填充比例或缩小填充区域。".into());
    }
    Ok(())
}

fn boundary_roles(loops: &mut [HatchLoop]) -> Result<Vec<Vec<Vec2>>, String> {
    if loops.len() > 2000 {
        return Err("填充边界过多，请分批修改。".into());
    }
    let polygons: Vec<Vec<Vec2>> = loops
        .iter()
        .map(|l| {
            Polyline {
                vertices: l.vertices.clone(),
                closed: true,
            }
            .tessellate(1e-3)
        })
        .collect();
    for (i, l) in loops.iter_mut().enumerate() {
        let probe = polygons[i].first().copied().unwrap_or(Vec2::ZERO);
        let depth = polygons
            .iter()
            .enumerate()
            .filter(|(j, p)| *j != i && cadcraft_engine::geom::point_in_polygon(p, probe))
            .count();
        l.outer = depth % 2 == 0;
    }
    Ok(polygons)
}

pub fn execute(s: &mut Session, command: &str, p: &Value) -> Result<Value, String> {
    execute_checked(s, command, p, false)
}

pub fn preview(s: &mut Session, command: &str, p: &Value) -> Result<Value, String> {
    execute_checked(s, command, p, true)
}

fn execute_checked(
    s: &mut Session,
    command: &str,
    p: &Value,
    preview: bool,
) -> Result<Value, String> {
    let before = s.state().map_err(|e| e.to_string())?.clone();
    let mut work = Session::empty();
    work.new_drawing(true);
    *work.state_mut().map_err(|e| e.to_string())? = before.clone();
    let gap = if let Some(gap) = p.get("gapTolerance") {
        gap.as_f64()
            .filter(|g| g.is_finite() && (0.0..=5000.0).contains(g))
            .ok_or("缺口容差须在 0 至 5000 之间。")?
    } else if command == "hatch"
        || p.get("boundaryAdd").is_some()
        || p.get("boundaryPoints").is_some()
    {
        automatic_gap(&before.doc, p)
    } else {
        before.doc.header.f64("HPGAPTOL", 0.0)
    };
    work.doc_mut()
        .map_err(|e| e.to_string())?
        .header
        .set_f64("HPGAPTOL", gap);
    let target = handles(p, "handles");
    let remove = handles(p, "boundaryRemove");
    let mut additions: Vec<HatchLoop> = Vec::new();
    let mut point_validation = None;
    if p.get("boundaryAdd").is_some() || p.get("boundaryPoints").is_some() {
        let mut q = json!({"pattern":"SOLID"});
        if p.get("boundaryAdd").is_some() {
            q["handles"] = p["boundaryAdd"].clone();
        } else {
            q["points"] = p["boundaryPoints"].clone();
        }
        let created = make(&mut work, &q, preview)?;
        if p.get("boundaryPoints").is_some() {
            point_validation = Some((
                created["acceptedPointIndices"].clone(),
                created["rejectedPointIndices"].clone(),
            ));
        }
        for h in handles(&created, "handles") {
            if let Some(e) = work.doc().map_err(|e| e.to_string())?.entity(h) {
                if let EntityKind::Hatch(h) = &e.kind {
                    additions.extend(h.loops.clone());
                }
            }
        }
        // Discard temporary entities and their undo record. Retain only loops.
        *work.state_mut().map_err(|e| e.to_string())? = before.clone();
    }
    let mut result = if command == "hatch" {
        // Boundary-add probes restore their snapshot; use the same tolerance for the final operation.
        work.doc_mut()
            .map_err(|e| e.to_string())?
            .header
            .set_f64("HPGAPTOL", gap);
        make(&mut work, p, preview)?
    } else {
        work.execute(command, p).map_err(|e| e.to_string())?
    };
    if let Some((accepted, rejected)) = point_validation {
        result["acceptedPointIndices"] = accepted;
        result["rejectedPointIndices"] = rejected;
    }
    let touched = if command == "hatch" {
        handles(&result, "handles")
    } else {
        target
    };
    let mut sources = Vec::new();
    for handle in touched {
        let d = work.doc().map_err(|e| e.to_string())?;
        let Some(EntityKind::Hatch(mut h)) = d.entity(handle).map(|e| e.kind.clone()) else {
            continue;
        };
        if !remove.is_empty() {
            let polygons = boundary_roles(&mut h.loops)?;
            let removed_outer: Vec<_> = h
                .loops
                .iter()
                .enumerate()
                .filter(|(_, l)| l.outer && l.sources.iter().any(|s| remove.contains(s)))
                .map(|(i, _)| polygons[i].clone())
                .collect();
            h.loops.retain(|l| {
                !l.sources.iter().any(|s| remove.contains(s))
                    && !l.vertices.first().is_some_and(|v| {
                        removed_outer
                            .iter()
                            .any(|outer| cadcraft_engine::geom::point_in_polygon(outer, v.p))
                    })
            });
        }
        for l in &additions {
            if !h
                .loops
                .iter()
                .any(|old| old.sources == l.sources && old.vertices == l.vertices)
            {
                let mut added = l.clone();
                let points = Polyline {
                    vertices: l.vertices.clone(),
                    closed: true,
                }
                .tessellate(1e-3);
                if let Some(first) = points.first() {
                    let depth = h
                        .loops
                        .iter()
                        .filter(|old| {
                            cadcraft_engine::geom::point_in_polygon(
                                &Polyline {
                                    vertices: old.vertices.clone(),
                                    closed: true,
                                }
                                .tessellate(1e-3),
                                *first,
                            )
                        })
                        .count();
                    added.outer = depth % 2 == 0;
                }
                h.loops.push(added);
            }
        }
        if !additions.is_empty() {
            boundary_roles(&mut h.loops)?;
        }
        // DXF path flags need not identify an External path (e.g. a valid
        // polyline path may have only flag 2). Infer missing roles from the
        // stored boundaries; never trace or replace imported geometry.
        if !h.loops.iter().any(|l| l.outer) {
            boundary_roles(&mut h.loops)?;
        }
        if h.loops.is_empty() || !h.loops.iter().any(|l| l.outer) {
            return Err("至少保留一个外部填充边界。".into());
        }
        if p["associative"].as_bool() != Some(false)
            && (command == "hatch"
                || !additions.is_empty()
                || p["associative"].as_bool() == Some(true))
        {
            repair_ellipse(d, &mut h);
        }
        density(d, &h)?;
        sources.push(json!({"handle":handle.hex(),"sources":h.loops.iter().flat_map(|l|l.sources.iter().map(|s|s.hex())).collect::<Vec<_>>()}));
        work.doc_mut()
            .map_err(|e| e.to_string())?
            .modify_entity(handle, |e| e.kind = EntityKind::Hatch(h))
            .map_err(|e| e.to_string())?;
    }
    result["hatches"] = json!(sources);
    if let Some(value) = before.doc.header.get("HPGAPTOL") {
        work.doc_mut()
            .map_err(|e| e.to_string())?
            .header
            .vars
            .insert("HPGAPTOL".into(), value.clone());
    } else {
        work.doc_mut()
            .map_err(|e| e.to_string())?
            .header
            .vars
            .remove("HPGAPTOL");
    }
    let doc = work.state().map_err(|e| e.to_string())?.doc.clone();
    let state = s.state_mut().map_err(|e| e.to_string())?;
    state.push_undo(Snapshot {
        label: "剖面填充".into(),
        doc: before.doc,
        selection: before.selection,
    });
    state.doc = doc;
    state.revision += 1;
    Ok(result)
}

// Upstream's Select Objects path accepts closed entities only. Join selected
// open curves into a disposable boundary without altering the user's lines.
fn make(s: &mut Session, p: &Value, preview: bool) -> Result<Value, String> {
    if let Some(points) = p["points"].as_array() {
        let initial = s.state().map_err(|e| e.to_string())?.clone();
        let mut accepted = Vec::new();
        let mut rejected = Vec::new();
        let mut created = Vec::new();
        let mut regions: Vec<Vec<Vec<Vec2>>> = Vec::new();
        for (index, point) in points.iter().enumerate() {
            let probe = point[0]
                .as_f64()
                .zip(point[1].as_f64())
                .map(|(x, y)| Vec2::new(x, y));
            if probe.is_some_and(|v| {
                regions.iter().any(|loops| {
                    loops
                        .iter()
                        .filter(|l| cadcraft_engine::geom::point_in_polygon(l, v))
                        .count()
                        % 2
                        == 1
                })
            }) {
                continue;
            }
            // Trace on an isolated snapshot. Failed/open points cannot leave entities behind.
            let before = s.state().map_err(|e| e.to_string())?.clone();
            let mut q = p.clone();
            q["points"] = json!([point]);
            let traced = s.execute("hatch", &q).map_err(|e| e.to_string());
            let polygons = traced.as_ref().ok().map(|r| {
                handles(r, "handles")
                    .into_iter()
                    .flat_map(|h| {
                        s.doc()
                            .ok()
                            .and_then(|d| d.entity(h))
                            .and_then(|e| match &e.kind {
                                EntityKind::Hatch(h) => Some(
                                    h.loops
                                        .iter()
                                        .map(|l| {
                                            Polyline {
                                                vertices: l.vertices.clone(),
                                                closed: true,
                                            }
                                            .tessellate(1e-3)
                                        })
                                        .collect::<Vec<_>>(),
                                ),
                                _ => None,
                            })
                            .unwrap_or_default()
                    })
                    .collect::<Vec<_>>()
            });
            match (traced, polygons) {
                (Ok(result), Some(polygons)) if !polygons.is_empty() => {
                    accepted.push(index);
                    regions.push(polygons);
                    created.extend(handles(&result, "handles"));
                }
                (Err(error), _) if !preview => {
                    *s.state_mut().map_err(|e| e.to_string())? = initial;
                    return Err(error);
                }
                _ => {
                    *s.state_mut().map_err(|e| e.to_string())? = before;
                    rejected.push(index);
                }
            }
        }
        let mut q = p.clone();
        q["points"] = json!(accepted.iter().map(|i| &points[*i]).collect::<Vec<_>>());
        let mut result = if accepted.len() <= 1 || p["separate"].as_bool() == Some(true) {
            json!({"handle":created.first().map(|h|h.hex()),"handles":created.iter().map(|h|h.hex()).collect::<Vec<_>>()})
        } else {
            *s.state_mut().map_err(|e| e.to_string())? = initial;
            s.execute("hatch", &q).map_err(|e| e.to_string())?
        };
        result["acceptedPointIndices"] = json!(accepted);
        result["rejectedPointIndices"] = json!(rejected);
        return Ok(result);
    }
    let selected = handles(p, "handles");
    if selected.is_empty() || p.get("points").is_some() {
        return s.execute("hatch", p).map_err(|e| e.to_string());
    }
    let d = s.doc().map_err(|e| e.to_string())?;
    let open: Vec<Handle> = selected
        .iter()
        .copied()
        .filter(|h| {
            d.entity(*h).is_some_and(|e| match &e.kind {
                EntityKind::Line(_) | EntityKind::Arc(_) => true,
                EntityKind::LwPolyline(p) => !p.closed,
                EntityKind::Spline(p) => !p.closed,
                EntityKind::Ellipse(p) => !cadcraft_engine::geom::Ellipse {
                    center: p.center.xy(),
                    major: p.major.xy(),
                    ratio: p.ratio,
                    start: p.start,
                    end: p.end,
                }
                .is_full(),
                _ => false,
            })
        })
        .collect();
    if open.is_empty() {
        return s.execute("hatch", p).map_err(|e| e.to_string());
    }
    let ext = d.extents(&cadcraft_engine::doc::Space::Model);
    let size = (ext.width() + ext.height()).max(1e-6);
    let polys: Vec<Vec<Vec2>> = open
        .iter()
        .filter_map(|h| d.entity(*h))
        .flat_map(|e| cadcraft_engine::select::hit_polylines(d, e, size / 20_000.0))
        .collect();
    let outline = cadcraft_engine::geom::region::outline(
        &polys,
        (size * 1e-9).max(1e-9),
        d.header.f64("HPGAPTOL", 0.0),
    )
    .ok_or("所选线条没有形成闭合边界，请补齐缺口或点选区域内部。")?;
    let temporary = s
        .execute(
            "pline",
            &json!({"points":outline.iter().map(|p|[p.x,p.y]).collect::<Vec<_>>(),"closed":true}),
        )
        .map_err(|e| e.to_string())?;
    let temp = temporary["handle"]
        .as_str()
        .and_then(Handle::parse_hex)
        .ok_or("临时填充边界生成失败")?;
    let mut q = p.clone();
    q["handles"] = json!(
        selected
            .iter()
            .filter(|h| !open.contains(h))
            .map(|h| h.hex())
            .chain(std::iter::once(temp.hex()))
            .collect::<Vec<_>>()
    );
    let result = s.execute("hatch", &q).map_err(|e| e.to_string())?;
    s.doc_mut().map_err(|e| e.to_string())?.remove_entity(temp);
    for handle in handles(&result, "handles") {
        s.doc_mut()
            .map_err(|e| e.to_string())?
            .modify_entity(handle, |e| {
                if let EntityKind::Hatch(h) = &mut e.kind {
                    for l in &mut h.loops {
                        if l.sources.contains(&temp) {
                            l.sources = open.clone();
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(result)
}
