use crate::CadcraftSession;
use cadcraft_engine::{
    Snapshot,
    doc::{
        Common, Drawing, Lineweight,
        color::{Color, Rgb},
    },
};
use serde_json::{Value, json};
const DEFAULT_COLOR_BLOCK: &str = "PW_APPEARANCE_DEFAULT_V1";
fn saved_color(d: &Drawing) -> Option<(&str, Value)> {
    d.blocks.iter().find_map(|(name, b)| {
        if !name.starts_with(DEFAULT_COLOR_BLOCK) || !b.entities.is_empty() {
            return None;
        }
        let value = serde_json::from_str::<Value>(&b.description).ok()?;
        (value["patentWorkbenchAppearance"] == 1).then_some((name.as_str(), value))
    })
}

pub(crate) fn restore_color(d: &mut Drawing) {
    let saved = saved_color(d).map(|(_, v)| v);
    if let Some(saved) = saved {
        if saved["aci"].as_i64() == Some(d.header.i64("CECOLOR", 256)) {
            if let Some(rgb) = saved["rgb"].as_i64().filter(|n| (0..=0xffffff).contains(n)) {
                d.header.set_i64("CECOLOR_RGB", rgb);
            }
        }
    }
}

fn save_color(d: &mut Drawing) {
    let saved=saved_color(d).map(|(name,_)|name.to_owned());
    let mut name=saved.clone().unwrap_or_else(||DEFAULT_COLOR_BLOCK.into());
    if saved.is_none() {while d.block(&name).is_some() {name=format!("{DEFAULT_COLOR_BLOCK}_{}",d.new_handle().hex());}}
    let mut block=cadcraft_engine::doc::Block::new(&name);
    block.description=json!({"patentWorkbenchAppearance":1,"aci":d.header.i64("CECOLOR",256),"rgb":d.header.get("CECOLOR_RGB").and_then(|v|v.as_i64())}).to_string();
    d.blocks.insert(name,std::sync::Arc::new(block));
}

pub(crate) fn values(d: &Drawing, c: &Common) -> Value {
    let layer = d.layer(&c.layer);
    let color = match c.color {
        Color::ByLayer => layer.map(|l| l.color).unwrap_or(Color::Index(7)),
        Color::ByBlock => Color::Index(7),
        v => v,
    };
    let rgb = if color == Color::Index(7) {
        Rgb(0, 0, 0)
    } else {
        color.resolve(Color::Index(7), Color::Index(7))
    };
    let weight = match c.lineweight {
        Lineweight::ByLayer => layer.map(|l| l.lineweight).unwrap_or_default(),
        v => v,
    };
    let lineweight = match weight {
        Lineweight::Mm100(n) => f64::from(n) / 100.0,
        _ => d.header.i64("LWDEFAULT", 25).clamp(0, 211) as f64 / 100.0,
    };
    let linetype = match c.linetype.to_ascii_lowercase().as_str() {
        "bylayer" => layer.map(|l| l.linetype.as_str()).unwrap_or("Continuous"),
        "byblock" => "Continuous",
        _ => &c.linetype,
    };
    json!({"color":rgb.hex(),"lineweight":lineweight,"linetype":linetype})
}

