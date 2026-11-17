use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};

fn run(session: &mut CadcraftSession, command: &str, params: Value) -> Value {
    serde_json::from_str(&session.execute(command, &params.to_string()).unwrap()).unwrap()
}

fn scene(session: &CadcraftSession) -> Value {
    serde_json::from_str(&session.scene().unwrap()).unwrap()
}

fn spring() -> Value {
    json!({"at":[10.0,20.0],"end":[90.0,20.0],"width":30.0,"turns":6,"wire":2.0})
}

#[test]
fn extension_spring_preserves_kind_through_edit_grip_and_dxf() {
    let mut s = CadcraftSession::new();
    let result = run(
        &mut s,
        "bridge.spring",
        json!({"kind":"extension","at":[0,0],"end":[82.7,0],"width":20,"turns":15,"wire":2.3}),
    );
    let h = result["handle"].as_str().unwrap();
    assert_eq!(scene(&s)["entities"][0]["spring"]["kind"], "extension");
    assert_eq!(scene(&s)["primitives"].as_array().unwrap().len(), 42);
    let before = s.export_dxf().unwrap();
    assert!(
        s.execute(
            "bridge.spring",
            &json!({"kind":null,"handle":h,"turns":15,"wire":2.3}).to_string()
        )
        .is_err()
    );
    assert_eq!(s.export_dxf().unwrap(), before);
    run(
        &mut s,
        "grip.move",
        json!({"handle":h,"index":1,"to":[100,0]}),
    );
    run(
        &mut s,
        "bridge.spring",
        json!({"handle":h,"turns":14,"wire":2.3}),
    );
    assert_eq!(scene(&s)["entities"][0]["spring"]["kind"], "extension");
    let bytes = s.export_dxf().unwrap();
    let mut reopened = CadcraftSession::new();
    reopened.load_dxf(&bytes).unwrap();
    assert_eq!(
        scene(&reopened)["entities"][0]["spring"]["kind"],
        "extension"
    );
    assert_eq!(scene(&reopened)["entities"][0]["spring"]["turns"], 14);
    assert!(
        s.execute(
            "bridge.spring",
            &json!({"kind":"extension","at":[0,0],"end":[40,0],"width":20,"turns":15,"wire":2.3})
                .to_string()
        )
        .is_err()
    );
}

#[test]
fn spring_side_view_draws_visible_coil_loops_instead_of_two_waves() {
    let mut session = CadcraftSession::new();
    run(&mut session, "bridge.spring", spring());
    let drawing = scene(&session);
    assert_eq!(drawing["primitives"].as_array().unwrap().len(), 2 * 6 + 5);
}

#[test]
fn sample_spring_has_two_close_unground_end_turns_and_five_active_turns() {
    use cadcraft_engine::doc::EntityKind;

    let mut session = CadcraftSession::new();
    run(
        &mut session,
        "bridge.spring",
        json!({"at":[0.0,0.0],"end":[88.25,0.0],"width":45.0,"turns":7,"wire":4.5}),
    );
    let doc = cadcraft_io::read(&session.export_dxf().unwrap(), "spring.dxf").unwrap();
    let block = doc
        .blocks
        .values()
        .find(|b| b.description.starts_with("PatentWorkbenchSpring:"))
        .unwrap();
    let children: Vec<_> = block.entities.iter().collect();
    assert_eq!(children.len(), 2 * 7 + 5);
    let extent = |entity: &std::sync::Arc<cadcraft_engine::doc::Entity>| {
        let EntityKind::LwPolyline(ref poly) = entity.kind else {
            panic!("expected editable polyline")
        };
        let axial: Vec<_> = poly.vertices.iter().map(|v| v.p.x * 88.25).collect();
        axial.iter().copied().fold(f64::NEG_INFINITY, f64::max)
            - axial.iter().copied().fold(f64::INFINITY, f64::min)
    };
    let end_span = extent(children[0]);
    let body_span = extent(children[3]);
    assert!(
        end_span < body_span * 0.75,
        "end coil should be visibly close"
    );
    assert!(
        extent(children[6]) < body_span * 0.75,
        "both end coils should be close"
    );
    let starts: Vec<_> = (0..4)
        .map(|i| {
            let EntityKind::LwPolyline(ref poly) = children[2 + i].kind else {
                unreachable!()
            };
            poly.vertices[0].p.x * 88.25
        })
        .collect();
    assert!(
        starts
            .windows(2)
            .all(|pair| ((pair[1] - pair[0]) - 14.95 * 88.25 / 90.37951188).abs() < 0.05)
    );
    let EntityKind::LwPolyline(ref left) = children[3].kind else {
        unreachable!()
    };
    let EntityKind::LwPolyline(ref right) = children[10].kind else {
        unreachable!()
    };
    assert!(left.vertices[0].p.y * 45.0 < -5.0);
    assert!(left.vertices.iter().any(|v| v.p.y * 45.0 > 20.0));
    assert!(left.vertices.last().unwrap().p.y * 45.0 < -15.0);
    assert!(right.vertices[0].p.y * 45.0 > 5.0);
    assert!(right.vertices.iter().any(|v| v.p.y * 45.0 < -20.0));
    assert!(right.vertices.last().unwrap().p.y * 45.0 > 15.0);
    assert!(children.iter().all(|entity| matches!(&entity.kind, EntityKind::LwPolyline(poly) if poly.vertices.len() >= 3)), "all visible wire outlines and unground ends must remain editable curves");
    for cap in &children[14..19] {
        let EntityKind::LwPolyline(ref poly) = cap.kind else {
            unreachable!()
        };
        assert!(poly.vertices.iter().all(|vertex| vertex.p.y < 0.0));
    }
}

