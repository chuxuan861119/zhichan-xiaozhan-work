use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};
fn run(s: &mut CadcraftSession, c: &str, p: Value) -> Value {
    serde_json::from_str(&s.execute(c, &p.to_string()).unwrap()).unwrap()
}
fn scene(s: &CadcraftSession) -> Value {
    serde_json::from_str(&s.scene().unwrap()).unwrap()
}
fn spec(kind: &str) -> Value {
    json!({"kind":kind,"teeth":20,"hole":true,"at":[10,20],"size":80,"rotation":30})
}

#[test]
fn gears_have_move_scale_teeth_and_round_gears_have_centered_rotation_grips() {
    for kind in ["external", "internal", "rack"] {
        let mut s = CadcraftSession::new();
        let mut p = spec(kind); p["rotation"] = json!(0);
        run(&mut s,"bridge.gear",p);
        let entity = scene(&s)["entities"][0].clone();
        let grips=entity["grips"].as_array().unwrap();
        assert_eq!(grips.len(), if kind=="rack" {3} else {4});
        assert_eq!(grips[0],json!([10.0,20.0]));
        assert_eq!(grips[1],json!([if kind=="rack" {90.0} else {50.0},20.0]));
        assert_ne!(grips[1],grips[2]);
    }
}

#[test]
fn gear_scale_grips_preserve_anchor_rotation_and_other_copies_with_single_undo() {
    for kind in ["external","internal","rack"] {
        let mut s=CadcraftSession::new();
        let mut p=spec(kind);p["rotation"]=json!(0);
        let h=run(&mut s,"bridge.gear",p)["handle"].clone();
        let copy=run(&mut s,"copy",json!({"handles":[h],"delta":[200,0]}))["handles"][0].clone();
        let result=run(&mut s,"bridge.edit",json!({"command":"grip.move","params":{"handle":h,"index":1,"to":[if kind=="rack"{170}else{90},20]}}));
        assert_eq!(result["scene"]["entities"].as_array().unwrap().len(),1);
        let find=|s:&CadcraftSession, handle:&Value| scene(s)["entities"].as_array().unwrap().iter().find(|e|e["handle"]==*handle).unwrap().clone();
        assert_eq!(find(&s,&h)["gear"]["size"].as_f64(),Some(160.0));
        assert_eq!(find(&s,&h)["grips"][0],json!([10.0,20.0]));
        assert_eq!(find(&s,&copy)["gear"]["size"].as_f64(),Some(80.0));
        run(&mut s,"undo",json!({}));assert_eq!(find(&s,&h)["gear"]["size"].as_f64(),Some(80.0));
        run(&mut s,"redo",json!({}));assert_eq!(find(&s,&h)["gear"]["size"].as_f64(),Some(160.0));
    }
}

#[test]
fn teeth_grip_previews_are_isolated_and_changes_are_integer_bounded_and_durable() {
    for kind in ["external","internal","rack"] {
        let mut s=CadcraftSession::new();
        let mut p=spec(kind);p["rotation"]=json!(0);
        let h=run(&mut s,"bridge.gear",p)["handle"].clone();
        let from=scene(&s)["entities"][0]["grips"][2].clone();
        assert!(from.is_array(),"missing tooth-count grip");
        let x=from[0].as_f64().unwrap();let y=from[1].as_f64().unwrap();
        let to=if kind=="rack" {json!([x,y-8.0])}else{json!([x-8.0,y])};
        let params=json!({"handle":h,"index":2,"to":to});
        let before=s.export_dxf().unwrap();
        let preview=run(&mut s,"bridge.preview_draw",json!({"command":"grip.move","params":params}));
        assert_eq!(preview["entities"][0]["gear"]["teeth"],24);
        assert_eq!(s.export_dxf().unwrap(),before);
        run(&mut s,"grip.move",params);
        assert_eq!(scene(&s)["entities"][0]["gear"]["teeth"],24);
        s.load_dxf(&s.export_dxf().unwrap()).unwrap();
        assert_eq!(scene(&s)["entities"][0]["gear"]["teeth"],24);
        run(&mut s,"grip.move",json!({"handle":h,"index":2,"to":[-1e6,-1e6]}));
        assert_eq!(scene(&s)["entities"][0]["gear"]["teeth"],120);
        run(&mut s,"grip.move",json!({"handle":h,"index":2,"to":[1e6,1e6]}));
        assert_eq!(scene(&s)["entities"][0]["gear"]["teeth"],if kind=="rack"{2}else{8});
    }
}

