use cadcraft_engine::{
    doc::{Block, Common, Drawing, Entity, EntityKind, Insert, Line, Space},
    geom::Vec3,
};
use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};
use std::sync::Arc;

fn run(session: &mut CadcraftSession, command: &str, params: Value) -> Value {
    serde_json::from_str(&session.execute(command, &params.to_string()).unwrap()).unwrap()
}

fn scene(session: &CadcraftSession) -> Value {
    serde_json::from_str(&session.scene().unwrap()).unwrap()
}

fn paste(session: &mut CadcraftSession, bytes: &[u8], params: Value) -> Value {
    serde_json::from_str(&session.paste_dxf(bytes, &params.to_string()).unwrap()).unwrap()
}

fn line(y: f64) -> EntityKind {
    EntityKind::Line(Line {
        a: Vec3::new(0.0, y, 0.0),
        b: Vec3::new(10.0, y, 0.0),
    })
}

fn insert(name: &str) -> EntityKind {
    EntityKind::Insert(Insert {
        block: name.into(),
        insert: Vec3::ZERO,
        scale: Vec3::new(1.0, 1.0, 1.0),
        rotation: 0.0,
        attribs: vec![],
        rows: 1,
        cols: 1,
        row_spacing: 0.0,
        col_spacing: 0.0,
    })
}

#[test]
fn paste_retains_current_geometry_and_maps_handles_in_requested_order() {
    let mut source = CadcraftSession::new();
    let line = run(&mut source, "line", json!({"points":[[0,0],[10,0]]}))["handles"][0].clone();
    let circle = run(&mut source, "circle", json!({"center":[20,20],"radius":3}))["handle"].clone();
    let bytes = source.export_dxf().unwrap();
    let mut current = CadcraftSession::new();
    let retained = run(
        &mut current,
        "circle",
        json!({"center":[100,100],"radius":7}),
    )["handle"]
        .clone();
    let result = paste(
        &mut current,
        &bytes,
        json!({"handles":[circle,line],"delta":[30,40]}),
    );
    let handles = result["handles"].as_array().unwrap();
    assert_eq!(handles.len(), 2);
    assert_ne!(handles[0], retained);
    assert_ne!(handles[1], retained);
    let state = scene(&current);
    assert_eq!(state["entityCount"], 3);
    assert_eq!(state["entities"][0]["radius"], 7.0);
    assert_eq!(state["entities"][1]["handle"], handles[0]);
    assert_eq!(state["entities"][1]["type"], "Circle");
    assert_eq!(
        state["entities"][1]["geometry"]["center"],
        json!({"x":50.0,"y":60.0,"z":0.0})
    );
    assert_eq!(state["entities"][2]["handle"], handles[1]);
    assert_eq!(state["entities"][2]["type"], "Line");
    run(&mut current, "undo", json!({}));
    assert_eq!(scene(&current)["entityCount"], 1);
    run(&mut current, "redo", json!({}));
    assert_eq!(scene(&current)["entityCount"], 3);
}

#[test]
fn snapshot_paste_survives_erased_sources_and_worker_checkpoint_reload() {
    let mut current = CadcraftSession::new();
    let handle = run(&mut current, "circle", json!({"center":[2,3],"radius":8}))["handle"].clone();
    let snapshot = current.export_dxf().unwrap();
    run(&mut current, "erase", json!({"handles":[handle.clone()]}));
    current.load_dxf(&current.export_dxf().unwrap()).unwrap();
    assert_eq!(scene(&current)["entityCount"], 0);
    let result = paste(
        &mut current,
        &snapshot,
        json!({"handles":[handle],"from":[2,3],"to":[12,23]}),
    );
    assert_eq!(result["handles"].as_array().unwrap().len(), 1);
    let state = scene(&current);
    assert_eq!(state["entities"][0]["radius"], 8.0);
    assert_eq!(
        state["entities"][0]["geometry"]["center"],
        json!({"x":12.0,"y":23.0,"z":0.0})
    );
}

