//! Single-level EXPLODE over a staged drawing. Unsupported objects never disappear.
use crate::CadcraftSession;
use cadcraft_engine::{
    Session, Snapshot,
    doc::{
        Drawing, Entity, EntityKind, Handle, Line, Lineweight, Text, TextStyle,
        color::{Color, Rgb},
    },
    geom::{Mat3, Vec2, Vec3},
    render,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
const MAX_PARTS: usize = 100_000;
fn entity(source: &Entity, kind: EntityKind) -> Entity {
    Entity {
        handle: Handle(0),
        common: source.common.clone(),
        kind,
    }
}
fn line(source: &Entity, a: Vec2, b: Vec2) -> Entity {
    entity(
        source,
        EntityKind::Line(Line {
            a: a.to3(0.0),
            b: b.to3(0.0),
        }),
    )
}

// SVD of the transformed two ellipse axes; preserve analytic curves, including mirrors.
fn ellipse(
    center: Vec3,
    u: Vec2,
    v: Vec2,
    start: f64,
    end: f64,
    m: &Mat3,
) -> Result<EntityKind, String> {
    let a = m.apply_vec(u);
    let b = m.apply_vec(v);
    let xx = a.x * a.x + b.x * b.x;
    let yy = a.y * a.y + b.y * b.y;
    let xy = a.x * a.y + b.x * b.y;
    let gap = ((xx - yy).powi(2) + 4.0 * xy * xy).sqrt();
    let major = ((xx + yy + gap) / 2.0).max(0.0).sqrt();
    let minor = a.cross(b).abs() / major;
    if !major.is_finite() || !minor.is_finite() || major <= 0.0 || minor <= 0.0 {
        return Err("曲线的变换无效，未修改图纸。".into());
    }
    let angle = 0.5 * (2.0 * xy).atan2(xx - yy);
    let unit = Vec2::from_angle(angle);
    let param = |t: f64| {
        let p = a * t.cos() + b * t.sin();
        (p.dot(unit.perp()) / minor).atan2(p.dot(unit) / major)
    };
    let full = (end - start).abs() >= std::f64::consts::TAU - 1e-10;
    let (st, en) = if full {
        (0.0, std::f64::consts::TAU)
    } else if a.cross(b) < 0.0 {
        (param(end), param(start))
    } else {
        (param(start), param(end))
    };
    Ok(EntityKind::Ellipse(cadcraft_engine::doc::Ellipse {
        center: m.apply(center.xy()).to3(center.z),
        major: (unit * major).to3(0.0),
        ratio: minor / major,
        start: st,
        end: en,
    }))
}
fn transformed(d: &mut Drawing, source: &Entity, m: &Mat3, depth: usize) -> Result<Entity, String> {
    if depth > 64 {
        return Err("块嵌套过深，未修改图纸。".into());
    }
    if !m.det().is_finite() || m.det() == 0.0 {
        return Err("块的比例无效，未修改图纸。".into());
    }
    let mut e = source.clone();
    e.handle = Handle(0);
    let ux = m.apply_vec(Vec2::new(1.0, 0.0));
    let uy = m.apply_vec(Vec2::new(0.0, 1.0));
    let uniform = (ux.len() - uy.len()).abs() < 1e-10 * ux.len().max(uy.len()).max(1.0)
        && ux.dot(uy).abs() < 1e-10 * ux.len() * uy.len();
    match &source.kind {
        EntityKind::LwPolyline(p)
            if !uniform
                && (p.vertices.iter().any(|v| {
                    v.bulge.abs() > 1e-12 || v.start_width != 0.0 || v.end_width != 0.0
                }) || p.const_width != 0.0) =>
        {
            // Like AutoCAD's *E fallback, retain a non-transformable wide/curved polyline
            // in a scaled anonymous block rather than destroying its widths or bulges.
            let u = m.apply_vec(Vec2::new(1.0, 0.0));
            let v = m.apply_vec(Vec2::new(0.0, 1.0));
            if u.dot(v).abs() > 1e-10 * u.len() * v.len() {
                return Err("此含弧多段线的斜切变换暂不能安全分解，原图已保留。".into());
            }
            let name = format!("*E{}", d.new_handle().hex());
            let mut b = cadcraft_engine::doc::Block::new(&name);
            b.anonymous = true;
            b.explodable = false;
            let mut child = source.clone();
            child.handle = d.new_handle();
            b.entities.push(child);
            d.blocks.insert(name.clone(), Arc::new(b));
            e.kind = EntityKind::Insert(cadcraft_engine::doc::Insert {
                block: name,
                insert: m.apply(Vec2::ZERO).to3(0.0),
                scale: Vec3::new(u.len(), m.det() / u.len(), 1.0),
                rotation: u.y.atan2(u.x),
                attribs: Vec::new(),
                rows: 1,
                cols: 1,
                row_spacing: 0.0,
                col_spacing: 0.0,
            });
        }
        EntityKind::Circle(c) if !uniform => {
            e.kind = ellipse(
                c.center,
                Vec2::new(c.radius, 0.0),
                Vec2::new(0.0, c.radius),
                0.0,
                std::f64::consts::TAU,
                m,
            )?
        }
        EntityKind::Arc(c) if !uniform => {
            e.kind = ellipse(
                c.center,
                Vec2::new(c.radius, 0.0),
                Vec2::new(0.0, c.radius),
                c.start,
                c.end,
                m,
            )?
        }
        EntityKind::Ellipse(c) => {
            e.kind = ellipse(
                c.center,
                c.major.xy(),
                c.major.xy().perp() * c.ratio,
                c.start,
                c.end,
                m,
            )?
        }
        EntityKind::Insert(ins) => {
            let block = d.block(&ins.block).ok_or("块定义不存在")?.as_ref().clone();
            let matrix = m.then_before(ins.transform(block.base.xy()));
            let u = matrix.apply_vec(Vec2::new(1.0, 0.0));
            let v = matrix.apply_vec(Vec2::new(0.0, 1.0));
            let mut insert = ins.clone();
            if u.dot(v).abs() < 1e-10 * u.len() * v.len() && u.len() > 1e-12 {
                insert.insert = matrix.apply(block.base.xy()).to3(ins.insert.z);
                insert.rotation = u.y.atan2(u.x);
                insert.scale.x = u.len();
                insert.scale.y = matrix.det() / u.len();
            } else {
                // A sheared nested block cannot be represented by INSERT axes. Keep one reference
                // level, with an anonymous transformed definition, rather than flattening recursively.
                let mut b = block.clone();
                b.name = format!("*E{}", d.new_handle().hex());
                b.base = Vec3::ZERO;
                b.entities = Default::default();
                b.anonymous = true;
                for child in block.entities.iter() {
                    let mut child = transformed(d, child, &matrix, depth + 1)?;
                    child.handle = d.new_handle();
                    b.entities.push(child);
                }
                insert.block = b.name.clone();
                insert.insert = Vec3::ZERO;
                insert.rotation = 0.0;
                insert.scale = Vec3::new(1.0, 1.0, 1.0);
                d.blocks.insert(b.name.clone(), Arc::new(b));
            }
            e.kind = EntityKind::Insert(insert);
        }
        _ => e.kind.transform(m),
    }
    Ok(e)
}
fn hatch(d: &Drawing, e: &Entity) -> Result<Vec<Entity>, String> {
    if let EntityKind::Hatch(h) = &e.kind {
        // Display tessellation may silently omit over-budget line families or
        // dash runs. Never turn such an incomplete display into permanent data.
        crate::hatch::density(d, h)?;
    }
    let list = render::build_entities(
        d,
        std::iter::once(e),
        &render::Options {
            min_dash: 0.0,
            view: None,
            tolerance: 0.001,
            ..Default::default()
        },
    );
    let mut out: Vec<Entity> = Vec::new();
    for primitive in &list.prims {
        let points = list.points(primitive);
        match primitive.kind {
            render::Kind::Polyline => {
                for pair in points.windows(2) {
                    out.push(line(e, pair[0], pair[1]));
                }
            }
            render::Kind::Point => {
                if let Some(p) = points.first() {
                    out.push(entity(
                        e,
                        EntityKind::Point(cadcraft_engine::doc::Point {
                            p: p.to3(0.0),
                            angle: 0.0,
                        }),
                    ));
                }
            }
            render::Kind::Tris => {
                for triangle in points.chunks_exact(3) {
                    let mut part = entity(
                        e,
                        EntityKind::Solid(cadcraft_engine::doc::Solid {
                            corners: [
                                triangle[0].to3(0.0),
                                triangle[1].to3(0.0),
                                triangle[2].to3(0.0),
                                triangle[2].to3(0.0),
                            ],
                        }),
                    );
                    if !primitive.aci7 {
                        part.common.color = Color::True(primitive.color);
                    }
                    out.push(part);
                }
            }
            _ => {}
        }
        if out.len() > MAX_PARTS {
            return Err("分解产生的对象过多，未修改图纸。".into());
        }
    }
    Ok(out)
}
fn mtext(d: &mut Drawing, e: &Entity, t: &cadcraft_engine::doc::MText) -> Vec<Entity> {
    let layout = cadcraft_fonts::with_explode_layout(|| render::layout_mtext_entity(d, t));
    let base_style = d.text_style(&t.style).cloned().unwrap_or_default();
    let mut out: Vec<Entity> = Vec::new();
    for run in layout.explode_text {
        let font = if run.font.is_empty() {
            base_style.font.clone()
        } else {
            run.font
        };
        let style = d
            .text_styles
            .iter()
            .find(|s| s.font == font && !s.backwards && !s.upside_down && !s.vertical)
            .map(|s| s.name.clone())
            .unwrap_or_else(|| {
                let name = format!("PW_EXPLODE_{}", d.new_handle().hex());
                d.text_styles.push(TextStyle {
                    name: name.clone(),
                    font: font.clone(),
                    ..Default::default()
                });
                name
            });
        let mut part = entity(
            e,
            EntityKind::Text(Text {
                insert: run.at.to3(t.insert.z),
                align_pt: None,
                height: run.height,
                value: run.value,
                rotation: t.rotation,
                width_factor: run.width_factor,
                oblique: run.oblique,
                style,
                halign: Default::default(),
                valign: Default::default(),
            }),
        );
        match run.color {
            Some(cadcraft_fonts::MTextColor::Aci(i)) if i > 0 && i <= 255 => {
                part.common.color = Color::Index(i as u8)
            }
            Some(cadcraft_fonts::MTextColor::Rgb(rgb)) => {
                part.common.color = Color::True(Rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8))
            }
            _ => {}
        }
        let mut merged = false;
        if let (Some(previous), EntityKind::Text(next)) = (out.last_mut(), &part.kind) {
            if let EntityKind::Text(prev) = &mut previous.kind {
                if prev.style == next.style
                    && prev.height == next.height
                    && prev.width_factor == next.width_factor
                    && prev.oblique == next.oblique
                    && previous.common.color == part.common.color
                {
                    let delta = (next.insert.xy() - prev.insert.xy()).rotate(-next.rotation);
                    let font = cadcraft_fonts::TextFont::resolve(&font);
                    let width = cadcraft_fonts::text_width(
                        &font,
                        &prev.value,
                        prev.height,
                        prev.width_factor,
                    );
                    let gap = delta.x - width;
                    let space = cadcraft_fonts::space_width(&font, prev.height, prev.width_factor);
                    if delta.y.abs() < 1e-8 && (gap.abs() < 1e-8 || (gap - space).abs() < 1e-8) {
                        if gap > space / 2.0 {
                            prev.value.push(' ');
                        }
                        prev.value.push_str(&next.value);
                        merged = true;
                    }
                }
            }
        }
        if !merged {
            out.push(part);
        }
    }
    for (ps, color) in layout.explode_lines {
        for pair in ps.windows(2) {
            let mut part = line(e, pair[0], pair[1]);
            match color {
                Some(cadcraft_fonts::MTextColor::Aci(i)) if i > 0 && i <= 255 => {
                    part.common.color = Color::Index(i as u8)
                }
                Some(cadcraft_fonts::MTextColor::Rgb(rgb)) => {
                    part.common.color = Color::True(Rgb::from_u32(rgb))
                }
                _ => {}
            }
            out.push(part);
        }
    }
    out
}
impl CadcraftSession {
    pub(crate) fn explode(&mut self, p: &Value) -> Result<String, String> {
        match self.try_explode(p) {
            Ok(result) => Ok(result),
            Err(problem) => Ok(json!({"changed":false,"exploded":0,"removed":[],"handles":[],"skipped":[],"problem":problem}).to_string()),
        }
    }
    fn try_explode(&mut self, p: &Value) -> Result<String, String> {
        let before = self.session.state().map_err(|e| e.to_string())?.clone();
        let raw = p
            .get("handles")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .filter_map(Handle::parse_hex)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| before.selection.clone());
        let mut seen = HashSet::new();
        let handles: Vec<_> = raw.into_iter().filter(|h| seen.insert(*h)).collect();
        let mut work = Session::empty();
        work.new_drawing(true);
        let mut state = before.clone();
        state.undo.clear();
        state.redo.clear();
        *work.state_mut().map_err(|e| e.to_string())? = state;
        let mut created = Vec::new();
        let mut removed = Vec::new();
        let mut skipped = Vec::new();
        let mut detached = Vec::new();
        let mut preserved = HashSet::new();
        if let Some(details) = p.get("details").and_then(Value::as_array) {
            if details.len() > 100 {
                return Err("局部放大对象过多，未修改图纸。".into());
            }
            for detail in details {
                let id = detail["id"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 400)
                    .ok_or("局部放大对象编号无效，未修改图纸。")?;
                if detached.contains(&id.to_owned()) {
                    return Err("局部放大对象重复，未修改图纸。".into());
                }
                let members: Vec<Handle> = detail["handles"]
                    .as_array()
                    .ok_or("局部放大图形绑定缺失。")?
                    .iter()
                    .map(|h| {
                        h.as_str()
                            .and_then(Handle::parse_hex)
                            .ok_or("局部放大图形绑定无效。")
                    })
                    .collect::<Result<_, _>>()?;
                if members.is_empty() || members.len() > MAX_PARTS {
                    return Err("局部放大图形数量无效，未修改图纸。".into());
                }
                let member_set: HashSet<Handle> = members.iter().copied().collect();
                if member_set.len() != members.len()
                    || members.iter().any(|h| preserved.contains(h))
                {
                    return Err("局部放大图形绑定重复，未修改图纸。".into());
                }
                let names: Vec<&str> = detail["groups"]
                    .as_array()
                    .ok_or("局部放大编组绑定缺失。")?
                    .iter()
                    .map(|n| {
                        n.as_str()
                            .filter(|n| n.starts_with("PW_DETAIL_"))
                            .ok_or("局部放大编组绑定无效。")
                    })
                    .collect::<Result<_, _>>()?;
                if names.len() != 4 {
                    return Err("局部放大编组绑定不完整。".into());
                }
                let doc = work.doc().map_err(|e| e.to_string())?;
                if members.iter().any(|h| doc.entity(*h).is_none()) {
                    return Err("局部放大图形已变化，未修改图纸。".into());
                }
                if doc
                    .groups
                    .iter()
                    .filter(|g| names.contains(&g.name.as_str()))
                    .any(|g| g.members.iter().any(|h| !member_set.contains(h)))
                {
                    return Err("局部放大编组与图形绑定不一致，未修改图纸。".into());
                }
                preserved.extend(members.iter().copied());
                if members.iter().any(|h| {
                    doc.entity(*h)
                        .is_some_and(|e| doc.layer(&e.common.layer).is_some_and(|l| l.locked))
                }) {
                    skipped.push(json!({"detail":id,"reason":"局部放大包含锁定图形，整体保留"}));
                    continue;
                }
                work.doc_mut()
                    .map_err(|e| e.to_string())?
                    .groups
                    .retain(|g| !names.contains(&g.name.as_str()));
                // Only remove the semantic wrapper. Hatches, gears and polylines
                // inside it remain intact until the next EXPLODE invocation.
                created.extend(members.iter().map(|h| h.hex()));
                if created.len() > MAX_PARTS {
                    return Err("分解产生的对象过多，未修改图纸。".into());
                }
                detached.push(id.to_owned());
            }
        }
        let mut order: HashMap<Handle, usize> = before
            .doc
            .model
            .iter()
            .enumerate()
            .map(|(i, e)| (e.handle, i))
            .collect();
        for handle in handles {
            if preserved.contains(&handle) {
                continue;
            }
            let Some(source) = work
                .doc()
                .map_err(|e| e.to_string())?
                .entity(handle)
                .map(|e| (**e).clone())
            else {
                skipped.push(json!({"handle":handle.hex(),"reason":"对象已不存在"}));
                continue;
            };
            let d = work.doc().map_err(|e| e.to_string())?;
            if d.layer(&source.common.layer).is_some_and(|l| l.locked) {
                skipped.push(json!({"handle":handle.hex(),"reason":"锁定图层"}));
                continue;
            }
            let parts = match &source.kind {
                EntityKind::Insert(ins) => {
                    let block = d
                        .block(&ins.block)
                        .ok_or("块定义不存在，未修改图纸。")?
                        .as_ref()
                        .clone();
                    if !block.explodable
                        || block.xref_path.is_some()
                        || ins.block.contains('|')
                        || ins.rows > 1
                        || ins.cols > 1
                    {
                        skipped.push(json!({"handle":handle.hex(),"reason":"此块禁止分解或属于外部参照/多重插入"}));
                        continue;
                    }
                    if block.array.is_some() {
                        None
                    } else {
                        let m = ins.transform(block.base.xy());
                        let mut parts = Vec::new();
                        for child in block.entities.iter() {
                            let mut part = transformed(
                                work.doc_mut().map_err(|e| e.to_string())?,
                                child,
                                &m,
                                0,
                            )?;
                            if part.common.layer == "0" {
                                part.common.layer = source.common.layer.clone();
                            }
                            if part.common.color == Color::ByBlock {
                                part.common.color = source.common.color;
                            }
                            if part.common.lineweight == Lineweight::ByBlock {
                                part.common.lineweight = source.common.lineweight;
                            }
                            if part.common.linetype.eq_ignore_ascii_case("byblock") {
                                part.common.linetype = source.common.linetype.clone();
                            }
                            parts.push(part);
                        }
                        Some(parts)
                    }
                }
                EntityKind::Hatch(_) => Some(hatch(d, &source)?),
                EntityKind::MText(t) => Some(mtext(
                    work.doc_mut().map_err(|e| e.to_string())?,
                    &source,
                    t,
                )),
                EntityKind::Polyline3d(poly) => {
                    let mut parts: Vec<_> = poly
                        .points
                        .windows(2)
                        .map(|pair| {
                            entity(
                                &source,
                                EntityKind::Line(Line {
                                    a: pair[0],
                                    b: pair[1],
                                }),
                            )
                        })
                        .collect();
                    if poly.closed && poly.points.len() > 2 {
                        parts.push(entity(
                            &source,
                            EntityKind::Line(Line {
                                a: *poly.points.last().ok_or("空多段线")?,
                                b: poly.points[0],
                            }),
                        ));
                    }
                    Some(parts)
                }
                _ => None,
            };
            let added = if let Some(parts) = parts {
                if parts.is_empty() {
                    skipped.push(json!({"handle":handle.hex(),"reason":"没有可分解的组成对象"}));
                    continue;
                }
                let d = work.doc_mut().map_err(|e| e.to_string())?;
                let mut added = Vec::new();
                d.remove_entity(handle);
                for mut part in parts {
                    part.handle = d.new_handle();
                    added.push(part.handle.hex());
                    d.model.push(part);
                }
                added
            } else {
                let result = work
                    .execute("explode", &json!({"handles":[handle.hex()]}))
                    .map_err(|e| e.to_string())?;
                if work
                    .doc()
                    .map_err(|e| e.to_string())?
                    .entity(handle)
                    .is_some()
                {
                    skipped
                        .push(json!({"handle":handle.hex(),"reason":"单一对象或不支持的复合对象"}));
                    continue;
                }
                result["handles"]
                    .as_array()
                    .ok_or("分解结果缺少对象")?
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            };
            let position = order.get(&handle).copied().unwrap_or(usize::MAX);
            for h in &added {
                if let Some(h) = Handle::parse_hex(h) {
                    order.insert(h, position);
                }
            }
            created.extend(added);
            removed.push(handle.hex());
            if created.len() > MAX_PARTS {
                return Err("分解产生的对象过多，未修改图纸。".into());
            }
        }
        let changed = !removed.is_empty() || !detached.is_empty();
        if changed {
            work.doc_mut()
                .map_err(|e| e.to_string())?
                .model
                .sort_by_key(|e| order.get(&e.handle).copied().unwrap_or(usize::MAX));
            let doc = work.state().map_err(|e| e.to_string())?.doc.clone();
            let state = self.session.state_mut().map_err(|e| e.to_string())?;
            state.push_undo(Snapshot {
                label: "分解".into(),
                doc: before.doc,
                selection: before.selection,
            });
            state.doc = doc;
            state.selection.clear();
            state.revision += 1;
            self.hatch_preview = None;
        }
        Ok(json!({"changed":changed,"exploded":removed.len()+detached.len(),"detached":detached,"removed":removed,"handles":created,"skipped":skipped}).to_string())
    }
}