#[test]
fn round_gear_rotation_grips_use_the_gear_center_and_keep_size_and_teeth() {
    for kind in ["external","internal"] {
        let mut s=CadcraftSession::new();
        let mut p=spec(kind);p["rotation"]=json!(0);
        let h=run(&mut s,"bridge.gear",p)["handle"].clone();
        run(&mut s,"grip.move",json!({"handle":h,"index":3,"to":[-46,20]}));
        let entity=scene(&s)["entities"][0].clone();
        assert!((entity["rotation"].as_f64().unwrap()-90.0).abs()<1e-8);
        assert_eq!(entity["grips"][0],json!([10.0,20.0]));
        assert_eq!(entity["gear"]["size"].as_f64(),Some(80.0));
        assert_eq!(entity["gear"]["teeth"],20);
        let before=s.export_dxf().unwrap();
        assert!(s.execute("grip.move",&json!({"handle":h,"index":3,"to":[10,20]}).to_string()).is_ok());
        assert_eq!(s.export_dxf().unwrap(),before,"undefined center direction is a no-op");
    }
}

#[test]
fn mirrored_nonuniform_gear_grips_keep_aspect_and_reject_locked_edits() {
    use cadcraft_engine::doc::EntityKind;
    let mut s=CadcraftSession::new();
    let h=run(&mut s,"bridge.gear",spec("external"))["handle"].clone();
    let mut doc=cadcraft_io::read(&s.export_dxf().unwrap(),"gear.dxf").unwrap();
    let mut entity=(**doc.model.iter().next().unwrap()).clone();
    let EntityKind::Insert(ref mut ins)=entity.kind else {panic!("expected insert");};
    ins.scale.x=-40.0;ins.scale.y=20.0;
    doc.model.replace(entity);
    s.load_dxf(&cadcraft_io::write(&doc,"gear.dxf").unwrap()).unwrap();
    let grips=scene(&s)["entities"][0]["grips"].clone();
    let a=grips[0].as_array().unwrap();let b=grips[1].as_array().unwrap();
    let to=json!([a[0].as_f64().unwrap()+2.0*(b[0].as_f64().unwrap()-a[0].as_f64().unwrap()),a[1].as_f64().unwrap()+2.0*(b[1].as_f64().unwrap()-a[1].as_f64().unwrap())]);
    run(&mut s,"grip.move",json!({"handle":h,"index":1,"to":to}));
    let after=cadcraft_io::read(&s.export_dxf().unwrap(),"gear.dxf").unwrap();
    let EntityKind::Insert(ins)=&after.model.iter().next().unwrap().kind else {panic!("expected insert");};
    assert!((ins.scale.x+80.0).abs()<1e-8);assert!((ins.scale.y-40.0).abs()<1e-8);
    let mut locked=after.clone();locked.layers[0].locked=true;
    s.load_dxf(&cadcraft_io::write(&locked,"gear.dxf").unwrap()).unwrap();
    let before=s.export_dxf().unwrap();
    for index in 0..4 {
        assert!(s.execute("grip.move",&json!({"handle":h,"index":index,"to":[100,100]}).to_string()).is_err());
        assert_eq!(s.export_dxf().unwrap(),before);
    }
}