#[test]
fn paste_imports_nested_native_block_definitions_without_flattening_them() {
    let mut source = Drawing::new_metric();
    let mut child = Block::new("Clipboard Child");
    child.entities.push(Entity {
        handle: source.new_handle(),
        common: Common::default(),
        kind: line(0.0),
    });
    source.blocks.insert(child.name.clone(), Arc::new(child));
    let mut parent = Block::new("Clipboard Parent");
    parent.entities.push(Entity {
        handle: source.new_handle(),
        common: Common::default(),
        kind: insert("Clipboard Child"),
    });
    source.blocks.insert(parent.name.clone(), Arc::new(parent));
    let handle = source
        .add(&Space::Model, Common::default(), insert("Clipboard Parent"))
        .unwrap();
    let mut current = CadcraftSession::new();
    let bytes = cadcraft_io::write(&source, "clipboard.dxf").unwrap();
    paste(
        &mut current,
        &bytes,
        json!({"handles":[handle.hex()],"delta":[5,10]}),
    );
    let restored = cadcraft_io::read(&current.export_dxf().unwrap(), "restored.dxf").unwrap();
    assert!(restored.block("Clipboard Parent").is_some());
    assert!(restored.block("Clipboard Child").is_some());
    assert!(matches!(
        restored.model.iter().next().unwrap().kind,
        EntityKind::Insert(_)
    ));
    assert_eq!(
        scene(&current)["primitives"][0]["points"],
        json!([[5.0, 10.0], [15.0, 10.0]])
    );
}

#[test]
fn paste_rejects_missing_duplicate_or_invalid_handles_and_keeps_current_checkpoint() {
    let mut source = CadcraftSession::new();
    let handle = run(&mut source, "circle", json!({"center":[0,0],"radius":2}))["handle"].clone();
    let bytes = source.export_dxf().unwrap();
    let mut current = CadcraftSession::new();
    run(&mut current, "line", json!({"points":[[0,0],[10,0]]}));
    let before = current.export_dxf().unwrap();
    let state = current.scene().unwrap();
    for params in [
        json!({"handles":[],"delta":[0,0]}),
        json!({"handles":[handle.clone(),"FFFF"],"delta":[0,0]}),
        json!({"handles":[handle.clone(),handle.clone()],"delta":[0,0]}),
        json!({"handles":["not-hex"],"delta":[0,0]}),
        json!({"handles":[handle.clone()],"delta":["NaN",0]}),
        json!({"handles":[handle.clone()],"delta":[0,0],"from":[0,0],"to":[1,1]}),
    ] {
        assert!(current.paste_dxf(&bytes, &params.to_string()).is_err());
        assert_eq!(current.export_dxf().unwrap(), before);
        assert_eq!(current.scene().unwrap(), state);
    }
    assert!(
        current
            .paste_dxf(
                b"broken",
                &json!({"handles":[handle],"delta":[0,0]}).to_string()
            )
            .is_err()
    );
    assert_eq!(current.export_dxf().unwrap(), before);
}

#[test]
fn paste_rolls_back_native_overflow_without_adding_partial_geometry_or_undo() {
    let mut source = Drawing::new_metric();
    let handle = source
        .add(
            &Space::Model,
            Common::default(),
            EntityKind::Line(Line {
                a: Vec3::new(1e308, 0.0, 0.0),
                b: Vec3::new(1e308, 10.0, 0.0),
            }),
        )
        .unwrap();
    let bytes = cadcraft_io::write(&source, "clipboard.dxf").unwrap();
    let mut current = CadcraftSession::new();
    run(&mut current, "circle", json!({"center":[0,0],"radius":2}));
    let before = current.export_dxf().unwrap();
    let state = current.scene().unwrap();
    assert!(
        current
            .paste_dxf(
                &bytes,
                &json!({"handles":[handle.hex()],"delta":[1e308,0]}).to_string()
            )
            .is_err()
    );
    assert_eq!(current.export_dxf().unwrap(), before);
    assert_eq!(current.scene().unwrap(), state);
    run(&mut current, "undo", json!({}));
    assert_eq!(scene(&current)["entityCount"], 0);
}

