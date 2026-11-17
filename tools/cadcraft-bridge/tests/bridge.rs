use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};

fn run(s: &mut CadcraftSession, command: &str, params: Value) -> Value {
    serde_json::from_str(&s.execute(command, &params.to_string()).unwrap()).unwrap()
}
fn scene(s: &CadcraftSession) -> Value {
    serde_json::from_str(&s.scene().unwrap()).unwrap()
}

#[test]
fn property_edits_reject_locked_layers_and_invalid_values_atomically() {
    let mut s = CadcraftSession::new();
    let circle = run(&mut s, "circle", json!({"center":[20,20],"radius":10}))["handle"].clone();
    let line = run(&mut s, "line", json!({"points":[[0,0],[10,0]]}))["handles"][0].clone();
    for params in [
        json!({"handles":[circle.clone()],"radius":-1}),
        json!({"handles":[line],"radius":5}),
    ] {
        let before = s.export_dxf().unwrap();
        assert!(s.execute("properties.set", &params.to_string()).is_err());
        assert_eq!(s.export_dxf().unwrap(), before);
    }
    run(&mut s, "layer.new", json!({"name":"Locked"}));
    run(
        &mut s,
        "properties.set",
        json!({"handles":[circle.clone()],"layer":"Locked"}),
    );
    run(&mut s, "layer.set", json!({"name":"Locked","locked":true}));
    let before = s.export_dxf().unwrap();
    assert!(
        s.execute(
            "properties.set",
            &json!({"handles":[circle],"radius":42}).to_string()
        )
        .is_err()
    );
    assert_eq!(s.export_dxf().unwrap(), before);
}

#[test]
fn scene_exposes_groups_and_locked_visibility_after_checkpoint_reload() {
    let mut s = CadcraftSession::new();
    let a = run(&mut s, "line", json!({"points":[[0,0],[10,0]]}))["handles"][0].clone();
    let b = run(&mut s, "line", json!({"points":[[0,10],[10,10]]}))["handles"][0].clone();
    run(&mut s, "group", json!({"handles":[a.clone(),b.clone()]}));
    run(&mut s, "layer.set", json!({"name":"0","locked":true}));
    s.load_dxf(&s.export_dxf().unwrap()).unwrap();
    assert_eq!(scene(&s)["groups"][0]["members"], json!([a, b]));
    assert_eq!(scene(&s)["entities"][0]["locked"], true);
    assert_eq!(scene(&s)["entities"][0]["visible"], true);
}

#[test]
fn bridge_selects_a_rotated_window_as_a_polygon_not_its_bounding_box() {
    let mut s = CadcraftSession::new();
    let inside = run(&mut s, "line", json!({"points":[[4,4],[6,6]]}))["handles"][0].clone();
    run(&mut s, "line", json!({"points":[[0,0],[1,0]]}));
    let result = run(
        &mut s,
        "bridge.select_polygon",
        json!({"polygon":[[0,5],[5,10],[10,5],[5,0]],"crossing":false}),
    );
    assert_eq!(result["handles"], json!([inside]));
}

#[test]
fn spline_preview_uses_the_engine_without_mutating_the_drawing() {
    let mut s = CadcraftSession::new();
    run(&mut s, "circle", json!({"center":[0,0],"radius":2}));
    let before = s.export_dxf().unwrap();
    let preview = run(
        &mut s,
        "bridge.preview_spline",
        json!({"fit":[[0,0],[5,10],[10,0]]}),
    );
    assert_eq!(preview["entities"][0]["type"], "Spline");
    assert!(preview["primitives"][0]["points"].as_array().unwrap().len() > 3);
    assert_eq!(s.export_dxf().unwrap(), before);
}

#[test]
fn modify_preview_is_isolated_from_geometry_selection_and_undo() {
    let mut s = CadcraftSession::new();
    let handle = run(&mut s, "line", json!({"points":[[10,0],[20,0]]}))["handles"][0].clone();
    let before = s.export_dxf().unwrap();
    let original = scene(&s);
    let preview = run(&mut s, "bridge.preview_modify", json!({"command":"mirror","params":{"handles":[handle],"p1":[0,-10],"p2":[0,10]}}));
    assert_eq!(preview["entityCount"], 2);
    assert_eq!(s.export_dxf().unwrap(), before);
    assert_eq!(scene(&s), original);
    assert!(s.execute("bridge.preview_modify", &json!({"command":"erase","params":{}}).to_string()).is_err());
    assert_eq!(s.export_dxf().unwrap(), before);
}