#[test]
fn gear_types_are_standard_editable_blocks_and_survive_dxf() {
    for kind in ["external", "internal", "rack"] {
        let mut s = CadcraftSession::new();
        let handle = run(&mut s, "bridge.gear", spec(kind))["handle"].clone();
        let first = scene(&s);
        assert_eq!(first["entities"].as_array().unwrap().len(), 1);
        assert_eq!(first["entities"][0]["gear"]["kind"], kind);
        assert_eq!(first["entities"][0]["gear"]["teeth"], 20);
        assert!(first["primitives"].as_array().unwrap().iter().all(|p| {
            p["points"]
                .as_array()
                .unwrap()
                .iter()
                .all(|p| p[0].as_f64().unwrap().is_finite() && p[1].as_f64().unwrap().is_finite())
        }));
        s.load_dxf(&s.export_dxf().unwrap()).unwrap();
        assert_eq!(scene(&s)["entities"][0]["gear"]["kind"], kind);
        let parts = run(&mut s, "explode", json!({"handles":[handle]}));
        assert!(parts["changed"].as_bool().unwrap());
        assert!(
            scene(&s)["entities"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["gear"].is_null())
        );
        assert!(
            scene(&s)["entities"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["type"] == "Polyline" || e["type"] == "Circle")
        );
    }
}

#[test]
fn gear_validation_is_atomic_and_preview_does_not_touch_history() {
    let mut s = CadcraftSession::new();
    let before = s.export_dxf().unwrap();
    for (key, value) in [
        ("teeth", json!(3)),
        ("teeth", json!(121)),
        ("teeth", json!(8.5)),
        ("teeth", json!(4294967304u64)),
        ("size", json!(-1)),
        ("kind", json!("unknown")),
        ("at", json!([1e20, 0])),
    ] {
        let mut p = spec("external");
        p[key] = value;
        assert!(s.execute("bridge.gear", &p.to_string()).is_err());
        assert_eq!(s.export_dxf().unwrap(), before);
    }
    let preview = run(
        &mut s,
        "bridge.preview_draw",
        json!({"command":"bridge.gear","params":spec("external")}),
    );
    assert!(!preview["primitives"].as_array().unwrap().is_empty());
    assert_eq!(s.export_dxf().unwrap(), before);
    run(&mut s, "bridge.gear", spec("external"));
    run(&mut s, "undo", json!({}));
    assert_eq!(scene(&s)["entityCount"], 0);
    run(&mut s, "redo", json!({}));
    assert_eq!(scene(&s)["entityCount"], 1);
}