#[test]
fn supplied_spring_profile_keeps_the_left_and_right_visible_turns() {
    use cadcraft_engine::doc::EntityKind;

    let mut session = CadcraftSession::new();
    run(
        &mut session,
        "bridge.spring",
        json!({"at":[0.0,0.0],"end":[88.25,0.0],"width":45.0,"turns":7,"wire":4.5}),
    );
    let doc = cadcraft_io::read(&session.export_dxf().unwrap(), "reference-spring.dxf").unwrap();
    let block = doc
        .blocks
        .values()
        .find(|block| block.description.starts_with("PatentWorkbenchSpring:"))
        .unwrap();
    let children: Vec<_> = block.entities.iter().collect();
    assert_eq!(
        children.len(),
        19,
        "the reference has seven visible turns on each side and five unground end details"
    );

    let curve = |index: usize| {
        let EntityKind::LwPolyline(polyline) = &children[index].kind else {
            panic!("spring outline must stay editable");
        };
        polyline
            .vertices
            .iter()
            .map(|point| (point.p.x * 88.25, point.p.y * 45.0))
            .collect::<Vec<_>>()
    };
    let left = curve(3);
    assert!((left[0].0 - 36.82).abs() < 1.0);
    assert!((left[0].1 + 11.76).abs() < 1.0);
    assert!(left.iter().any(|point| point.1 > 22.0));
    assert!((left.last().unwrap().1 + 18.66).abs() < 1.0);

    let right = curve(10);
    assert!((right[0].0 - 58.72).abs() < 1.0);
    assert!((right[0].1 - 11.8).abs() < 1.0);
    assert!(right.iter().any(|point| point.1 < -20.0));
    assert!((right.last().unwrap().1 - 18.65).abs() < 1.0);
}

#[test]
fn wire_diameter_is_geometrically_preserved_at_other_spring_sizes() {
    use cadcraft_engine::doc::EntityKind;
    let mut session = CadcraftSession::new();
    run(&mut session, "bridge.spring", spring());
    let doc = cadcraft_io::read(&session.export_dxf().unwrap(), "wire-size.dxf").unwrap();
    let block = doc
        .blocks
        .values()
        .find(|block| block.description.starts_with("PatentWorkbenchSpring:5:"))
        .unwrap();
    let circle = block.entities.iter().nth(2 * 6 + 2).unwrap();
    let EntityKind::LwPolyline(circle) = &circle.kind else {
        panic!("end must be an editable circle")
    };
    for (scale, dimension) in [(80.0, 0), (30.0, 1)] {
        let values: Vec<_> = circle
            .vertices
            .iter()
            .map(|v| {
                if dimension == 0 {
                    v.p.x * scale
                } else {
                    v.p.y * scale
                }
            })
            .collect();
        let diameter = values.iter().copied().fold(f64::NEG_INFINITY, f64::max)
            - values.iter().copied().fold(f64::INFINITY, f64::min);
        assert!(
            (diameter - 2.0).abs() < 0.05,
            "end-face diameter should match wire size"
        );
    }
}

