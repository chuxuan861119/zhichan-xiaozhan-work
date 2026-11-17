use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};
use std::f64::consts::PI;

fn run(s: &mut CadcraftSession, cmd: &str, p: Value) -> Value {
    serde_json::from_str(&s.execute(cmd, &p.to_string()).unwrap()).unwrap()
}
fn scene(s: &CadcraftSession) -> Value {
    serde_json::from_str(&s.scene().unwrap()).unwrap()
}
fn entity(s: &CadcraftSession, h: &Value) -> Value {
    scene(s)["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["handle"] == *h)
        .unwrap()
        .clone()
}
fn create(s: &mut CadcraftSession, kind: &str, n: u64, at: [f64; 2], size: f64) -> Value {
    run(
        s,
        "bridge.gear",
        json!({"kind":kind,"teeth":n,"hole":true,"at":at,"size":size,"rotation":0}),
    )["handle"]
        .clone()
}
fn pos(e: &Value) -> [f64; 2] {
    serde_json::from_value(e["grips"][0].clone()).unwrap()
}
fn module(e: &Value) -> f64 {
    let g = &e["gear"];
    let n = g["teeth"].as_f64().unwrap();
    g["size"].as_f64().unwrap()
        / match g["kind"].as_str().unwrap() {
            "external" => n + 2.0,
            "internal" => n + 5.5,
            _ => PI * n,
        }
}
fn enable(s: &mut CadcraftSession, a: &Value, b: &Value) {
    assert_eq!(
        run(
            s,
            "bridge.gear_mesh",
            json!({"handles":[a,b],"enabled":true})
        )["changed"],
        true
    );
}
fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-7, "{a} != {b}");
}

#[test]
fn tooth_edits_resize_only_the_edited_wheel_and_keep_fixed_partners_unchanged() {
    for (kind, teeth, size) in [
        ("external", 30, 128.0),
        ("internal", 60, 262.0),
        ("rack", 24, 96.0 * PI),
    ] {
        for edited_first in [true, false] {
            for next in [12, 28] {
                let mut s = CadcraftSession::new();
                let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
                let b = create(&mut s, kind, teeth, [200.0, 0.0], size);
                if edited_first {
                    enable(&mut s, &a, &b);
                } else {
                    enable(&mut s, &b, &a);
                }
                let fixed = entity(&s, &b);
                let previous = entity(&s, &a);
                let before = s.export_dxf().unwrap();
                run(
                    &mut s,
                    "bridge.gear",
                    json!({"handle":a,"kind":"external","teeth":next,
                    "hole":true,"size":previous["gear"]["size"]}),
                );
                let current = entity(&s, &a);
                close(module(&current), module(&fixed));
                assert_eq!(
                    entity(&s, &b),
                    fixed,
                    "unmodified partner must retain its complete scene state"
                );
                assert_eq!(current["gear"]["teeth"], next);
                if next < 20 {
                    assert!(
                        current["gear"]["size"].as_f64().unwrap()
                            < previous["gear"]["size"].as_f64().unwrap()
                    );
                }
                let after = s.export_dxf().unwrap();
                run(&mut s, "undo", json!({}));
                assert_eq!(s.export_dxf().unwrap(), before);
                run(&mut s, "redo", json!({}));
                assert_eq!(s.export_dxf().unwrap(), after);
                s.load_dxf(&after).unwrap();
                close(module(&entity(&s, &a)), module(&fixed));
                assert_eq!(entity(&s, &b), fixed);
            }
        }
    }
}

#[test]
fn tooth_grip_preview_and_commit_keep_the_rest_of_the_train_fixed() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "external", 30, [200.0, 0.0], 128.0);
    let c = create(&mut s, "external", 16, [400.0, 0.0], 72.0);
    enable(&mut s, &a, &b);
    enable(&mut s, &b, &c);
    let ea = entity(&s, &a);
    let fixed = [entity(&s, &b), entity(&s, &c)];
    let grip: [f64; 2] = serde_json::from_value(ea["grips"][2].clone()).unwrap();
    let params = json!({"handle":a,"index":2,"to":[grip[0]+8.8,grip[1]]});
    let before = s.export_dxf().unwrap();
    let preview = run(
        &mut s,
        "bridge.preview_draw",
        json!({"command":"grip.move","params":params}),
    );
    for fixed_entity in &fixed {
        let found = preview["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["handle"] == fixed_entity["handle"])
            .unwrap();
        assert_eq!(found, fixed_entity);
    }
    assert_eq!(s.export_dxf().unwrap(), before, "preview must be read-only");
    run(&mut s, "grip.move", params);
    close(entity(&s, &a)["gear"]["size"].as_f64().unwrap(), 72.0);
    assert_eq!(entity(&s, &a)["gear"]["teeth"], 16);
    assert_eq!(entity(&s, &b), fixed[0]);
    assert_eq!(entity(&s, &c), fixed[1]);
}

