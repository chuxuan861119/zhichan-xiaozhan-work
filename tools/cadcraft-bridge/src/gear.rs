//! Patent-diagram gears: bounded illustrative involute profiles, not manufacturing calculations.
use crate::CadcraftSession;
use cadcraft_engine::{
    Snapshot,
    doc::{Block, Circle, Drawing, Entity, EntityKind, Handle, Insert, LwPolyline, Space},
    geom::{PolyVertex, Vec2, Vec3},
};
use serde_json::{Value, json};
use std::{
    f64::consts::{PI, TAU},
    sync::Arc,
};
const PREFIX: &str = "PatentWorkbenchGear:1:";
#[derive(Clone)]
struct Spec {
    kind: String,
    teeth: usize,
    hole: bool,
}
impl Spec {
    fn parse(p: &Value) -> Result<Self, String> {
        let kind = p["kind"].as_str().ok_or("请选择齿轮类型")?;
        if !["external", "internal", "rack"].contains(&kind) {
            return Err("齿轮类型无效".into());
        }
        let teeth = p["teeth"].as_u64().ok_or("齿数须为整数")?;
        let min = if kind == "rack" { 2 } else { 8 };
        if !(min..=120).contains(&teeth) {
            return Err(format!("齿数须为 {min}～120 的整数"));
        }
        Ok(Self {
            kind: kind.into(),
            teeth: teeth as usize,
            hole: kind == "external" && p["hole"].as_bool().unwrap_or(true),
        })
    }
    fn value(&self) -> Value {
        json!({"kind":self.kind,"teeth":self.teeth,"hole":self.hole})
    }
    fn diameter_factor(&self) -> f64 {
        if self.kind == "rack" { 1.0 } else { 2.0 }
    }
}
fn finite(p: &Value, key: &str) -> Result<f64, String> {
    p[key]
        .as_f64()
        .filter(|n| n.is_finite() && n.abs() <= 1e9)
        .ok_or_else(|| format!("{key} 数值无效"))
}
fn inv(r: f64, base: f64) -> f64 {
    let t = ((r / base).powi(2) - 1.0).max(0.0).sqrt();
    t - t.atan()
}
fn profile(spec: &Spec) -> Vec<Vec2> {
    let n = spec.teeth;
    if spec.kind == "rack" {
        let pitch = 1.0 / n as f64;
        let mut points = vec![Vec2::new(0.0, -0.8 * pitch), Vec2::ZERO];
        for i in 0..n {
            for (x, y) in [
                (0.15, 0.0),
                (0.35, 0.65),
                (0.65, 0.65),
                (0.85, 0.0),
                (1.0, 0.0),
            ] {
                points.push(Vec2::new((i as f64 + x) * pitch, y * pitch));
            }
        }
        points.push(Vec2::new(1.0, -0.8 * pitch));
        return points;
    }
    let internal = spec.kind == "internal";
    let module = 2.0 / (n as f64 + if internal { 5.5 } else { 2.0 });
    let pitch = module * n as f64 / 2.0;
    let root = if internal {
        pitch + 1.25 * module
    } else {
        (pitch - 1.25 * module).max(0.1)
    };
    let tip = if internal { pitch - module } else { 1.0 };
    let base = pitch * 20.0_f64.to_radians().cos();
    let half = |r: f64| {
        PI / (2.0 * n as f64)
            + (if internal { 1.0 } else { -1.0 }) * (inv(r.max(base), base) - inv(pitch, base))
    };
    let mut points = Vec::with_capacity(n * 22);
    let at = |r: f64, t: f64| Vec2::new(r * t.cos(), r * t.sin());
    for i in 0..n {
        let angle = TAU * i as f64 / n as f64;
        for j in 0..=7 {
            let r = root + (tip - root) * j as f64 / 7.0;
            points.push(at(r, angle - half(r)));
        }
        for j in 1..=3 {
            points.push(at(
                tip,
                angle - half(tip) + 2.0 * half(tip) * j as f64 / 3.0,
            ));
        }
        for j in 1..=7 {
            let r = tip + (root - tip) * j as f64 / 7.0;
            points.push(at(r, angle + half(r)));
        }
        let a = angle + half(root);
        let b = angle + TAU / n as f64 - half(root);
        for j in 1..=3 {
            points.push(at(root, a + (b - a) * j as f64 / 3.0));
        }
    }
    // The root arc meets the next flank at exactly the same vertex.
    points.dedup_by(|a, b| (*a - *b).len() < 1e-10);
    // Closed polylines carry their closing edge; do not add a duplicate endpoint.
    if points.len() > 2 && (points[0] - *points.last().unwrap()).len() < 1e-10 {
        points.pop();
    }
    points
}
fn kinds(spec: &Spec) -> Vec<EntityKind> {
    let mut out = vec![EntityKind::LwPolyline(LwPolyline {
        vertices: profile(spec).into_iter().map(PolyVertex::new).collect(),
        closed: true,
        const_width: 0.0,
        elevation: 0.0,
        plinegen: false,
    })];
    if spec.kind == "internal" || spec.hole {
        out.push(EntityKind::Circle(Circle {
            center: Vec3::ZERO,
            radius: if spec.kind == "internal" { 1.0 } else { 0.23 },
        }));
    }
    out
}
pub(crate) fn info(doc: &Drawing, e: &Entity) -> Option<Value> {
    let EntityKind::Insert(ins) = &e.kind else {
        return None;
    };
    let block = doc.block(&ins.block)?;
    let spec =
        Spec::parse(&serde_json::from_str::<Value>(block.description.strip_prefix(PREFIX)?).ok()?)
            .ok()?;
    let size = ins.scale.x.abs() * spec.diameter_factor();
    if !size.is_finite() || size <= 0.0 {
        return None;
    }
    let mut value = spec.value();
    value["size"] = json!(size);
    Some(value)
}

