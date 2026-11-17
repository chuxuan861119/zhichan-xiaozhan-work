use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};

fn run(s: &mut CadcraftSession, command: &str, params: Value) -> Value {
    serde_json::from_str(&s.execute(command, &params.to_string()).unwrap()).unwrap()
}

#[test]
fn trim_picks_pattern_interior_without_nearby_strokes_and_ignores_holes() {
    let mut s = CadcraftSession::new();
    run(&mut s, "rectang", json!({"p1":[0,0],"p2":[10,10]}));
    run(&mut s, "rectang", json!({"p1":[6,6],"p2":[9,9]}));
    let h = run(&mut s, "hatch", json!({"points":[[1,1]],"pattern":"ANSI31","scale":100}))["handles"][0].clone();
    let before = s.scene().unwrap();
    assert_eq!(run(&mut s, "bridge.pick_trim", json!({"point":[2,5],"aperture":0.01})), h);
    assert_eq!(run(&mut s, "bridge.pick_trim", json!({"point":[7,7],"aperture":0.01})), Value::Null);
    assert_eq!(s.scene().unwrap(), before);
}

#[test]
fn quick_trim_does_not_erase_uncut_hatch_or_distant_region() {
    let mut s = CadcraftSession::new();
    let a = run(&mut s, "rectang", json!({"p1":[0,0],"p2":[10,10]}))["handle"].clone();
    let b = run(&mut s, "rectang", json!({"p1":[20,0],"p2":[30,10]}))["handle"].clone();
    let h = run(&mut s, "hatch", json!({"handles":[a,b],"pattern":"SOLID"}))["handle"].clone();
    run(&mut s, "line", json!({"points":[[25,-1],[25,11]]}));
    let before = s.scene().unwrap();
    assert!(s.execute("trim", &json!({"handle":h,"pick":[5,5],"mode":"quick"}).to_string()).is_err());
    assert_eq!(s.scene().unwrap(), before);
}

#[test]
fn trim_removes_only_face_containing_cursor_and_keeps_other_region() {
    let mut s = CadcraftSession::new();
    let a = run(&mut s, "rectang", json!({"p1":[0,0],"p2":[10,10]}))["handle"].clone();
    let b = run(&mut s, "rectang", json!({"p1":[20,0],"p2":[30,10]}))["handle"].clone();
    let h = run(&mut s, "hatch", json!({"handles":[a,b],"pattern":"ANSI31","scale":100}))["handle"].clone();
    run(&mut s, "line", json!({"points":[[5,-1],[5,11]]}));
    run(&mut s, "trim", json!({"handle":h,"pick":[2,5],"mode":"quick"}));
    assert_eq!(run(&mut s,"bridge.pick_trim",json!({"point":[2,5],"aperture":0.01})),Value::Null);
    assert!(run(&mut s,"bridge.pick_trim",json!({"point":[8,5],"aperture":0.01})).is_string());
    assert!(run(&mut s,"bridge.pick_trim",json!({"point":[22,5],"aperture":0.01})).is_string());
}

#[test]
fn curves_under_pickbox_keep_priority_and_quick_erase_semantics() {
    let mut s = CadcraftSession::new();
    run(&mut s, "rectang", json!({"p1":[0,0],"p2":[10,10]}));
    run(&mut s, "hatch", json!({"points":[[1,1]],"pattern":"SOLID"}));
    let line = run(&mut s, "line", json!({"points":[[2,3],[4,3]]}))["handles"][0].clone();
    assert_eq!(run(&mut s, "bridge.pick_trim", json!({"point":[3,3.005],"aperture":0.01})), line);
    run(&mut s, "trim", json!({"handle":line,"pick":[3,3],"mode":"quick"}));
    let scene: Value = serde_json::from_str(&s.scene().unwrap()).unwrap();
    assert!(!scene["entities"].as_array().unwrap().iter().any(|e|e["handle"]==line));
    assert!(scene["entities"].as_array().unwrap().iter().any(|e|e["type"]=="Hatch"));
}

#[test]
fn solid_trim_pick_respects_holes_and_curved_boundaries_instead_of_bounds() {
    let mut s = CadcraftSession::new();
    run(&mut s, "circle", json!({"center":[0,0],"radius":10}));
    run(&mut s, "circle", json!({"center":[0,0],"radius":2}));
    run(&mut s, "hatch", json!({"points":[[5,0]],"pattern":"SOLID"}));
    for point in [[0,0],[9,9]] {
        assert_eq!(run(&mut s, "bridge.pick_trim", json!({"point":point,"aperture":0.01})), Value::Null);
    }
    assert!(run(&mut s, "bridge.pick_trim", json!({"point":[5,0],"aperture":0.01})).is_string());
}