impl CadcraftSession {
    pub(crate) fn drawing_defaults(&mut self, p: &Value) -> Result<String,String> {
        const KEYS: [&str;6]=["CECOLOR","CECOLOR_RGB","CELWEIGHT","CELTYPE","CELTSCALE","TEXTSTYLE"];
        if let Some(restore)=p.get("restore") {
            let header: cadcraft_engine::doc::Header=serde_json::from_value(restore.clone()).map_err(|e|e.to_string())?;
            let linetypes:Vec<cadcraft_engine::doc::Linetype>=serde_json::from_value(restore.get("linetypes").cloned().unwrap_or(json!([]))).map_err(|e|e.to_string())?;
            let text_styles:Vec<cadcraft_engine::doc::TextStyle>=serde_json::from_value(restore.get("text_styles").cloned().unwrap_or(json!([]))).map_err(|e|e.to_string())?;
            if header.vars.keys().any(|k|!KEYS.contains(&k.as_str())) {return Err("无效的绘图默认特性".into());}
            let d=self.session.doc_mut().map_err(|e|e.to_string())?;
            for key in KEYS {d.header.vars.remove(key);}
            d.header.vars.extend(header.vars);
            for lt in linetypes {if d.linetype(&lt.name).is_none(){d.linetypes.push(lt);}}
            for style in text_styles {if d.text_style(&style.name).is_none(){d.text_styles.push(style);}}
            save_color(d);
        }
        let d=self.session.doc().map_err(|e|e.to_string())?;
        let mut header=d.header.clone();header.vars.retain(|k,_|KEYS.contains(&k.as_str()));
        Ok(json!({"vars":header.vars,"linetypes":d.linetypes,"text_styles":d.text_styles}).to_string())
    }
    pub(crate) fn current_common(&self) -> Common {
        let mut c = self.session.current_common();
        if let Ok(d) = self.session.doc() {
            if let Some(rgb) = d.header.get("CECOLOR_RGB").and_then(|v| v.as_i64()) {
                c.color = Color::True(Rgb::from_u32(rgb as u32));
            }
        }
        c
    }
    pub(crate) fn appearance(&mut self, p: &Value) -> Result<String, String> {
        if let Some(v) = p.get("color") {
            if v.as_str().and_then(Color::parse).is_none() {
                return Err("请选择有效颜色。".into());
            }
        }
        if let Some(v) = p.get("lineweight") {
            if !v
                .as_f64()
                .is_some_and(|n| n.is_finite() && (0.0..=2.11).contains(&n))
            {
                return Err("线宽范围为 0–2.11 mm。".into());
            }
        }
        if let Some(v) = p.get("linetype") {
            if !v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 255) {
                return Err("请选择有效线型。".into());
            }
        }
        let selected = p.get("handles").is_some();
        if selected {
            let hs = p["handles"]
                .as_array()
                .filter(|a| !a.is_empty())
                .ok_or("未选择对象。")?;
            let d = self.session.doc().map_err(|e| e.to_string())?;
            for h in hs {
                let e = h
                    .as_str()
                    .and_then(cadcraft_engine::doc::Handle::parse_hex)
                    .and_then(|h| d.model.get(h))
                    .ok_or("选中对象已不存在。")?;
                if d.layer(&e.common.layer).is_some_and(|l| l.locked) {
                    return Err("选中对象已锁定。".into());
                }
            }
        }
        let before = self.session.state().map_err(|e| e.to_string())?.clone();
        let outcome = (|| -> Result<(), String> {
            if let Some(name) = p["linetype"].as_str() {
                if self
                    .session
                    .doc()
                    .map_err(|e| e.to_string())?
                    .linetype(name)
                    .is_none()
                {
                    self.session
                        .execute("linetype", &json!({"load":name}))
                        .map_err(|e| e.to_string())?;
                }
            }
            if selected {
                self.session
                    .execute("properties.set", p)
                    .map_err(|e| e.to_string())?;
                // Patent synchronization bakes ByBlock children. Restore inheritance only
                // for the uniform parts of our parametric figures, on a private copy.
                let d = self.session.doc_mut().map_err(|e| e.to_string())?;
                for handle in p["handles"].as_array().into_iter().flatten() {
                    let h =
                        cadcraft_engine::doc::Handle::parse_hex(handle.as_str().ok_or("对象无效")?)
                            .ok_or("对象无效")?;
                    let Some(entity) = before.doc.model.get(h) else {
                        continue;
                    };
                    if crate::gear::info(&before.doc, entity).is_none()
                        && crate::spring::info(&before.doc, entity).is_none()
                        && crate::chain::info(&before.doc, entity).is_none()
                    {
                        continue;
                    }
                    let cadcraft_engine::doc::EntityKind::Insert(insert) = &entity.kind else {
                        continue;
                    };
                    let source = before.doc.block(&insert.block).ok_or("图形定义已不存在")?;
                    let appearance = values(&before.doc, &entity.common);
                    let mut block = (**source).clone();
                    block.name = format!("PW_APPEARANCE_{}", d.new_handle().hex());
                    block.entities = cadcraft_engine::doc::EntityStore::new();
                    for child in source.entities.iter() {
                        let mut child = (**child).clone();
                        let old = values(&before.doc, &child.common);
                        child.handle = d.new_handle();
                        if p.get("color").is_some()
                            && (child.common.color == Color::ByBlock
                                || old["color"] == appearance["color"])
                        {
                            child.common.color = Color::ByBlock;
                        }
                        if p.get("lineweight").is_some()
                            && (child.common.lineweight == Lineweight::ByBlock
                                || old["lineweight"] == appearance["lineweight"])
                        {
                            child.common.lineweight = Lineweight::ByBlock;
                        }
                        if p.get("linetype").is_some()
                            && (child.common.linetype.eq_ignore_ascii_case("ByBlock")
                                || old["linetype"] == appearance["linetype"])
                        {
                            child.common.linetype = "ByBlock".into();
                        }
                        block.entities.push(child);
                    }
                    let name = block.name.clone();
                    d.blocks.insert(name.clone(), std::sync::Arc::new(block));
                    d.modify_entity(h, |e| {
                        if let cadcraft_engine::doc::EntityKind::Insert(i) = &mut e.kind {
                            i.block = name;
                        }
                    })
                    .map_err(|e| e.to_string())?;
                    let referenced=d.model.iter().chain(d.layouts.iter().flat_map(|l|l.entities.iter())).chain(d.blocks.values().flat_map(|b|b.entities.iter())).any(|e|matches!(&e.kind,cadcraft_engine::doc::EntityKind::Insert(i) if i.block.eq_ignore_ascii_case(&insert.block)));
                    if !referenced {
                        d.blocks.remove(&source.name);
                    }
                }
            } else {
                for (key, command, arg) in [
                    ("color", "color", "color"),
                    ("lineweight", "lweight", "lineweight"),
                    ("linetype", "linetype", "current"),
                ] {
                    if let Some(v) = p.get(key) {
                        self.session
                            .execute(command, &json!({arg:v}))
                            .map_err(|e| e.to_string())?;
                    }
                }
                if p.get("color").is_some() {
                    let d = self.session.doc_mut().map_err(|e| e.to_string())?;
                    save_color(d);
                }
            }
            Ok(())
        })();
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        if let Err(e) = outcome {
            *state = before;
            return Err(e);
        }
        let doc = state.doc.clone();
        *state = before;
        state.push_undo(Snapshot {
            label: "特性".into(),
            doc: state.doc.clone(),
            selection: state.selection.clone(),
        });
        state.doc = doc;
        state.revision += 1;
        self.hatch_preview = None;
        Ok(json!({"changed":true}).to_string())
    }
}

