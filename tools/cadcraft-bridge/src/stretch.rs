//! Window stretch with an explicit selection: never mutate unselected patent entities.
use crate::CadcraftSession;
use cadcraft_engine::{
    Snapshot,
    doc::{EntityKind, Handle},
    geom::{Arc, Mat3, Vec2},
};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc as Shared};

fn point(v: &Value) -> Result<Vec2, String> {
    let a: [f64; 2] = serde_json::from_value(v.clone()).map_err(|_| "拉伸坐标无效")?;
    if a.iter().any(|n| !n.is_finite() || n.abs() > 1e12) {
        return Err("拉伸坐标超出范围".into());
    }
    Ok(Vec2::new(a[0], a[1]))
}
fn inside(p: Vec2, polygon: &[Vec2]) -> bool {
    let mut result = false;
    for i in 0..polygon.len() {
        let a = polygon[i];
        let b = polygon[(i + 1) % polygon.len()];
        let d = b - a;
        let q = p - a;
        let cross = d.x * q.y - d.y * q.x;
        if cross.abs() <= 1e-9 * d.len().max(1.0)
            && q.dot(d) >= -1e-9
            && q.dot(d) <= d.dot(d) + 1e-9
        {
            return true;
        }
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            result = !result;
        }
    }
    result
}
impl CadcraftSession {
    pub(crate) fn stretch(&mut self, p: &Value) -> Result<String, String> {
        let mut polygon: Vec<Vec2> = p["window"]
            .as_array()
            .ok_or("请框定拉伸范围")?
            .iter()
            .map(point)
            .collect::<Result<_, _>>()?;
        if polygon.len() == 2 {
            let a = polygon[0];
            let b = polygon[1];
            polygon = vec![a, Vec2::new(b.x, a.y), b, Vec2::new(a.x, b.y)];
        }
        if polygon.len() != 4 {
            return Err("拉伸范围必须是四边形".into());
        }
        let a = polygon[1] - polygon[0];
        let b = polygon[3] - polygon[0];
        if a.len() <= 1e-9 || b.len() <= 1e-9 || (a.x * b.y - a.y * b.x).abs() <= 1e-12 {
            return Err("拉伸范围不能是一个点或一条线，请重新框选".into());
        }
        let delta = point(&p["delta"])?;
        if delta.len() <= 1e-12 {
            return Err("拉伸距离必须大于零".into());
        }
        let handles: Vec<String> =
            serde_json::from_value(p["handles"].clone()).map_err(|_| "请选择拉伸对象")?;
        let moved: HashSet<String> =
            serde_json::from_value(p["moveHandles"].clone()).map_err(|_| "缺少完整包含对象")?;
        if handles.is_empty() {
            return Err("范围内没有可拉伸对象".into());
        }
        self.validate_edit("stretch", p)?;
        let state = self.session.state().map_err(|e| e.to_string())?;
        let mut doc = (*state.doc).clone();
        let mut changed = Vec::new();
        for hex in handles {
            let h = Handle::parse_hex(&hex).ok_or("拉伸对象无效")?;
            let old = doc.model.get(h).ok_or("拉伸对象已不存在")?;
            if !doc.is_visible(old) {
                return Err("拉伸对象不可见".into());
            }
            let mut kind = old.kind.clone();
            if moved.contains(&hex) {
                kind.transform(&Mat3::translate(delta));
            } else {
                match &mut kind {
                    EntityKind::Line(l) => {
                        for p in [&mut l.a, &mut l.b] {
                            if inside(p.xy(), &polygon) {
                                p.x += delta.x;
                                p.y += delta.y;
                            }
                        }
                        if (l.a - l.b).len() <= 1e-12 {
                            return Err("拉伸会使线段长度为零，未修改图纸".into());
                        }
                    }
                    EntityKind::LwPolyline(pl) => {
                        for v in &mut pl.vertices {
                            if inside(v.p, &polygon) {
                                v.p += delta;
                            }
                        }
                        if pl
                            .vertices
                            .windows(2)
                            .any(|v| (v[0].p - v[1].p).len() <= 1e-12)
                        {
                            return Err("拉伸会使相邻顶点重合，未修改图纸".into());
                        }
                    }
                    EntityKind::Arc(a) => {
                        let arc = Arc::new(a.center.xy(), a.radius, a.start, a.end);
                        let mut start = arc.start_point();
                        let mut end = arc.end_point();
                        let first = inside(start, &polygon);
                        let last = inside(end, &polygon);
                        if !first && !last {
                            continue;
                        }
                        if first && last {
                            a.center.x += delta.x;
                            a.center.y += delta.y;
                        } else {
                            if first {
                                start += delta;
                            }
                            if last {
                                end += delta;
                            }
                            let next = Arc::from_3_points(start, arc.mid_point(), end)
                                .ok_or("拉伸后无法构成圆弧，未修改图纸")?;
                            a.center.x = next.center.x;
                            a.center.y = next.center.y;
                            a.radius = next.radius;
                            a.start = next.start;
                            a.end = next.end;
                        }
                    }
                    EntityKind::Solid(s) | EntityKind::Trace(s) => {
                        for p in &mut s.corners {
                            if inside(p.xy(), &polygon) {
                                p.x += delta.x;
                                p.y += delta.y;
                            }
                        }
                    }
                    EntityKind::Spline(s) => {
                        if s.fit.is_empty() {
                            for p in &mut s.control {
                                if inside(*p, &polygon) {
                                    *p += delta;
                                }
                            }
                        } else {
                            let fit = s
                                .fit
                                .iter()
                                .map(|p| if inside(*p, &polygon) { *p + delta } else { *p })
                                .collect::<Vec<_>>();
                            if fit != s.fit {
                                *s = s.refit(&fit, s.closed);
                            }
                        }
                    }
                    // Rigid objects are moved only when fully enclosed. In particular
                    // do not change an INSERT's shape or its parameterized definition.
                    _ => continue,
                }
            }
            if kind != old.kind {
                doc.modify_entity(h, |e| e.kind = kind)
                    .map_err(|e| e.to_string())?;
                changed.push(hex);
            }
        }
        if changed.is_empty() {
            return Err("范围内没有可移动的端点或完整对象，请重新框选".into());
        }
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        let before = state.doc.clone();
        state.push_undo(Snapshot {
            label: "局部拉伸".into(),
            doc: before.clone(),
            selection: state.selection.clone(),
        });
        state.doc = Shared::new(doc);
        state.revision += 1;
        cadcraft_engine::assoc::after_command(&mut self.session, Some(&before), None);
        self.hatch_preview = None;
        Ok(json!({"handles":changed,"stretched":changed.len()}).to_string())
    }
}
