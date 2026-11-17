use cadcraft_engine::{Session, doc::Space, geom::Vec2, render};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

pub mod codec;

// Separate from the browser editor build: only Harmony's conversion worker
// includes the DWG reader/writer. Both platforms use the same codec algorithm.
#[cfg(feature = "harmony-codec")]
#[wasm_bindgen]
pub fn convert_cad(mode: &str, bytes: &[u8], options: &str, font: &[u8]) -> Result<Vec<u8>, String> {
    let args: Vec<String> = serde_json::from_str(options).map_err(|e| e.to_string())?;
    CadcraftSession::new().register_font("Source Han Serif CN", font)?;
    codec::convert(mode, bytes, &args)
}

mod explode;
mod appearance;
mod gear;
mod chain;
mod gear_mesh;
mod clipboard;
mod spring;
mod extension_spring;
mod corner;
mod stretch;
mod hatch;
mod hatch_preview;
mod trim_pick;
mod text;
pub mod unified;

#[wasm_bindgen]
pub struct CadcraftSession {
    session: Session,
    hatch_preview: Option<hatch_preview::PreparedHatch>,
    checkpoints: std::collections::VecDeque<(String, cadcraft_engine::DocState)>,
    edit_transaction: Option<cadcraft_engine::DocState>,
}