#[test]
fn an_incompatible_middle_tooth_edit_rolls_back_instead_of_moving_fixed_gears() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "external", 20, [80.0, 0.0], 88.0);
    let c = create(&mut s, "external", 20, [160.0, 0.0], 88.0);
    enable(&mut s, &a, &b);
    enable(&mut s, &b, &c);
    let before = s.export_dxf().unwrap();
    let error = s
        .execute(
            "bridge.gear",
            &json!({"handle":b,"kind":"external","teeth":8,"hole":true,"size":88}).to_string(),
        )
        .unwrap_err();
    assert!(error.contains("其他齿轮"));
    assert_eq!(s.export_dxf().unwrap(), before);
}

#[test]
fn editing_the_internal_wheel_or_rack_keeps_the_external_partner_fixed() {
    for (kind, teeth, size, next) in [("internal", 60, 262.0, 52), ("rack", 24, 96.0 * PI, 16)] {
        let mut s = CadcraftSession::new();
        let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
        let b = create(&mut s, kind, teeth, [200.0, 0.0], size);
        enable(&mut s, &a, &b);
        let fixed = entity(&s, &a);
        run(
            &mut s,
            "bridge.gear",
            json!({"handle":b,"kind":kind,"teeth":next,"hole":false,"size":size}),
        );
        assert_eq!(entity(&s, &a), fixed);
        close(module(&entity(&s, &b)), module(&fixed));
        assert!(entity(&s, &b)["gear"]["size"].as_f64().unwrap() < size);
        let doc = cadcraft_io::read(&s.export_dxf().unwrap(), "mesh.dxf").unwrap();
        let dwg = cadcraft_io::write(&doc, "mesh.dwg").unwrap();
        let restored = cadcraft_io::read(&dwg, "mesh.dwg").unwrap();
        s.load_dxf(&cadcraft_io::write(&restored, "mesh.dxf").unwrap())
            .unwrap();
        close(module(&entity(&s, &b)), module(&entity(&s, &a)));
        assert_eq!(entity(&s, &a)["geometry"], fixed["geometry"]);
    }
}

#[test]
fn compatible_middle_tooth_edit_uses_a_new_center_without_moving_either_partner() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 22, [0.0, 0.0], 96.0);
    let b = create(&mut s, "external", 20, [84.0, 0.0], 88.0);
    let c = create(&mut s, "external", 22, [168.0, 0.0], 96.0);
    enable(&mut s, &a, &b);
    enable(&mut s, &b, &c);
    let fixed = [entity(&s, &a), entity(&s, &c)];
    run(
        &mut s,
        "bridge.gear",
        json!({"handle":b,"kind":"external","teeth":62,"hole":true,"size":88}),
    );
    let at = pos(&entity(&s, &b));
    close(at[0], 84.0);
    close(at[1].abs(), 84.0 * 3.0_f64.sqrt());
    close(module(&entity(&s, &b)), 4.0);
    assert_eq!(entity(&s, &a), fixed[0]);
    assert_eq!(entity(&s, &c), fixed[1]);
}

