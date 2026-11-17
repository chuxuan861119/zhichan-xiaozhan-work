use cadcraft_engine::doc::{EntityKind, Hatch};
use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};

fn run(s: &mut CadcraftSession, command: &str, params: Value) -> Value {
    serde_json::from_str(&s.execute(command, &params.to_string()).unwrap()).unwrap()
}

// External writers may mark a closed polyline path only as Polyline (2),
// without External (1). The embedded ANSI31 definition intentionally differs
// from the bundled pattern, just as imported metric/customized files can.
fn external_hatch(flags: i32) -> Vec<u8> {
    let mut text = String::from(
        "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1027\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nHATCH\n5\nA0\n100\nAcDbEntity\n8\n0\n100\nAcDbHatch\n10\n0\n20\n0\n30\n0\n210\n0\n220\n0\n230\n1\n2\nANSI31\n70\n0\n71\n0\n91\n2\n",
    );
    // Put the hole first: inference must use containment, not list order.
    for (i, points) in [
        [[10, 10], [20, 10], [20, 20], [10, 20]],
        [[0, 0], [40, 0], [40, 40], [0, 40]],
    ]
    .iter()
    .enumerate()
    {
        let path_flags = if i == 0 { 2 } else { flags };
        if path_flags & 2 != 0 {
            text.push_str(&format!("92\n{path_flags}\n72\n0\n73\n1\n93\n4\n"));
            for [x, y] in points {
                text.push_str(&format!("10\n{x}\n20\n{y}\n"));
            }
        } else {
            text.push_str(&format!("92\n{path_flags}\n93\n4\n"));
            for edge in 0..4 {
                let [x1, y1] = points[edge];
                let [x2, y2] = points[(edge + 1) % 4];
                text.push_str(&format!("72\n1\n10\n{x1}\n20\n{y1}\n11\n{x2}\n21\n{y2}\n"));
            }
        }
        text.push_str("97\n0\n");
    }
    text.push_str("75\n0\n76\n1\n52\n0\n41\n1\n77\n0\n78\n1\n53\n0\n43\n0\n44\n0\n45\n0\n46\n10\n79\n0\n98\n0\n0\nENDSEC\n0\nEOF\n");
    text.into_bytes()
}

fn hatch(s: &CadcraftSession) -> Hatch {
    let doc = cadcraft_io::read(&s.export_dxf().unwrap(), "external.dxf").unwrap();
    doc.model
        .iter()
        .find_map(|e| match &e.kind {
            EntityKind::Hatch(h) => Some(h.clone()),
            _ => None,
        })
        .unwrap()
}