#[test]
fn paste_isolates_a_changed_named_block_and_repeated_paste_reuses_its_definition() {
    let mut source = Drawing::new_metric();
    let mut block = Block::new("Source Block");
    block.entities.push(Entity {
        handle: source.new_handle(),
        common: Common::default(),
        kind: line(0.0),
    });
    source.blocks.insert(block.name.clone(), Arc::new(block));
    let handle = source
        .add(&Space::Model, Common::default(), insert("Source Block"))
        .unwrap();
    let bytes = cadcraft_io::write(&source, "clipboard.dxf").unwrap();
    let mut changed = source.clone();
    // Use the actual first block member handle rather than assuming a seed value.
    let member = changed
        .block("Source Block")
        .unwrap()
        .entities
        .iter()
        .next()
        .unwrap()
        .handle;
    Arc::make_mut(changed.blocks.get_mut("Source Block").unwrap())
        .entities
        .modify(member, |entity| entity.kind = line(100.0));
    let mut current = CadcraftSession::new();
    current
        .load_dxf(&cadcraft_io::write(&changed, "current.dxf").unwrap())
        .unwrap();
    for i in 0..3 {
        paste(
            &mut current,
            &bytes,
            json!({"handles":[handle.hex()],"delta":[10,0]}),
        );
        let doc = cadcraft_io::read(&current.export_dxf().unwrap(), "copied.dxf").unwrap();
        assert_eq!(
            doc.blocks
                .values()
                .filter(|b| !b.name.starts_with('*'))
                .count(),
            2,
            "copies must reuse the frozen definition, pass {i}"
        );
        let sc = scene(&current);
        assert!(
            sc["primitives"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["points"] == json!([[10.0, 0.0], [20.0, 0.0]]))
        );
        assert!(
            sc["primitives"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["points"] == json!([[0.0, 100.0], [10.0, 100.0]]))
        );
    }
}