#[test]
fn attaching_an_independent_gear_keeps_the_existing_train_in_either_selection_order() {
    for reversed in [false, true] {
        let mut s = CadcraftSession::new();
        let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
        let b = create(&mut s, "external", 30, [200.0, 0.0], 100.0);
        enable(&mut s, &a, &b);
        let c = create(&mut s, "external", 16, [400.0, 50.0], 40.0);
        let original = s.export_dxf().unwrap();
        let ea = entity(&s, &a);
        let eb = entity(&s, &b);
        if reversed {
            enable(&mut s, &c, &b);
        } else {
            enable(&mut s, &b, &c);
        }
        assert_eq!(entity(&s, &a)["geometry"], ea["geometry"]);
        assert_eq!(entity(&s, &b)["geometry"], eb["geometry"]);
        assert_eq!(entity(&s, &b)["gearMates"], json!([a, c]));
        close(module(&entity(&s, &c)), module(&eb));
        let pc = pos(&entity(&s, &c));
        let pb = pos(&eb);
        close((pc[0] - pb[0]).hypot(pc[1] - pb[1]), module(&eb) * 23.0);
        let saved = s.export_dxf().unwrap();
        run(&mut s, "undo", json!({}));
        assert_eq!(s.export_dxf().unwrap(), original);
        run(&mut s, "redo", json!({}));
        assert_eq!(s.export_dxf().unwrap(), saved);
    }
}

#[test]
fn a_train_propagates_from_either_end_and_the_middle_without_group_order_dependency() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "external", 30, [200.0, 0.0], 100.0);
    let c = create(&mut s, "external", 16, [400.0, 0.0], 40.0);
    enable(&mut s, &b, &c);
    enable(&mut s, &b, &a);
    let saved = s.export_dxf().unwrap();
    for (driver, ratios) in [
        (&a, [1.0, -20.0 / 30.0, 20.0 / 16.0]),
        (&b, [-30.0 / 20.0, 1.0, -30.0 / 16.0]),
        (&c, [16.0 / 20.0, -16.0 / 30.0, 1.0]),
    ] {
        s.load_dxf(&saved).unwrap();
        let baseline = s.export_dxf().unwrap();
        let old = [entity(&s, &a), entity(&s, &b), entity(&s, &c)];
        let params = json!({"handles":[driver],"base":pos(&entity(&s,driver)),"angle":540});
        let preview = run(
            &mut s,
            "bridge.preview_modify",
            json!({"command":"rotate","params":params,"compact":true}),
        );
        assert_eq!(preview["entities"].as_array().unwrap().len(), 3);
        assert!(
            s.export_dxf().unwrap() == baseline,
            "preview changed the train"
        );
        run(&mut s, "rotate", params);
        for (i, h) in [&a, &b, &c].iter().enumerate() {
            let delta =
                entity(&s, h)["rotation"].as_f64().unwrap() - old[i]["rotation"].as_f64().unwrap();
            if *h == driver {
                close((delta - 540.0).rem_euclid(360.0), 0.0);
            } else {
                close(delta, 540.0 * ratios[i]);
            }
            assert_eq!(pos(&entity(&s, h)), pos(&old[i]));
        }
        run(&mut s, "undo", json!({}));
        assert!(
            s.export_dxf().unwrap() == baseline,
            "one undo must restore the whole train"
        );
    }
}

#[test]
fn removing_one_train_edge_keeps_the_other_edge_and_invalid_join_is_atomic() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "external", 30, [200.0, 0.0], 100.0);
    let c = create(&mut s, "external", 16, [400.0, 0.0], 40.0);
    enable(&mut s, &a, &b);
    enable(&mut s, &b, &c);
    let before = s.export_dxf().unwrap();
    assert!(
        s.execute(
            "bridge.gear_mesh",
            &json!({"handles":[a,c],"enabled":true}).to_string()
        )
        .is_err()
    );
    assert_eq!(s.export_dxf().unwrap(), before);
    run(
        &mut s,
        "bridge.gear_mesh",
        json!({"handles":[c,b],"enabled":false}),
    );
    assert_eq!(entity(&s, &b)["gearMates"], json!([a]));
    assert!(entity(&s, &c)["gearMate"].is_null());
    run(&mut s, "undo", json!({}));
    assert_eq!(s.export_dxf().unwrap(), before);
    run(&mut s, "erase", json!({"handles":[a]}));
    assert_eq!(entity(&s, &b)["gearMates"], json!([c]));
    assert_eq!(entity(&s, &c)["gearMates"], json!([b]));
    assert_eq!(
        scene(&s)["groups"].as_array().unwrap().len(),
        1,
        "erasing an endpoint must not leave a one-member mesh group"
    );
}