/// Stable semantic grip order: move, uniform size, tooth count, then centred rotation.
pub(crate) fn grips(doc: &Drawing, e: &Entity) -> Option<Vec<Vec2>> {
    let value = info(doc, e)?;
    let EntityKind::Insert(ins) = &e.kind else { return None; };
    let rack = value["kind"] == "rack";
    let teeth = value["teeth"].as_u64()? as f64;
    let mut local = vec![Vec2::ZERO, Vec2::new(1.0, 0.0),
        if rack { Vec2::new(0.5, -(2.5 / teeth).max(0.1)) } else { Vec2::new(-1.25, 0.0) }];
    if !rack { local.push(Vec2::new(0.0, 1.4)); }
    Some(local.into_iter().map(|p| ins.insert.xy() + Vec2::new(p.x * ins.scale.x, p.y * ins.scale.y).rotate(ins.rotation)).collect())
}

impl CadcraftSession {
    pub(crate) fn gear_grip(&mut self, p: &Value) -> Result<Option<String>, String> {
        let Some(handle) = p["handle"].as_str().and_then(Handle::parse_hex) else { return Ok(None); };
        let doc = self.session.doc().map_err(|e| e.to_string())?;
        let Some(entity) = doc.model.get(handle) else { return Ok(None); };
        let Some(mut value) = info(doc, entity) else { return Ok(None); };
        let index = p["index"].as_u64().ok_or("齿轮控制点无效")? as usize;
        if index == 0 { return Ok(None); } // The ordinary insertion grip still moves the block.
        let points = grips(doc, entity).ok_or("齿轮控制点不可用")?;
        let from = *points.get(index).ok_or("齿轮控制点无效")?;
        let xy: [f64;2] = serde_json::from_value(p["to"].clone()).map_err(|_|"控制点坐标无效")?;
        if xy.iter().any(|n| !n.is_finite() || n.abs() > 1e9) { return Err("控制点坐标无效".into()); }
        let to = Vec2::new(xy[0],xy[1]);
        let EntityKind::Insert(ins) = &entity.kind else { unreachable!(); };
        let center = ins.insert.xy();
        let size = value["size"].as_f64().ok_or("齿轮大小无效")?;
        let unchanged = || Ok(Some(json!({"changed":false}).to_string()));
        match index {
            1 => {
                let next = (size * (to-center).len() / (from-center).len()).clamp(1e-5,1e8);
                if (next-size).abs() <= size*1e-10 { return unchanged(); }
                value["size"] = json!(next);
            }
            2 => {
                let direction = if value["kind"] == "rack" {
                    Vec2::new(0.0,-ins.scale.y.signum()).rotate(ins.rotation)
                } else { (from-center) / (from-center).len() };
                let delta = to-from;
                let previous = value["teeth"].as_f64().ok_or("齿数无效")?;
                let next = (previous + (delta.x*direction.x+delta.y*direction.y)/(size*0.025)).round()
                    .clamp(if value["kind"]=="rack"{2.0}else{8.0},120.0) as u64;
                if value["teeth"].as_u64()==Some(next) { return unchanged(); }
                value["teeth"] = json!(next);
            }
            3 => {
                let target = to-center;
                if target.len() < 1e-10 { return unchanged(); }
                let source = from-center;
                // Pointer gestures carry their accumulated turn count; old callers still use the shortest arc.
                let delta = if p.get("angle").is_some() { finite(p,"angle")?.to_radians() }
                    else { (target.y.atan2(target.x)-source.y.atan2(source.x)+PI).rem_euclid(TAU)-PI };
                if delta.abs()<1e-10 { return unchanged(); }
                value["rotation"] = json!((ins.rotation+delta).to_degrees());
            }
            _ => return Err("齿轮控制点无效".into()),
        }
        value["handle"] = json!(handle.hex());
        self.gear(&value).map(Some)
    }

