//! Editable patent-diagram chain drives. Geometry is intentionally not a manufacturing model.
use crate::CadcraftSession;
use cadcraft_engine::{
    Snapshot,
    doc::{Block, Drawing, Entity, EntityKind, Handle, Insert, LwPolyline, Space},
    geom::{PolyVertex, Vec2, Vec3},
};
use serde_json::{Value, json};
use std::{
    f64::consts::{PI, TAU},
    sync::Arc,
};
const PREFIX: &str = "PatentWorkbenchChain:1:";
fn offsets() -> &'static Vec<f64> {
    static DATA: std::sync::OnceLock<Vec<f64>> = std::sync::OnceLock::new();
    DATA.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!(
            "../../../src/shared/drawing-markup/sprocket-profile.json"
        ))
        .expect("bundled tooth profile");
        v["radialOffsets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_f64().unwrap())
            .collect()
    })
}
#[derive(Clone)]
struct Spec {
    single: bool,
    at: Vec2,
    end: Vec2,
    r: f64,
    r2: f64,
    n: usize,
    n2: usize,
    h: f64,
    h2: f64,
    flip: bool,
}
fn number(p: &Value, key: &str) -> Result<f64, String> {
    p[key]
        .as_f64()
        .filter(|n| n.is_finite() && n.abs() <= 1e9)
        .ok_or_else(|| format!("{key} 数值无效"))
}
fn point(p: &Value, key: &str) -> Result<Vec2, String> {
    let a: [f64; 2] = serde_json::from_value(p[key].clone()).map_err(|_| "链轮位置无效")?;
    if a.iter().any(|n| !n.is_finite() || n.abs() > 1e9) {
        return Err("链轮位置无效".into());
    }
    Ok(Vec2::new(a[0], a[1]))
}
fn radius_for_teeth(pitch: f64, teeth: usize) -> f64 {
    pitch / (2.0 * (PI / teeth as f64).sin())
}
fn wheel_for_radius(pitch: f64, target: f64, limit: f64) -> (usize, f64) {
    let mut best = (8, radius_for_teeth(pitch, 8));
    let mut error = f64::INFINITY;
    for n in 8..=120 {
        let r = radius_for_teeth(pitch, n);
        if r >= 1e-4 && r <= limit.min(1e8) + 1e-9 && (r - target).abs() < error {
            best = (n, r);
            error = (r - target).abs();
        }
    }
    best
}
impl Spec {
    fn parse(p: &Value) -> Result<Self, String> {
        let n = p["teeth"]
            .as_u64()
            .filter(|n| (8..=120).contains(n))
            .ok_or("齿数须为 8～120 的整数")? as usize;
        let n2 = p["otherTeeth"]
            .as_u64()
            .filter(|n| (8..=120).contains(n))
            .ok_or("齿数须为 8～120 的整数")? as usize;
        let r = number(p, "radius")?;
        let r2 = if p.get("otherRadius").is_some() {
            number(p, "otherRadius")?
        } else {
            r * (PI / n as f64).sin() / (PI / n2 as f64).sin()
        };
        let s = Self {
            single: p["single"].as_bool().ok_or("请选择链传动或单个链轮")?,
            at: point(p, "at")?,
            end: point(p, "end")?,
            r,
            r2,
            n,
            n2,
            h: number(p, "hole")?,
            h2: number(p, "otherHole")?,
            flip: p["flip"].as_bool().unwrap_or(false),
        };
        s.validate()?;
        Ok(s)
    }
    fn validate(&self) -> Result<(), String> {
        let s = self;
        let (r, r2) = (s.r, s.r2);
        if r < 1e-4
            || r2 < 1e-4
            || r > 1e8
            || r2 > 1e8
            || s.h < 0.0
            || s.h > r * 0.5
            || s.h2 < 0.0
            || s.h2 > r2 * 0.5
        {
            return Err("轮径或轴孔大小无效；轴孔半径不得超过轮半径的一半".into());
        }
        let d = (s.end - s.at).len();
        if d < 1e-6 || d > 1e8 || (!s.single && d < (r + r2) * 1.08 - 1e-8) {
            return Err("两轮距离过近，请拉开轮心或减小轮径".into());
        }
        Ok(())
    }
    fn pitch(&self) -> f64 {
        2.0 * self.r * (PI / self.n as f64).sin()
    }
    fn match_pitch(&mut self) {
        let first_pitch = self.pitch();
        let other_pitch = 2.0 * self.r2 * (PI / self.n2 as f64).sin();
        let pitch = if self.single
            || (first_pitch - other_pitch).abs() <= first_pitch.max(other_pitch) * 1e-9
        {
            first_pitch
        } else {
            first_pitch.min(other_pitch)
        };
        if !self.single {
            (self.n, self.r) =
                wheel_for_radius(pitch, self.r, (self.end - self.at).len() / 1.08 - self.r2);
            self.h = self.h.min(self.r * 0.5);
        }
        let (n, r) = if self.single {
            (self.n2, radius_for_teeth(pitch, self.n2))
        } else {
            wheel_for_radius(pitch, self.r2, (self.end - self.at).len() / 1.08 - self.r)
        };
        self.n2 = n;
        self.r2 = r;
        self.h2 = self.h2.min(r * 0.5);
    }
    fn wheel_size(&mut self, right: bool, target: f64) {
        self.match_pitch();
        let limit = if self.single {
            1e8
        } else {
            (self.end - self.at).len() / 1.08 - if right { self.r } else { self.r2 }
        };
        let (n, r) = wheel_for_radius(self.pitch(), target, limit);
        if right {
            self.n2 = n;
            self.r2 = r;
            self.h2 = self.h2.min(r * 0.5);
        } else {
            self.n = n;
            self.r = r;
            self.h = self.h.min(r * 0.5);
        }
    }
    fn value(&self) -> Value {
        json!({"single":self.single,"at":[self.at.x,self.at.y],"end":[self.end.x,self.end.y],"radius":self.r,"otherRadius":self.r2,"teeth":self.n,"otherTeeth":self.n2,"hole":self.h,"otherHole":self.h2,"flip":self.flip})
    }
    fn world(&self, p: Vec2) -> Vec2 {
        let u = (self.end - self.at) / (self.end - self.at).len();
        let y = p.y * if self.flip { -1.0 } else { 1.0 };
        self.at + Vec2::new(u.x * p.x - u.y * y, u.y * p.x + u.x * y)
    }
    fn grips(&self) -> Vec<Vec2> {
        let d = (self.end - self.at).len();
        let points = if self.single {
            vec![
                (0.0, 0.0),
                (0.0, self.r),
                (0.0, -self.h.max(self.r * 0.15)),
                (self.r * 1.5, self.r * 1.5),
            ]
        } else {
            vec![
                (d / 2.0, 0.0),
                (0.0, 0.0),
                (d, 0.0),
                (0.0, self.r),
                (d, self.r2),
                (0.0, -self.h.max(self.r * 0.15)),
                (d, -self.h2.max(self.r2 * 0.15)),
                (d + self.r, self.r * 1.6),
            ]
        };
        points
            .into_iter()
            .map(|(x, y)| self.world(Vec2::new(x, y)))
            .collect()
    }
}
fn read(doc: &Drawing, e: &Entity) -> Option<Spec> {
    let EntityKind::Insert(i) = &e.kind else {
        return None;
    };
    // Nonuniform external edits remain ordinary editable CAD geometry, never silently reshaped.
    if (i.scale.x.abs() - i.scale.y.abs()).abs() > 1e-7 * i.scale.x.abs() || i.scale.x.abs() < 1e-10
    {
        return None;
    }
    let mut s = Spec::parse(
        &serde_json::from_str::<Value>(doc.block(&i.block)?.description.strip_prefix(PREFIX)?)
            .ok()?,
    )
    .ok()?;
    let transform =
        |p: Vec2| i.insert.xy() + Vec2::new(p.x * i.scale.x, p.y * i.scale.y).rotate(i.rotation);
    s.at = transform(s.at);
    s.end = transform(s.end);
    let k = i.scale.x.abs();
    s.r *= k;
    s.r2 *= k;
    s.h *= k;
    s.h2 *= k;
    s.flip ^= i.scale.x * i.scale.y < 0.0;
    Some(s)
}
pub(crate) fn info(doc: &Drawing, e: &Entity) -> Option<Value> {
    read(doc, e).map(|s| s.value())
}
pub(crate) fn grips(doc: &Drawing, e: &Entity) -> Option<Vec<Vec2>> {
    read(doc, e).map(|s| s.grips())
}
fn arc(cx: f64, cy: f64, r: f64, a: f64, b: f64, count: usize) -> Vec<Vec2> {
    (0..=count)
        .map(|i| {
            let t = a + (b - a) * i as f64 / count as f64;
            Vec2::new(cx + r * t.cos(), cy + r * t.sin())
        })
        .collect()
}
fn wheel(
    paths: &mut Vec<Vec<Vec2>>,
    s: &Spec,
    cx: f64,
    r: f64,
    n: usize,
    h: f64,
    left: bool,
    theta: f64,
) {
    let pitch = 2.0 * r * (PI / n as f64).sin();
    let inset = pitch / r * 0.48;
    let (start, end) = if s.single {
        (0.0, TAU)
    } else if left {
        (-theta + inset, theta - inset)
    } else {
        (theta + inset, TAU - theta - inset)
    };
    let count = ((end - start) / TAU * n as f64 * 64.0).ceil() as usize;
    let profile = (0..=count)
        .map(|i| {
            let a = start + (end - start) * i as f64 / count as f64;
            let t = (a / TAU * n as f64 - 0.25).rem_euclid(1.0);
            let u = t * 64.0;
            let k = (u.floor() as usize).min(63);
            let rr =
                r + pitch * (offsets()[k] + (offsets()[k + 1] - offsets()[k]) * (u - k as f64));
            Vec2::new(cx + rr * a.cos(), rr * a.sin())
        })
        .filter(|p| s.single || p.y.abs() * theta.sin() + p.x * theta.cos() < s.r - pitch * 0.51)
        .collect();
    paths.push(profile);
    paths.push(arc(cx, 0.0, r - pitch * 0.55, 0.0, TAU, 128));
    paths.push(arc(cx, 0.0, r - pitch * 0.46, 0.0, TAU, 128));
    if h > 0.0 {
        let a = 0.28_f64.acos();
        let mut p = arc(cx, 0.0, h, PI - a, TAU + a, 80);
        p.push(Vec2::new(cx + h * 0.28, h * 1.15));
        p.push(Vec2::new(cx - h * 0.28, h * 1.15));
        p.push(p[0]);
        paths.push(p);
    }
}
fn paths(s: &Spec) -> Vec<Vec<Vec2>> {
    let d = (s.end - s.at).len();
    let theta = ((s.r - s.r2) / d).clamp(-1.0, 1.0).acos();
    let mut paths = vec![];
    wheel(&mut paths, s, 0.0, s.r, s.n, s.h, true, theta);
    if !s.single {
        wheel(&mut paths, s, d, s.r2, s.n2, s.h2, false, theta);
        let straight = (d * d - (s.r - s.r2).powi(2)).max(0.0).sqrt();
        let right = 2.0 * theta * s.r2;
        let left = (TAU - 2.0 * theta) * s.r;
        let total = 2.0 * straight + right + left;
        let nominal = 2.0 * s.r * (PI / s.n as f64).sin();
        let links = (2.0 * (total / nominal / 2.0).round()).clamp(12.0, 512.0) as usize;
        let step = total / links as f64;
        let track = |mut z: f64| {
            if z < straight {
                return Vec2::new(
                    s.r * theta.cos() + z * theta.sin(),
                    s.r * theta.sin() - z * theta.cos(),
                );
            }
            z -= straight;
            if z < right {
                let a = theta - z / s.r2;
                return Vec2::new(d + s.r2 * a.cos(), s.r2 * a.sin());
            }
            z -= right;
            if z < straight {
                return Vec2::new(
                    d + s.r2 * theta.cos() - z * theta.sin(),
                    -s.r2 * theta.sin() - z * theta.cos(),
                );
            }
            z -= straight;
            let a = -theta - z / s.r;
            Vec2::new(s.r * a.cos(), s.r * a.sin())
        };
        let pins: Vec<_> = (0..links).map(|i| track(i as f64 * step)).collect();
        let w = step * 0.45;
        for i in 0..links {
            let a = pins[i];
            let b = pins[(i + 1) % links];
            let angle = (b.y - a.y).atan2(b.x - a.x);
            if i % 2 == 0 {
                let mut p = arc(b.x, b.y, w, angle - PI / 2.0, angle + PI / 2.0, 12);
                p.extend(arc(
                    a.x,
                    a.y,
                    w,
                    angle + PI / 2.0,
                    angle + 3.0 * PI / 2.0,
                    12,
                ));
                p.push(p[0]);
                paths.push(p);
            } else {
                let before = pins[(i + links - 1) % links];
                let after = pins[(i + 2) % links];
                let before_angle = (a.y - before.y).atan2(a.x - before.x);
                let after_angle = (after.y - b.y).atan2(after.x - b.x);
                for sign in [-1.0, 1.0] {
                    let normal = Vec2::new(-angle.sin() * sign, angle.cos() * sign);
                    paths.push(vec![
                        a + Vec2::new(-before_angle.sin(), before_angle.cos()) * (sign * w),
                        (a + b) / 2.0 + normal * w * 0.82,
                        b + Vec2::new(-after_angle.sin(), after_angle.cos()) * (sign * w),
                    ]);
                }
            }
            paths.push(arc(a.x, a.y, step * 0.145, 0.0, TAU, 20));
        }
    }
    paths
        .into_iter()
        .filter(|p| p.len() > 1)
        .map(|p| p.into_iter().map(|v| s.world(v)).collect())
        .collect()
}
impl CadcraftSession {
    pub(crate) fn chain_grip(&mut self, p: &Value) -> Result<Option<String>, String> {
        let Some(h) = p["handle"].as_str().and_then(Handle::parse_hex) else {
            return Ok(None);
        };
        let doc = self.session.doc().map_err(|e| e.to_string())?;
        let Some(mut s) = doc.model.get(h).and_then(|e| read(doc, e)) else {
            return Ok(None);
        };
        s.match_pitch();
        let index = p["index"]
            .as_u64()
            .filter(|i| *i < 8)
            .ok_or("链轮控制点无效")? as usize;
        let to = point(p, "to")?;
        let from = *s.grips().get(index).ok_or("链轮控制点无效")?;
        let index = if s.single { [0, 3, 5, 7][index] } else { index };
        let d = (s.end - s.at).len();
        let u = (s.end - s.at) / d;
        let v = to - s.at;
        let y = (-v.x * u.y + v.y * u.x).abs();
        match index {
            0 => {
                let delta = to - from;
                s.at = s.at + delta;
                s.end = s.end + delta;
            }
            1 | 2 => {
                let anchor = if index == 1 { s.end } else { s.at };
                let delta = to - anchor;
                let len = delta.len();
                if len > 1e-12 {
                    let factor = if s.single {
                        1.0
                    } else {
                        ((s.r + s.r2) * 1.08).max(len) / len
                    };
                    if index == 1 {
                        s.at = anchor + delta * factor
                    } else {
                        s.end = anchor + delta * factor
                    }
                }
            }
            3 | 4 => s.wheel_size(index == 4, y),
            5 => s.h = y.clamp(0.0, s.r * 0.5),
            6 => s.h2 = y.clamp(0.0, s.r2 * 0.5),
            7 => {
                let f = ((to - s.at).len() / (from - s.at).len())
                    .clamp(1e-4 / s.r.min(s.r2), 1e8 / s.r.max(s.r2).max(d));
                s.r *= f;
                s.r2 *= f;
                s.h *= f;
                s.h2 *= f;
                s.end = s.at + (s.end - s.at) * f;
            }
            _ => unreachable!(),
        }
        let mut value = s.value();
        value["handle"] = json!(h.hex());
        self.chain(&value).map(Some)
    }
    pub(crate) fn chain(&mut self, p: &Value) -> Result<String, String> {
        let mut spec = Spec::parse(p)?;
        spec.match_pitch();
        spec.validate()?;
        let handle = p
            .get("handle")
            .map(|v| v.as_str().and_then(Handle::parse_hex).ok_or("链轮对象无效"))
            .transpose()?;
        let state = self.session.state().map_err(|e| e.to_string())?;
        let mut doc = (*state.doc).clone();
        let mut common = self.current_common();
        let mut old = None;
        if let Some(h) = handle {
            let e = doc.model.get(h).ok_or("链轮已不存在")?;
            let previous = read(&doc, e).ok_or("对象不是可调整的链轮")?;
            if previous.single != spec.single {
                return Err("不能通过参数改变链轮类型".into());
            }
            common = e.common.clone();
            if let EntityKind::Insert(i) = &e.kind {
                old = Some(i.block.clone());
            }
        }
        if doc.layer(&common.layer).is_some_and(|l| l.locked) {
            return Err("对象位于锁定图层".into());
        }
        let d = (spec.end - spec.at).len();
        let angle = (spec.end.y - spec.at.y).atan2(spec.end.x - spec.at.x);
        let mut local = spec.clone();
        local.at = Vec2::ZERO;
        local.end = Vec2::new(d, 0.0);
        let name = format!("PW_CHAIN_V1_{}", doc.new_handle().hex());
        let mut block = Block::new(&name);
        block.description = format!("{PREFIX}{}", local.value());
        for mut path in paths(&local) {
            let closed = (path[0] - *path.last().unwrap()).len() < 1e-8;
            if closed {
                path.pop();
            }
            let mut e = Entity::new(
                doc.new_handle(),
                EntityKind::LwPolyline(LwPolyline {
                    vertices: path.into_iter().map(PolyVertex::new).collect(),
                    closed,
                    const_width: 0.0,
                    elevation: 0.0,
                    plinegen: false,
                }),
            );
            e.common.color = cadcraft_engine::doc::color::Color::ByBlock;
            e.common.lineweight = cadcraft_engine::doc::Lineweight::ByBlock;
            e.common.linetype = "ByBlock".into();
            block.entities.push(e);
        }
        doc.blocks.insert(name.clone(), Arc::new(block));
        let insert = EntityKind::Insert(Insert {
            block: name,
            insert: Vec3::new(spec.at.x, spec.at.y, 0.0),
            scale: Vec3::new(1.0, 1.0, 1.0),
            rotation: angle,
            attribs: vec![],
            rows: 1,
            cols: 1,
            row_spacing: 0.0,
            col_spacing: 0.0,
        });
        let h = if let Some(h) = handle {
            doc.model.replace(Entity {
                handle: h,
                common,
                kind: insert,
            });
            h
        } else {
            doc.add(&Space::Model, common, insert)
                .map_err(|e| e.to_string())?
        };
        if let Some(old) = old {
            let referenced = doc
                .model
                .iter()
                .chain(doc.layouts.iter().flat_map(|layout|layout.entities.iter()))
                .chain(doc.blocks.values().flat_map(|b| b.entities.iter()))
                .any(|e| matches!(&e.kind,EntityKind::Insert(i) if i.block.eq_ignore_ascii_case(&old)));
            if !referenced {
                if let Some(key) = doc
                    .blocks
                    .keys()
                    .find(|key| key.eq_ignore_ascii_case(&old))
                    .cloned()
                {
                    doc.blocks.remove(&key);
                }
            }
        }
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        state.push_undo(Snapshot {
            label: if spec.single { "链轮" } else { "链传动" }.into(),
            doc: state.doc.clone(),
            selection: state.selection.clone(),
        });
        state.doc = Arc::new(doc);
        state.revision += 1;
        self.hatch_preview = None;
        Ok(json!({"handle":h.hex(),"handles":[h.hex()]}).to_string())
    }
}