#[test]
fn train_parameter_edits_translation_and_locked_distant_partner_are_atomic() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "external", 30, [200.0, 0.0], 100.0);
    let c = create(&mut s, "external", 16, [400.0, 0.0], 40.0);
    let d = create(&mut s, "external", 24, [600.0, 0.0], 40.0);
    enable(&mut s, &a, &b);
    enable(&mut s, &b, &c);
    enable(&mut s, &c, &d);
    let original = s.export_dxf().unwrap();
    run(
        &mut s,
        "bridge.gear",
        json!({"handle":d,"kind":"external","teeth":32,"hole":true,"size":136}),
    );
    for h in [&a, &b, &c, &d] {
        close(module(&entity(&s, h)), 4.0);
    }
    run(&mut s, "undo", json!({}));
    assert!(
        s.export_dxf().unwrap() == original,
        "parameter edit must undo the whole train"
    );
    let old = [
        entity(&s, &a),
        entity(&s, &b),
        entity(&s, &c),
        entity(&s, &d),
    ];
    run(&mut s, "move", json!({"handles":[d],"delta":[10,20]}));
    for (i, h) in [&a, &b, &c, &d].iter().enumerate() {
        close(pos(&entity(&s, h))[0] - pos(&old[i])[0], 10.0);
        close(pos(&entity(&s, h))[1] - pos(&old[i])[1], 20.0);
    }
    run(&mut s, "undo", json!({}));
    let mut doc = cadcraft_io::read(&s.export_dxf().unwrap(), "train.dxf").unwrap();
    let mut layer = doc.layers[0].clone();
    layer.name = "locked-far-gear".into();
    layer.locked = true;
    doc.layers.push(layer);
    let h = cadcraft_engine::doc::Handle::parse_hex(d.as_str().unwrap()).unwrap();
    let mut e = doc.model.get(h).unwrap().as_ref().clone();
    e.common.layer = "locked-far-gear".into();
    doc.model.replace(e);
    s.load_dxf(&cadcraft_io::write(&doc, "train.dxf").unwrap())
        .unwrap();
    let before = s.export_dxf().unwrap();
    assert!(
        s.execute(
            "rotate",
            &json!({"handles":[a],"base":pos(&entity(&s,&a)),"angle":30}).to_string()
        )
        .is_err()
    );
    assert!(
        s.export_dxf().unwrap() == before,
        "a locked distant gear must roll back every intermediate change"
    );
}

#[test]
fn a_train_including_a_rack_survives_dwg_roundtrip_and_propagates_both_directions() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 50.0], 88.0);
    let b = create(&mut s, "external", 30, [200.0, 50.0], 100.0);
    let c = create(&mut s, "rack", 12, [400.0, 0.0], 40.0);
    enable(&mut s, &a, &b);
    enable(&mut s, &b, &c);
    run(&mut s, "bridge.prepare_export", json!({}));
    let doc = cadcraft_io::read(&s.export_dxf().unwrap(), "train.dxf").unwrap();
    let dwg = cadcraft_io::write(&doc, "train.dwg").unwrap();
    let restored = cadcraft_io::read(&dwg, "train.dwg").unwrap();
    s.load_dxf(&cadcraft_io::write(&restored, "train.dxf").unwrap())
        .unwrap();
    assert_eq!(entity(&s, &b)["gearMates"], json!([a, c]));
    let start = entity(&s, &c);
    let center = pos(&entity(&s, &a));
    run(
        &mut s,
        "rotate",
        json!({"handles":[a],"base":center,"angle":90}),
    );
    close(
        pos(&entity(&s, &c))[0] - pos(&start)[0],
        -module(&start) * 10.0 * PI / 2.0,
    );
    let angle = entity(&s, &a)["rotation"].as_f64().unwrap();
    run(
        &mut s,
        "move",
        json!({"handles":[c],"delta":[module(&start)*10.0*PI/4.0,0]}),
    );
    close(entity(&s, &a)["rotation"].as_f64().unwrap() - angle, -45.0);
}

