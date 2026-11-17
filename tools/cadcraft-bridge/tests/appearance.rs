use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};
fn run(s: &mut CadcraftSession, c: &str, p: Value) -> Value {
    serde_json::from_str(&s.execute(c, &p.to_string()).unwrap()).unwrap()
}
fn scene(s: &CadcraftSession) -> Value {
    serde_json::from_str(&s.scene().unwrap()).unwrap()
}

#[test]
fn restored_defaults_keep_exact_color_when_composition_replaces_the_document() {
    let mut source=CadcraftSession::new();
    run(&mut source,"bridge.appearance",json!({"color":"#123456","lineweight":0.7,"linetype":"DASHED"}));
    let defaults=run(&mut source,"bridge.drawing_defaults",json!({}));
    let mut target=CadcraftSession::new();
    run(&mut target,"bridge.drawing_defaults",json!({"restore":defaults}));
    let bytes=target.export_dxf().unwrap();target.load_dxf(&bytes).unwrap();
    assert_eq!(scene(&source)["appearance"],scene(&target)["appearance"]);
    run(&mut target,"line",json!({"points":[[0,0],[100,0]]}));
    assert!(scene(&target)["primitives"].as_array().unwrap().len()>1);
}

#[test]
fn dot_linetypes_carry_lineweight_into_scene_and_svg() {
    let mut s = CadcraftSession::new();
    run(&mut s,"bridge.appearance",json!({"color":"#123456","lineweight":0.25,"linetype":"DOT"}));
    let line=run(&mut s,"line",json!({"points":[[0,0],[100,0]]}));
    let thin=s.export_patent_svg().unwrap();
    run(&mut s,"bridge.appearance",json!({"handles":line["handles"],"lineweight":2.0}));
    assert!(scene(&s)["primitives"].as_array().unwrap().iter().all(|p| p["lineweight"]==2.0));
    assert_ne!(thin,s.export_patent_svg().unwrap());
}

#[test]
fn normalization_preserves_nested_block_inheritance_without_recoloring_explicit_children() {
    let mut s=CadcraftSession::new();
    run(&mut s,"bridge.appearance",json!({"color":"ByBlock","linetype":"ByBlock"}));
    let line=run(&mut s,"line",json!({"points":[[0,0],[100,0]]}));
    run(&mut s,"block",json!({"name":"Inner","base":[0,0],"handles":line["handles"]}));
    let h=scene(&s)["entities"][0]["handle"].clone();
    run(&mut s,"block",json!({"name":"Outer","base":[0,0],"handles":[h]}));
    let h=scene(&s)["entities"][0]["handle"].clone();
    run(&mut s,"bridge.flatten_layers",json!({}));
    run(&mut s,"bridge.appearance",json!({"handles":[h],"color":"#ff0000","linetype":"DASHED"}));
    let sc=scene(&s);
    assert!(sc["primitives"].as_array().unwrap().len()>1);
    assert!(sc["primitives"].as_array().unwrap().iter().all(|p|p["color"]==json!([255,0,0])));
    let bytes=s.export_dxf().unwrap();s.load_dxf(&bytes).unwrap();
    assert_eq!(sc["primitives"],scene(&s)["primitives"]);
}

#[test]
fn block_attribute_text_retains_byblock_color_after_normalization() {
    let mut s=CadcraftSession::new();
    run(&mut s,"bridge.appearance",json!({"color":"ByBlock"}));
    let a=run(&mut s,"attdef",json!({"tag":"LABEL","default":"ABC","at":[0,0],"height":5}));
    run(&mut s,"block",json!({"name":"LabelBlock","base":[0,0],"handles":[a["handle"]]}));
    let h=scene(&s)["entities"][0]["handle"].clone();
    run(&mut s,"bridge.flatten_layers",json!({}));
    run(&mut s,"bridge.appearance",json!({"handles":[h],"color":"#ff0000"}));
    let sc=scene(&s);
    assert!(!sc["primitives"].as_array().unwrap().is_empty());
    assert!(sc["primitives"].as_array().unwrap().iter().all(|p|p["color"]==json!([255,0,0])));
}