fn entity_geometry(scene: &Value) -> Value {
    scene["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["handle"] == "A0")
        .unwrap()["geometry"]
        .clone()
}

#[test]
fn external_paths_without_outer_flags_preview_edit_and_roundtrip() {
    for flags in [0, 2, 16, 18] {
        let mut s = CadcraftSession::new();
        s.load_dxf(&external_hatch(flags)).unwrap();
        let before = s.export_dxf().unwrap();
        let original = hatch(&s);
        let params = json!({"handles":["A0"], "scale":2, "angle":30});
        let mut direct = CadcraftSession::new();
        direct.load_dxf(&external_hatch(flags)).unwrap();
        run(&mut direct, "hatchedit", params.clone());
        let preview = run(
            &mut s,
            "bridge.preview_modify",
            json!({
                "command":"hatchedit", "params":params, "compact":true,
            }),
        );
        assert_eq!(
            s.export_dxf().unwrap(),
            before,
            "preview must not mutate or save repairs"
        );
        run(&mut s, "hatchedit", params);
        let edited = hatch(&s);
        assert_eq!(
            hatch(&direct),
            edited,
            "direct edit must match preview commit"
        );
        assert!(!edited.loops[0].outer, "the first path is a hole");
        assert!(edited.loops[1].outer, "the containing path is exterior");
        for (old, new) in original.loops.iter().zip(&edited.loops) {
            assert_eq!(old.vertices, new.vertices);
            assert_eq!(old.sources, new.sources);
        }
        let scene: Value = serde_json::from_str(&s.scene().unwrap()).unwrap();
        assert_eq!(entity_geometry(&preview), entity_geometry(&scene));
        let saved = s.export_dxf().unwrap();
        run(&mut s, "undo", json!({}));
        assert_eq!(s.export_dxf().unwrap(), before);
        run(&mut s, "redo", json!({}));
        assert_eq!(hatch(&s), edited);
        s.load_dxf(&saved).unwrap();
        assert_eq!(hatch(&s), edited);
    }
}

#[test]
fn rejected_external_hatch_edit_keeps_boundaries_pattern_and_history_unchanged() {
    let mut s = CadcraftSession::new();
    s.load_dxf(&external_hatch(0)).unwrap();
    let before = s.export_dxf().unwrap();
    let params = json!({"handles":["A0"], "pattern":"ANSI31", "scale":0.000001});
    for command in ["hatchedit", "bridge.preview_modify"] {
        let p = if command == "hatchedit" {
            params.clone()
        } else {
            json!({"command":"hatchedit", "params":params, "compact":true})
        };
        assert!(
            s.execute(command, &p.to_string())
                .unwrap_err()
                .contains("过密")
        );
        assert_eq!(s.export_dxf().unwrap(), before);
    }
    run(&mut s, "undo", json!({}));
    assert_eq!(
        s.export_dxf().unwrap(),
        before,
        "failed edits must not add an undo item"
    );
}

#[test]
#[ignore = "Set CAD_EXTERNAL_DWG_PATH for a read-only local-file acceptance probe"]
fn local_external_dwg_hatch_copy_preview_edit_undo_and_roundtrip() {
    fn contains_hatch(d: &cadcraft_engine::doc::Drawing, name: &str, depth: usize) -> bool {
        if depth > 16 {
            return false;
        }
        d.block(name).is_some_and(|b| {
            b.entities.iter().any(|e| match &e.kind {
                EntityKind::Hatch(_) => true,
                EntityKind::Insert(i) => contains_hatch(d, &i.block, depth + 1),
                _ => false,
            })
        })
    }
    let path = std::env::var("CAD_EXTERNAL_DWG_PATH").unwrap();
    let original_file = std::fs::read(&path).unwrap();
    let dxf = patent_cadcraft_bridge::codec::convert("dwg-to-dxf", &original_file, &[]).unwrap();
    let doc = cadcraft_io::read(&dxf, "external.dxf").unwrap();
    let source = doc
        .model
        .iter()
        .chain(doc.blocks.values().flat_map(|b| b.entities.iter()))
        .chain(doc.layouts.iter().flat_map(|l| l.entities.iter()))
        .find_map(|e| match &e.kind {
            EntityKind::Hatch(h) if !h.loops.is_empty() => Some(e.clone()),
            _ => None,
        })
        .expect("the local drawing must contain a hatch");
    let EntityKind::Hatch(original) = &source.kind else {
        unreachable!()
    };
    let handle = source.handle;
    eprintln!(
        "local probe: hatch={}, loops={}, explicit_outer={}",
        handle.hex(),
        original.loops.len(),
        original.loops.iter().filter(|l| l.outer).count()
    );
    // Check the full input too: a block definition handle is not a directly
    // editable model-space entity until the ordinary EXPLODE workflow runs.
    let mut full = CadcraftSession::new();
    full.load_dxf(&dxf).unwrap();
    let properties = run(&mut full, "properties", json!({"handles":[handle.hex()]}));
    eprintln!(
        "full input: model_entities={}, model_hatches={}, target_property_objects={}",
        doc.model.len(),
        doc.model
            .iter()
            .filter(|e| matches!(e.kind, EntityKind::Hatch(_)))
            .count(),
        properties["objects"].as_array().map_or(0, |a| a.len())
    );
    if doc.entity(handle).is_none() {
        let error = full
            .execute(
                "hatchedit",
                &json!({"handles":[handle.hex()], "pattern":"ANSI31"}).to_string(),
            )
            .unwrap_err();
        assert!(error.contains("select one or more hatches"));
        eprintln!("full input: block-definition handle correctly requires explode before editing");
    }
    // Follow the supported block workflow on an in-memory copy of the full
    // drawing, not a fabricated handle inserted into a user document.
    for depth in 0..=16 {
        let current = cadcraft_io::read(&full.export_dxf().unwrap(), "probe.dxf").unwrap();
        if let Some(e) = current
            .model
            .iter()
            .find(|e| matches!(e.kind, EntityKind::Hatch(_)))
        {
            let EntityKind::Hatch(h) = &e.kind else {
                unreachable!()
            };
            let before = full.export_dxf().unwrap();
            let params =
                json!({"handles":[e.handle.hex()], "pattern":"ANSI31", "scale":1, "angle":30});
            run(
                &mut full,
                "bridge.preview_modify",
                json!({"command":"hatchedit", "params":params, "compact":true}),
            );
            assert_eq!(full.export_dxf().unwrap(), before);
            run(&mut full, "hatchedit", params);
            let saved = full.export_dxf().unwrap();
            let after = cadcraft_io::read(&saved, "probe.dxf").unwrap();
            let EntityKind::Hatch(edited) = &after.entity(e.handle).unwrap().kind else {
                unreachable!()
            };
            for (a, b) in h.loops.iter().zip(&edited.loops) {
                assert_eq!(a.vertices, b.vertices);
            }
            assert_eq!(h.loops.len(), edited.loops.len());
            run(&mut full, "undo", json!({}));
            assert_eq!(full.export_dxf().unwrap(), before);
            run(&mut full, "redo", json!({}));
            assert_eq!(full.export_dxf().unwrap(), saved);
            eprintln!(
                "full input: ordinary explode depth={depth}, model hatch={} preview/edit/undo/redo passed",
                e.handle.hex()
            );
            break;
        }
        let Some(target) = current.model.iter().find_map(|e| match &e.kind {
            EntityKind::Insert(i) if contains_hatch(&current, &i.block, 0) => Some(e.handle),
            _ => None,
        }) else {
            eprintln!(
                "full input: no model INSERT references the stored HATCH blocks; isolated geometry probe only"
            );
            break;
        };
        assert!(
            depth < 16,
            "external block nesting exceeded the probe limit"
        );
        run(&mut full, "explode", json!({"handles":[target.hex()]}));
    }
    // An isolated copy also supports files whose HATCH entities live inside
    // blocks/layouts; this does not claim to test block-selection UI behavior.
    let mut isolated = doc.clone();
    isolated.model = Default::default();
    let mut source = source.as_ref().clone();
    source.common = Default::default();
    isolated.model.push(source);
    let mut s = CadcraftSession::new();
    s.load_dxf(&cadcraft_io::write(&isolated, "probe.dxf").unwrap())
        .unwrap();
    let before = s.export_dxf().unwrap();
    let params = json!({"handles":[handle.hex()], "pattern":"ANSI31", "scale":1, "angle":30});
    let preview = run(
        &mut s,
        "bridge.preview_modify",
        json!({"command":"hatchedit", "params":params, "compact":true}),
    );
    assert_eq!(s.export_dxf().unwrap(), before);
    run(&mut s, "hatchedit", params);
    let saved = s.export_dxf().unwrap();
    let edited_doc = cadcraft_io::read(&saved, "external.dxf").unwrap();
    let EntityKind::Hatch(edited) = &edited_doc.entity(handle).unwrap().kind else {
        panic!("edited hatch missing")
    };
    assert_eq!(original.loops.len(), edited.loops.len());
    for (old, new) in original.loops.iter().zip(&edited.loops) {
        assert_eq!(old.vertices, new.vertices);
        assert_eq!(old.sources, new.sources);
    }
    assert!(edited.loops.iter().any(|l| l.outer));
    assert_eq!(edited.pattern, "ANSI31");
    assert!(!preview["primitives"].as_array().unwrap().is_empty());
    run(&mut s, "undo", json!({}));
    assert_eq!(s.export_dxf().unwrap(), before);
    run(&mut s, "redo", json!({}));
    assert_eq!(s.export_dxf().unwrap(), saved);
    s.load_dxf(&saved).unwrap();
    assert_eq!(s.export_dxf().unwrap(), saved);
    assert_eq!(
        std::fs::read(&path).unwrap(),
        original_file,
        "never overwrite the source DWG"
    );
}

#[test]
fn submitting_the_current_named_pattern_keeps_its_imported_definition() {
    let mut s = CadcraftSession::new();
    s.load_dxf(&external_hatch(3)).unwrap();
    let original = hatch(&s);
    assert!(!original.pattern_lines.is_empty());
    let params = json!({"handles":["A0"], "pattern":"ansi31", "scale":2, "angle":15});
    // Exercise the cached appearance-only preview path as well as initial preview.
    for scale in [1, 2] {
        let mut p = params.clone();
        p["scale"] = json!(scale);
        run(
            &mut s,
            "bridge.preview_modify",
            json!({"command":"hatchedit", "params":p, "compact":true}),
        );
    }
    run(&mut s, "hatchedit", params);
    let edited = hatch(&s);
    assert_eq!(
        edited.pattern_lines, original.pattern_lines,
        "editing angle/scale must not silently replace an external named pattern"
    );
    assert_eq!(edited.loops, original.loops);
    assert_eq!(edited.scale, 2.0);
    assert!((edited.angle.to_degrees() - 15.0).abs() < 1e-9);
    run(
        &mut s,
        "hatchedit",
        json!({"handles":["A0"], "pattern":"ANSI32"}),
    );
    assert_ne!(
        hatch(&s).pattern_lines,
        original.pattern_lines,
        "an explicit different pattern must still replace the definition"
    );
}