#[test]
fn full_turns_survive_normalized_roots_and_directly_selected_intermediate_gears() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "external", 30, [200.0, 0.0], 132.0);
    let c = create(&mut s, "external", 16, [400.0, 0.0], 72.0);
    let rack = create(&mut s, "rack", 12, [600.0, 0.0], 100.0);
    enable(&mut s, &a, &b);
    enable(&mut s, &b, &c);
    enable(&mut s, &c, &rack);
    let saved = s.export_dxf().unwrap();
    let old = entity(&s, &rack);
    for handle in [
        a.clone(),
        json!(u64::from_str_radix(a.as_str().unwrap(), 16).unwrap()),
    ] {
        s.load_dxf(&saved).unwrap();
        run(
            &mut s,
            "rotate",
            json!({"handles":[handle],"base":[0,0],"angle":360}),
        );
        close(
            pos(&entity(&s, &rack))[0] - pos(&old)[0],
            module(&old) * 20.0 * PI,
        );
    }
    let mut outcomes = Vec::new();
    for degrees in [90.0, 450.0] {
        s.load_dxf(&saved).unwrap();
        run(
            &mut s,
            "rotate",
            json!({"handles":[a,b],"base":[0,0],"angle":degrees}),
        );
        outcomes.push(entity(&s, &rack));
    }
    close(
        pos(&outcomes[1])[0] - pos(&outcomes[0])[0],
        -module(&old) * 30.0 * PI,
    );
}

#[test]
fn ungroup_only_removes_user_groups_and_keeps_mesh_editable_and_undoable() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "external", 30, [200.0, 0.0], 100.0);
    enable(&mut s, &a, &b);
    let before = s.export_dxf().unwrap();
    let noop = run(
        &mut s,
        "bridge.edit",
        json!({"command":"ungroup","params":{"handles":[a,b]}}),
    );
    assert_eq!(noop["result"]["changed"], false);
    assert_eq!(s.export_dxf().unwrap(), before);
    run(&mut s, "group", json!({"handles":[a,b],"name":"user-pair"}));
    let grouped = s.export_dxf().unwrap();
    let result = run(
        &mut s,
        "bridge.edit",
        json!({"command":"ungroup","params":{"handles":[a,b]}}),
    );
    assert_eq!(result["result"]["ungrouped"], json!(["user-pair"]));
    assert_eq!(entity(&s, &a)["gearMate"], b);
    run(&mut s, "undo", json!({}));
    assert_eq!(s.export_dxf().unwrap(), grouped);
    run(&mut s, "redo", json!({}));
    let angle = entity(&s, &b)["rotation"].as_f64().unwrap();
    run(
        &mut s,
        "rotate",
        json!({"handles":[a],"base":[0,0],"angle":30}),
    );
    close(entity(&s, &b)["rotation"].as_f64().unwrap() - angle, -20.0);
    let name = scene(&s)["groups"][0]["name"].as_str().unwrap().to_owned();
    let before = s.export_dxf().unwrap();
    assert!(
        s.execute("ungroup", &json!({"name":name}).to_string())
            .is_err()
    );
    assert!(
        s.execute(
            "ungroup",
            &json!({"name":[format!(" {} ",name.to_lowercase())]}).to_string()
        )
        .is_err()
    );
    assert_eq!(s.export_dxf().unwrap(), before);
}

#[test]
fn explicit_grip_rotation_preserves_turns_in_preview_commit_history_and_saved_reload() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 50.0], 88.0);
    let b = create(&mut s, "rack", 12, [200.0, 0.0], 100.0);
    enable(&mut s, &a, &b);
    let old = entity(&s, &b);
    let radius = module(&old) * 10.0;
    let before = s.export_dxf().unwrap();
    for degrees in [179.0_f64, 181.0, 360.0, 540.0, 720.0, -181.0, -540.0] {
        let current = s.export_dxf().unwrap();
        let angle = degrees.to_radians();
        let params = json!({"handle":a,"index":3,"to":[-61.6*angle.sin(),50.0+61.6*angle.cos()],"angle":degrees});
        let preview = run(
            &mut s,
            "bridge.preview_draw",
            json!({"command":"grip.move","params":params}),
        );
        let peer = preview["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["handle"] == b)
            .unwrap();
        close(pos(peer)[0] - pos(&old)[0], radius * angle);
        assert!(
            s.export_dxf().unwrap() == current,
            "preview must not mutate the document"
        );
        run(&mut s, "grip.move", params);
        close(pos(&entity(&s, &b))[0] - pos(&old)[0], radius * angle);
        let saved = s.export_dxf().unwrap();
        run(&mut s, "undo", json!({}));
        assert!(
            s.export_dxf().unwrap() == current,
            "one undo must restore the pair"
        );
        run(&mut s, "redo", json!({}));
        assert!(
            s.export_dxf().unwrap() == saved,
            "one redo must restore the turn"
        );
        s.load_dxf(&saved).unwrap();
        close(pos(&entity(&s, &b))[0] - pos(&old)[0], radius * angle);
        assert_eq!(entity(&s, &a)["gearMate"], b);
        s.load_dxf(&before).unwrap();
    }
}