#[wasm_bindgen]
impl CadcraftSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let mut session = Session::empty();
        session.new_drawing(true);
        Self { session, hatch_preview: None, checkpoints: Default::default(), edit_transaction: None }
    }

    pub fn execute(&mut self, command: &str, params: &str) -> Result<String, String> {
        let values: Value = serde_json::from_str(params).map_err(|e| e.to_string())?;
        if gear_mesh::intercept(self.session.doc().map_err(|e|e.to_string())?,command) {
            return self.mesh_edit(command,&values);
        }
        self.execute_raw(command,params)
    }

    fn execute_raw(&mut self, command: &str, params: &str) -> Result<String, String> {
        let params: Value = serde_json::from_str(params).map_err(|e| e.to_string())?;
        if command == "bridge.pick_trim" {
            return serde_json::to_string(&self.trim_pick(&params)?).map_err(|e| e.to_string());
        }
        // Keep a copy-on-write edit boundary separate from user undo/checkpoint history.
        // The worker accepts it only after patent semantic constraints also succeed.
        if command == "bridge.edit_begin" {
            if self.edit_transaction.is_some() { return Err("CAD 编辑事务尚未完成。".into()); }
            self.edit_transaction = Some(self.session.state().map_err(|e|e.to_string())?.clone());
            return Ok(json!({"begun":true}).to_string());
        }
        if command == "bridge.edit_finish" {
            let accept = params["accept"].as_bool().ok_or("缺少编辑事务结果。")?;
            let state = self.edit_transaction.take().ok_or("CAD 编辑事务不存在。")?;
            if !accept {
                *self.session.state_mut().map_err(|e|e.to_string())? = state;
                self.hatch_preview = None;
            }
            return Ok(json!({"accepted":accept}).to_string());
        }
        if command == "bridge.appearance" { return self.appearance(&params); }
        if command == "bridge.gear" { return self.gear(&params); }
        if command == "bridge.chain" { return self.chain(&params); }
        if command == "bridge.spring" { return self.spring(&params); }
        if command == "bridge.corner" { return self.corner(&params); }
        if command == "stretch" { return self.stretch(&params); }
        if command == "bridge.remember" {
            let key = params["key"].as_str().filter(|s| !s.is_empty() && s.len() <= 128).ok_or("无效检查点")?;
            self.checkpoints.retain(|(id,_)| id != key && !params["forget"].as_array().is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some(id))));
            let mut state = self.session.state().map_err(|e|e.to_string())?.clone();
            state.undo.clear();state.redo.clear();
            self.checkpoints.push_back((key.into(),state));
            while self.checkpoints.len() > 8 {self.checkpoints.pop_front();}
            return Ok(json!({"remembered":true}).to_string());
        }
        if command == "bridge.checkout" {
            let key = params["key"].as_str().ok_or("无效检查点")?;
            let Some((_,state)) = self.checkpoints.iter().find(|(id,_)| id == key) else {return Ok(json!({"restored":false}).to_string());};
            *self.session.state_mut().map_err(|e|e.to_string())? = state.clone();
            self.hatch_preview = None;
            return Ok(json!({"restored":true}).to_string());
        }
        if command == "bridge.edit" {
            let operation = params["command"].as_str().ok_or("缺少编辑命令")?;
            if operation.starts_with("bridge.edit") { return Err("不支持嵌套编辑".into()); }
            let before = self.session.doc().map_err(|e| e.to_string())?.clone();
            let result: Value = serde_json::from_str(&self.execute(operation, &params["params"].to_string())?).map_err(|e| e.to_string())?;
            let after = self.session.doc().map_err(|e| e.to_string())?;
            // Definition changes can affect otherwise unchanged INSERTs; use a full scene then.
            // Parameterized blocks create private definitions and replace only their own INSERT.
            let grip_entity = (operation == "grip.move")
                .then(|| params["params"]["handle"].as_str())
                .flatten()
                .and_then(cadcraft_engine::doc::Handle::parse_hex)
                .and_then(|h| before.model.get(h));
            let private_definition = matches!(operation, "bridge.gear" | "bridge.gear_mesh" | "bridge.spring" | "bridge.chain")
                || grip_entity.is_some_and(|e| {
                    gear::info(&before, e).is_some() || spring::info(&before, e).is_some() || chain::info(&before,e).is_some()
                });
            let definitions_changed = !private_definition
                && (before.layers != after.layers || before.blocks != after.blocks || before.text_styles != after.text_styles);
            let changed: std::collections::HashSet<_> = after.model.iter()
                .filter(|e| before.model.get(e.handle).is_none_or(|old| !std::sync::Arc::ptr_eq(old,e)))
                .map(|e| e.handle).collect();
            let removed: Vec<_> = before.model.iter().filter(|e| after.model.get(e.handle).is_none()).map(|e| e.handle.hex()).collect();
            let mut scene: Value = serde_json::from_str(&self.scene_filtered(if definitions_changed {None} else {Some(&changed)})?).map_err(|e| e.to_string())?;
            scene["removedHandles"] = json!(removed);
            return Ok(json!({"result":result,"scene":scene}).to_string());
        }
        if command == "bridge.text" {
            return self.edit_text(&params);
        }
        if command == "bridge.text_grip" {
            return self.text_grip(&params)?.ok_or_else(|| "文字控制点无效".into());
        }
        if command == "grip.move" {
            self.validate_edit(command, &params)?;
            if let Some(result) = self.gear_grip(&params)? { return Ok(result); }
            if let Some(result) = self.chain_grip(&params)? { return Ok(result); }
            if let Some(result) = self.spring_grip(&params)? { return Ok(result); }
            if let Some(result) = self.text_grip(&params)? { return Ok(result); }
        }
        if command == "bridge.object_index" {
            // Composition needs membership, not grips, glyph outlines or a full
            // tessellation of every entity. This query never changes the document.
            let state = self.session.state().map_err(|e| e.to_string())?;
            return Ok(json!({
                "entities": state.doc.model.iter().map(|e| json!({"handle": e.handle.hex()})).collect::<Vec<_>>(),
                "groups": state.doc.groups.iter().map(|g| json!({"name": g.name, "selectable": g.selectable, "members": g.members.iter().map(|h| h.hex()).collect::<Vec<_>>()})).collect::<Vec<_>>(),
                "primitives": []
            }).to_string());
        }
        if command == "bridge.preview_draw" {
            let operation = params["command"].as_str().ok_or("缺少绘图方式")?;
            if !["bridge.chain", "bridge.gear", "bridge.spring", "grip.move", "circle", "circle.ttr", "circle.ttt", "arc.sce", "arc.ser", "arc.sea", "arc.continue", "ellipse.axis", "ellipse.arc", "polygon"].contains(&operation) {
                return Err("不支持此绘图预览".into());
            }
            let mut preview = Self::new();
            if matches!(operation, "circle.ttr" | "circle.ttt" | "arc.continue" | "grip.move")
                || (matches!(operation, "bridge.gear" | "bridge.spring" | "bridge.chain") && params["params"].get("handle").is_some()) {
                let mut state = self.session.state().map_err(|e| e.to_string())?.clone();
                state.undo.clear(); state.redo.clear();
                *preview.session.state_mut().map_err(|e| e.to_string())? = state;
            }
            let before = preview.session.doc().map_err(|e|e.to_string())?.clone();
            let edited=params["params"]["handle"].as_str().and_then(cadcraft_engine::doc::Handle::parse_hex);
            let mut retained:std::collections::HashSet<_>=edited.into_iter().collect();
            if let Some(h)=edited {retained.extend(gear_mesh::connected(&before,h));}
            preview.execute(operation, &params["params"].to_string())?;
            let state = preview.session.state_mut().map_err(|e| e.to_string())?;
            let drawing = std::sync::Arc::make_mut(&mut state.doc);
            let unchanged:Vec<_> = before.model.iter().filter(|e|!retained.contains(&e.handle)&&drawing.model.get(e.handle).is_some_and(|after|std::sync::Arc::ptr_eq(after,e))).map(|e|e.handle).collect();
            for handle in unchanged { drawing.model.remove(handle); }
            return preview.scene();
        }
        if command == "bridge.preview_modify" {
            let operation = params["command"].as_str().ok_or("缺少预览操作")?;
            if ![
                "mirror",
                "offset",
                "break",
                "stretch",
                "fillet",
                "chamfer",
                "trim",
                "extend",
                "arrayrect",
                "arraypolar",
                "arraypath",
                "hatch",
                "hatchedit",
                "bridge.gear_mesh",
                "move",
                "rotate",
                "scale",
            ]
            .contains(&operation)
            {
                return Err("不支持此修改预览".into());
            }
            if matches!(operation, "hatch" | "hatchedit") && params["compact"] == true {
                return self.preview_hatch(operation, &params["params"]);
            }
            let mut preview = Self::new();
            let mut state = self.session.state().map_err(|e| e.to_string())?.clone();
            state.undo.clear();
            state.redo.clear();
            *preview.session.state_mut().map_err(|e| e.to_string())? = state;
            preview.validate_edit(operation, &params["params"])?;
            preview.execute(operation, &params["params"].to_string())?;
            if params["compact"] == true {
                let before = self.session.doc().map_err(|e| e.to_string())?;
                let after = preview.session.doc().map_err(|e| e.to_string())?;
                let changed: std::collections::HashSet<_> = after.model.iter()
                    .filter(|e| before.model.get(e.handle).is_none_or(|old| !std::sync::Arc::ptr_eq(old, e)))
                    .map(|e| e.handle).collect();
                let removed: Vec<_> = before.model.iter()
                    .filter(|e| after.model.get(e.handle).is_none())
                    .map(|e| e.handle.hex()).collect();
                let mut scene: Value = serde_json::from_str(&preview.scene_filtered(Some(&changed))?).map_err(|e| e.to_string())?;
                scene["removedHandles"] = json!(removed);
                return Ok(scene.to_string());
            }
            return preview.scene();
        }
        if command == "bridge.preview_spline" {
            let fit = params["fit"].as_array().ok_or("缺少曲线经过点")?;
            if fit.len() < 2 || fit.len() > 1000 {
                return Err("曲线经过点须为 2 至 1000 个".into());
            }
            let mut preview = Self::new();
            preview
                .session
                .execute("spline", &params)
                .map_err(|e| e.to_string())?;
            return preview.scene();
        }
        if command == "bridge.add_primitives" {
            return self.add_primitives(&params);
        }
        if command == "bridge.transform_model" {
            return self.transform_model(&params);
        }
        if command == "bridge.prepare_export" {
            return self.prepare_export();
        }
        if command == "bridge.drawing_defaults" {
            return self.drawing_defaults(&params);
        }
        if command == "bridge.flatten_layers" {
            let drawing = unified::flatten_layers(self.session.doc().map_err(|e| e.to_string())?)?;
            let state = self.session.state_mut().map_err(|e| e.to_string())?;
            state.doc = std::sync::Arc::new(drawing);
            state.revision += 1;
            return Ok(json!({"layer":"0","entityCount":state.doc.entity_count()}).to_string());
        }
        if command == "bridge.select_polygon" {
            let polygon: Vec<[f64; 2]> =
                serde_json::from_value(params["polygon"].clone()).map_err(|_| "框选坐标无效")?;
            if !(3..=5000).contains(&polygon.len()) || polygon.iter().flatten().any(|n| !n.is_finite()) {
                return Err("框选坐标无效".into());
            }
            let doc = self.session.doc().map_err(|e| e.to_string())?;
            let points: Vec<Vec2> = polygon.iter().map(|p| Vec2::new(p[0], p[1])).collect();
            let handles = cadcraft_engine::select::select_polygon(
                doc,
                &Space::Model,
                &points,
                params["crossing"].as_bool().unwrap_or(false),
            );
            return Ok(
                json!({"handles":handles.iter().map(|h| h.hex()).collect::<Vec<_>>()} ).to_string(),
            );
        }
        if command == "explode" {
            return self.explode(&params);
        }
        self.validate_edit(command, &params)?;
        if command == "bridge.hatch_swatches" {
            return hatch::swatches(&mut self.session).map(|v| v.to_string());
        }
        if matches!(command, "hatch" | "hatchedit") {
            if let Some(result) = self.commit_hatch_preview(command, &params)? {
                return Ok(result.to_string());
            }
            return hatch::execute(&mut self.session, command, &params).map(|v| v.to_string());
        }
        // A restored snapshot already contains the matching boundaries and
        // hatch links. Running after-command association again detaches loops
        // restored by an undo of boundary editing.
        if matches!(command, "undo" | "redo") && params.get("mode").is_none() {
            let mut labels = Vec::new();
            for _ in 0..params["count"].as_u64().unwrap_or(1).clamp(1, 1000) {
                let label = if command == "undo" {
                    self.session.undo()
                } else {
                    self.session.redo()
                }
                .map_err(|e| e.to_string())?;
                if let Some(label) = label {
                    labels.push(label);
                } else {
                    break;
                }
            }
            return Ok(json!({if command == "undo" {"undone"} else {"redone"}:labels}).to_string());
        }
        self.session
            .execute(command, &params)
            .map(|v| v.to_string())
            .map_err(|e| e.to_string())
    }

    pub fn scene(&self) -> Result<String, String> {
        self.scene_filtered(None)
    }

    fn scene_filtered(&self, handles: Option<&std::collections::HashSet<cadcraft_engine::doc::Handle>>) -> Result<String, String> {
        let state = self.session.state().map_err(|e| e.to_string())?;
        let list = if let Some(handles) = handles {
            render::build_entities(&state.doc, state.doc.model.iter().filter(|e| handles.contains(&e.handle)).map(|e| e.as_ref()), &render::Options{lineweights:true,..Default::default()})
        } else {
            render::build(&state.doc, &Space::Model, &render::Options{lineweights:true,..Default::default()})
        };
        let b = list.bounds;
        let bounds = if b.is_empty() {
            Value::Null
        } else {
            json!({"min": [b.min.x, b.min.y], "max": [b.max.x, b.max.y]})
        };
        // Mirrors upstream SVG export_list's framing, including its empty-drawing frame.
        let (w, h) = if b.is_empty() {
            (1.0, 1.0)
        } else {
            (b.width().max(1e-9), b.height().max(1e-9))
        };
        let margin = w.max(h) * 0.02;
        let origin = if b.is_empty() {
            [0.0, 1.0]
        } else {
            [b.min.x - margin, b.max.y + margin]
        };
        let primitives: Vec<Value> = list
            .prims
            .iter()
            .map(|p| {
                let kind = match p.kind {
                    render::Kind::Polyline => "polyline",
                    render::Kind::Tris => "triangles",
                    render::Kind::Mask => "mask",
                    render::Kind::Point => "point",
                    render::Kind::Infinite { ray: true } => "ray",
                    render::Kind::Infinite { ray: false } => "infinite",
                };
                json!({"handle":p.handle.hex(), "kind":kind,
                "points":list.points(p).iter().map(|q| [q.x,q.y]).collect::<Vec<_>>(),
                "color":[p.color.0,p.color.1,p.color.2], "aci7":p.aci7,"lineweight":p.lw})
            })
            .collect();
        let gear_meshes = gear_mesh::adjacency(&state.doc);
        let entities: Vec<Value> = state
            .doc
            .model
            .iter()
            .filter(|e| handles.is_none_or(|hs| hs.contains(&e.handle)))
            .map(|e| {
                let mut entity = json!({"handle":e.handle.hex(),"type":e.kind.type_name(),"layer":e.common.layer,
                "locked":state.doc.layer(&e.common.layer).is_some_and(|l| l.locked),
                "visible":state.doc.is_visible(e),
                "geometry":e.kind,"common":e.common,
                "grips":e.kind.grips().iter().map(|p|[p.x,p.y]).collect::<Vec<_>>()});
                entity["appearance"]=appearance::values(&state.doc,&e.common);
                if let Some(gear)=gear::info(&state.doc,e) {
                    entity["gear"]=gear;
                    if let Some(mates)=gear_meshes.get(&e.handle) {
                        entity["gearMate"]=json!(mates[0].hex());
                        entity["gearMates"]=json!(mates.iter().map(|h|h.hex()).collect::<Vec<_>>());
                    }
                }
                if let Some(chain)=chain::info(&state.doc,e) {
                    entity["chain"]=chain;
                    entity["grips"]=json!(chain::grips(&state.doc,e).unwrap_or_default().iter().map(|p|[p.x,p.y]).collect::<Vec<_>>());
                }
                if let Some(spring)=spring::info(&state.doc,e) {
                    entity["spring"]=spring;
                    entity["grips"]=json!(spring::grips(&state.doc,e).unwrap_or_default().iter().map(|p|[p.x,p.y]).collect::<Vec<_>>());
                }
                if let Some(grips)=gear::grips(&state.doc,e) {entity["grips"]=json!(grips.iter().map(|p|[p.x,p.y]).collect::<Vec<_>>());}
                use cadcraft_engine::doc::{EntityKind,Lineweight};
                let weight = match e.common.lineweight {
                    Lineweight::ByLayer => state.doc.layer(&e.common.layer).map(|layer|layer.lineweight).unwrap_or_default(),
                    value => value,
                };
                entity["lineweight"] = json!(match weight {
                    Lineweight::Mm100(value) => f64::from(value)/100.0,
                    _ => match state.doc.header.i64("LWDEFAULT",25) { value @ 0..=211 => value as f64/100.0, _ => 0.25 },
                });
                match &e.kind {
                    EntityKind::Text(text) => {
                        entity["text"] = json!(text.value);
                        entity["height"] = json!(text.height);
                        entity["rotation"] = json!(text.rotation.to_degrees());
                        if let Some(origin)=crate::text::text_origin(&state.doc,&e.kind) {entity["textOrigin"]=json!([origin.x,origin.y]);}
                    }
                    EntityKind::MText(text) => {
                        entity["text"] = json!(text.contents);
                        entity["plainText"] = json!(cadcraft_fonts::plain_mtext(&text.contents));
                        entity["width"] = json!(text.width);
                        entity["height"] = json!(text.height);
                        entity["rotation"] = json!(text.rotation.to_degrees());
                        if let Some(origin)=crate::text::text_origin(&state.doc,&e.kind) {entity["textOrigin"]=json!([origin.x,origin.y]);}
                        if text.style == "Patent Workbench Text" {
                            let layout = cadcraft_engine::render::layout_mtext_entity(&state.doc, text);
                            let step = text.height * 5.0 / 3.0 * text.line_spacing;
                            let extent = step * layout.lines.len().max(1) as f64;
                            let position = |x:f64,y:f64| {let p=text.insert.xy()+cadcraft_engine::geom::Vec2::new(x,y).rotate(text.rotation); [p.x,p.y]};
                            entity["textOrigin"] = json!([text.insert.x,text.insert.y]);
                            entity["textLines"] = json!(layout.lines);
                            entity["grips"] = json!([position(0.0,0.0),position(text.width,0.0),position(text.width,-extent)]);
                        }
                    }
                    EntityKind::Circle(circle) => entity["radius"] = json!(circle.radius),
                    EntityKind::Arc(arc) => entity["radius"] = json!(arc.radius),
                    EntityKind::Insert(insert) => entity["rotation"] = json!(insert.rotation.to_degrees()),
                    _ => {}
                }
                entity
            })
            .collect();
        Ok(
            json!({"partial":handles.is_some(),"entityCount":state.doc.entity_count(),"revision":state.revision,
            "selection":state.selection.iter().map(|h|h.hex()).collect::<Vec<_>>(),
            "bounds":bounds,"svgFrame":{"origin":origin,"width":w+2.0*margin,"height":h+2.0*margin},
            "groups":state.doc.groups.iter().map(|g| json!({"name":g.name,"selectable":g.selectable,
                "members":g.members.iter().map(|h| h.hex()).collect::<Vec<_>>()})).collect::<Vec<_>>(),
            "appearance":appearance::values(&state.doc,&self.current_common()),
            "linetypes":state.doc.linetypes.iter().map(|l| &l.name).collect::<Vec<_>>(),
            "entities":entities,"primitives":primitives})
            .to_string(),
        )
    }

    pub fn export_dxf(&self) -> Result<Vec<u8>, String> {
        unified::write_dxf(self.session.doc().map_err(|e| e.to_string())?)
    }

    pub fn load_dxf(&mut self, data: &[u8]) -> Result<(), String> {
        if data.len() > 100 * 1024 * 1024 {
            return Err("DXF exceeds the 100 MiB input limit".into());
        }
        if cadcraft_dwg::is_dwg(data) {
            return Err("Convert DWG through the native codec before loading".into());
        }
        let mut drawing = cadcraft_io::read(data, "drawing.dxf").map_err(|e| e.to_string())?;
        appearance::restore_color(&mut drawing);
        spring::upgrade_legacy_blocks(&mut drawing);
        let mut session = Session::empty();
        session.open_drawing(drawing, "Drawing", None);
        self.session = session;
        Ok(())
    }

    pub fn paste_dxf(&mut self, data: &[u8], params: &str) -> Result<String, String> {
        use cadcraft_engine::doc::Handle;
        let params: Value = serde_json::from_str(params).map_err(|error| error.to_string())?;
        let handles = params["handles"]
            .as_array()
            .ok_or("粘贴缺少源对象 handle 列表。")?;
        if handles.is_empty() || handles.len() > 100_000 {
            return Err("粘贴源对象数量须为 1 至 100000 个。".into());
        }
        let mut seen = std::collections::HashSet::new();
        let handles: Vec<_> = handles
            .iter()
            .map(|value| {
                let handle = value
                    .as_str()
                    .and_then(Handle::parse_hex)
                    .ok_or("粘贴源对象 handle 无效。")?;
                if !seen.insert(handle) {
                    return Err("粘贴源对象 handle 不得重复。");
                }
                Ok(handle)
            })
            .collect::<Result<_, _>>()?;
        let point = |key: &str| -> Result<[f64; 2], String> {
            let point: [f64; 2] = serde_json::from_value(params[key].clone())
                .map_err(|_| format!("粘贴 {key} 坐标无效。"))?;
            if point.iter().any(|value| !value.is_finite()) {
                return Err(format!("粘贴 {key} 坐标必须有限。"));
            }
            Ok(point)
        };
        let delta = if params.get("delta").is_some() {
            if params.get("from").is_some() || params.get("to").is_some() {
                return Err("粘贴坐标只能使用 delta 或 from/to 中的一种。".into());
            }
            point("delta")?
        } else {
            let from = point("from")?;
            let to = point("to")?;
            let delta = [to[0] - from[0], to[1] - from[1]];
            if delta.iter().any(|value| !value.is_finite()) {
                return Err("粘贴位移超出有效范围。".into());
            }
            delta
        };
        // Parsing and copying happen in an isolated snapshot session, never in the working doc.
        let mut source = Self::new();
        source.load_dxf(data)?;
        let source_doc = source.session.doc().map_err(|error| error.to_string())?;
        if handles
            .iter()
            .any(|handle| source_doc.entity(*handle).is_none())
        {
            return Err("粘贴快照缺少选中的源对象，当前工作稿未修改。".into());
        }
        source.session.execute("copybase",&json!({"handles":handles.iter().map(|handle|handle.hex()).collect::<Vec<_>>(),"base":[0,0]})).map_err(|error|error.to_string())?;
        if source
            .session
            .clipboard
            .iter()
            .map(|entity| entity.handle)
            .collect::<Vec<_>>()
            != handles
        {
            return Err("粘贴快照对象顺序不完整，当前工作稿未修改。".into());
        }
        self.isolate_clipboard(&mut source,data)?;
        if let Some(defs) = &source.session.clipboard_source {
            self.validate_clipboard_definitions(&defs.defs)?;
        }
        // Holding the full state snapshot makes doc_mut copy-on-write. On failure restore
        // geometry, definitions, selection, revision, undo/redo and the previous clipboard.
        let before = self
            .session
            .state()
            .map_err(|error| error.to_string())?
            .clone();
        let previous_clipboard = self.session.clipboard.clone();
        let previous_base = self.session.clipboard_base;
        let previous_source = self.session.clipboard_source.clone();
        self.session.clipboard = source.session.clipboard.clone();
        self.session.clipboard_base = source.session.clipboard_base;
        self.session.clipboard_source = source.session.clipboard_source.clone();
        let result=(|| -> Result<String,String> {
                let mut result=self.session.execute("pasteclip", &json!({"at":delta})).map_err(|e|e.to_string())?;
                let created:Vec<_>=result["handles"].as_array().ok_or("粘贴结果缺少对象列表")?.iter().map(|v|v.as_str().and_then(Handle::parse_hex).ok_or("粘贴对象编号无效")).collect::<Result<_,_>>()?;
                self.paste_relationships(source.session.doc().map_err(|e|e.to_string())?,&handles,&created)?;
                if params["compact"]==true {
                    result["scene"]=serde_json::from_str(&self.scene_filtered(Some(&created.iter().copied().collect()))?).map_err(|e|e.to_string())?;
                }
                Ok(result.to_string())
        })();
        match result {
            Ok(result)=>Ok(result),
            Err(error) => {
                *self
                    .session
                    .state_mut()
                    .map_err(|error| error.to_string())? = before;
                self.session.clipboard = previous_clipboard;
                self.session.clipboard_base = previous_base;
                self.session.clipboard_source = previous_source;
                Err(error.to_string())
            }
        }
    }

    pub fn export_svg(&self) -> Result<String, String> {
        Ok(appearance::svg(
            self.session.doc().map_err(|e| e.to_string())?,
            None,
        ))
    }

    pub fn export_patent_svg(&self) -> Result<String, String> {
        Ok(unified::patent_svg(
            self.session.doc().map_err(|e| e.to_string())?,
            None,
        ))
    }

    pub fn commands(&self) -> Result<String, String> {
        serde_json::to_string(
            &cadcraft_engine::command_specs()
                .iter()
                .map(|c| c.info(&self.session))
                .collect::<Vec<_>>(),
        )
        .map_err(|e| e.to_string())
    }

    pub fn pick(&self, x: f64, y: f64, aperture: f64) -> Result<Option<String>, String> {
        if !x.is_finite() || !y.is_finite() || !aperture.is_finite() || aperture <= 0.0 {
            return Err("Pick requires finite coordinates and a positive aperture".into());
        }
        Ok(cadcraft_engine::select::pick(
            self.session.doc().map_err(|e| e.to_string())?,
            &Space::Model,
            Vec2::new(x, y),
            aperture,
        )
        .map(|h| h.hex()))
    }

    pub fn register_font(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if name.trim().is_empty() || name.len() > 128 || name.contains([',', ';']) {
            return Err("Font name must be 1–128 bytes without comma or semicolon".into());
        }
        if bytes.len() > 32 << 20 {
            return Err("Font exceeds 32 MiB".into());
        }
        let data = std::sync::Arc::new(bytes.to_vec());
        if cadcraft_fonts::ttf::faces(&data).is_empty() {
            return Err("Invalid TrueType/OpenType font".into());
        }
        cadcraft_fonts::ttf::register(name, (*data).clone());
        cadcraft_fonts::ttf::set_fallback_fonts(name);
        Ok(())
    }
}

