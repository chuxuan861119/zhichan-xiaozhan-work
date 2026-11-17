use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};
#[test]
fn editing_model_chain_preserves_paper_space_reference() {
    use cadcraft_engine::doc::{Common, EntityKind, Space};
    let mut s = CadcraftSession::new();
    let h = run(&mut s, "bridge.chain", spec(false))["handle"].clone();
    let mut doc = cadcraft_io::read(&s.export_dxf().unwrap(), "chain.dxf").unwrap();
    let EntityKind::Insert(i) = &doc.model.iter().next().unwrap().kind else {
        panic!()
    };
    let mut i = i.clone();
    i.block = i.block.to_lowercase();
    let paper = doc.layouts[0].name.clone();
    doc.add(
        &Space::Paper(paper),
        Common::default(),
        EntityKind::Insert(i),
    )
    .unwrap();
    s.load_dxf(&cadcraft_io::write(&doc, "chain.dxf").unwrap())
        .unwrap();
    run(
        &mut s,
        "grip.move",
        json!({"handle":h,"index":2,"to":[150,0]}),
    );
    let after = cadcraft_io::read(&s.export_dxf().unwrap(), "chain.dxf").unwrap();
    let EntityKind::Insert(i) = &after.layouts[0].entities.iter().next().unwrap().kind else {
        panic!()
    };
    assert!(after.block(&i.block).is_some());
}
fn run(s: &mut CadcraftSession, c: &str, p: Value) -> Value {
    serde_json::from_str(&s.execute(c, &p.to_string()).unwrap()).unwrap()
}
fn scene(s: &CadcraftSession) -> Value {
    serde_json::from_str(&s.scene().unwrap()).unwrap()
}
fn spec(single: bool) -> Value {
    json!({"single":single,"at":[0,0],"end":[108,0],"radius":14,"teeth":23,"otherTeeth":17,"hole":2.5,"otherHole":1.5})
}
#[test]
fn resizing_wheels_keeps_shared_pitch_and_all_chain_plate_joins_closed() {
    use std::f64::consts::PI;
    for index in [3, 4] {
        let mut s = CadcraftSession::new();
        let h = run(&mut s, "bridge.chain", spec(false))["handle"].clone();
        run(
            &mut s,
            "grip.move",
            json!({"handle":h,"index":index,"to":[108,42]}),
        );
        let sc = scene(&s);
        let chain = &sc["entities"][0]["chain"];
        let pitch = 28.0 * (PI / 23.0).sin();
        for (r, n) in [("radius", "teeth"), ("otherRadius", "otherTeeth")] {
            let actual = 2.0 * chain[r].as_f64().unwrap() * (PI / chain[n].as_f64().unwrap()).sin();
            assert!(
                (actual - pitch).abs() < 1e-9,
                "wheel pitch changed: {actual}"
            );
        }
        let paths = sc["primitives"].as_array().unwrap();
        let outer: Vec<_> = paths
            .iter()
            .filter(|p| p["points"].as_array().unwrap().len() == 27)
            .flat_map(|p| p["points"].as_array().unwrap())
            .collect();
        assert!(!outer.is_empty());
        for p in paths
            .iter()
            .filter(|p| p["points"].as_array().unwrap().len() == 3)
        {
            for end in [&p["points"][0], &p["points"][2]] {
                let gap = outer
                    .iter()
                    .map(|v| {
                        (v[0].as_f64().unwrap() - end[0].as_f64().unwrap())
                            .hypot(v[1].as_f64().unwrap() - end[1].as_f64().unwrap())
                    })
                    .fold(f64::INFINITY, f64::min);
                assert!(gap < 1e-8, "open plate join: {gap}");
            }
        }
    }
}
#[test]
fn mismatched_legacy_parameters_are_rebuilt_with_common_pitch() {
    use std::f64::consts::PI;
    let pitch = 28.0 * (PI / 23.0).sin();
    for side in ["radius", "otherRadius"] {
        let mut s = CadcraftSession::new();
        let mut p = spec(false);
        p["otherRadius"] = json!(pitch / (2.0 * (PI / 17.0).sin()));
        p[side] = json!(42.0);
        run(&mut s, "bridge.chain", p);
        let sc = scene(&s);
        let chain = &sc["entities"][0]["chain"];
        for (r, n) in [("radius", "teeth"), ("otherRadius", "otherTeeth")] {
            assert!(
                (2.0 * chain[r].as_f64().unwrap() * (PI / chain[n].as_f64().unwrap()).sin()
                    - pitch)
                    .abs()
                    < 1e-9
            );
        }
    }
}
#[test]
fn native_dwg_and_dxf_roundtrip_preserve_chain_metadata_and_ordinary_geometry() {
    let mut s = CadcraftSession::new();
    for single in [false, true] {
        run(&mut s, "bridge.chain", spec(single));
    }
    let original = scene(&s);
    let drawing = cadcraft_io::read(&s.export_dxf().unwrap(), "chain.dxf").unwrap();
    let bytes = cadcraft_io::write(&drawing, "chain.dwg").unwrap();
    assert!(bytes.starts_with(b"AC1032"));
    let restored = cadcraft_io::read(&bytes, "chain.dwg").unwrap();
    s.load_dxf(&cadcraft_io::write(&restored, "chain.dxf").unwrap())
        .unwrap();
    let after = scene(&s);
    assert_eq!(after["entityCount"], 2);
    assert_eq!(
        after["primitives"].as_array().unwrap().len(),
        original["primitives"].as_array().unwrap().len()
    );
    assert!(
        after["entities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["chain"].is_object())
    );
}
#[test]
fn locked_chain_edits_do_not_mutate_and_explode_remains_available() {
    let mut s = CadcraftSession::new();
    let h = run(&mut s, "bridge.chain", spec(false))["handle"].clone();
    let mut doc = cadcraft_io::read(&s.export_dxf().unwrap(), "chain.dxf").unwrap();
    doc.layers
        .iter_mut()
        .find(|l| l.name == "0")
        .unwrap()
        .locked = true;
    s.load_dxf(&cadcraft_io::write(&doc, "chain.dxf").unwrap())
        .unwrap();
    let before = s.export_dxf().unwrap();
    assert!(
        s.execute(
            "grip.move",
            &json!({"handle":h,"index":2,"to":[150,0]}).to_string()
        )
        .is_err()
    );
    assert_eq!(before, s.export_dxf().unwrap());
    doc.layers
        .iter_mut()
        .find(|l| l.name == "0")
        .unwrap()
        .locked = false;
    s.load_dxf(&cadcraft_io::write(&doc, "chain.dxf").unwrap())
        .unwrap();
    run(&mut s, "explode", json!({"handles":[h]}));
    assert!(scene(&s)["entityCount"].as_u64().unwrap() > 100);
}
#[test]
fn chain_has_editable_semantic_grips_and_independent_copy_with_undo() {
    let mut s = CadcraftSession::new();
    let h = run(&mut s, "bridge.chain", spec(false))["handle"].clone();
    assert_eq!(
        scene(&s)["entities"][0]["grips"].as_array().unwrap().len(),
        8
    );
    let copy = run(&mut s, "copy", json!({"handles":[h],"delta":[0,80]}))["handles"][0].clone();
    run(
        &mut s,
        "grip.move",
        json!({"handle":h,"index":2,"to":[150,20]}),
    );
    let sc = scene(&s);
    let e = sc["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["handle"] == h)
        .unwrap();
    assert_eq!(e["chain"]["end"], json!([150.0, 20.0]));
    let c = sc["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["handle"] == copy)
        .unwrap();
    assert_eq!(c["chain"]["end"], json!([108.0, 80.0]));
    run(&mut s, "undo", json!({}));
    s.load_dxf(&s.export_dxf().unwrap()).unwrap();
    assert!(
        scene(&s)["entities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["chain"].is_object())
    );
}
#[test]
fn sprocket_and_chain_preview_do_not_mutate_and_invalid_edits_are_atomic() {
    for single in [false, true] {
        let mut s = CadcraftSession::new();
        let h = run(&mut s, "bridge.chain", spec(single))["handle"].clone();
        let before = s.export_dxf().unwrap();
        run(
            &mut s,
            "bridge.preview_draw",
            json!({"command":"grip.move","params":{"handle":h,"index":3,"to":[0,20]}}),
        );
        assert_eq!(s.export_dxf().unwrap(), before);
        let mut bad = spec(single);
        bad["handle"] = h;
        bad["hole"] = json!(100);
        assert!(s.execute("bridge.chain", &bad.to_string()).is_err());
        assert_eq!(s.export_dxf().unwrap(), before);
    }
}