#[test]
fn meshing_matches_pitch_positions_and_keeps_the_first_selected_gear() {
    for (ka, kb, na, nb) in [
        ("external", "external", 20, 30),
        ("internal", "external", 40, 16),
        ("external", "internal", 16, 40),
        ("external", "rack", 20, 12),
        ("rack", "external", 12, 20),
    ] {
        let mut s = CadcraftSession::new();
        let a = create(&mut s, ka, na, [10.0, 20.0], 84.0);
        let b = create(&mut s, kb, nb, [300.0, 50.0], 70.0);
        let old = entity(&s, &a);
        enable(&mut s, &a, &b);
        let ea = entity(&s, &a);
        let eb = entity(&s, &b);
        assert_eq!(ea["geometry"], old["geometry"]);
        assert_eq!(ea["gearMate"], b);
        assert_eq!(eb["gearMate"], a);
        close(module(&ea), module(&eb));
        if ka != "rack" && kb != "rack" {
            let pa = pos(&ea);
            let pb = pos(&eb);
            let m = module(&ea);
            let z = if ka == kb {
                (na + nb) as f64
            } else {
                na.abs_diff(nb) as f64
            };
            close((pa[0] - pb[0]).hypot(pa[1] - pb[1]), m * z / 2.0);
        }
    }
}

#[test]
fn rotation_couples_both_ways_with_one_undo_and_persists_through_dxf() {
    for (kind, n, sign) in [("external", 30, -1.0), ("internal", 40, 1.0)] {
        let mut s = CadcraftSession::new();
        let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
        let b = create(&mut s, kind, n, [200.0, 0.0], 100.0);
        enable(&mut s, &a, &b);
        let before = s.export_dxf().unwrap();
        let ba = entity(&s, &a);
        let bb = entity(&s, &b);
        let p = pos(&ba);
        run(&mut s, "rotate", json!({"handles":[a],"base":p,"angle":45}));
        close(
            entity(&s, &b)["rotation"].as_f64().unwrap() - bb["rotation"].as_f64().unwrap(),
            sign * 45.0 * 20.0 / n as f64,
        );
        assert_eq!(pos(&entity(&s, &b)), pos(&bb));
        run(&mut s, "undo", json!({}));
        assert_eq!(s.export_dxf().unwrap(), before);
        run(&mut s, "redo", json!({}));
        let bytes = s.export_dxf().unwrap();
        s.load_dxf(&bytes).unwrap();
        assert_eq!(entity(&s, &a)["gearMate"], b);
        let olda = entity(&s, &a)["rotation"].as_f64().unwrap();
        let pb = pos(&entity(&s, &b));
        run(
            &mut s,
            "rotate",
            json!({"handles":[b],"base":pb,"angle":30}),
        );
        close(
            entity(&s, &a)["rotation"].as_f64().unwrap() - olda,
            sign * 30.0 * n as f64 / 20.0,
        );
        run(
            &mut s,
            "bridge.gear_mesh",
            json!({"handles":[a,b],"enabled":false}),
        );
        let oldb = entity(&s, &b);
        run(&mut s, "rotate", json!({"handles":[a],"base":p,"angle":45}));
        assert_eq!(entity(&s, &b)["geometry"], oldb["geometry"]);
    }
}

