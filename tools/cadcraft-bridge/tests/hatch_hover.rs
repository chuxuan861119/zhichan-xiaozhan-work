use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};
fn run(s: &mut CadcraftSession, c: &str, p: Value) -> Value {
    serde_json::from_str(&s.execute(c, &p.to_string()).unwrap()).unwrap()
}
fn open_box(s: &mut CadcraftSession) {
    for (a, b) in [
        ([0., 0.], [10., 0.]),
        ([10., 0.], [10., 10.]),
        ([10., 10.], [0., 10.]),
        ([0., 10.], [0., 0.05]),
    ] {
        run(s, "line", json!({"points":[a,b]}));
    }
}
#[test]
fn gap_hover_is_read_only_and_tolerance_commit_matches_preview() {
    let mut s = CadcraftSession::new();
    open_box(&mut s);
    let bytes = s.export_dxf().unwrap();
    let before = s.scene().unwrap();
    let mut params = json!({"points":[[5,5]],"pattern":"ANSI31","scale":1,"gapTolerance":0.1});
    let preview = run(
        &mut s,
        "bridge.preview_modify",
        json!({"command":"hatch","params":params,"compact":true}),
    );
    assert_eq!(preview["acceptedPointIndices"], json!([0]));
    assert!(!preview["gapPoints"].as_array().unwrap().is_empty());
    assert_eq!(s.export_dxf().unwrap(), bytes);
    assert_eq!(s.scene().unwrap(), before);
    params["points"] = json!([[6, 5]]);
    let moved = run(
        &mut s,
        "bridge.preview_modify",
        json!({"command":"hatch","params":params,"compact":true}),
    );
    assert_eq!(moved["primitives"], preview["primitives"]);
    assert_eq!(s.scene().unwrap(), before);
    run(&mut s, "hatch", params);
    let sc: Value = serde_json::from_str(&s.scene().unwrap()).unwrap();
    assert_eq!(sc["entityCount"], 5);
    let doc = cadcraft_io::read(&s.export_dxf().unwrap(), "test.dxf").unwrap();
    assert_eq!(doc.header.f64("HPGAPTOL", 0.0), 0.0);
    run(&mut s, "undo", json!({}));
    assert_eq!(s.export_dxf().unwrap(), bytes);
    run(&mut s, "redo", json!({}));
    let saved = s.export_dxf().unwrap();
    s.load_dxf(&saved).unwrap();
    let reopened: Value = serde_json::from_str(&s.scene().unwrap()).unwrap();
    assert_eq!(reopened["entityCount"], 5);
}
#[test]
fn insufficient_tolerance_reports_gap_without_accepting_region() {
    let mut s = CadcraftSession::new();
    open_box(&mut s);
    let preview = run(
        &mut s,
        "bridge.preview_modify",
        json!({"command":"hatch","compact":true,"params":{"points":[[5,5]],"gapTolerance":0.01}}),
    );
    assert_eq!(preview["rejectedPointIndices"], json!([0]));
    assert_eq!(preview["gapPoints"].as_array().unwrap().len(), 2);
}
