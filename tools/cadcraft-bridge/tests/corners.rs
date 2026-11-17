use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};
fn run(s: &mut CadcraftSession, c: &str, p: Value) -> Value {
    serde_json::from_str(&s.execute(c, &p.to_string()).unwrap()).unwrap()
}
#[test]
fn corner_replaces_geometry_atomically_with_one_undo_and_rejects_stale_or_locked_edits() {
    let mut s = CadcraftSession::new();
    run(&mut s, "line", json!({"points":[[0,0],[100,0]]}));
    let scene: Value = serde_json::from_str(&s.scene().unwrap()).unwrap();
    let e = &scene["entities"][0];
    let mut after = e["geometry"].clone();
    after["a"] = json!({"x":20,"y":0,"z":0});
    let p = json!({"edits":[{"handle":e["handle"],"before":e["geometry"],"after":after}],"create":{"commonFrom":e["handle"],"geometry":{"type":"arc","center":{"x":20,"y":20,"z":0},"radius":20,"start":-1.5707963267948966,"end":0}}});
    run(&mut s, "bridge.corner", p.clone());
    assert!(s.execute("bridge.corner", &p.to_string()).is_err());
    run(&mut s, "undo", json!({}));
    let restored: Value = serde_json::from_str(&s.scene().unwrap()).unwrap();
    assert_eq!(restored["entityCount"], 1);
    assert_eq!(restored["entities"][0]["geometry"], e["geometry"]);
    run(&mut s, "layer.set", json!({"name":"0","locked":true}));
    let before = s.export_dxf().unwrap();
    assert!(s.execute("bridge.corner", &p.to_string()).is_err());
    assert_eq!(s.export_dxf().unwrap(), before);
}