#[test]
fn body_wire_diameter_matches_the_end_face_after_independent_resizing() {
    use cadcraft_engine::doc::EntityKind;
    for (length, width, wire) in [(80.0, 30.0, 2.0), (120.0, 45.0, 3.0), (80.0, 30.0, 5.0)] {
        let mut session = CadcraftSession::new();
        run(
            &mut session,
            "bridge.spring",
            json!({"at":[0,0],"end":[length,0],"width":width,"turns":6,"wire":wire}),
        );
        let doc = cadcraft_io::read(&session.export_dxf().unwrap(), "wire.dxf").unwrap();
        let block = doc
            .blocks
            .values()
            .find(|b| b.description.starts_with("PatentWorkbenchSpring:"))
            .unwrap();
        let paths: Vec<Vec<_>> = block
            .entities
            .iter()
            .map(|entity| {
                let EntityKind::LwPolyline(p) = &entity.kind else {
                    panic!("expected editable contour")
                };
                p.vertices
                    .iter()
                    .map(|v| (v.p.x * length, v.p.y * width))
                    .collect()
            })
            .collect();
        let crossing = |index: usize, last: bool| {
            let mut hits: Vec<_> = paths[index]
                .windows(2)
                .filter_map(|pair| {
                    let (a, b) = (pair[0], pair[1]);
                    if a.1 * b.1 > 0.0 || a.1 == b.1 {
                        return None;
                    }
                    Some((a.0 - a.1 * (b.0 - a.0) / (b.1 - a.1), b.0 - a.0, b.1 - a.1))
                })
                .collect();
            hits.sort_by(|a, b| a.0.total_cmp(&b.0));
            if last { *hits.last().unwrap() } else { hits[0] }
        };
        let outer = crossing(3, true);
        let inner = crossing(8, false);
        let thickness = ((outer.0 - inner.0) * inner.2).abs() / inner.1.hypot(inner.2);
        assert!(
            (thickness - wire).abs() < wire * 0.06,
            "L={length}, W={width}: body wire {thickness} must match end wire {wire}"
        );
    }
}

fn previous_spring_document() -> (CadcraftSession, cadcraft_engine::doc::Drawing, String) {
    use cadcraft_engine::{
        doc::{EntityKind, EntityStore, Line},
        geom::{PolyVertex, Vec2, Vec3},
    };
    use std::{f64::consts::TAU, sync::Arc};

    fn previous_point(i: usize, side: f64) -> Vec2 {
        let t = i as f64 / (6 * 24) as f64;
        let angle = TAU * 6.0 * t;
        let usable = 1.0 - 2.0 / 80.0;
        let projection = 0.7 * usable / 6.0;
        let radius = 0.5 - 2.0 / 60.0;
        let x = 2.0 / 160.0 + usable * t + projection * angle.sin();
        let y = radius * angle.cos();
        let tangent_x = 80.0 * (usable / (TAU * 6.0) + projection * angle.cos());
        let tangent_y = -30.0 * radius * angle.sin();
        let offset = side / tangent_x.hypot(tangent_y);
        Vec2::new(x - offset * tangent_y / 80.0, y + offset * tangent_x / 30.0)
    }

    let mut session = CadcraftSession::new();
    run(&mut session, "bridge.spring", spring());
    let mut doc = cadcraft_io::read(&session.export_dxf().unwrap(), "old-spring.dxf").unwrap();
    let name = doc
        .blocks
        .keys()
        .find(|name| name.starts_with("PW_SPRING_"))
        .unwrap()
        .clone();
    let mut block = (**doc.blocks.get(&name).unwrap()).clone();
    block.description =
        block
            .description
            .replacen("PatentWorkbenchSpring:5:", "PatentWorkbenchSpring:2:", 1);
    let originals: Vec<_> = block
        .entities
        .iter()
        .map(|entity| (**entity).clone())
        .collect();
    let mut old_entities = EntityStore::new();
    for (index, mut child) in originals.into_iter().take(2).enumerate() {
        if index < 2 {
            let EntityKind::LwPolyline(ref mut curve) = child.kind else {
                panic!("expected contour")
            };
            let side = if index == 0 { -1.0 } else { 1.0 };
            curve.vertices = (0..=6 * 24)
                .map(|i| PolyVertex::new(previous_point(i, side)))
                .collect();
        }
        old_entities.push(child);
    }
    for (index, entity) in block
        .entities
        .iter()
        .skip(block.entities.len() - 2)
        .enumerate()
    {
        let mut child = (**entity).clone();
        let i = if index == 0 { 0 } else { 6 * 24 };
        let a = previous_point(i, -1.0);
        let b = previous_point(i, 1.0);
        child.kind = EntityKind::Line(Line {
            a: Vec3::new(a.x, a.y, 0.0),
            b: Vec3::new(b.x, b.y, 0.0),
        });
        old_entities.push(child);
    }
    block.entities = old_entities;
    doc.blocks.insert(name.clone(), Arc::new(block));
    (session, doc, name)
}