#[test]
fn picking_svg_frame_and_command_catalog_use_upstream_geometry() {
    let mut s = CadcraftSession::new();
    let added = run(&mut s, "line", json!({"points": [[0,0],[10,5]]}));
    assert_eq!(
        s.pick(5.0, 2.5, 0.1).unwrap().unwrap(),
        added["handles"][0].as_str().unwrap()
    );
    assert!(s.pick(100.0, 100.0, 0.1).unwrap().is_none());
    assert!(s.export_svg().unwrap().contains("<polyline"));
    assert_eq!(scene(&s)["svgFrame"]["origin"], json!([-0.2, 5.2]));
    let commands: Value = serde_json::from_str(&s.commands().unwrap()).unwrap();
    assert!(
        commands
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == "circle" && c["params"].as_str().unwrap().contains("radius"))
    );
}

#[test]
fn real_engine_edits_and_undoes_geometry() {
    let mut s = CadcraftSession::new();
    let added = run(&mut s, "line", json!({"points": [[0,0],[10,0]]}));
    assert_eq!(scene(&s)["entityCount"], 1);
    run(
        &mut s,
        "move",
        json!({"handles": added["handles"], "delta": [5,2]}),
    );
    assert_eq!(scene(&s)["primitives"][0]["points"][0], json!([5.0, 2.0]));
    run(&mut s, "undo", json!({}));
    assert_eq!(scene(&s)["primitives"][0]["points"][0], json!([0.0, 0.0]));
    run(&mut s, "erase", json!({"handles": added["handles"]}));
    assert_eq!(scene(&s)["entityCount"], 0);
}

#[test]
fn dxf_roundtrip_preserves_editable_entities_and_failed_load_keeps_document() {
    let mut s = CadcraftSession::new();
    run(&mut s, "circle", json!({"center": [3,4], "radius": 2}));
    let bytes = s.export_dxf().unwrap();
    let mut restored = CadcraftSession::new();
    restored.load_dxf(&bytes).unwrap();
    assert_eq!(scene(&restored)["entityCount"], 1);
    assert!(restored.load_dxf(b"invalid drawing").is_err());
    assert_eq!(scene(&restored)["entityCount"], 1);
    assert!(restored.execute("circle", "invalid json").is_err());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn native_dwg_roundtrip_has_real_magic_and_editable_geometry() {
    let mut s = CadcraftSession::new();
    run(&mut s, "line", json!({"points": [[0,0],[10,4]]}));
    let doc = cadcraft_io::read(&s.export_dxf().unwrap(), "test.dxf").unwrap();
    let dwg = cadcraft_io::write(&doc, "test.dwg").unwrap();
    assert!(dwg.starts_with(b"AC1032"));
    let restored = cadcraft_io::read(&dwg, "test.dwg").unwrap();
    assert_eq!(restored.entity_count(), 1);
}

#[test]
fn codec_process_converts_bytes_and_rejects_invalid_input() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let mut s = CadcraftSession::new();
    run(&mut s, "circle", json!({"center": [1,2], "radius": 3}));
    let convert = |mode: &str, bytes: &[u8]| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_cadcraft-codec"))
            .arg(mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        child.wait_with_output().unwrap()
    };
    let dwg = convert("dxf-to-dwg", &s.export_dxf().unwrap());
    assert!(
        dwg.status.success(),
        "{}",
        String::from_utf8_lossy(&dwg.stderr)
    );
    assert!(dwg.stdout.starts_with(b"AC1032"));
    let dxf = convert("dwg-to-dxf", &dwg.stdout);
    assert!(dxf.status.success());
    let mut restored = CadcraftSession::new();
    restored.load_dxf(&dxf.stdout).unwrap();
    assert_eq!(scene(&restored)["entityCount"], 1);
    assert!(!convert("dwg-to-dxf", b"broken").status.success());
}

#[test]
fn codec_svg_uses_fixed_world_frame_and_rejects_invalid_frames() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let mut s = CadcraftSession::new();
    run(&mut s, "line", json!({"points": [[10,20],[20,30]]}));
    let convert = |frame: &[&str]| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_cadcraft-codec"))
            .arg("dxf-to-svg")
            .args(frame)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&s.export_dxf().unwrap())
            .unwrap();
        child.wait_with_output().unwrap()
    };
    let out = convert(&["--frame", "5", "50", "100", "80"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let svg = String::from_utf8(out.stdout).unwrap();
    assert!(svg.contains("viewBox=\"0 0 100.000000 80.000000\""));
    assert!(svg.contains("5.000000,30.000000 15.000000,20.000000"));
    assert!(convert(&[]).status.success());
    assert!(!convert(&["--frame", "0", "0", "-1", "80"]).status.success());
    assert!(
        !convert(&["--frame", "NaN", "0", "1", "80"])
            .status
            .success()
    );
}

#[test]
fn codec_scene_reports_mapping_and_entity_handles() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let mut s = CadcraftSession::new();
    run(&mut s, "line", json!({"points":[[10,20],[20,30]]}));
    let mut child = Command::new(env!("CARGO_BIN_EXE_cadcraft-codec"))
        .arg("dxf-to-scene")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&s.export_dxf().unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(state["entityCount"], 1);
    assert_eq!(state["svgFrame"]["origin"], json!([9.8, 30.2]));
}