#[test]
fn gear_and_rack_convert_rotation_and_translation_without_orbiting_the_gear() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 50.0], 88.0);
    let b = create(&mut s, "rack", 12, [200.0, 0.0], 100.0);
    enable(&mut s, &a, &b);
    let old = entity(&s, &b);
    let center = pos(&entity(&s, &a));
    let radius = module(&old) * 10.0;
    run(
        &mut s,
        "rotate",
        json!({"handles":[a],"base":center,"angle":90}),
    );
    let moved = entity(&s, &b);
    close(pos(&moved)[0] - pos(&old)[0], radius * PI / 2.0);
    close(pos(&moved)[1], pos(&old)[1]);
    assert_eq!(pos(&entity(&s, &a)), center);
    let angle = entity(&s, &a)["rotation"].as_f64().unwrap();
    run(
        &mut s,
        "move",
        json!({"handles":[b],"delta":[radius*PI/4.0,0]}),
    );
    close(entity(&s, &a)["rotation"].as_f64().unwrap() - angle, 45.0);
    assert_eq!(pos(&entity(&s, &a)), center);
}

#[test]
fn meshed_grip_preview_is_read_only_compact_and_contains_the_partner() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "external", 30, [200.0, 0.0], 100.0);
    enable(&mut s, &a, &b);
    run(&mut s, "line", json!({"points":[[1000,1000],[1100,1100]]}));
    let before = s.export_dxf().unwrap();
    let origin = entity(&s, &a)["grips"][3].clone();
    let initial = run(
        &mut s,
        "bridge.preview_draw",
        json!({"command":"grip.move","params":{"handle":a,"index":3,"to":origin}}),
    );
    assert_eq!(
        initial["entities"].as_array().unwrap().len(),
        2,
        "unchanged first frame must not erase the selected pair"
    );
    let p = run(
        &mut s,
        "bridge.preview_draw",
        json!({"command":"grip.move","params":{"handle":a,"index":3,"to":[-61.6,0]}}),
    );
    assert_eq!(p["entities"].as_array().unwrap().len(), 2);
    assert_eq!(s.export_dxf().unwrap(), before);
    let changed = run(
        &mut s,
        "bridge.edit",
        json!({"command":"grip.move","params":{"handle":a,"index":3,"to":[-61.6,0]}}),
    );
    assert_eq!(changed["scene"]["entities"].as_array().unwrap().len(), 2);
    assert_eq!(entity(&s, &a)["gearMate"], b);
}

#[test]
fn invalid_locked_and_conflicting_mesh_requests_are_atomic() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "internal", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "internal", 30, [200.0, 0.0], 100.0);
    let before = s.export_dxf().unwrap();
    assert!(
        s.execute(
            "bridge.gear_mesh",
            &json!({"handles":[a,b],"enabled":true}).to_string()
        )
        .is_err()
    );
    assert_eq!(s.export_dxf().unwrap(), before);
    let c = create(&mut s, "external", 12, [400.0, 0.0], 60.0);
    enable(&mut s, &a, &c);
    let d = create(&mut s, "external", 16, [600.0, 0.0], 60.0);
    enable(&mut s, &b, &d);
    let before = s.export_dxf().unwrap();
    assert!(
        s.execute(
            "bridge.gear_mesh",
            &json!({"handles":[b,c],"enabled":true}).to_string()
        )
        .is_err()
    );
    assert_eq!(s.export_dxf().unwrap(), before);
}

#[test]
fn size_teeth_and_mirror_edits_keep_pitch_and_tooth_phase_and_leave_one_undo() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "external", 30, [200.0, 0.0], 100.0);
    enable(&mut s, &a, &b);
    let before = s.export_dxf().unwrap();
    run(
        &mut s,
        "bridge.gear",
        json!({"handle":a,"kind":"external","teeth":24,"hole":true,"size":104}),
    );
    close(module(&entity(&s, &a)), module(&entity(&s, &b)));
    run(&mut s, "undo", json!({}));
    assert_eq!(s.export_dxf().unwrap(), before);
    run(
        &mut s,
        "mirror",
        json!({"handles":[a],"p1":[0,-100],"p2":[0,100],"erase":true}),
    );
    let ea = entity(&s, &a);
    let eb = entity(&s, &b);
    let pa = pos(&ea);
    let pb = pos(&eb);
    let phi = (pb[1] - pa[1]).atan2(pb[0] - pa[0]);
    let ra = ea["rotation"].as_f64().unwrap().to_radians();
    let rb = eb["rotation"].as_f64().unwrap().to_radians();
    // Even-tooth wheel is invariant under the reflected local-X half-turn.
    let phase = ((phi - ra) * 20.0 + (phi + PI - rb) * 30.0) / std::f64::consts::TAU;
    close(phase.rem_euclid(1.0), 0.5);
}