#[test]
fn untouched_previous_spring_upgrades_to_closed_end_geometry_on_import() {
    use cadcraft_engine::doc::EntityKind;

    let (mut session, doc, name) = previous_spring_document();
    session
        .load_dxf(&cadcraft_io::write(&doc, "old-spring.dxf").unwrap())
        .unwrap();
    let exported = cadcraft_io::read(&session.export_dxf().unwrap(), "upgraded.dxf").unwrap();
    assert!(
        exported.blocks[&name]
            .description
            .starts_with("PatentWorkbenchSpring:5:")
    );
    assert_eq!(exported.blocks[&name].entities.len(), 2 * 6 + 5);
    assert!(
        exported.blocks[&name]
            .entities
            .iter()
            .all(|entity| !matches!(entity.kind, EntityKind::Line(_)))
    );
}

#[test]
fn externally_modified_previous_spring_is_not_silently_replaced() {
    use cadcraft_engine::doc::EntityKind;
    use std::sync::Arc;

    let (mut session, mut doc, name) = previous_spring_document();
    let mut block = (**doc.blocks.get(&name).unwrap()).clone();
    let mut child = (**block.entities.iter().next().unwrap()).clone();
    let EntityKind::LwPolyline(ref mut contour) = child.kind else {
        unreachable!()
    };
    contour.vertices[12].p.y += 0.1;
    block.entities.replace(child);
    doc.blocks.insert(name.clone(), Arc::new(block));
    session
        .load_dxf(&cadcraft_io::write(&doc, "modified-spring.dxf").unwrap())
        .unwrap();
    let exported =
        cadcraft_io::read(&session.export_dxf().unwrap(), "modified-spring.dxf").unwrap();
    assert!(
        exported.blocks[&name]
            .description
            .starts_with("PatentWorkbenchSpring:2:")
    );
    assert_eq!(exported.blocks[&name].entities.len(), 4);
}

#[test]
fn previous_spring_with_missing_contours_is_left_untouched_on_import() {
    use cadcraft_engine::doc::EntityStore;
    use std::sync::Arc;

    let (mut session, mut doc, name) = previous_spring_document();
    let mut block = (**doc.blocks.get(&name).unwrap()).clone();
    block.entities = EntityStore::new();
    doc.blocks.insert(name.clone(), Arc::new(block));

    session
        .load_dxf(&cadcraft_io::write(&doc, "missing-spring.dxf").unwrap())
        .unwrap();
    let exported = cadcraft_io::read(&session.export_dxf().unwrap(), "missing-spring.dxf").unwrap();
    assert!(
        exported.blocks[&name]
            .description
            .starts_with("PatentWorkbenchSpring:2:")
    );
    assert_eq!(exported.blocks[&name].entities.len(), 0);
}

fn legacy_spring_document() -> (CadcraftSession, cadcraft_engine::doc::Drawing, String) {
    use cadcraft_engine::doc::{EntityKind, EntityStore, Line};
    use cadcraft_engine::geom::{PolyVertex, Vec2, Vec3};
    use std::sync::Arc;

    let mut session = CadcraftSession::new();
    run(&mut session, "line", json!({"points":[[-20,0],[-10,0]]}));
    run(&mut session, "bridge.spring", spring());
    let mut doc = cadcraft_io::read(&session.export_dxf().unwrap(), "older-spring.dxf").unwrap();
    let name = doc
        .blocks
        .keys()
        .find(|name| name.starts_with("PW_SPRING_V5_"))
        .unwrap()
        .clone();
    let mut block = (**doc.blocks.get(&name).unwrap()).clone();
    block.description =
        block
            .description
            .replacen("PatentWorkbenchSpring:5:", "PatentWorkbenchSpring:1:", 1);
    let mut old_entities = EntityStore::new();
    for (index, entity) in block.entities.iter().take(2).enumerate() {
        let mut child = (**entity).clone();
        let EntityKind::LwPolyline(ref mut curve) = child.kind else {
            unreachable!()
        };
        let side = if index == 0 { -1.0 } else { 1.0 };
        curve.vertices = (0..=6 * 24)
            .map(|i| {
                let t = i as f64 / (6 * 24) as f64;
                PolyVertex::new(Vec2::new(
                    t,
                    (0.5 - 1.0 / 30.0) * (std::f64::consts::TAU * 6.0 * t).sin() + side / 30.0,
                ))
            })
            .collect();
        old_entities.push(child);
    }
    for (index, entity) in block
        .entities
        .iter()
        .skip(block.entities.len() - 2)
        .enumerate()
    {
        let mut child = (**entity).clone();
        let x = if index == 0 { 0.0 } else { 1.0 };
        child.kind = EntityKind::Line(Line {
            a: Vec3::new(x, -1.0 / 30.0, 0.0),
            b: Vec3::new(x, 1.0 / 30.0, 0.0),
        });
        old_entities.push(child);
    }
    block.entities = old_entities;
    doc.blocks.insert(name.clone(), Arc::new(block));
    (session, doc, name)
}

