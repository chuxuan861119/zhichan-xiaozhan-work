use cadcraft_engine::{
    doc::{
        Block, Common, DashElement, Drawing, Entity, EntityKind, Group, Insert, Layer, Line,
        Linetype, Lineweight, Space, Transparency, color::Color,
    },
    geom::Vec3,
    render,
};
use patent_cadcraft_bridge::CadcraftSession;
use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
    sync::Arc,
};

fn session(drawing: &Drawing) -> CadcraftSession {
    let mut session = CadcraftSession::new();
    session
        .load_dxf(&cadcraft_io::write(drawing, "test.dxf").unwrap())
        .unwrap();
    session
}

fn run(session: &mut CadcraftSession, command: &str) -> Value {
    serde_json::from_str(&session.execute(command, "{}").unwrap()).unwrap()
}

fn drawing(session: &CadcraftSession) -> Drawing {
    cadcraft_io::read(&session.export_dxf().unwrap(), "test.dxf").unwrap()
}

fn line(y: f64) -> EntityKind {
    EntityKind::Line(Line {
        a: Vec3::new(0.0, y, 0.0),
        b: Vec3::new(20.0, y, 0.0),
    })
}

fn insert(block: &str, x: f64) -> EntityKind {
    EntityKind::Insert(Insert {
        block: block.into(),
        insert: Vec3::new(x, 0.0, 0.0),
        scale: Vec3::new(1.0, 1.0, 1.0),
        rotation: 0.0,
        attribs: vec![],
        cols: 1,
        rows: 1,
        col_spacing: 0.0,
        row_spacing: 0.0,
    })
}

fn signature(d: &Drawing) -> Vec<Value> {
    let list = render::build(
        d,
        &Space::Model,
        &render::Options {
            lineweights: true,
            ..Default::default()
        },
    );
    list.prims.iter().map(|p| json!({"points":list.points(p).iter().map(|p|[p.x,p.y]).collect::<Vec<_>>(),"color":[p.color.0,p.color.1,p.color.2],"aci7":p.aci7,"lw":p.lw})).collect()
}

#[test]
fn flatten_bakes_layer_styles_and_hidden_flags_without_unlocking_other_edits() {
    let mut d = Drawing::new_metric();
    d.header.set_i64("LWDEFAULT", 35);
    let mut layer = Layer::new("Source");
    layer.color = Color::Index(1);
    layer.lineweight = Lineweight::Mm100(70);
    layer.linetype = "Dashed".into();
    layer.transparency = 45;
    layer.locked = true;
    d.layers.push(layer);
    d.linetypes.push(Linetype {
        name: "Dashed".into(),
        description: String::new(),
        pattern: vec![DashElement::dash(3.0), DashElement::dash(-2.0)],
    });
    let visible = d
        .add(
            &Space::Model,
            Common {
                layer: "Source".into(),
                ..Default::default()
            },
            line(0.0),
        )
        .unwrap();
    d.add(
        &Space::Model,
        Common {
            layer: "Source".into(),
            visible: false,
            ..Default::default()
        },
        line(10.0),
    )
    .unwrap();
    let mut hidden = Layer::new("Hidden");
    hidden.on = false;
    hidden.frozen = true;
    d.layers.push(hidden);
    d.add(
        &Space::Model,
        Common {
            layer: "Hidden".into(),
            ..Default::default()
        },
        line(20.0),
    )
    .unwrap();
    let mut s = session(&d);
    assert!(
        s.execute(
            "move",
            &json!({"handles":[visible.hex()],"delta":[1,1]}).to_string()
        )
        .is_err()
    );
    let before = signature(&drawing(&s));
    run(&mut s, "bridge.flatten_layers");
    let after = drawing(&s);
    assert_eq!(signature(&after), before);
    // The pinned reader starts with an empty Defpoints layer even when it is absent on disk.
    assert!(
        after
            .layers
            .iter()
            .all(|layer| matches!(layer.name.as_str(), "0" | "Defpoints"))
    );
    assert_eq!(
        patent_cadcraft_bridge::unified::flatten_layers(&after)
            .unwrap()
            .layers
            .len(),
        1
    );
    assert!(after.layers[0].on && !after.layers[0].frozen && !after.layers[0].locked);
    assert_eq!(after.header.str("CLAYER", ""), "0");
    let c = &after.entity(visible).unwrap().common;
    assert_eq!(c.layer, "0");
    assert_eq!(c.color, Color::Index(1));
    assert_eq!(c.linetype, "Dashed");
    assert_eq!(c.lineweight, Lineweight::Mm100(70));
    assert_eq!(c.transparency, Transparency::Percent(45));
    assert_eq!(after.model.iter().filter(|e| !e.common.visible).count(), 2);
    assert!(
        s.execute(
            "move",
            &json!({"handles":[visible.hex()],"delta":[1,1]}).to_string()
        )
        .is_ok()
    );
}