#[test]
fn a_locked_partner_rejects_the_whole_rotation_without_consuming_undo() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "external", 30, [200.0, 0.0], 100.0);
    enable(&mut s, &a, &b);
    let mut doc = cadcraft_io::read(&s.export_dxf().unwrap(), "mesh.dxf").unwrap();
    let mut layer = doc.layers[0].clone();
    layer.name = "locked-partner".into();
    layer.locked = true;
    doc.layers.push(layer);
    let h = cadcraft_engine::doc::Handle::parse_hex(b.as_str().unwrap()).unwrap();
    let mut e = doc.model.get(h).unwrap().as_ref().clone();
    e.common.layer = "locked-partner".into();
    doc.model.replace(e);
    s.load_dxf(&cadcraft_io::write(&doc, "mesh.dxf").unwrap())
        .unwrap();
    let before = s.export_dxf().unwrap();
    assert!(
        s.execute(
            "rotate",
            &json!({"handles":[a],"base":[0,0],"angle":45}).to_string()
        )
        .is_err()
    );
    assert_eq!(s.export_dxf().unwrap(), before);
}

#[test]
fn copy_and_explode_do_not_leave_links_to_unrelated_or_missing_entities() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "external", 30, [200.0, 0.0], 100.0);
    enable(&mut s, &a, &b);
    let copied = run(&mut s, "copy", json!({"handles":[a],"delta":[0,200]}))["handles"][0].clone();
    assert!(entity(&s, &copied)["gearMate"].is_null());
    let before = s.export_dxf().unwrap();
    run(&mut s, "explode", json!({"handles":[a]}));
    assert!(entity(&s, &b)["gearMate"].is_null());
    run(&mut s, "undo", json!({}));
    assert_eq!(s.export_dxf().unwrap(), before);
    assert_eq!(entity(&s, &b)["gearMate"], a);
}

#[test]
fn meshes_survive_native_dwg_roundtrip_and_normalization() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "internal", 40, [200.0, 0.0], 100.0);
    enable(&mut s, &a, &b);
    run(&mut s, "bridge.prepare_export", json!({}));
    let doc = cadcraft_io::read(&s.export_dxf().unwrap(), "mesh.dxf").unwrap();
    let dwg = cadcraft_io::write(&doc, "mesh.dwg").unwrap();
    let restored = cadcraft_io::read(&dwg, "mesh.dwg").unwrap();
    s.load_dxf(&cadcraft_io::write(&restored, "mesh.dxf").unwrap())
        .unwrap();
    assert_eq!(entity(&s, &a)["gearMate"], b);
    let old = entity(&s, &b)["rotation"].as_f64().unwrap();
    run(
        &mut s,
        "rotate",
        json!({"handles":[a],"base":[0,0],"angle":20}),
    );
    close(entity(&s, &b)["rotation"].as_f64().unwrap() - old, 10.0);
}

#[test]
fn an_externally_deformed_mesh_can_still_be_disconnected_without_changing_geometry() {
    let mut s = CadcraftSession::new();
    let a = create(&mut s, "external", 20, [0.0, 0.0], 88.0);
    let b = create(&mut s, "external", 30, [200.0, 0.0], 100.0);
    enable(&mut s, &a, &b);
    let mut doc = cadcraft_io::read(&s.export_dxf().unwrap(), "mesh.dxf").unwrap();
    let h = cadcraft_engine::doc::Handle::parse_hex(b.as_str().unwrap()).unwrap();
    let mut e = doc.model.get(h).unwrap().as_ref().clone();
    let cadcraft_engine::doc::EntityKind::Insert(ins) = &mut e.kind else {
        unreachable!()
    };
    ins.scale.y *= 2.0;
    doc.model.replace(e);
    s.load_dxf(&cadcraft_io::write(&doc, "mesh.dxf").unwrap())
        .unwrap();
    let before = entity(&s, &b)["geometry"].clone();
    run(
        &mut s,
        "bridge.gear_mesh",
        json!({"handles":[a,b],"enabled":false}),
    );
    assert_eq!(entity(&s, &b)["geometry"], before);
    assert!(entity(&s, &b)["gearMate"].is_null());
}