#[test]
fn loading_an_older_spring_rebuilds_its_profile_without_changing_other_entities() {
    let (mut session, doc, name) = legacy_spring_document();
    let bytes = cadcraft_io::write(&doc, "older-spring.dxf").unwrap();
    session.load_dxf(&bytes).unwrap();
    let drawing = scene(&session);
    assert_eq!(drawing["entityCount"], 2);
    let upgraded = cadcraft_io::read(&session.export_dxf().unwrap(), "new-spring.dxf").unwrap();
    assert!(
        upgraded.blocks[&name]
            .description
            .starts_with("PatentWorkbenchSpring:5:"),
        "{}",
        upgraded.blocks[&name].description
    );
    assert!(
        drawing["primitives"].as_array().unwrap().len() >= 2 * 6 + 5,
        "{}",
        drawing["primitives"].as_array().unwrap().len()
    );
}

#[test]
fn invalidly_short_legacy_spring_is_not_upgraded_or_corrupted() {
    use cadcraft_engine::doc::EntityKind;

    let (mut session, mut doc, name) = legacy_spring_document();
    let insert = doc
        .model
        .iter()
        .find_map(|entity| {
            matches!(&entity.kind, EntityKind::Insert(value) if value.block == name)
                .then(|| (**entity).clone())
        })
        .unwrap();
    let mut insert = insert;
    let EntityKind::Insert(ref mut value) = insert.kind else {
        unreachable!()
    };
    value.scale.x = 2.0;
    doc.model.replace(insert);
    session
        .load_dxf(&cadcraft_io::write(&doc, "short-spring.dxf").unwrap())
        .unwrap();
    let exported = cadcraft_io::read(&session.export_dxf().unwrap(), "short-spring.dxf").unwrap();
    assert!(
        exported.blocks[&name]
            .description
            .starts_with("PatentWorkbenchSpring:1:")
    );
    for primitive in scene(&session)["primitives"].as_array().unwrap() {
        for point in primitive["points"].as_array().unwrap() {
            assert!(point[0].as_f64().unwrap().is_finite());
            assert!(point[1].as_f64().unwrap().is_finite());
        }
    }
}

#[test]
fn legacy_spring_with_custom_polyline_attributes_is_not_upgraded() {
    use cadcraft_engine::doc::EntityKind;
    use std::sync::Arc;

    let (mut session, mut doc, name) = legacy_spring_document();
    let mut block = (**doc.blocks.get(&name).unwrap()).clone();
    let mut child = (**block.entities.iter().next().unwrap()).clone();
    let EntityKind::LwPolyline(ref mut curve) = child.kind else {
        unreachable!()
    };
    curve.elevation = 3.0;
    curve.plinegen = true;
    block.entities.replace(child);
    doc.blocks.insert(name.clone(), Arc::new(block));
    session
        .load_dxf(&cadcraft_io::write(&doc, "raised-spring.dxf").unwrap())
        .unwrap();
    let exported = cadcraft_io::read(&session.export_dxf().unwrap(), "raised-spring.dxf").unwrap();
    assert!(
        exported.blocks[&name]
            .description
            .starts_with("PatentWorkbenchSpring:1:")
    );
}

#[test]
fn legacy_spring_shared_with_different_aspect_ratios_is_not_upgraded() {
    use cadcraft_engine::doc::EntityKind;

    let (mut session, mut doc, name) = legacy_spring_document();
    let source = doc
        .model
        .iter()
        .find_map(|entity| {
            matches!(&entity.kind, EntityKind::Insert(value) if value.block == name)
                .then(|| (**entity).clone())
        })
        .unwrap();
    let mut copy = source.clone();
    copy.handle = doc.new_handle();
    let EntityKind::Insert(ref mut value) = copy.kind else {
        unreachable!()
    };
    value.scale.x *= 1.5;
    value.insert.x += 120.0;
    doc.model.push(copy);
    session
        .load_dxf(&cadcraft_io::write(&doc, "shared-spring.dxf").unwrap())
        .unwrap();
    let exported = cadcraft_io::read(&session.export_dxf().unwrap(), "shared-spring.dxf").unwrap();
    assert!(
        exported.blocks[&name]
            .description
            .starts_with("PatentWorkbenchSpring:1:")
    );
}