#[test]
fn complete_copied_mesh_links_new_gears_but_never_links_back_to_the_source_or_partial_selection() {
    let mut source = CadcraftSession::new();
    let a = run(
        &mut source,
        "bridge.gear",
        json!({"kind":"external","teeth":20,"hole":true,"at":[0,0],"size":88,"rotation":0}),
    )["handle"]
        .clone();
    let b = run(
        &mut source,
        "bridge.gear",
        json!({"kind":"external","teeth":30,"hole":true,"at":[200,0],"size":100,"rotation":0}),
    )["handle"]
        .clone();
    run(
        &mut source,
        "bridge.gear_mesh",
        json!({"handles":[a,b],"enabled":true}),
    );
    let bytes = source.export_dxf().unwrap();
    let mut target = CadcraftSession::new();
    let copied = paste(
        &mut target,
        &bytes,
        json!({"handles":[a,b],"delta":[0,200]}),
    )["handles"]
        .clone();
    let sc = scene(&target);
    assert_eq!(sc["entities"][0]["gearMate"], copied[1]);
    assert_eq!(sc["entities"][1]["gearMate"], copied[0]);
    let old = sc["entities"][1]["rotation"].as_f64().unwrap();
    run(
        &mut target,
        "rotate",
        json!({"handles":[copied[0]],"base":[0,200],"angle":30}),
    );
    assert!(
        (scene(&target)["entities"][1]["rotation"].as_f64().unwrap() - old + 20.0).abs() < 1e-7
    );
    let partial =
        paste(&mut target, &bytes, json!({"handles":[a],"delta":[0,400]}))["handles"][0].clone();
    assert!(
        scene(&target)["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["handle"] == partial)
            .unwrap()["gearMate"]
            .is_null()
    );
}

#[test]
fn a_copied_associative_hatch_uses_only_new_boundary_handles() {
    let mut source = CadcraftSession::new();
    let boundary = run(&mut source, "rectang", json!({"p1":[0,0],"p2":[20,20]}))["handle"].clone();
    let fill = run(
        &mut source,
        "hatch",
        json!({"handles":[boundary],"pattern":"ANSI31","scale":1,"angle":0}),
    )["handle"]
        .clone();
    assert!(!fill.is_null());
    let mut target = CadcraftSession::new();
    let result = paste(
        &mut target,
        &source.export_dxf().unwrap(),
        json!({"handles":[boundary,fill],"delta":[50,0]}),
    );
    let doc = cadcraft_io::read(&target.export_dxf().unwrap(), "pasted.dxf").unwrap();
    let h =
        cadcraft_engine::doc::Handle::parse_hex(result["handles"][1].as_str().unwrap()).unwrap();
    let EntityKind::Hatch(hatch) = &doc.model.get(h).unwrap().kind else {
        panic!("expected hatch")
    };
    assert!(hatch.associative);
    assert_eq!(hatch.loops[0].sources[0].hex(), result["handles"][0]);
    let partial = paste(
        &mut target,
        &source.export_dxf().unwrap(),
        json!({"handles":[fill],"delta":[100,0]}),
    );
    let sc = scene(&target);
    let e = sc["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["handle"] == partial["handles"][0])
        .unwrap();
    assert_eq!(e["geometry"]["associative"], false);
}

#[test]
fn paste_keeps_source_layer_appearance_without_overwriting_target_or_accumulating_records() {
    let mut doc = Drawing::new_metric();
    doc.layers[0].color = cadcraft_engine::doc::color::Color::Index(1);
    let h = doc
        .add(&Space::Model, Common::default(), line(0.0))
        .unwrap();
    let bytes = cadcraft_io::write(&doc, "source.dxf").unwrap();
    let mut target = CadcraftSession::new();
    run(&mut target, "line", json!({"points":[[0,100],[10,100]]}));
    let mut count = None;
    for _ in 0..3 {
        paste(
            &mut target,
            &bytes,
            json!({"handles":[h.hex()],"delta":[0,0]}),
        );
        let pasted = cadcraft_io::read(&target.export_dxf().unwrap(), "target.dxf").unwrap();
        assert_eq!(
            pasted.layers[0].color,
            cadcraft_engine::doc::color::Color::Index(7)
        );
        let total = (
            pasted.layers.len(),
            pasted.linetypes.len(),
            pasted.text_styles.len(),
        );
        assert_eq!(*count.get_or_insert(total), total);
        let sc = scene(&target);
        assert!(
            sc["primitives"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["color"] == json!([255, 0, 0]))
        );
    }
}

#[test]
fn compact_paste_returns_only_new_geometry_instead_of_rebuilding_the_target_scene() {
    let mut source = CadcraftSession::new();
    let h = run(&mut source, "line", json!({"points":[[0,0],[10,0]]}))["handles"][0].clone();
    let mut target = CadcraftSession::new();
    run(
        &mut target,
        "circle",
        json!({"center":[500,500],"radius":100}),
    );
    let result = paste(
        &mut target,
        &source.export_dxf().unwrap(),
        json!({"handles":[h],"delta":[0,0],"compact":true}),
    );
    assert_eq!(result["scene"]["partial"], true);
    assert_eq!(result["scene"]["entities"].as_array().unwrap().len(), 1);
    assert_eq!(result["scene"]["primitives"].as_array().unwrap().len(), 1);
    assert_eq!(scene(&target)["entityCount"], 2);
}

#[test]
fn different_selections_from_the_same_snapshot_never_alias_isolated_definitions() {
    let mut source = Drawing::new_metric();
    let mut hs = Vec::new();
    for (name, y) in [("First", 0.0), ("Second", 20.0)] {
        let mut b = Block::new(name);
        b.entities.push(Entity {
            handle: source.new_handle(),
            common: Common::default(),
            kind: line(y),
        });
        source.blocks.insert(name.into(), Arc::new(b));
        hs.push(
            source
                .add(&Space::Model, Common::default(), insert(name))
                .unwrap()
                .hex(),
        );
    }
    let snapshot = cadcraft_io::write(&source, "source.dxf").unwrap();
    let mut changed = source.clone();
    for b in changed.blocks.values_mut() {
        let handles: Vec<_> = b.entities.iter().map(|e| e.handle).collect();
        for h in handles {
            Arc::make_mut(b)
                .entities
                .modify(h, |e| e.kind = line(100.0));
        }
    }
    let mut target = CadcraftSession::new();
    target
        .load_dxf(&cadcraft_io::write(&changed, "target.dxf").unwrap())
        .unwrap();
    for h in hs {
        paste(
            &mut target,
            &snapshot,
            json!({"handles":[h],"delta":[50,0]}),
        );
    }
    let doc = cadcraft_io::read(&target.export_dxf().unwrap(), "pasted.dxf").unwrap();
    assert_eq!(
        doc.blocks
            .values()
            .filter(|b| !b.name.starts_with('*'))
            .count(),
        4
    );
}