#[test]
fn appearance_defaults_selection_history_and_dxf_roundtrip() {
    let mut s = CadcraftSession::new();
    run(
        &mut s,
        "bridge.appearance",
        json!({"color":"#c04020","lineweight":0.7,"linetype":"DASHED"}),
    );
    run(&mut s, "line", json!({"points":[[0,0],[100,0]]}));
    let first = scene(&s);
    let h = first["entities"][0]["handle"].clone();
    assert_eq!(
        first["entities"][0]["appearance"],
        json!({"color":"#c04020","lineweight":0.7,"linetype":"DASHED"})
    );
    assert!(
        first["primitives"].as_array().unwrap().len() > 1,
        "dashes must be actual rendered geometry"
    );
    run(
        &mut s,
        "bridge.appearance",
        json!({"handles":[h],"color":"#008000"}),
    );
    assert_eq!(scene(&s)["entities"][0]["appearance"]["color"], "#008000");
    assert_eq!(scene(&s)["appearance"]["color"], "#c04020");
    run(&mut s, "undo", json!({}));
    assert_eq!(scene(&s)["entities"][0]["appearance"]["color"], "#c04020");
    run(&mut s, "redo", json!({}));
    let bytes = s.export_dxf().unwrap();
    let mut reopened = CadcraftSession::new();
    reopened.load_dxf(&bytes).unwrap();
    assert_eq!(
        scene(&reopened)["entities"][0]["appearance"],
        scene(&s)["entities"][0]["appearance"]
    );
    assert_eq!(scene(&reopened)["appearance"], scene(&s)["appearance"]);
    let before = reopened.export_dxf().unwrap();
    assert!(
        reopened
            .execute(
                "bridge.appearance",
                r##"{"color":"#ff0000","lineweight":-1}"##
            )
            .is_err()
    );
    assert_eq!(before, reopened.export_dxf().unwrap());
}

#[test]
fn svg_preserves_lineweight_ratios() {
    let mut s = CadcraftSession::new();
    run(&mut s, "bridge.appearance", json!({"lineweight":0.25}));
    run(&mut s, "line", json!({"points":[[0,0],[100,0]]}));
    run(&mut s, "bridge.appearance", json!({"lineweight":1.0}));
    run(&mut s, "line", json!({"points":[[0,10],[100,10]]}));
    let svg = s.export_patent_svg().unwrap();
    let widths: Vec<f64> = svg
        .split("stroke-width=\"")
        .skip(1)
        .map(|s| s.split('"').next().unwrap().parse().unwrap())
        .collect();
    assert_eq!(widths.len(), 2);
    assert!((widths[1] / widths[0] - 4.0).abs() < 0.001);
}

#[test]
fn appearance_survives_native_dwg_and_all_offered_linetypes_render() {
    for lt in [
        "Continuous",
        "DASHED",
        "DASHED2",
        "DOT",
        "CENTER",
        "DASHDOT",
        "PHANTOM",
    ] {
        let mut s = CadcraftSession::new();
        run(
            &mut s,
            "bridge.appearance",
            json!({"color":"#123456","lineweight":0.5,"linetype":lt}),
        );
        run(&mut s, "circle", json!({"center":[0,0],"radius":40}));
        assert!(!scene(&s)["primitives"].as_array().unwrap().is_empty());
        let doc = cadcraft_io::read(&s.export_dxf().unwrap(), "appearance.dxf").unwrap();
        let dwg = cadcraft_io::write(&doc, "appearance.dwg").unwrap();
        let doc = cadcraft_io::read(&dwg, "appearance.dwg").unwrap();
        let dxf = cadcraft_io::write(&doc, "appearance.dxf").unwrap();
        let mut reopened = CadcraftSession::new();
        reopened.load_dxf(&dxf).unwrap();
        assert_eq!(
            scene(&reopened)["entities"][0]["appearance"],
            scene(&s)["entities"][0]["appearance"]
        );
    }
}

#[test]
fn generated_blocks_use_exact_current_color_and_keep_it_after_parameter_edits() {
    let mut s = CadcraftSession::new();
    run(
        &mut s,
        "bridge.appearance",
        json!({"color":"#123456","lineweight":0.5}),
    );
    let g = run(
        &mut s,
        "bridge.gear",
        json!({"kind":"external","teeth":20,"hole":true,"size":40,"at":[0,0],"rotation":0}),
    );
    let h = g["handle"].clone();
    // Adding patent annotations normalizes layer/block inheritance in the saved scene.
    run(&mut s,"bridge.flatten_layers",json!({}));
    assert!(
        scene(&s)["primitives"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["color"] == json!([18, 52, 86]))
    );
    run(
        &mut s,
        "bridge.appearance",
        json!({"handles":[h],"color":"#cc0000"}),
    );
    assert!(
        scene(&s)["primitives"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["color"] == json!([204, 0, 0]))
    );
    run(
        &mut s,
        "bridge.gear",
        json!({"handle":h,"kind":"external","teeth":24,"hole":true,"size":40,"at":[0,0],"rotation":0}),
    );
    assert!(
        scene(&s)["primitives"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["color"] == json!([204, 0, 0]))
    );
}