#[test]
fn externally_changed_legacy_spring_block_is_not_silently_overwritten() {
    use cadcraft_engine::doc::EntityKind;
    use std::sync::Arc;

    let (mut session, mut doc, name) = legacy_spring_document();
    let mut block = (**doc.blocks.get(&name).unwrap()).clone();
    let changed: Vec<_> = block
        .entities
        .iter()
        .filter_map(|entity| {
            let EntityKind::LwPolyline(_) = entity.kind else {
                return None;
            };
            let mut changed = (**entity).clone();
            let EntityKind::LwPolyline(ref mut curve) = changed.kind else {
                unreachable!()
            };
            curve.vertices[12].p.y += 0.1;
            Some(changed)
        })
        .collect();
    for child in changed {
        block.entities.replace(child);
    }
    doc.blocks.insert(name, Arc::new(block));
    session
        .load_dxf(&cadcraft_io::write(&doc, "edited-spring.dxf").unwrap())
        .unwrap();
    let drawing = scene(&session);
    let contour = drawing["primitives"][0]["points"].as_array().unwrap();
    let backwards = contour
        .windows(2)
        .filter(|pair| pair[1][0].as_f64().unwrap() < pair[0][0].as_f64().unwrap() - 1e-6)
        .count();
    assert_eq!(backwards, 0);
}