/// Preserve engine tessellation, colors and masks while applying the resolved lineweights
/// that the upstream SVG writer currently omits. The unit also keeps screen weights stable.
pub(crate) fn svg(d: &Drawing, window: Option<cadcraft_engine::geom::Bounds2>) -> String {
    let list = cadcraft_engine::render::build(
        d,
        &cadcraft_engine::doc::Space::Model,
        &cadcraft_engine::render::Options {
            lineweights: true,
            ..Default::default()
        },
    );
    let original = cadcraft_io::svg::export_list(&list, window);
    let mut widths = list
        .prims
        .iter()
        .filter(|p| {
            matches!(
                p.kind,
                cadcraft_engine::render::Kind::Polyline
                    | cadcraft_engine::render::Kind::Point
                    | cadcraft_engine::render::Kind::Infinite { .. }
            )
        })
        .map(|p| (p.lw / 0.25).max(0.5));
    let mut output = String::with_capacity(original.len());
    let mut rest = original.as_str();
    let mut unit = None;
    while let Some(start) = rest.find("stroke-width=\"") {
        let end = start + 14;
        output.push_str(&rest[..end]);
        rest = &rest[end..];
        let quote = rest.find('"').unwrap_or(0);
        let base = rest[..quote].parse::<f64>().unwrap_or(0.0);
        unit.get_or_insert(base);
        output.push_str(&format!(
            "{:.6}",
            base * f64::from(widths.next().unwrap_or(1.0))
        ));
        rest = &rest[quote..];
    }
    output.push_str(rest);
    if let Some(unit) = unit.filter(|u| *u > 0.0) {
        output = output.replacen(
            "<svg ",
            &format!("<svg data-cad-stroke-unit=\"{unit}\" "),
            1,
        );
    }
    output
}