#[test]
fn gear_edit_is_copy_on_write_and_preserves_reference_transform() {
    let mut s = CadcraftSession::new();
    let h = run(&mut s, "bridge.gear", spec("external"))["handle"].clone();
    let copy = run(&mut s, "copy", json!({"handles":[h],"delta":[100,0]}))["handles"][0].clone();
    let original = scene(&s)["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["handle"] == h)
        .unwrap()
        .clone();
    run(
        &mut s,
        "bridge.gear",
        json!({"handle":copy,"kind":"external","teeth":32,"hole":false,"size":120}),
    );
    let after = scene(&s);
    assert_eq!(
        after["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["handle"] == h)
            .unwrap(),
        &original
    );
    let edited = after["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["handle"] == copy)
        .unwrap();
    assert_eq!(edited["gear"]["teeth"], 32);
    assert_eq!(
        edited["geometry"]["rotation"],
        original["geometry"]["rotation"]
    );
    assert!((edited["gear"]["size"].as_f64().unwrap() - 120.0).abs() < 1e-6);
    run(&mut s, "undo", json!({}));
    assert!(
        scene(&s)["entities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["gear"]["teeth"] == 20)
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn gears_survive_native_dwg_roundtrip_with_standard_geometry_and_parameters() {
    let mut s = CadcraftSession::new();
    for kind in ["external", "internal", "rack"] {
        run(&mut s, "bridge.gear", spec(kind));
    }
    let doc = cadcraft_io::read(&s.export_dxf().unwrap(), "gear.dxf").unwrap();
    let dwg = cadcraft_io::write(&doc, "gear.dwg").unwrap();
    assert!(dwg.starts_with(b"AC1032"));
    let restored = cadcraft_io::read(&dwg, "gear.dwg").unwrap();
    s.load_dxf(&cadcraft_io::write(&restored, "gear.dxf").unwrap())
        .unwrap();
    assert_eq!(scene(&s)["entityCount"], 3);
    assert!(
        scene(&s)["entities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["gear"]["teeth"] == 20)
    );
}

#[test]
fn gear_updates_leave_no_orphan_definitions_and_locked_edits_are_atomic() {
    let mut s = CadcraftSession::new();
    let h = run(&mut s, "bridge.gear", spec("external"))["handle"].clone();
    for n in 21..=30 {
        run(
            &mut s,
            "bridge.gear",
            json!({"handle":h,"kind":"external","teeth":n,"hole":false,"size":80}),
        );
    }
    let doc = cadcraft_io::read(&s.export_dxf().unwrap(), "gear.dxf").unwrap();
    assert_eq!(
        doc.blocks
            .keys()
            .filter(|n| n.starts_with("PW_GEAR_V1_"))
            .count(),
        1
    );
    run(&mut s, "layer.set", json!({"name":"0","locked":true}));
    let before = s.export_dxf().unwrap();
    assert!(
        s.execute(
            "bridge.gear",
            &json!({"handle":h,"kind":"external","teeth":40,"hole":true,"size":80}).to_string()
        )
        .is_err()
    );
    assert_eq!(s.export_dxf().unwrap(), before);
}

#[test]
fn gear_delta_and_preview_exclude_unrelated_geometry_and_survive_layer_normalization() {
    let mut s = CadcraftSession::new();
    run(&mut s, "line", json!({"points":[[-100,0],[100,0]]}));
    let created = run(
        &mut s,
        "bridge.edit",
        json!({"command":"bridge.gear","params":spec("internal")}),
    );
    assert_eq!(created["scene"]["entities"].as_array().unwrap().len(), 1);
    let h = created["result"]["handle"].clone();
    run(&mut s, "bridge.flatten_layers", json!({}));
    let edit = json!({"handle":h,"kind":"internal","teeth":40,"hole":false,"size":120});
    let before = s.export_dxf().unwrap();
    let preview = run(
        &mut s,
        "bridge.preview_draw",
        json!({"command":"bridge.gear","params":edit}),
    );
    assert_eq!(preview["entities"].as_array().unwrap().len(), 1);
    assert_eq!(preview["entities"][0]["gear"]["teeth"], 40);
    assert_eq!(s.export_dxf().unwrap(), before);
    let updated = run(
        &mut s,
        "bridge.edit",
        json!({"command":"bridge.gear","params":edit}),
    );
    assert_eq!(updated["scene"]["entities"].as_array().unwrap().len(), 1);
    assert_eq!(scene(&s)["entityCount"], 2);
    assert_eq!(updated["scene"]["entities"][0]["handle"], h);
}

#[test]
fn parameter_edits_preserve_imported_nonuniform_mirror_transform_and_common_properties() {
    use cadcraft_engine::doc::EntityKind;
    let mut s = CadcraftSession::new();
    let h = run(&mut s, "bridge.gear", spec("external"))["handle"].clone();
    let mut doc = cadcraft_io::read(&s.export_dxf().unwrap(), "gear.dxf").unwrap();
    let mut entity = (**doc.model.iter().next().unwrap()).clone();
    let EntityKind::Insert(ref mut insert) = entity.kind else {
        panic!("expected block reference")
    };
    insert.scale.x = -80.0;
    insert.scale.y = 20.0;
    insert.rotation = 0.6;
    let common = entity.common.clone();
    doc.model.replace(entity);
    s.load_dxf(&cadcraft_io::write(&doc, "gear.dxf").unwrap())
        .unwrap();
    run(
        &mut s,
        "bridge.gear",
        json!({"handle":h,"kind":"external","teeth":120,"hole":false,"size":200}),
    );
    let after = cadcraft_io::read(&s.export_dxf().unwrap(), "gear.dxf").unwrap();
    let entity = after.model.iter().next().unwrap();
    assert_eq!(entity.common, common);
    let EntityKind::Insert(insert) = &entity.kind else {
        panic!("expected block reference")
    };
    assert!((insert.scale.x + 100.0).abs() < 1e-9);
    assert!((insert.scale.y - 25.0).abs() < 1e-9);
    assert!((insert.rotation - 0.6).abs() < 1e-9);
    assert_eq!(insert.insert.x, 10.0);
    assert_eq!(insert.insert.y, 20.0);
}

#[test]
fn gear_parameter_edits_restore_through_shared_checkpoint_history() {
    let mut s = CadcraftSession::new();
    let h = run(&mut s, "bridge.gear", spec("external"))["handle"].clone();
    run(&mut s, "bridge.remember", json!({"key":"original"}));
    run(
        &mut s,
        "bridge.gear",
        json!({"handle":h,"kind":"external","teeth":32,"hole":false,"size":120}),
    );
    run(&mut s, "bridge.remember", json!({"key":"modified"}));
    assert_eq!(
        run(&mut s, "bridge.checkout", json!({"key":"original"}))["restored"],
        true
    );
    assert_eq!(scene(&s)["entities"][0]["gear"]["teeth"], 20);
    assert_eq!(scene(&s)["entities"][0]["gear"]["hole"], true);
    assert_eq!(
        run(&mut s, "bridge.checkout", json!({"key":"modified"}))["restored"],
        true
    );
    assert_eq!(scene(&s)["entities"][0]["gear"]["teeth"], 32);
    assert_eq!(scene(&s)["entities"][0]["gear"]["hole"], false);
}

#[test]
fn deferred_edit_rolls_back_geometry_definitions_and_undo_without_using_history_slots() {
    let mut s = CadcraftSession::new();
    let h = run(&mut s, "bridge.gear", spec("external"))["handle"].clone();
    run(&mut s, "bridge.remember", json!({"key":"saved"}));
    let before = s.export_dxf().unwrap();
    for _ in 0..10 {
        run(&mut s, "bridge.edit_begin", json!({}));
        run(&mut s, "bridge.edit", json!({"command":"bridge.gear","params":{"handle":h,"kind":"external","teeth":32,"hole":false,"size":300}}));
        run(&mut s, "bridge.edit_finish", json!({"accept":false}));
        assert_eq!(s.export_dxf().unwrap(), before);
    }
    assert_eq!(run(&mut s, "bridge.checkout", json!({"key":"saved"}))["restored"], true);
    run(&mut s, "bridge.edit_begin", json!({}));
    run(&mut s, "bridge.gear", json!({"handle":h,"kind":"external","teeth":24,"hole":true,"size":60}));
    run(&mut s, "bridge.edit_finish", json!({"accept":true}));
    assert_eq!(scene(&s)["entities"][0]["gear"]["teeth"], 24);
    run(&mut s, "undo", json!({}));
    assert_eq!(scene(&s)["entities"][0]["gear"]["teeth"], 20);
    run(&mut s, "redo", json!({}));
    assert_eq!(scene(&s)["entities"][0]["gear"]["teeth"], 24);
}

#[test]
fn normalizing_after_new_annotations_does_not_accumulate_gear_definitions() {
    let mut s = CadcraftSession::new();
    run(&mut s, "bridge.gear", spec("external"));
    run(&mut s, "bridge.flatten_layers", json!({}));
    let baseline = cadcraft_io::read(&s.export_dxf().unwrap(), "gear.dxf").unwrap().blocks.len();
    for i in 0..20 {
        run(&mut s, "line", json!({"points":[[i,0],[i,1]]}));
        run(&mut s, "bridge.flatten_layers", json!({}));
        let bytes = s.export_dxf().unwrap();
        s.load_dxf(&bytes).unwrap();
        let doc = cadcraft_io::read(&bytes, "gear.dxf").unwrap();
        assert_eq!(doc.blocks.len(), baseline, "save {i} added block definitions");
        assert_eq!(scene(&s)["entities"][0]["gear"]["teeth"], 20);
    }
}
