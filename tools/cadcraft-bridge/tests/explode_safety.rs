use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};

fn run(s: &mut CadcraftSession, command: &str, params: Value) -> Value {
    serde_json::from_str(&s.execute(command, &params.to_string()).unwrap()).unwrap()
}
fn scene(s: &CadcraftSession) -> Value {
    serde_json::from_str(&s.scene().unwrap()).unwrap()
}
fn dense_net(s: &mut CadcraftSession) -> Value {
    let edge = run(s, "rectang", json!({"p1":[0,0],"p2":[100,0.1]}))["handle"].clone();
    let hatch = run(
        s,
        "hatch",
        json!({"handles":[edge],"pattern":"NET","scale":1}),
    )["handle"]
        .clone();
    // A legitimate imported DXF defines both families explicitly, even when its
    // full-detail display exceeds the renderer's per-family budget.
    let text = String::from_utf8(s.export_dxf().unwrap())
        .unwrap()
        .replace("\r\n", "\n");
    let mut tags: Vec<String> = text.lines().map(str::to_owned).collect();
    let mut in_hatch = false;
    for pair in tags.chunks_exact_mut(2) {
        let code = pair[0].trim().parse::<i32>().unwrap();
        if code == 0 {
            in_hatch = pair[1] == "HATCH";
        }
        if in_hatch && matches!(code, 41 | 43 | 44 | 45 | 46 | 49) {
            pair[1] = (pair[1].parse::<f64>().unwrap() * 0.001).to_string();
        }
    }
    s.load_dxf(format!("{}\n", tags.join("\n")).as_bytes())
        .unwrap();
    hatch
}

#[test]
fn dense_imported_pattern_never_commits_only_the_surviving_line_family() {
    let mut s = CadcraftSession::new();
    let hatch = dense_net(&mut s);
    let rectangle = run(&mut s, "rectang", json!({"p1":[200,0],"p2":[210,10]}))["handle"].clone();
    let before = s.export_dxf().unwrap();
    let result = run(&mut s, "explode", json!({"handles":[rectangle,hatch]}));
    assert_eq!(result["changed"], false);
    assert!(result["problem"].is_string());
    assert_eq!(s.export_dxf().unwrap(), before);
}

#[test]
fn whole_detail_detaches_one_semantic_level_without_changing_any_geometry() {
    let mut s = CadcraftSession::new();
    let body = run(&mut s, "rectang", json!({"p1":[0,0],"p2":[10,10]}))["handle"].clone();
    let frame = run(&mut s, "circle", json!({"center":[5,5],"radius":10}))["handle"].clone();
    run(
        &mut s,
        "group",
        json!({"name":"PW_DETAIL_TEST_BODY","handles":[body],"selectable":false}),
    );
    run(
        &mut s,
        "group",
        json!({"name":"PW_DETAIL_TEST_FRAME","handles":[frame]}),
    );
    let before = scene(&s);
    let result = run(
        &mut s,
        "explode",
        json!({"handles":[],"details":[{"id":"d","handles":[body,frame],"groups":["PW_DETAIL_TEST_BODY","PW_DETAIL_TEST_FRAME","PW_DETAIL_TEST_SOURCE","PW_DETAIL_TEST_LABEL"]}]}),
    );
    assert_eq!(result["changed"], true);
    assert_eq!(result["detached"], json!(["d"]));
    assert_eq!(result["exploded"], 1);
    assert_eq!(scene(&s)["entities"], before["entities"]);
    assert!(scene(&s)["groups"].as_array().unwrap().is_empty());
    run(&mut s, "undo", json!({}));
    assert_eq!(scene(&s)["groups"], before["groups"]);
    run(&mut s, "redo", json!({}));
    let bytes = s.export_dxf().unwrap();
    s.load_dxf(&bytes).unwrap();
    assert!(scene(&s)["groups"].as_array().unwrap().is_empty());
    assert_eq!(scene(&s)["entities"], before["entities"]);
    let doc = cadcraft_io::read(&bytes, "detail.dxf").unwrap();
    let dwg = cadcraft_io::write(&doc, "detail.dwg").unwrap();
    let reloaded = cadcraft_io::read(&dwg, "detail.dwg").unwrap();
    s.load_dxf(&cadcraft_io::write(&reloaded, "detail.dxf").unwrap())
        .unwrap();
    assert!(scene(&s)["groups"].as_array().unwrap().is_empty());
    assert_eq!(scene(&s)["entityCount"], 2);
}

#[test]
fn failed_native_decomposition_also_rolls_back_an_earlier_detail_detachment() {
    let mut s = CadcraftSession::new();
    let hatch = dense_net(&mut s);
    let body = run(&mut s, "rectang", json!({"p1":[200,0],"p2":[210,10]}))["handle"].clone();
    run(
        &mut s,
        "group",
        json!({"name":"PW_DETAIL_TEST_BODY","handles":[body],"selectable":false}),
    );
    let before = s.export_dxf().unwrap();
    let result = run(
        &mut s,
        "explode",
        json!({"handles":[hatch],"details":[{"id":"d","handles":[body],
        "groups":["PW_DETAIL_TEST_BODY","PW_DETAIL_TEST_FRAME","PW_DETAIL_TEST_SOURCE","PW_DETAIL_TEST_LABEL"]}]}),
    );
    assert_eq!(result["changed"], false);
    assert_eq!(s.export_dxf().unwrap(), before);
}

#[test]
fn a_locked_detail_is_retained_while_an_unlocked_rectangle_explodes() {
    let mut s = CadcraftSession::new();
    run(&mut s, "layer.new", json!({"name":"locked"}));
    run(&mut s, "layer.current", json!({"name":"locked"}));
    let body = run(&mut s, "rectang", json!({"p1":[0,0],"p2":[10,10]}))["handle"].clone();
    run(
        &mut s,
        "group",
        json!({"name":"PW_DETAIL_TEST_BODY","handles":[body],"selectable":false}),
    );
    run(&mut s, "layer.current", json!({"name":"0"}));
    run(&mut s, "layer.set", json!({"name":"locked","locked":true}));
    let free = run(&mut s, "rectang", json!({"p1":[20,0],"p2":[30,10]}))["handle"].clone();
    let result = run(
        &mut s,
        "explode",
        json!({"handles":[free],"details":[{"id":"d","handles":[body],
        "groups":["PW_DETAIL_TEST_BODY","PW_DETAIL_TEST_FRAME","PW_DETAIL_TEST_SOURCE","PW_DETAIL_TEST_LABEL"]}]}),
    );
    assert_eq!(result["exploded"], 1);
    assert_eq!(result["detached"], json!([]));
    assert_eq!(result["skipped"].as_array().unwrap().len(), 1);
    assert!(
        scene(&s)["entities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["handle"] == body)
    );
    assert_eq!(scene(&s)["groups"].as_array().unwrap().len(), 1);
}