    pub(crate) fn gear(&mut self, p: &Value) -> Result<String, String> {
        let spec = Spec::parse(p)?;
        let size = finite(p, "size")?;
        if size <= 1e-6 || size > 1e8 {
            return Err("图形大小须大于 0 且不超过 100000000".into());
        }
        let handle = p
            .get("handle")
            .map(|h| h.as_str().and_then(Handle::parse_hex).ok_or("齿轮对象无效"))
            .transpose()?;
        let state = self.session.state().map_err(|e| e.to_string())?;
        let mut doc = (*state.doc).clone();
        let mut common = self.current_common();
        let mut insert = if let Some(handle) = handle {
            let e = doc.model.get(handle).ok_or("齿轮已不存在")?;
            if doc.layer(&e.common.layer).is_some_and(|l| l.locked) {
                return Err("齿轮位于锁定图层".into());
            }
            let previous = info(&doc, e).ok_or("选中对象已不是可调整的齿轮")?;
            if previous["kind"] != spec.kind {
                return Err("不能通过参数修改齿轮类型".into());
            }
            common = e.common.clone();
            let EntityKind::Insert(old) = &e.kind else {
                unreachable!()
            };
            let mut ins = old.clone();
            let ratio = size / previous["size"].as_f64().ok_or("齿轮大小无效")?;
            ins.scale.x *= ratio;
            ins.scale.y *= ratio;
            if p.get("rotation").is_some() { ins.rotation = finite(p,"rotation")?.to_radians(); }
            ins
        } else {
            if doc.layer(&common.layer).is_some_and(|l| l.locked) {
                return Err("当前图层已锁定".into());
            }
            let xy: [f64; 2] =
                serde_json::from_value(p["at"].clone()).map_err(|_| "请指定齿轮位置")?;
            if xy.iter().any(|n| !n.is_finite() || n.abs() > 1e9) {
                return Err("齿轮位置无效".into());
            }
            let rotation = finite(p, "rotation")?.to_radians();
            let scale = size / spec.diameter_factor();
            Insert {
                block: String::new(),
                insert: Vec3::new(xy[0], xy[1], 0.0),
                scale: Vec3::new(scale, scale, 1.0),
                rotation,
                attribs: vec![],
                rows: 1,
                cols: 1,
                row_spacing: 0.0,
                col_spacing: 0.0,
            }
        };
        let previous_block = if handle.is_some() {
            Some(insert.block.clone())
        } else {
            None
        };
        let name = format!("PW_GEAR_V1_{}", doc.new_handle().hex());
        let mut block = Block::new(&name);
        block.description = format!("{PREFIX}{}", spec.value());
        for kind in kinds(&spec) {
            let mut child = Entity::new(doc.new_handle(), kind);
            child.common.color = cadcraft_engine::doc::color::Color::ByBlock;
            child.common.lineweight = cadcraft_engine::doc::Lineweight::ByBlock;
            child.common.linetype = "ByBlock".into();
            block.entities.push(child);
        }
        doc.blocks.insert(name.clone(), Arc::new(block));
        insert.block = name;
        let h = if let Some(handle) = handle {
            doc.model.replace(Entity {
                handle,
                common,
                kind: EntityKind::Insert(insert),
            });
            handle
        } else {
            doc.add(&Space::Model, common, EntityKind::Insert(insert))
                .map_err(|e| e.to_string())?
        };
        if let Some(old) = previous_block {
            let references = doc
                .model
                .iter()
                .chain(doc.blocks.values().flat_map(|block| block.entities.iter()))
                .any(|entity| matches!(&entity.kind,EntityKind::Insert(i) if i.block==old));
            if !references {
                doc.blocks.remove(&old);
            }
        }
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        state.push_undo(Snapshot {
            label: "齿轮".into(),
            doc: state.doc.clone(),
            selection: state.selection.clone(),
        });
        state.doc = Arc::new(doc);
        state.revision += 1;
        self.hatch_preview = None;
        Ok(json!({"handle":h.hex(),"handles":[h.hex()]}).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagram_profiles_are_bounded_finite_and_have_no_zero_length_edges() {
        for kind in ["external", "internal", "rack"] {
            for teeth in [8, 20, 120] {
                let s = Spec {
                    kind: kind.into(),
                    teeth,
                    hole: true,
                };
                let points = profile(&s);
                assert!(points.len() < 3000);
                for (a, b) in points
                    .iter()
                    .zip(points.iter().cycle().skip(1))
                    .take(points.len())
                {
                    assert!(a.x.is_finite() && a.y.is_finite());
                    assert!((*a - *b).len() > 1e-12);
                    if kind != "rack" {
                        assert!(a.len() <= 1.00000001);
                    }
                    if kind == "external" {
                        assert!(a.len() > 0.23);
                    }
                }
            }
        }
    }
}
