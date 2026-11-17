use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};

fn run(s: &mut CadcraftSession, command: &str, params: Value) -> Value {
    serde_json::from_str(&s.execute(command, &params.to_string()).unwrap()).unwrap()
}

fn outline(s: &mut CadcraftSession, origin: f64, size: f64, gap: f64) {
    for (a, b) in [
        ([origin, origin], [origin + size, origin]),
        ([origin + size, origin], [origin + size, origin + size]),
        ([origin + size, origin + size], [origin, origin + size]),
        ([origin, origin + size], [origin, origin + gap]),
    ] {
        run(s, "line", json!({"points": [a, b]}));
    }
}

fn hatch(s: &CadcraftSession, handle: &str) -> Value {
    let scene: Value = serde_json::from_str(&s.scene().unwrap()).unwrap();
    scene["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["handle"] == handle)
        .unwrap()["geometry"]
        .clone()
}

#[test]
fn default_tolerance_keeps_tiny_gap_island_out_of_outer_fill() {
    let mut s = CadcraftSession::new();
    outline(&mut s, 0.0, 20.0, 0.0);
    outline(&mut s, 5.0, 5.0, 0.0001);
    let result = run(
        &mut s,
        "hatch",
        json!({"points": [[2, 2]], "pattern": "SOLID"}),
    );
    let fill = hatch(&s, result["handle"].as_str().unwrap());
    assert_eq!(
        fill["loops"].as_array().unwrap().len(),
        2,
        "a tiny drafting gap must not fill the island"
    );
}

#[test]
fn requested_tolerance_keeps_gapped_island_and_source_lines_unchanged() {
    let mut s = CadcraftSession::new();
    outline(&mut s, 0.0, 20.0, 0.0);
    outline(&mut s, 5.0, 5.0, 0.05);
    let before: Value = serde_json::from_str(&s.scene().unwrap()).unwrap();
    let result = run(
        &mut s,
        "hatch",
        json!({"points": [[2, 2]], "pattern": "SOLID", "gapTolerance": 0.1}),
    );
    let fill = hatch(&s, result["handle"].as_str().unwrap());
    assert_eq!(fill["loops"].as_array().unwrap().len(), 2);
    let after: Value = serde_json::from_str(&s.scene().unwrap()).unwrap();
    for entity in before["entities"].as_array().unwrap() {
        assert!(after["entities"].as_array().unwrap().contains(entity));
    }
}

#[test]
fn explicit_zero_keeps_strict_closure_and_auto_does_not_seal_large_openings() {
    for (gap, tolerance) in [(0.0001, Some(0.0)), (0.02, None)] {
        let mut s = CadcraftSession::new();
        outline(&mut s, 0.0, 20.0, 0.0);
        outline(&mut s, 5.0, 5.0, gap);
        let mut params = json!({"points": [[2, 2]], "pattern": "SOLID"});
        if let Some(value) = tolerance {
            params["gapTolerance"] = json!(value);
        }
        let result = run(&mut s, "hatch", params);
        assert_eq!(
            hatch(&s, result["handle"].as_str().unwrap())["loops"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}

#[test]
fn automatic_tolerance_is_local_and_matches_preview_commit_undo_and_reload() {
    for offset in [0.0, 1_000_000.0] {
        let mut s = CadcraftSession::new();
        outline(&mut s, offset, 20.0, 0.0001);
        outline(&mut s, offset + 5.0, 5.0, 0.0001);
        outline(&mut s, offset + 6.0, 1.0, 0.0001);
        outline(&mut s, offset + 100.0, 0.00001, 0.0);
        outline(&mut s, offset + 200.0, 10_000.0, 0.0);
        let bytes = s.export_dxf().unwrap();
        let params = json!({"points": [[offset + 2.0, offset + 2.0]], "pattern": "SOLID"});
        let preview = run(
            &mut s,
            "bridge.preview_modify",
            json!({"command": "hatch", "params": params, "compact": true}),
        );
        assert_eq!(preview["acceptedPointIndices"], json!([0]));
        assert_eq!(s.export_dxf().unwrap(), bytes);
        let result = run(&mut s, "hatch", params);
        let handle = result["handle"].as_str().unwrap();
        let fill = hatch(&s, handle);
        assert_eq!(fill["loops"].as_array().unwrap().len(), 3);
        assert_eq!(
            fill["loops"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|l| l["outer"] == false)
                .count(),
            2
        );
        let saved = s.export_dxf().unwrap();
        run(&mut s, "undo", json!({}));
        assert_eq!(s.export_dxf().unwrap(), bytes);
        run(&mut s, "redo", json!({}));
        assert_eq!(hatch(&s, handle), fill);
        s.load_dxf(&saved).unwrap();
        assert_eq!(hatch(&s, handle)["loops"], fill["loops"]);
    }
}

#[test]
fn automatic_tolerance_scales_down_for_tiny_geometry() {
    let mut s = CadcraftSession::new();
    outline(&mut s, 0.0, 0.001, 0.0);
    outline(&mut s, 0.0002, 0.0002, 0.00001);
    let result = run(
        &mut s,
        "hatch",
        json!({"points": [[0.0001, 0.0001]], "pattern": "SOLID"}),
    );
    assert_eq!(
        hatch(&s, result["handle"].as_str().unwrap())["loops"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn automatic_hover_reuses_prepared_region_in_a_large_drawing() {
    let mut s = CadcraftSession::new();
    outline(&mut s, 0.0, 20.0, 0.0);
    outline(&mut s, 5.0, 5.0, 0.0001);
    for i in 0..1000 {
        let x = 100.0 + f64::from(i % 50) * 12.0;
        let y = 100.0 + f64::from(i / 50) * 12.0;
        run(
            &mut s,
            "pline",
            json!({"points": [[x,y],[x+10.0,y],[x+10.0,y+10.0],[x,y+10.0]], "closed": true}),
        );
    }
    let before = s.export_dxf().unwrap();
    let started = std::time::Instant::now();
    let first = run(
        &mut s,
        "bridge.preview_modify",
        json!({"command": "hatch", "compact": true,
        "params": {"points": [[2,2]], "pattern": "SOLID"}}),
    );
    let initial = started.elapsed();
    let started = std::time::Instant::now();
    for i in 0..100 {
        let moved = run(
            &mut s,
            "bridge.preview_modify",
            json!({"command": "hatch", "compact": true,
            "params": {"points": [[2.0 + f64::from(i) * 0.01,2]], "pattern": "SOLID"}}),
        );
        assert_eq!(moved["primitives"], first["primitives"]);
    }
    println!(
        "1000 remote boundaries: first auto preview {:?}; 100 cached hovers {:?}",
        initial,
        started.elapsed()
    );
    assert_eq!(s.export_dxf().unwrap(), before);
}