#[test]
fn flatten_clones_nested_blocks_for_different_inherited_insert_contexts() {
    let mut d = Drawing::new_metric();
    for (name, color, lw, transparency) in [("Red", 1, 70, 25), ("Green", 3, 20, 60)] {
        let mut layer = Layer::new(name);
        layer.color = Color::Index(color);
        layer.lineweight = Lineweight::Mm100(lw);
        layer.transparency = transparency;
        d.layers.push(layer);
    }
    let mut hidden = Layer::new("Hidden");
    hidden.on = false;
    d.layers.push(hidden);
    let mut child = Block::new("Child");
    for (common, y) in [
        (
            Common {
                color: Color::ByBlock,
                lineweight: Lineweight::ByBlock,
                linetype: "ByBlock".into(),
                transparency: Transparency::ByBlock,
                ..Default::default()
            },
            0.0,
        ),
        (Common::default(), 5.0),
        (
            Common {
                layer: "Hidden".into(),
                ..Default::default()
            },
            10.0,
        ),
    ] {
        child.entities.push(Entity {
            handle: d.new_handle(),
            common,
            kind: line(y),
        });
    }
    d.blocks.insert("Child".into(), Arc::new(child));
    let mut parent = Block::new("Parent");
    parent.entities.push(Entity {
        handle: d.new_handle(),
        common: Common {
            color: Color::ByBlock,
            lineweight: Lineweight::ByBlock,
            transparency: Transparency::ByBlock,
            ..Default::default()
        },
        kind: insert("Child", 0.0),
    });
    d.blocks.insert("Parent".into(), Arc::new(parent));
    for (layer, x) in [("Red", 0.0), ("Green", 40.0)] {
        d.add(
            &Space::Model,
            Common {
                layer: layer.into(),
                ..Default::default()
            },
            insert("Parent", x),
        )
        .unwrap();
    }
    let mut s = session(&d);
    let before = signature(&drawing(&s));
    run(&mut s, "bridge.flatten_layers");
    let after = drawing(&s);
    assert_eq!(signature(&after), before);
    let blocks: Vec<_> = after
        .model
        .iter()
        .map(|e| match &e.kind {
            EntityKind::Insert(i) => i.block.clone(),
            _ => panic!("must retain editable block"),
        })
        .collect();
    assert_ne!(blocks[0], blocks[1]);
    for block in after.blocks.values() {
        for e in block.entities.iter() {
            assert_eq!(e.common.layer, "0");
            // Layer inheritance is baked, but block inheritance must remain editable.
            assert!(!matches!(e.common.color, Color::ByLayer));
            assert!(!matches!(
                e.common.lineweight,
                Lineweight::ByLayer | Lineweight::Default
            ));
            assert!(matches!(e.common.transparency, Transparency::Percent(_)));
        }
    }
    let bytes = s.export_dxf().unwrap();
    run(&mut s, "bridge.flatten_layers");
    assert_eq!(
        s.export_dxf().unwrap(),
        bytes,
        "normalization must be idempotent"
    );
    s.load_dxf(&bytes).unwrap();
    let block_count = drawing(&s).blocks.len();
    // A newly generated patent label is ByLayer, so the document-wide fast path
    // cannot apply. Already baked nested definitions must still be reused.
    s.execute("line", &json!({"points":[[100,0],[100,5]]}).to_string()).unwrap();
    run(&mut s, "bridge.flatten_layers");
    assert_eq!(
        drawing(&s).blocks.len(),
        block_count,
        "reloaded normalized blocks must not be cloned repeatedly"
    );
}