#[test]
fn explicit_font_registration_supports_cjk_with_existing_licensed_font() {
    let mut session = CadcraftSession::new();
    let font = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../src/shared/document/fonts/SourceHanSerifCN-Regular.otf"
    ))
    .unwrap();
    session.register_font("patent-cjk-test", &font).unwrap();
    assert!(session.register_font("bad-font", b"invalid").is_err());
    run(
        &mut session,
        "text",
        json!({"at":[0,0],"text":"专利工作台","height":5}),
    );
    assert!(
        scene(&session)["primitives"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["kind"] == "triangles")
    );
    let bytes = session.export_dxf().unwrap();
    assert!(String::from_utf8(bytes).unwrap().contains("专利工作台"));
}

#[test]
fn codec_accepts_explicit_font_for_deterministic_chinese_rendering() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let font_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../src/shared/document/fonts/SourceHanSerifCN-Regular.otf"
    );
    let mut session = CadcraftSession::new();
    session
        .register_font("Source Han Serif CN", &std::fs::read(font_path).unwrap())
        .unwrap();
    run(
        &mut session,
        "text",
        json!({"at":[0,0],"text":"专利工作台","height":5}),
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_cadcraft-codec"))
        .args([
            "dxf-to-svg",
            "--font",
            font_path,
            "--frame",
            "0",
            "10",
            "50",
            "20",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&session.export_dxf().unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let svg = String::from_utf8(output.stdout).unwrap();
    assert!(svg.contains("<path fill="));
    assert!(svg.contains("viewBox=\"0 0 50.000000 20.000000\""));
}

#[test]
fn export_primitive_batch_creates_real_entities_and_rejects_partial_changes() {
    let mut session = CadcraftSession::new();
    run(
        &mut session,
        "bridge.add_primitives",
        json!({"primitives":[
            {"kind":"triangles","points":[[0,0],[2,0],[1,1]],"color":[20,30,40],"lineweight":0.2},
            {"kind":"polyline","points":[[0,0],[2,0]],"color":[0,0,0],"lineweight":0.2}
        ]}),
    );
    assert_eq!(scene(&session)["entityCount"], 2);
    let original = session.export_dxf().unwrap();
    assert!(
        session
            .execute(
                "bridge.add_primitives",
                &json!({"primitives":[
                    {"kind":"polyline","points":[[0,0],[2,0]],"color":[0,0,0],"lineweight":0.2},
                    {"kind":"unknown","points":[[0,0]],"color":[0,0,0],"lineweight":0.2}
                ]})
                .to_string()
            )
            .is_err()
    );
    assert_eq!(session.export_dxf().unwrap(), original);
}

#[test]
fn whole_model_export_transform_preserves_circle_entities_and_copies() {
    let mut session = CadcraftSession::new();
    run(&mut session, "circle", json!({"center":[2,3],"radius":1}));
    run(
        &mut session,
        "bridge.transform_model",
        json!({"origin":[0,0],"copies":[
            {"scale":2,"rotation":90,"delta":[10,0]},
            {"scale":1,"rotation":0,"delta":[20,0]}
        ]}),
    );
    let state = scene(&session);
    assert_eq!(state["entityCount"], 2);
    assert!(
        state["entities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["type"] == "Circle")
    );
    let properties = run(
        &mut session,
        "properties",
        json!({"handles":[state["entities"][0]["handle"]]}),
    );
    assert!(properties.to_string().contains("radius"));
    let before = session.export_dxf().unwrap();
    assert!(
        session
            .execute(
                "bridge.transform_model",
                &json!({"origin":[0,0],"copies":[{"scale":-1,"rotation":0,"delta":[0,0]}]})
                    .to_string()
            )
            .is_err()
    );
    assert_eq!(session.export_dxf().unwrap(), before);
}

#[test]
fn export_layer_is_visible_even_when_source_current_layer_is_off() {
    let mut session = CadcraftSession::new();
    run(&mut session, "layer.set", json!({"name":"0","on":false}));
    run(&mut session, "bridge.prepare_export", json!({}));
    run(
        &mut session,
        "text",
        json!({"at":[0,0],"text":"12","height":5}),
    );
    assert!(!scene(&session)["primitives"].as_array().unwrap().is_empty());
}

#[test]
fn scene_exposes_native_entity_grips() {
    let mut session = CadcraftSession::new();
    run(&mut session, "circle", json!({"center":[2,3],"radius":1}));
    let state = scene(&session);
    let grips = state["entities"][0]["grips"]
        .as_array()
        .expect("native grips array");
    assert!(grips.contains(&json!([2.0, 3.0])));
    assert_eq!(grips.len(), 5);
}

#[test]
fn array_previews_are_non_destructive_and_copies_survive_reload() {
    for (command, settings, expected) in [
        ("arrayrect", json!({"rows":2,"cols":3,"rowSpacing":10,"colSpacing":-12,"axisAngle":30,"associative":false}), 6),
        ("arraypolar", json!({"center":[0,0],"count":4,"angle":360,"rotate":true,"associative":false}), 4),
    ] {
        let mut s = CadcraftSession::new();
        let h = run(&mut s, "line", json!({"points":[[10,0],[15,0]]}))["handles"][0].clone();
        let mut params = settings;
        params["handles"] = json!([h]);
        let before = s.export_dxf().unwrap();
        let preview = run(&mut s, "bridge.preview_modify", json!({"command":command,"params":params}));
        assert_eq!(preview["entities"].as_array().unwrap().len(), expected);
        assert_eq!(s.export_dxf().unwrap(), before);
        run(&mut s, command, params);
        assert_eq!(scene(&s)["entities"], preview["entities"]);
        let bytes = s.export_dxf().unwrap();
        let mut reopened = CadcraftSession::new();
        reopened.load_dxf(&bytes).unwrap();
        assert_eq!(scene(&reopened)["entities"].as_array().unwrap().len(), expected);
        run(&mut s, "undo", json!({}));
        assert_eq!(scene(&s)["entities"].as_array().unwrap().len(), 1);
    }
}

#[test]
fn hatch_can_be_created_by_boundary_or_point_edited_and_protected() {
    for by_point in [false, true] {
        let mut s = CadcraftSession::new();
        let circle = run(&mut s, "circle", json!({"center":[0,0],"radius":10}))["handle"].clone();
        let mut params = if by_point {json!({"points":[[0,0]]})} else {json!({"handles":[circle]})};
        params["pattern"] = json!("ANSI31");
        params["scale"] = json!(2);
        let before = s.export_dxf().unwrap();
        let preview = run(&mut s, "bridge.preview_modify", json!({"command":"hatch","params":params}));
        assert_eq!(preview["entities"].as_array().unwrap().len(), 2);
        assert_eq!(s.export_dxf().unwrap(), before);
        run(&mut s, "hatch", params);
        let current = scene(&s);
        let hatch = current["entities"].as_array().unwrap().iter().find(|e| e["type"] == "Hatch").unwrap()["handle"].clone();
        let edit = json!({"handles":[hatch.clone()],"pattern":"ANSI32","scale":4,"angle":30});
        let before = s.export_dxf().unwrap();
        run(&mut s, "bridge.preview_modify", json!({"command":"hatchedit","params":edit}));
        assert_eq!(s.export_dxf().unwrap(), before);
        run(&mut s, "hatchedit", edit.clone());
        s.load_dxf(&s.export_dxf().unwrap()).unwrap();
        let props = run(&mut s, "properties", json!({"handles":[hatch.clone()]}));
        assert_eq!(props["objects"][0]["geometry"]["pattern"], "ANSI32");
        assert_eq!(props["objects"][0]["geometry"]["scale"], 4.0);
        run(&mut s, "layer.set", json!({"name":"0","locked":true}));
        let before = s.export_dxf().unwrap();
        assert!(s.execute("hatchedit", &edit.to_string()).is_err());
        assert_eq!(s.export_dxf().unwrap(), before);
    }
}

#[test]
fn lasso_accepts_triangles_and_concave_paths_without_selecting_their_bounds() {
    let mut s = CadcraftSession::new();
    let inside = run(&mut s, "line", json!({"points":[[1,1],[2,2]]}))["handles"][0].clone();
    run(&mut s, "line", json!({"points":[[7,7],[8,8]]}));
    let before = s.export_dxf().unwrap();
    for polygon in [json!([[0,0],[10,0],[0,10]]), json!([[0,0],[10,0],[10,3],[3,3],[3,10],[0,10]])] {
        let result = run(&mut s, "bridge.select_polygon", json!({"polygon":polygon,"crossing":true}));
        assert_eq!(result["handles"], json!([inside]));
    }
    assert!(s.execute("bridge.select_polygon", &json!({"polygon":[[0,0],[1,1]]}).to_string()).is_err());
    assert_eq!(s.export_dxf().unwrap(), before);
}