impl CadcraftSession {
    fn validate_clipboard_definitions(
        &self,
        source: &cadcraft_engine::doc::Drawing,
    ) -> Result<(), String> {
        let target = self.session.doc().map_err(|error| error.to_string())?;
        // The native merge intentionally retains target definitions with the same name.
        // Refuse differing definitions instead of silently changing copied objects.
        macro_rules! tables {
            ($field:ident) => {
                for source in &source.$field {
                    if target.$field.iter().any(|target|target.name.eq_ignore_ascii_case(&source.name) && target != source) {
                        return Err(format!("粘贴快照与当前图纸的同名定义 {} 已不同，未修改当前工作稿。",source.name));
                    }
                }
            }
        }
        tables!(layers);
        tables!(linetypes);
        tables!(text_styles);
        tables!(dim_styles);
        tables!(mleader_styles);
        tables!(table_styles);
        for source in source
            .blocks
            .values()
            .filter(|block| !block.anonymous && !block.name.starts_with('*'))
        {
            let Some(target) = target.block(&source.name) else {
                continue;
            };
            let mut source_metadata = source.as_ref().clone();
            let mut target_metadata = target.as_ref().clone();
            source_metadata.entities = Default::default();
            target_metadata.entities = Default::default();
            source_metadata.name.clear();
            target_metadata.name.clear();
            let same_entities =
                source.entities.len() == target.entities.len()
                    && source.entities.iter().zip(target.entities.iter()).all(
                        |(source, target)| {
                            source.common == target.common && source.kind == target.kind
                        },
                    );
            if source_metadata != target_metadata || !same_entities {
                return Err(format!(
                    "粘贴快照与当前图纸的同名块 {} 已不同，未修改当前工作稿。",
                    source.name
                ));
            }
        }
        Ok(())
    }