#[test]
fn repeated_normalization_preserves_unused_user_blocks_even_with_generated_looking_names() {
    let mut d = Drawing::new_metric();
    for name in ["UserUnused", "PW_NORMALIZED_1", "PW_GEAR_V1_CUSTOM"] {
        let mut block = Block::new(name);
        block.description = "user source definition".into();
        block.entities.push(Entity {handle:d.new_handle(), common:Common::default(), kind:line(5.0)});
        d.blocks.insert(name.into(), Arc::new(block));
    }
    let mut s = session(&d);
    for _ in 0..5 {
        s.execute("line", &json!({"points":[[0,0],[1,1]]}).to_string()).unwrap();
        run(&mut s, "bridge.flatten_layers");
        s.load_dxf(&s.export_dxf().unwrap()).unwrap();
    }
    let after = drawing(&s);
    assert_eq!(after.blocks.len(), 3);
    for name in ["UserUnused", "PW_NORMALIZED_1", "PW_GEAR_V1_CUSTOM"] {
        let block = after.block(name).unwrap();
        assert_eq!(block.description, "user source definition");
        assert_eq!(block.entities.len(), 1);
    }
}

#[test]
fn prepare_export_uses_one_visible_layer_without_revealing_hidden_source() {
    let mut d = Drawing::new_metric();
    d.layers[0].on = false;
    d.layers[0].locked = true;
    d.add(&Space::Model, Common::default(), line(0.0)).unwrap();
    let mut s = session(&d);
    let result = run(&mut s, "bridge.prepare_export");
    assert_eq!(result["layer"], "0");
    assert!(
        drawing(&s)
            .layers
            .iter()
            .all(|layer| matches!(layer.name.as_str(), "0" | "Defpoints"))
    );
    assert!(drawing(&s).model.iter().all(|e| !e.common.visible));
    s.execute(
        "text",
        &json!({"at":[0,0],"text":"12","height":5}).to_string(),
    )
    .unwrap();
    assert!(
        !serde_json::from_str::<Value>(&s.scene().unwrap()).unwrap()["primitives"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn prepare_export_reuses_matching_text_style_but_preserves_custom_name_collisions() {
    let mut d = Drawing::new_metric();
    d.text_styles.push(cadcraft_engine::doc::TextStyle {name:"Patent Workbench Export".into(),font:"user font".into(),..Default::default()});
    let mut s = session(&d);
    let first = run(&mut s,"bridge.prepare_export");
    let count = drawing(&s).text_styles.len();
    for _ in 0..20 {
        s.load_dxf(&s.export_dxf().unwrap()).unwrap();
        assert_eq!(run(&mut s,"bridge.prepare_export")["textStyle"], first["textStyle"]);
        let doc = drawing(&s);
        assert_eq!(doc.text_styles.len(), count);
        assert_eq!(doc.text_style("Patent Workbench Export").unwrap().font,"user font");
    }
}

#[test]
fn codec_patent_preview_hides_only_proxy_groups_and_preserves_full_checkpoint() {
    let mut d = Drawing::new_metric();
    for (name, y) in [
        ("PW_LABEL_1", 0.0),
        ("PW_DETAIL_1_FRAME", 10.0),
        ("PW_DETAIL_1_SOURCE", 20.0),
        ("PW_DETAIL_1_BODY", 30.0),
        ("Ordinary", 40.0),
    ] {
        let h = d.add(&Space::Model, Common::default(), line(y)).unwrap();
        d.groups.push(Group {
            name: name.into(),
            members: vec![h],
            description: String::new(),
            selectable: true,
        });
    }
    let s = session(&d);
    let bytes = s.export_dxf().unwrap();
    let convert = |options: &[&str]| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_cadcraft-codec"))
            .arg("dxf-to-svg")
            .args(options)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&bytes).unwrap();
        child.wait_with_output().unwrap()
    };
    let out = convert(&["--patent-preview", "--frame", "0", "50", "100", "80"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let preview = String::from_utf8(out.stdout).unwrap();
    assert_eq!(preview.matches("<polyline").count(), 2);
    assert!(!preview.contains("<rect width=\"100%\""));
    assert!(preview.contains("0.000000,20.000000 20.000000,20.000000"));
    assert!(preview.contains("viewBox=\"0 0 100.000000 80.000000\""));
    let full = convert(&["--frame", "0", "50", "100", "80"]);
    assert!(full.status.success());
    assert_eq!(
        String::from_utf8(full.stdout)
            .unwrap()
            .matches("<polyline")
            .count(),
        5
    );
    assert_eq!(s.export_dxf().unwrap(), bytes);
    let restored = drawing(&s);
    assert_eq!(restored.groups.len(), 5);
    assert_eq!(restored.model.len(), 5);
    assert_eq!(
        s.export_patent_svg().unwrap().matches("<polyline").count(),
        2
    );
}

#[test]
fn scene_exposes_serialized_geometry_and_editable_text_radius_values() {
    let mut s = CadcraftSession::new();
    s.execute("circle", &json!({"center":[2,3],"radius":7}).to_string())
        .unwrap();
    s.execute(
        "text",
        &json!({"at":[4,5],"text":"12","height":2,"rotation":90}).to_string(),
    )
    .unwrap();
    let state: Value = serde_json::from_str(&s.scene().unwrap()).unwrap();
    assert_eq!(state["entities"][0]["geometry"]["type"], "circle");
    assert_eq!(state["entities"][0]["radius"], 7.0);
    assert_eq!(state["entities"][0]["lineweight"], 0.25);
    assert_eq!(state["entities"][1]["text"], "12");
    assert_eq!(state["entities"][1]["height"], 2.0);
}

#[test]
fn flatten_preserves_dimension_styles_inherited_independently_from_the_source_layer() {
    let mut d = Drawing::new_metric();
    let mut layer = Layer::new("Dimensions");
    layer.color = Color::Index(4);
    layer.lineweight = Lineweight::Mm100(70);
    layer.linetype = "Dashed".into();
    d.layers.push(layer);
    d.linetypes.push(Linetype {
        name: "Dashed".into(),
        description: String::new(),
        pattern: vec![DashElement::dash(2.0), DashElement::dash(-1.0)],
    });
    let style = d
        .dim_styles
        .iter_mut()
        .find(|s| s.name == "ISO-25")
        .unwrap();
    style.dim_line_color = Color::ByLayer;
    style.ext_line_color = Color::ByLayer;
    style.text_color = Color::ByLayer;
    style.dim_lineweight = -1;
    style.ext_lineweight = -1;
    style.dim_linetype = "ByLayer".into();
    style.ext_linetype1 = "ByLayer".into();
    style.ext_linetype2 = "ByLayer".into();
    let kind:EntityKind=serde_json::from_value(json!({"type":"dimension","kind":{"linear":{"rotation":0.0}},"defpt":{"x":0,"y":10,"z":0},"textMid":{"x":10,"y":10,"z":0},"p13":{"x":0,"y":0,"z":0},"p14":{"x":20,"y":0,"z":0},"style":"ISO-25"})).unwrap();
    d.add(
        &Space::Model,
        Common {
            layer: "Dimensions".into(),
            color: Color::Index(1),
            lineweight: Lineweight::Mm100(20),
            ..Default::default()
        },
        kind,
    )
    .unwrap();
    let mut s = session(&d);
    let before = signature(&drawing(&s));
    assert!(!before.is_empty());
    run(&mut s, "bridge.flatten_layers");
    assert_eq!(signature(&drawing(&s)), before);
    assert_eq!(
        s.export_dxf().unwrap(),
        s.export_dxf().unwrap(),
        "serialized handles must be deterministic"
    );
    let bytes = s.export_dxf().unwrap();
    let mut handles = std::collections::HashSet::new();
    let text = String::from_utf8(bytes.clone()).unwrap();
    let lines: Vec<_> = text.lines().collect();
    for pair in lines
        .chunks_exact(2)
        .filter(|pair| matches!(pair[0].trim(), "5" | "105"))
    {
        // HANDSEED is a header value, not a record identity.
        let handle = pair[1].trim();
        assert!(
            handles.insert(handle),
            "duplicate serialized handle {handle}"
        );
    }
    s.load_dxf(&bytes).unwrap();
    run(&mut s, "bridge.flatten_layers");
    assert_eq!(signature(&drawing(&s)), before);
    let dxf = s.export_dxf().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_cadcraft-codec"))
        .arg("dxf-to-dwg")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&dxf).unwrap();
    let dwg = child.wait_with_output().unwrap();
    assert!(
        dwg.status.success(),
        "{}",
        String::from_utf8_lossy(&dwg.stderr)
    );
    let restored = cadcraft_io::read(&dwg.stdout, "test.dwg").unwrap();
    assert_eq!(
        signature(&restored),
        before,
        "DWG must preserve the same baked dimensional appearance"
    );
}

#[test]
fn patent_svg_removes_background_but_keeps_detail_body_wipeout_masks() {
    let mut s = CadcraftSession::new();
    s.execute("bridge.add_primitives",&json!({"primitives":[{"kind":"mask","points":[[0,0],[20,0],[20,20],[0,20]],"color":[255,255,255],"lineweight":0.0}]}).to_string()).unwrap();
    let svg = s.export_patent_svg().unwrap();
    assert!(!svg.contains("<rect width=\"100%\""));
    assert!(svg.contains("<path fill=\"#ffffff\""));
    assert!(s.export_svg().unwrap().contains("<rect width=\"100%\""));
}

#[test]
fn flatten_keeps_paper_space_and_session_hidden_entities_hidden_after_saving() {
    let mut d = Drawing::new_metric();
    let hidden = d.add(&Space::Model, Common::default(), line(0.0)).unwrap();
    d.hidden_objects.insert(hidden);
    let paper = d.layouts[0].name.clone();
    d.layers[0].frozen = true;
    d.add(&Space::Paper(paper), Common::default(), line(10.0))
        .unwrap();
    let normalized = patent_cadcraft_bridge::unified::flatten_layers(&d).unwrap();
    assert!(normalized.hidden_objects.is_empty());
    assert!(normalized.model.iter().all(|e| !e.common.visible));
    assert!(
        normalized.layouts[0]
            .entities
            .iter()
            .all(|e| !e.common.visible)
    );
    let restored = cadcraft_io::read(
        &cadcraft_io::write(&normalized, "test.dxf").unwrap(),
        "test.dxf",
    )
    .unwrap();
    assert!(restored.model.iter().all(|e| !e.common.visible));
    assert!(
        restored.layouts[0]
            .entities
            .iter()
            .all(|e| !e.common.visible)
    );
}

#[test]
fn flatten_rejects_excessive_block_nesting_atomically_instead_of_overflowing() {
    let mut d = Drawing::new_metric();
    for index in 0..40 {
        let name = format!("Nested{index}");
        let mut block = Block::new(&name);
        let kind = if index < 39 {
            insert(&format!("Nested{}", index + 1), 0.0)
        } else {
            line(0.0)
        };
        block.entities.push(Entity {
            handle: d.new_handle(),
            common: Common::default(),
            kind,
        });
        d.blocks.insert(name, Arc::new(block));
    }
    d.add(&Space::Model, Common::default(), insert("Nested0", 0.0))
        .unwrap();
    let mut s = session(&d);
    let original = s.export_dxf().unwrap();
    assert!(s.execute("bridge.flatten_layers", "{}").is_err());
    assert_eq!(s.export_dxf().unwrap(), original);
}

#[test]
fn flatten_preserves_attribute_layer_override_visibility_in_the_insert_context() {
    use cadcraft_engine::doc::{Attrib, AttribProps};
    let mut d = Drawing::new_metric();
    let mut hidden = Layer::new("Hidden");
    hidden.on = false;
    d.layers.push(hidden);
    d.header.set_i64("ATTMODE", 2);
    let attribute: Attrib = serde_json::from_value(
        json!({"tag":"NUMBER","text":{"insert":{"x":0,"y":0,"z":0},"height":5,"value":"12"}}),
    )
    .unwrap();
    let mut block = Block::new("Attribute");
    block.entities.push(Entity {
        handle: d.new_handle(),
        common: Common {
            layer: "Hidden".into(),
            ..Default::default()
        },
        kind: EntityKind::AttDef(attribute.clone()),
    });
    d.blocks.insert(block.name.clone(), Arc::new(block));
    let EntityKind::Insert(mut visible) = insert("Attribute", 0.0) else {
        panic!("fixture insert")
    };
    let mut shown = attribute.clone();
    shown.props = AttribProps {
        layer: Some("0".into()),
        ..Default::default()
    };
    visible.attribs.push(shown);
    d.add(
        &Space::Model,
        Common::default(),
        EntityKind::Insert(visible),
    )
    .unwrap();
    let EntityKind::Insert(mut invisible) = insert("Attribute", 40.0) else {
        panic!("fixture insert")
    };
    invisible.attribs.push(attribute);
    d.add(
        &Space::Model,
        Common::default(),
        EntityKind::Insert(invisible),
    )
    .unwrap();
    let original = signature(&d);
    assert!(!original.is_empty());
    let normalized = patent_cadcraft_bridge::unified::flatten_layers(&d).unwrap();
    assert_eq!(signature(&normalized), original);
    let saved = patent_cadcraft_bridge::unified::write_dxf(&normalized).unwrap();
    assert_eq!(
        signature(&cadcraft_io::read(&saved, "test.dxf").unwrap()),
        original
    );
}

#[test]
fn flatten_rejects_viewport_specific_layer_appearance_without_modifying_the_source() {
    use cadcraft_engine::doc::Viewport;
    let mut d = Drawing::new_metric();
    let paper = d.layouts[0].name.clone();
    d.add(
        &Space::Paper(paper),
        Common::default(),
        EntityKind::Viewport(Viewport {
            frozen_layers: vec!["0".into()],
            ..Default::default()
        }),
    )
    .unwrap();
    let original = d.clone();
    assert!(patent_cadcraft_bridge::unified::flatten_layers(&d).is_err());
    assert_eq!(d, original);
}

#[test]
fn dimension_export_does_not_overwrite_a_source_block_with_the_generated_name() {
    let mut d = Drawing::new_metric();
    let mut display = Block::new("Display");
    display.entities.push(Entity {
        handle: d.new_handle(),
        common: Common::default(),
        kind: line(10.0),
    });
    d.blocks.insert(display.name.clone(), Arc::new(display));
    let kind:EntityKind=serde_json::from_value(json!({"type":"dimension","kind":{"linear":{"rotation":0}},"defpt":{"x":0,"y":10,"z":0},"textMid":{"x":10,"y":10,"z":0},"block":"Display"})).unwrap();
    let handle = d.add(&Space::Model, Common::default(), kind).unwrap();
    let name = format!("PW_DIM_EXPORT_{}", handle.hex());
    let mut collision = Block::new(&name);
    collision.entities.push(Entity {
        handle: d.new_handle(),
        common: Common::default(),
        kind: line(123.0),
    });
    d.blocks.insert(name.clone(), Arc::new(collision));
    d.add(&Space::Model, Common::default(), insert(&name, 100.0))
        .unwrap();
    let before = signature(&d);
    let bytes = patent_cadcraft_bridge::unified::write_dxf(&d).unwrap();
    assert_eq!(
        signature(&cadcraft_io::read(&bytes, "test.dxf").unwrap()),
        before
    );
}

#[test]
fn dxf_roundtrip_preserves_wipeout_and_image_frame_header_settings() {
    for frame in 0..=2 {
        let mut d = Drawing::new_metric();
        d.header.set_i64("WIPEOUTFRAME", frame);
        d.header.set_i64("IMAGEFRAME", 2 - frame);
        d.header.set_i64("FRAME", frame);
        let bytes = patent_cadcraft_bridge::unified::write_dxf(&d).unwrap();
        let restored = cadcraft_io::read(&bytes, "frames.dxf").unwrap();
        for name in ["WIPEOUTFRAME", "IMAGEFRAME", "FRAME"] {
            assert_eq!(
                restored.header.get(name),
                d.header.get(name),
                "{name} must survive DXF"
            );
        }
    }
}

#[test]
fn body_wipeout_frames_do_not_reappear_when_the_working_checkpoint_is_reloaded() {
    let mut s = CadcraftSession::new();
    s.execute("wipeout", &json!({"frames":"off"}).to_string())
        .unwrap();
    s.execute("bridge.add_primitives",&json!({"primitives":[
        {"kind":"mask","points":[[0,0],[20,0],[20,20],[0,20]],"color":[255,255,255],"lineweight":0.0},
        {"kind":"mask","points":[[25,0],[45,0],[45,20],[25,20]],"color":[255,255,255],"lineweight":0.0},
        {"kind":"polyline","points":[[0,10],[45,10]],"color":[0,0,0],"lineweight":0.25}
    ]}).to_string()).unwrap();
    let before: Value = serde_json::from_str(&s.scene().unwrap()).unwrap();
    assert_eq!(before["primitives"].as_array().unwrap().len(), 3);
    let bytes = s.export_dxf().unwrap();
    s.load_dxf(&bytes).unwrap();
    let after: Value = serde_json::from_str(&s.scene().unwrap()).unwrap();
    assert_eq!(after["primitives"], before["primitives"]);
    assert_eq!(after["entityCount"], before["entityCount"]);
    assert_eq!(
        after["entities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entity| (&entity["handle"], &entity["type"], &entity["visible"]))
            .collect::<Vec<_>>(),
        before["entities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entity| (&entity["handle"], &entity["type"], &entity["visible"]))
            .collect::<Vec<_>>()
    );
}

#[test]
fn patent_preview_suppresses_wipeout_frames_without_changing_full_export_or_masks() {
    let mut d = Drawing::new_metric();
    d.header.set_i64("WIPEOUTFRAME", 1);
    d.add(
        &Space::Model,
        Common::default(),
        EntityKind::Wipeout(cadcraft_engine::doc::Wipeout {
            boundary: vec![
                cadcraft_engine::geom::Vec2::new(0.0, 0.0),
                cadcraft_engine::geom::Vec2::new(20.0, 0.0),
                cadcraft_engine::geom::Vec2::new(20.0, 20.0),
                cadcraft_engine::geom::Vec2::new(0.0, 20.0),
            ],
        }),
    )
    .unwrap();
    let view = patent_cadcraft_bridge::unified::patent_preview(&d);
    assert_eq!(view.header.i64("WIPEOUTFRAME", 1), 0);
    assert_eq!(d.header.i64("WIPEOUTFRAME", 1), 1);
    let svg = patent_cadcraft_bridge::unified::patent_svg(&d, None);
    assert!(!svg.contains("<polyline"));
    assert!(svg.contains("<path fill=\"#ffffff\""));
    assert!(cadcraft_io::svg::export(&d, &Space::Model).contains("<polyline"));
}

#[test]
fn object_index_is_read_only_and_matches_scene_handles_and_groups_without_tessellation() {
    let mut s = CadcraftSession::new();
    let line: Value = serde_json::from_str(&s.execute("line", &json!({"points":[[0,0],[20,0]]}).to_string()).unwrap()).unwrap();
    s.execute("group", &json!({"name":"detail", "handles":line["handles"], "selectable":false}).to_string()).unwrap();
    let before: Value = serde_json::from_str(&s.scene().unwrap()).unwrap();
    let index: Value = serde_json::from_str(&s.execute("bridge.object_index", "{}").unwrap()).unwrap();
    assert_eq!(index["groups"], before["groups"]);
    assert_eq!(index["entities"].as_array().unwrap().iter().map(|e| &e["handle"]).collect::<Vec<_>>(), before["entities"].as_array().unwrap().iter().map(|e| &e["handle"]).collect::<Vec<_>>());
    assert_eq!(index["primitives"], json!([]));
    assert_eq!(serde_json::from_str::<Value>(&s.scene().unwrap()).unwrap(), before);
}