#[test]
fn spring_is_an_editable_standard_block_and_roundtrips_dxf() {
    let mut session = CadcraftSession::new();
    let handle = run(&mut session, "bridge.spring", spring())["handle"].clone();
    let before = scene(&session);
    assert_eq!(before["entities"][0]["spring"]["turns"], 6);
    assert_eq!(before["entities"][0]["spring"]["wire"], 2.0);
    assert_eq!(before["entities"][0]["spring"]["length"], 80.0);
    assert_eq!(before["entities"][0]["spring"]["width"], 30.0);
    assert_eq!(before["entities"][0]["grips"].as_array().unwrap().len(), 5);
    assert!(before["primitives"].as_array().unwrap().len() >= 2);
    session.load_dxf(&session.export_dxf().unwrap()).unwrap();
    assert_eq!(scene(&session)["entities"][0]["spring"]["turns"], 6);
    run(&mut session, "explode", json!({"handles":[handle]}));
    assert!(
        scene(&session)["entities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["spring"].is_null())
    );
}

#[test]
fn spring_validation_preview_and_undo_are_atomic() {
    let mut session = CadcraftSession::new();
    let original = session.export_dxf().unwrap();
    for (key, value) in [
        ("end", json!([10, 20])),
        ("width", json!(0)),
        ("width", json!(1e30)),
        ("turns", json!(2)),
        ("turns", json!(25)),
        ("turns", json!(6.5)),
        ("wire", json!(0)),
        ("wire", json!(30)),
        ("at", json!([1e30, 0])),
    ] {
        let mut params = spring();
        params[key] = value.clone();
        assert!(
            session
                .execute("bridge.spring", &params.to_string())
                .is_err(),
            "{key}={value}"
        );
        assert_eq!(session.export_dxf().unwrap(), original);
    }
    let preview = run(
        &mut session,
        "bridge.preview_draw",
        json!({"command":"bridge.spring","params":spring()}),
    );
    assert!(!preview["primitives"].as_array().unwrap().is_empty());
    assert_eq!(session.export_dxf().unwrap(), original);
    run(&mut session, "bridge.spring", spring());
    run(&mut session, "undo", json!({}));
    assert_eq!(scene(&session)["entityCount"], 0);
    run(&mut session, "redo", json!({}));
    assert_eq!(scene(&session)["entityCount"], 1);
}

#[test]
fn spring_grips_change_only_the_selected_parameter_and_copy_on_write() {
    let mut session = CadcraftSession::new();
    let handle = run(&mut session, "bridge.spring", spring())["handle"].clone();
    let copy = run(
        &mut session,
        "copy",
        json!({"handles":[handle],"delta":[100,0]}),
    )["handles"][0]
        .clone();
    let before = scene(&session)["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["handle"] == handle)
        .unwrap()
        .clone();
    run(
        &mut session,
        "grip.move",
        json!({"handle":copy,"index":1,"to":[210,20]}),
    );
    run(
        &mut session,
        "grip.move",
        json!({"handle":copy,"index":2,"to":[150,45]}),
    );
    run(
        &mut session,
        "grip.move",
        json!({"handle":copy,"index":3,"to":[200,35]}),
    );
    let after = scene(&session);
    assert_eq!(
        after["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["handle"] == handle)
            .unwrap(),
        &before
    );
    let changed = after["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["handle"] == copy)
        .unwrap();
    assert_eq!(changed["spring"]["length"], 100.0);
    assert!(changed["spring"]["width"].as_f64().unwrap() > 30.0);
    assert!(changed["spring"]["turns"].as_u64().unwrap() > 6);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn spring_survives_native_dwg_roundtrip() {
    let mut session = CadcraftSession::new();
    run(&mut session, "bridge.spring", spring());
    let doc = cadcraft_io::read(&session.export_dxf().unwrap(), "spring.dxf").unwrap();
    let dwg = cadcraft_io::write(&doc, "spring.dwg").unwrap();
    let restored = cadcraft_io::read(&dwg, "spring.dwg").unwrap();
    session
        .load_dxf(&cadcraft_io::write(&restored, "spring.dxf").unwrap())
        .unwrap();
    assert_eq!(scene(&session)["entities"][0]["spring"]["turns"], 6);
}

#[test]
fn extension_spring_survives_native_dwg_and_explode() {
    let mut s = CadcraftSession::new();
    run(
        &mut s,
        "bridge.spring",
        json!({"kind":"extension","at":[0,0],"end":[82.7,0],"width":20,"turns":15,"wire":2.3}),
    );
    let doc = cadcraft_io::read(&s.export_dxf().unwrap(), "spring.dxf").unwrap();
    let dwg = cadcraft_io::write(&doc, "spring.dwg").unwrap();
    let restored = cadcraft_io::read(&dwg, "spring.dwg").unwrap();
    s.load_dxf(&cadcraft_io::write(&restored, "spring.dxf").unwrap())
        .unwrap();
    let current = scene(&s);
    assert_eq!(current["entities"][0]["spring"]["kind"], "extension");
    run(
        &mut s,
        "explode",
        json!({"handles":[current["entities"][0]["handle"]]}),
    );
    assert!(
        scene(&s)["entities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["type"] == "Polyline")
    );
    assert_eq!(scene(&s)["entityCount"], 42);
}

#[test]
fn scaled_spring_keeps_displayed_wire_diameter_and_parameter_edit_isolated() {
    let mut session = CadcraftSession::new();
    let h = run(&mut session, "bridge.spring", spring())["handle"].clone();
    run(
        &mut session,
        "scale",
        json!({"handles":[h],"base":[10,20],"factor":2}),
    );
    let scaled = &scene(&session)["entities"][0]["spring"];
    assert_eq!(scaled["length"], 160.0);
    assert_eq!(scaled["width"], 60.0);
    assert_eq!(scaled["wire"], 4.0);
}

#[test]
fn grip_drags_cannot_collapse_a_spring_into_invalid_dimensions() {
    let mut session = CadcraftSession::new();
    let h = run(&mut session, "bridge.spring", spring())["handle"].clone();
    run(
        &mut session,
        "grip.move",
        json!({"handle":h,"index":2,"to":[50,20]}),
    );
    let narrowed = scene(&session)["entities"][0]["spring"].clone();
    assert!(narrowed["width"].as_f64().unwrap() > 3.0 * narrowed["wire"].as_f64().unwrap());
    run(
        &mut session,
        "grip.move",
        json!({"handle":h,"index":1,"to":[10,20]}),
    );
    let shortened = scene(&session)["entities"][0]["spring"].clone();
    assert!(
        shortened["length"].as_f64().unwrap()
            > 2.0 * shortened["turns"].as_f64().unwrap() * shortened["wire"].as_f64().unwrap()
    );
}

#[test]
fn spring_parameter_preview_and_partial_edit_preserve_other_entities_and_locked_data() {
    let mut session = CadcraftSession::new();
    run(&mut session, "line", json!({"points":[[-100,0],[100,0]]}));
    let h = run(&mut session, "bridge.spring", spring())["handle"].clone();
    let original = session.export_dxf().unwrap();
    let update = json!({"handle":h,"turns":8,"wire":2.0,"length":100.0,"width":35.0});
    let preview = run(
        &mut session,
        "bridge.preview_draw",
        json!({"command":"bridge.spring","params":update}),
    );
    assert_eq!(preview["entities"].as_array().unwrap().len(), 1);
    assert_eq!(preview["entities"][0]["spring"]["turns"], 8);
    assert_eq!(session.export_dxf().unwrap(), original);
    let changed = run(
        &mut session,
        "bridge.edit",
        json!({"command":"bridge.spring","params":update}),
    );
    assert_eq!(changed["scene"]["entities"].as_array().unwrap().len(), 1);
    assert_eq!(scene(&session)["entityCount"], 2);
    run(&mut session, "layer.set", json!({"name":"0","locked":true}));
    let locked = session.export_dxf().unwrap();
    assert!(
        session
            .execute("bridge.spring", &update.to_string())
            .is_err()
    );
    assert_eq!(session.export_dxf().unwrap(), locked);
}

#[test]
fn maximum_coil_profile_is_bounded_and_finite() {
    let mut session = CadcraftSession::new();
    run(
        &mut session,
        "bridge.spring",
        json!({"at":[-1000,-1000],"end":[1000,1000],"width":600,"turns":24,"wire":5}),
    );
    let drawing = scene(&session);
    let primitives = drawing["primitives"].as_array().unwrap();
    assert_eq!(primitives.len(), 2 * 24 + 5);
    let total: usize = primitives
        .iter()
        .map(|p| p["points"].as_array().unwrap().len())
        .sum();
    assert!(total < 1800);
    assert!(
        primitives
            .iter()
            .flat_map(|p| p["points"].as_array().unwrap())
            .all(|p| p[0].as_f64().unwrap().is_finite() && p[1].as_f64().unwrap().is_finite())
    );
}

#[test]
fn turns_grip_on_extremely_short_imported_spring_rejects_without_panic_or_damage() {
    use cadcraft_engine::doc::EntityKind;
    let mut session = CadcraftSession::new();
    let h = run(&mut session, "bridge.spring", spring())["handle"].clone();
    let mut doc = cadcraft_io::read(&session.export_dxf().unwrap(), "spring.dxf").unwrap();
    let mut entity = (**doc.model.iter().next().unwrap()).clone();
    let EntityKind::Insert(ref mut insert) = entity.kind else {
        panic!("expected insert")
    };
    insert.scale.x = 5.0;
    doc.model.replace(entity);
    session
        .load_dxf(&cadcraft_io::write(&doc, "spring.dxf").unwrap())
        .unwrap();
    assert_eq!(scene(&session)["entities"][0]["spring"]["length"], 5.0);
    let before = session.export_dxf().unwrap();
    assert!(
        session
            .execute(
                "grip.move",
                &json!({"handle":h,"index":3,"to":[14,30]}).to_string()
            )
            .is_err()
    );
    assert_eq!(session.export_dxf().unwrap(), before);
}

#[test]
fn mixed_case_block_references_keep_the_untouched_spring_when_editing_a_copy() {
    use cadcraft_engine::doc::EntityKind;
    let mut session = CadcraftSession::new();
    let original = run(&mut session, "bridge.spring", spring())["handle"].clone();
    let copy = run(
        &mut session,
        "copy",
        json!({"handles":[original],"delta":[100,0]}),
    )["handles"][0]
        .clone();
    let mut doc = cadcraft_io::read(&session.export_dxf().unwrap(), "spring.dxf").unwrap();
    let copy_handle = cadcraft_engine::doc::Handle::parse_hex(copy.as_str().unwrap()).unwrap();
    let mut entity = (**doc.model.get(copy_handle).unwrap()).clone();
    let EntityKind::Insert(ref mut insert) = entity.kind else {
        panic!("expected insert")
    };
    insert.block = insert.block.to_ascii_lowercase();
    doc.model.replace(entity);
    session
        .load_dxf(&cadcraft_io::write(&doc, "spring.dxf").unwrap())
        .unwrap();
    assert_eq!(
        scene(&session)["entities"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["spring"].is_object())
            .count(),
        2
    );
    run(
        &mut session,
        "bridge.spring",
        json!({"handle":original,"turns":8,"wire":2.0}),
    );
    let after = scene(&session);
    assert_eq!(
        after["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["handle"] == copy)
            .unwrap()["spring"]["turns"],
        6
    );
}

#[test]
fn paper_space_reference_keeps_the_old_definition_when_model_spring_is_edited() {
    use cadcraft_engine::doc::{Common, EntityKind, Space};
    let mut session = CadcraftSession::new();
    let original = run(&mut session, "bridge.spring", spring())["handle"].clone();
    let mut doc = cadcraft_io::read(&session.export_dxf().unwrap(), "spring.dxf").unwrap();
    let EntityKind::Insert(insert) = &doc.model.iter().next().unwrap().kind else {
        panic!("expected insert")
    };
    let insert = insert.clone();
    let paper = doc.layouts[0].name.clone();
    doc.add(
        &Space::Paper(paper),
        Common::default(),
        EntityKind::Insert(insert),
    )
    .unwrap();
    session
        .load_dxf(&cadcraft_io::write(&doc, "spring.dxf").unwrap())
        .unwrap();
    run(
        &mut session,
        "bridge.spring",
        json!({"handle":original,"turns":8,"wire":2.0}),
    );
    let after = cadcraft_io::read(&session.export_dxf().unwrap(), "spring.dxf").unwrap();
    let EntityKind::Insert(paper_insert) = &after.layouts[0].entities.iter().next().unwrap().kind
    else {
        panic!("expected paper insert")
    };
    assert!(after.block(&paper_insert.block).is_some());
}