    // Validate the whole selection before the engine can partially mutate it. Export clones
    // intentionally bypass this user-edit guard: locked source layers must still export.
    fn validate_edit(&self, command: &str, params: &Value) -> Result<(), String> {
        if !matches!(
            command,
            "properties.set"
                | "grip.move"
                | "move"
                | "copy"
                | "rotate"
                | "scale"
                | "mirror"
                | "erase"
                | "join"
                | "explode"
                | "group"
                | "ungroup"
                | "block"
                | "arrayrect"
                | "arraypolar"
                | "arraypath"
                | "break"
                | "stretch"
                | "offset"
                | "trim"
                | "extend"
                | "fillet"
                | "chamfer"
                | "hatch"
                | "hatchedit"
        ) {
            return Ok(());
        }
        let state = self.session.state().map_err(|e| e.to_string())?;
        let mut handles: Vec<String> = params["handles"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|h| h.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        for key in ["handle", "h1", "h2"] {
            if let Some(h) = params[key].as_str() {
                handles.push(h.to_owned());
            }
        }
        if handles.is_empty() {
            handles.extend(state.selection.iter().map(|h| h.hex()));
        }
        let selected: std::collections::HashSet<_> = handles.iter()
            .filter_map(|h| cadcraft_engine::doc::Handle::parse_hex(h))
            .collect();
        let entities: Vec<_> = state
            .doc
            .model
            .iter()
            .filter(|e| selected.contains(&e.handle))
            .collect();
        if entities
            .iter()
            .any(|e| state.doc.layer(&e.common.layer).is_some_and(|l| l.locked))
        {
            return Err("选中对象位于锁定图层，请先解锁图层。".into());
        }
        if command != "properties.set" {
            return Ok(());
        }
        for key in ["height", "radius", "rotation", "lineweight", "color"] {
            if let Some(value) = params.get(key) {
                let n = value
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .ok_or("属性值必须是有效数字。")?;
                let valid = match key {
                    "height" | "radius" => n > 0.0,
                    "lineweight" => (0.0..=2.11).contains(&n),
                    "color" => n.fract() == 0.0 && (1.0..=255.0).contains(&n),
                    _ => true,
                };
                if !valid {
                    return Err(format!("属性 {key} 的数值超出有效范围。"));
                }
            }
        }
        for key in ["text", "height", "radius", "rotation"] {
            if params.get(key).is_none() {
                continue;
            }
            if entities.iter().any(|e| match key {
                "text" | "height" => !matches!(e.kind.type_name(), "Text" | "MText"),
                "radius" => !matches!(e.kind.type_name(), "Circle" | "Arc"),
                "rotation" => !matches!(e.kind.type_name(), "Text" | "MText" | "Block Reference"),
                _ => false,
            }) {
                return Err("此属性不适用于全部选中对象，请分别选择同类对象。".into());
            }
        }
        Ok(())
    }
    fn prepare_export(&mut self) -> Result<String, String> {
        let drawing = unified::flatten_layers(self.session.doc().map_err(|e| e.to_string())?)?;
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        state.doc = std::sync::Arc::new(drawing);
        state.revision += 1;
        let drawing = std::sync::Arc::make_mut(&mut state.doc);
        let mut name = "Patent Workbench Export".to_string();
        let mut serial = 1;
        loop {
            let style = cadcraft_engine::doc::TextStyle {
                name: name.clone(), font: "Source Han Serif CN".into(), ..Default::default()
            };
            match drawing.text_style(&name) {
                Some(existing) if existing == &style => break,
                Some(_) => { name = format!("Patent Workbench Export {serial}"); serial += 1; }
                None => { drawing.text_styles.push(style); break; }
            }
        }
        drawing.header.set_str("CLAYER", "0");
        drawing.header.set_str("TEXTSTYLE", &name);
        drawing.header.set_str("CELTYPE", "Continuous");
        drawing.header.set_f64("CELTSCALE", 1.0);
        Ok(json!({"layer":"0","textStyle":name}).to_string())
    }
    fn transform_model(&mut self, params: &Value) -> Result<String, String> {
        use cadcraft_engine::geom::Mat3;
        let origin: [f64; 2] =
            serde_json::from_value(params["origin"].clone()).map_err(|e| e.to_string())?;
        if origin.iter().any(|v| !v.is_finite() || v.abs() > 1e12) {
            return Err("Invalid transform origin".into());
        }
        let copies = params["copies"].as_array().ok_or("Expected copies array")?;
        if copies.is_empty() || copies.len() > 500 {
            return Err("Expected 1–500 copies".into());
        }
        let original = self.session.doc().map_err(|e| e.to_string())?;
        let entities: Vec<_> = original.model.iter().map(|e| (**e).clone()).collect();
        let mut drawing = original.clone();
        let base = Vec2::new(origin[0], origin[1]);
        for (index, copy) in copies.iter().enumerate() {
            let scale = copy["scale"].as_f64().ok_or("Expected scale")?;
            let angle = copy["rotation"].as_f64().ok_or("Expected rotation")?;
            let delta: [f64; 2] =
                serde_json::from_value(copy["delta"].clone()).map_err(|e| e.to_string())?;
            if !scale.is_finite()
                || scale <= 0.0
                || scale > 10000.0
                || !angle.is_finite()
                || delta.iter().any(|v| !v.is_finite() || v.abs() > 1e12)
            {
                return Err("Invalid export transform".into());
            }
            let matrix = Mat3::scale_about(base, scale)
                .then(Mat3::rotate_about(base, angle.to_radians()))
                .then(Mat3::translate(Vec2::new(delta[0], delta[1])));
            for source in &entities {
                let mut kind = source.kind.clone();
                kind.transform(&matrix);
                if index == 0 {
                    drawing
                        .modify_entity(source.handle, |e| e.kind = kind)
                        .map_err(|e| e.to_string())?;
                } else {
                    drawing
                        .add(&Space::Model, source.common.clone(), kind)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        state.doc = std::sync::Arc::new(drawing);
        state.revision += 1;
        Ok(json!({"entityCount":state.doc.entity_count()}).to_string())
    }
    // Export-only adapter: all geometry is native CADCraft document entities. Validate and
    // stage the entire batch before replacing the document; never leave a partial export.
    fn add_primitives(&mut self, params: &Value) -> Result<String, String> {
        use cadcraft_engine::{
            doc::{EntityKind, Lineweight, LwPolyline, Point, Solid, Wipeout},
            geom::{PolyVertex, Vec3},
        };
        let primitives = params["primitives"]
            .as_array()
            .ok_or("Expected primitives array")?;
        if primitives.len() > 100_000 {
            return Err("Too many export primitives".into());
        }
        let mut drawing = self.session.doc().map_err(|e| e.to_string())?.clone();
        let mut handles = Vec::new();
        for primitive in primitives {
            let points: Vec<[f64; 2]> =
                serde_json::from_value(primitive["points"].clone()).map_err(|e| e.to_string())?;
            if points
                .iter()
                .flatten()
                .any(|n| !n.is_finite() || n.abs() > 1e12)
                || points.len() > 100_000
            {
                return Err("Invalid export primitive coordinates".into());
            }
            let color: [u8; 3] =
                serde_json::from_value(primitive["color"].clone()).map_err(|e| e.to_string())?;
            let lw = primitive["lineweight"]
                .as_f64()
                .ok_or("Expected lineweight")?;
            if !(0.0..=2.11).contains(&lw) {
                return Err("Invalid lineweight".into());
            }
            let mut common = self.session.current_common();
            common.color = serde_json::from_value(json!({"kind":"true","value":color}))
                .map_err(|e| e.to_string())?;
            common.lineweight = Lineweight::Mm100((lw * 100.0).round() as u16);
            let p2 = |p: &[f64; 2]| Vec2::new(p[0], p[1]);
            let p3 = |p: &[f64; 2]| Vec3::new(p[0], p[1], 0.0);
            let kinds = match primitive["kind"].as_str() {
                Some("polyline") if points.len() >= 2 => vec![EntityKind::LwPolyline(LwPolyline {
                    vertices: points.iter().map(|p| PolyVertex::new(p2(p))).collect(),
                    closed: false,
                    const_width: 0.0,
                    elevation: 0.0,
                    plinegen: false,
                })],
                Some("point") if points.len() == 1 => vec![EntityKind::Point(Point {
                    p: p3(&points[0]),
                    angle: 0.0,
                })],
                Some("mask") if points.len() >= 3 => vec![EntityKind::Wipeout(Wipeout {
                    boundary: points.iter().map(p2).collect(),
                })],
                Some("triangles") if !points.is_empty() && points.len() % 3 == 0 => points
                    .chunks_exact(3)
                    .map(|t| {
                        EntityKind::Solid(Solid {
                            corners: [p3(&t[0]), p3(&t[1]), p3(&t[2]), p3(&t[2])],
                        })
                    })
                    .collect(),
                _ => return Err("Unsupported or invalid export primitive".into()),
            };
            for kind in kinds {
                handles.push(
                    drawing
                        .add(&Space::Model, common.clone(), kind)
                        .map_err(|e| e.to_string())?
                        .hex(),
                );
            }
        }
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        state.doc = std::sync::Arc::new(drawing);
        state.revision += 1;
        Ok(json!({"handles":handles}).to_string())
    }
}

impl Default for CadcraftSession {
    fn default() -> Self {
        Self::new()
    }
}
