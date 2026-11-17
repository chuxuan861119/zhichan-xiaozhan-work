//! Schematic gear trains. Each standard non-selectable GROUP carries one mesh edge.
use crate::{CadcraftSession, gear};
use cadcraft_engine::{
    Snapshot,
    doc::{Drawing, EntityKind, Group, Handle, Insert},
    geom::Vec2,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    f64::consts::{PI, TAU},
    sync::Arc,
};

const PREFIX: &str = "PatentWorkbenchGearMesh:1";

#[derive(Clone)]
struct Wheel {
    handle: Handle,
    kind: String,
    teeth: f64,
    size: f64,
    ins: Insert,
}
impl Wheel {
    fn read(doc: &Drawing, handle: Handle) -> Result<Self, String> {
        let e = doc.model.get(handle).ok_or("齿轮已不存在")?;
        let value = gear::info(doc, e).ok_or("只能为可参数化的齿轮设置啮合")?;
        let EntityKind::Insert(ins) = &e.kind else {
            unreachable!()
        };
        Ok(Self {
            handle,
            kind: value["kind"].as_str().unwrap().into(),
            teeth: value["teeth"].as_f64().unwrap(),
            size: value["size"].as_f64().unwrap(),
            ins: ins.clone(),
        })
    }
    fn module(&self) -> f64 {
        self.size / self.factor()
    }
    fn factor(&self) -> f64 {
        if self.kind == "rack" {
            PI * self.teeth
        } else {
            self.teeth + if self.kind == "internal" { 5.5 } else { 2.0 }
        }
    }
    fn radius(&self) -> f64 {
        self.module() * self.teeth / 2.0
    }
    fn at(&self) -> Vec2 {
        self.ins.insert.xy()
    }
    fn axis(&self) -> Vec2 {
        Vec2::new(self.ins.scale.x.signum(), 0.0).rotate(self.ins.rotation)
    }
    fn normal(&self) -> Vec2 {
        Vec2::new(0.0, self.ins.scale.y.signum()).rotate(self.ins.rotation)
    }
    fn chirality(&self) -> f64 {
        (self.ins.scale.x * self.ins.scale.y).signum()
    }
    fn phase_angle(&self) -> f64 {
        self.ins.rotation + if self.ins.scale.x < 0.0 { PI } else { 0.0 }
    }
}
fn pairs(doc: &Drawing) -> Vec<[Handle; 2]> {
    doc.groups
        .iter()
        .filter(|g| g.description == PREFIX && g.members.len() == 2)
        .map(|g| [g.members[0], g.members[1]])
        .collect()
}
pub(crate) fn adjacency(doc: &Drawing) -> HashMap<Handle, Vec<Handle>> {
    let mut graph: HashMap<Handle, Vec<Handle>> = HashMap::new();
    for [a, b] in pairs(doc) {
        if a != b && Wheel::read(doc, a).is_ok() && Wheel::read(doc, b).is_ok() {
            for (from, to) in [(a, b), (b, a)] {
                let neighbors = graph.entry(from).or_default();
                if !neighbors.contains(&to) {
                    neighbors.push(to);
                }
            }
        }
    }
    graph
}
pub(crate) fn connected(doc: &Drawing, h: Handle) -> HashSet<Handle> {
    let graph = adjacency(doc);
    let mut retained = HashSet::from([h]);
    let mut queue = VecDeque::from([h]);
    while let Some(current) = queue.pop_front() {
        for &next in graph.get(&current).into_iter().flatten() {
            if retained.insert(next) {
                queue.push_back(next);
            }
        }
    }
    retained
}
pub(crate) fn intercept(doc: &Drawing, command: &str) -> bool {
    command == "bridge.gear_mesh"
        || (!pairs(doc).is_empty()
            && matches!(
                command,
                "bridge.gear"
                    | "grip.move"
                    | "move"
                    | "stretch"
                    | "rotate"
                    | "scale"
                    | "mirror"
                    | "properties.set"
                    | "erase"
                    | "explode"
                    | "ungroup"
            ))
}
fn validate(doc: &Drawing, a: &Wheel, b: &Wheel) -> Result<(), String> {
    if a.handle == b.handle {
        return Err("请选择两个不同的齿轮".into());
    }
    if a.kind != "external" && b.kind != "external" {
        return Err("此组合不能直接啮合，请选择外齿轮与外齿轮、内齿圈或齿条。".into());
    }
    for w in [a, b] {
        let e = doc.model.get(w.handle).unwrap();
        if doc.layer(&e.common.layer).is_some_and(|l| l.locked) {
            return Err("啮合对象位于锁定图层，原对象未改变。".into());
        }
        if (w.ins.scale.x.abs() - w.ins.scale.y.abs()).abs() > 1e-8 * w.ins.scale.x.abs() {
            return Err("非等比变形的齿轮不能啮合，请先恢复等比大小。".into());
        }
        if w.ins.rows != 1 || w.ins.cols != 1 {
            return Err("阵列块不能直接设置啮合，请先分解阵列。".into());
        }
    }
    let ring = if a.kind == "internal" {
        Some((a, b))
    } else if b.kind == "internal" {
        Some((b, a))
    } else {
        None
    };
    if ring.is_some_and(|(i, e)| i.teeth - e.teeth < 3.0) {
        return Err("内齿圈齿数至少需比外齿轮多 3 齿，请先调整齿数。".into());
    }
    Ok(())
}
fn touch(doc: &mut Drawing, h: Handle) {
    if let Some(e) = doc.model.get(h) {
        doc.model.replace(e.as_ref().clone());
    }
}
fn pose(doc: &mut Drawing, w: &Wheel, at: Vec2, rotation: f64) -> Result<(), String> {
    if !at.x.is_finite()
        || !at.y.is_finite()
        || at.x.abs() > 1e9
        || at.y.abs() > 1e9
        || !rotation.is_finite()
    {
        return Err("啮合后的图形位置超出有效范围，原对象未改变。".into());
    }
    let mut e = doc
        .model
        .get(w.handle)
        .ok_or("啮合对象已不存在")?
        .as_ref()
        .clone();
    let EntityKind::Insert(ins) = &mut e.kind else {
        return Err("啮合对象已被分解".into());
    };
    ins.insert.x = at.x;
    ins.insert.y = at.y;
    ins.rotation = rotation;
    doc.model.replace(e);
    Ok(())
}
fn nearest_phase(angle: f64, previous: f64, teeth: f64) -> f64 {
    previous + (angle - previous + PI / teeth).rem_euclid(TAU / teeth) - PI / teeth
}

impl CadcraftSession {
    /// One undo and an atomic failure boundary include both INSERTs and the constraint.
    pub(crate) fn mesh_edit(&mut self, command: &str, p: &Value) -> Result<String, String> {
        let before = self.session.state().map_err(|e| e.to_string())?.clone();
        let result = if command == "bridge.gear_mesh" {
            self.set_mesh(p)
        } else if command == "ungroup" {
            self.ungroup_without_mesh(p)
        } else {
            self.execute_raw(command, &p.to_string())
                .and_then(|result| {
                    self.follow_mesh(&before.doc, command, p)?;
                    Ok(result)
                })
        };
        match result {
            Err(error) => {
                *self.session.state_mut().map_err(|e| e.to_string())? = before;
                self.hatch_preview = None;
                Err(format!("CAD_GEAR_MESH_REJECTED:{error}"))
            }
            Ok(result) => {
                let state = self.session.state_mut().map_err(|e| e.to_string())?;
                if !Arc::ptr_eq(&before.doc, &state.doc) {
                    state.undo = before.undo;
                    state.redo = before.redo;
                    state.push_undo(Snapshot {
                        label: "齿轮啮合".into(),
                        doc: before.doc,
                        selection: before.selection,
                    });
                    state.revision = before.revision + 1;
                }
                self.hatch_preview = None;
                Ok(result)
            }
        }
    }
    fn ungroup_without_mesh(&mut self, p: &Value) -> Result<String, String> {
        let doc = self.session.doc().map_err(|e| e.to_string())?;
        if let Some(names) = p.get("name") {
            let names: Vec<&str> = match names {
                Value::String(s) => s.split(',').map(str::trim).collect(),
                Value::Array(a) => a.iter().filter_map(|v| v.as_str().map(str::trim)).collect(),
                _ => return self.execute_raw("ungroup", &p.to_string()),
            };
            if doc.groups.iter().any(|g| {
                g.description == PREFIX && names.iter().any(|n| g.name.eq_ignore_ascii_case(n))
            }) {
                return Err("啮合关系不能通过取消编组移除，请使用取消啮合。".into());
            }
            return self.execute_raw("ungroup", &p.to_string());
        }
        let handles: Vec<Handle> = if let Some(hs) = p.get("handles") {
            hs.as_array()
                .ok_or("请选择有效的对象")?
                .iter()
                .map(|v| {
                    v.as_str()
                        .and_then(Handle::parse_hex)
                        .or_else(|| v.as_u64().map(Handle))
                        .ok_or("对象编号无效")
                })
                .collect::<Result<_, _>>()?
        } else {
            self.session
                .state()
                .map_err(|e| e.to_string())?
                .selection
                .clone()
        };
        let names: Vec<_> = doc
            .groups
            .iter()
            .filter(|g| g.description != PREFIX && g.members.iter().any(|h| handles.contains(h)))
            .map(|g| g.name.clone())
            .collect();
        if names.is_empty() {
            return Ok(json!({"changed":false,"ungrouped":[]}).to_string());
        }
        self.execute_raw("ungroup", &json!({"name":names}).to_string())
    }
    fn set_mesh(&mut self, p: &Value) -> Result<String, String> {
        let hs = p["handles"]
            .as_array()
            .filter(|h| h.len() == 2)
            .ok_or("请选择两个齿轮")?;
        let handle = |v: &Value| v.as_str().and_then(Handle::parse_hex).ok_or("齿轮对象无效");
        let a = handle(&hs[0])?;
        let b = handle(&hs[1])?;
        let enabled = p["enabled"].as_bool().ok_or("缺少啮合开关状态")?;
        let doc = self.session.doc().map_err(|e| e.to_string())?;
        let wa = Wheel::read(doc, a)?;
        let wb = Wheel::read(doc, b)?;
        if enabled {
            validate(doc, &wa, &wb)?;
        } else {
            self.validate_edit("grip.move", &json!({"handles":[a.hex(),b.hex()]}))?;
        }
        let graph = adjacency(doc);
        let linked = graph
            .get(&a)
            .is_some_and(|neighbors| neighbors.contains(&b));
        if linked == enabled {
            return Ok(json!({"changed":false}).to_string());
        }
        if enabled && graph.contains_key(&a) && graph.contains_key(&b) {
            return Err(
                "两个对象均已有啮合关系；请选择一个组内齿轮和一个独立齿轮，避免改变已有齿轮组。"
                    .into(),
            );
        }
        if enabled {
            // Selection order must never move or resize an established train.
            if graph.contains_key(&b) {
                self.align_mesh(b, a)?;
            } else {
                self.align_mesh(a, b)?;
            }
        }
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        let doc = Arc::make_mut(&mut state.doc);
        if enabled {
            let name = format!("PW_GEAR_MESH_{}", doc.new_handle().hex());
            doc.groups.push(Group {
                name,
                description: PREFIX.into(),
                selectable: false,
                members: vec![a, b],
            });
        } else {
            doc.groups.retain(|g| {
                !(g.description == PREFIX && g.members.contains(&a) && g.members.contains(&b))
            });
        }
        touch(doc, a);
        touch(doc, b);
        Ok(json!({"changed":true,"handles":[a.hex(),b.hex()]}).to_string())
    }
    /// Rebuild only a private follower definition when matching pitch requires a size change.
    fn match_pitch(&mut self, driver: &Wheel, follower: &Wheel) -> Result<Wheel, String> {
        let size = driver.module() * follower.factor();
        if (size - follower.size).abs() > follower.size * 1e-10 {
            let doc = self.session.doc().map_err(|e| e.to_string())?;
            let mut spec = gear::info(doc, doc.model.get(follower.handle).unwrap()).unwrap();
            spec["size"] = json!(size);
            spec["handle"] = json!(follower.handle.hex());
            self.gear(&spec)?;
        }
        Wheel::read(
            self.session.doc().map_err(|e| e.to_string())?,
            follower.handle,
        )
    }
    fn align_mesh(&mut self, a: Handle, b: Handle) -> Result<(), String> {
        let doc = self.session.doc().map_err(|e| e.to_string())?;
        let driver = Wheel::read(doc, a)?;
        let follower = Wheel::read(doc, b)?;
        validate(doc, &driver, &follower)?;
        let follower = self.match_pitch(&driver, &follower)?;
        let (at, rotation) = if driver.kind == "rack" {
            let contact = driver.at() + driver.axis() * (driver.size / 2.0);
            let at = contact + driver.normal() * (driver.module() * PI * 0.325 + follower.radius());
            let phi = (-driver.normal().y).atan2(-driver.normal().x);
            let ur = driver.teeth / 2.0 - 0.5;
            let beta = phi - TAU / follower.teeth * (0.5 + driver.chirality() * ur);
            (
                at,
                nearest_phase(
                    beta - (follower.phase_angle() - follower.ins.rotation),
                    follower.ins.rotation,
                    follower.teeth,
                ),
            )
        } else if follower.kind == "rack" {
            let pitch = driver.module() * PI;
            let normal = follower.normal();
            let axis = follower.axis();
            let phi = (-normal.y).atan2(-normal.x);
            let ug = (phi - driver.phase_angle()) * driver.teeth / TAU;
            let desired = follower.chirality() * (ug - 0.5);
            let difference = (follower.teeth / 2.0 - 0.5 - desired + 0.5).rem_euclid(1.0) - 0.5;
            (
                driver.at()
                    - axis * (follower.size / 2.0)
                    - normal * (pitch * 0.325 + driver.radius())
                    + axis * (difference * pitch),
                follower.ins.rotation,
            )
        } else {
            let delta = follower.at() - driver.at();
            let direction = if delta.len() > 1e-10 {
                delta / delta.len()
            } else {
                Vec2::new(1.0, 0.0)
            };
            let distance = if driver.kind == follower.kind {
                driver.radius() + follower.radius()
            } else {
                (driver.radius() - follower.radius()).abs()
            };
            let at = driver.at() + direction * distance;
            let phi = if follower.kind == "internal" {
                (-direction.y).atan2(-direction.x)
            } else {
                direction.y.atan2(direction.x)
            };
            let ud = (phi - driver.phase_angle()) * driver.teeth / TAU;
            let beta = if driver.kind == follower.kind {
                phi + PI - TAU / follower.teeth * (0.5 - ud)
            } else if driver.kind == "internal" {
                phi - TAU / follower.teeth * (ud + 0.5)
            } else {
                phi - TAU / follower.teeth * (ud - 0.5)
            };
            (
                at,
                nearest_phase(
                    beta - (follower.phase_angle() - follower.ins.rotation),
                    follower.ins.rotation,
                    follower.teeth,
                ),
            )
        };
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        pose(Arc::make_mut(&mut state.doc), &follower, at, rotation)
    }
    /// A tooth-count edit is local: existing partners keep their pitch, pose,
    /// definitions and downstream train. Only the edited INSERT is resized/reseated.
    fn retune_teeth(&mut self, handle: Handle, neighbors: &[Handle]) -> Result<(), String> {
        let doc = self.session.doc().map_err(|e| e.to_string())?;
        let edited = Wheel::read(doc, handle)?;
        let fixed = neighbors
            .iter()
            .map(|&h| Wheel::read(doc, h))
            .collect::<Result<Vec<_>, _>>()?;
        let pitch = fixed[0].module();
        for partner in &fixed {
            validate(doc, partner, &edited)?;
            if (partner.module() - pitch).abs() > pitch * 1e-8 {
                return Err("其他齿轮的齿距不一致，无法只调整当前齿轮；原图形未改变。".into());
            }
        }
        let size = pitch * edited.factor();
        if !size.is_finite() || size <= 1e-6 || size > 1e8 {
            return Err("调整后的齿轮大小超出有效范围，原图形未改变。".into());
        }
        // The new tooth profile already exists. Change its INSERT scale directly
        // rather than regenerating a second block or any partner's geometry.
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        let doc = Arc::make_mut(&mut state.doc);
        let mut entity = doc.model.get(handle).unwrap().as_ref().clone();
        let EntityKind::Insert(ins) = &mut entity.kind else {
            unreachable!()
        };
        ins.scale.x *= size / edited.size;
        ins.scale.y *= size / edited.size;
        doc.model.replace(entity);
        if fixed.len() == 1 {
            return self.align_mesh(fixed[0].handle, handle);
        }
        let resized = Wheel::read(self.session.doc().map_err(|e| e.to_string())?, handle)?;
        let tolerance = size.max(1.0) * 1e-8;
        let mut candidates = vec![resized.at()];
        for partner in &fixed {
            self.align_mesh(partner.handle, handle)?;
            candidates.push(Wheel::read(self.session.doc().unwrap(), handle)?.at());
            let state = self.session.state_mut().map_err(|e| e.to_string())?;
            pose(
                Arc::make_mut(&mut state.doc),
                &resized,
                resized.at(),
                resized.ins.rotation,
            )?;
        }
        // Two fixed circular partners constrain the edited centre to their
        // pitch-circle intersections. Try both, nearest to the original first.
        if resized.kind != "rack" {
            let circular: Vec<_> = fixed.iter().filter(|w| w.kind != "rack").collect();
            if let Some(a) = circular.first() {
                if let Some(b) = circular
                    .iter()
                    .skip(1)
                    .find(|b| (b.at() - a.at()).len() > tolerance)
                {
                    let distance = |w: &Wheel| {
                        if w.kind == resized.kind {
                            w.radius() + resized.radius()
                        } else {
                            (w.radius() - resized.radius()).abs()
                        }
                    };
                    let delta = b.at() - a.at();
                    let d = delta.len();
                    let ra = distance(a);
                    let rb = distance(b);
                    let x = (ra * ra - rb * rb + d * d) / (2.0 * d);
                    let y2 = ra * ra - x * x;
                    if y2 >= -tolerance * ra.max(1.0) {
                        let axis = delta / d;
                        let offset = Vec2::new(-axis.y, axis.x) * y2.max(0.0).sqrt();
                        let center = a.at() + axis * x;
                        candidates.extend([center + offset, center - offset]);
                    }
                }
            }
        }
        candidates.sort_by(|a, b| {
            (*a - resized.at())
                .len()
                .total_cmp(&(*b - resized.at()).len())
        });
        for candidate in candidates {
            let state = self.session.state_mut().map_err(|e| e.to_string())?;
            pose(
                Arc::make_mut(&mut state.doc),
                &resized,
                candidate,
                resized.ins.rotation,
            )?;
            self.align_mesh(fixed[0].handle, handle)?;
            let target = Wheel::read(self.session.doc().unwrap(), handle)?;
            if (target.at() - candidate).len() > tolerance {
                continue;
            }
            let period = if target.kind == "rack" {
                TAU
            } else {
                TAU / target.teeth
            };
            let mut compatible = true;
            for partner in fixed.iter().skip(1) {
                self.align_mesh(partner.handle, handle)?;
                let check = Wheel::read(self.session.doc().unwrap(), handle)?;
                let phase = (check.ins.rotation - target.ins.rotation + period / 2.0)
                    .rem_euclid(period)
                    - period / 2.0;
                if (check.at() - target.at()).len() > tolerance || phase.abs() > 1e-8 {
                    compatible = false;
                    break;
                }
            }
            if compatible {
                let state = self.session.state_mut().map_err(|e| e.to_string())?;
                return pose(
                    Arc::make_mut(&mut state.doc),
                    &target,
                    target.at(),
                    target.ins.rotation,
                );
            }
        }
        Err("保持其他齿轮大小和位置不变时，无法同时满足当前齿轮的全部啮合；请先解除部分啮合再调整，原图形未改变。".into())
    }
    fn follow_mesh(&mut self, before: &Drawing, command: &str, p: &Value) -> Result<(), String> {
        // Copies keep their own geometry; the existing source relationship is not cloned onto one copy.
        if p["copy"] == true || (command == "mirror" && p["erase"] != true) {
            return Ok(());
        }
        // Remove only invalid edges. Removing A must not also unlink B from C.
        let doc = self.session.doc().map_err(|e| e.to_string())?;
        let invalid: HashSet<_> = pairs(before)
            .into_iter()
            .flatten()
            .filter(|&h| Wheel::read(doc, h).is_err())
            .collect();
        if !invalid.is_empty() {
            let doc = Arc::make_mut(&mut self.session.state_mut().map_err(|e| e.to_string())?.doc);
            let affected: Vec<_> = pairs(before)
                .into_iter()
                .filter(|edge| edge.iter().any(|h| invalid.contains(h)))
                .flatten()
                .collect();
            doc.groups.retain(|g| {
                g.description != PREFIX
                    || (g.members.len() == 2 && !g.members.iter().any(|h| invalid.contains(h)))
            });
            for h in affected {
                touch(doc, h);
            }
        }
        let doc = self.session.doc().map_err(|e| e.to_string())?;
        let graph = adjacency(doc);
        let turn = if command == "rotate" || (command == "grip.move" && p["index"] == 3) {
            p["angle"]
                .as_f64()
                .filter(|angle| angle.abs() > 1e-12)
                .map(f64::to_radians)
        } else {
            None
        };
        let requested: HashSet<_> = if turn.is_some() {
            if let Some(hs) = p["handles"].as_array() {
                hs.iter()
                    .filter_map(|v| {
                        v.as_str()
                            .and_then(Handle::parse_hex)
                            .or_else(|| v.as_u64().map(Handle))
                    })
                    .collect()
            } else if let Some(h) = p["handle"]
                .as_str()
                .and_then(Handle::parse_hex)
                .or_else(|| p["handle"].as_u64().map(Handle))
            {
                HashSet::from([h])
            } else {
                self.session
                    .state()
                    .map_err(|e| e.to_string())?
                    .selection
                    .iter()
                    .copied()
                    .collect()
            }
        } else {
            HashSet::new()
        };
        let changed: Vec<_> = doc
            .model
            .iter()
            .filter(|e| {
                graph.contains_key(&e.handle)
                    && before
                        .model
                        .get(e.handle)
                        .is_some_and(|old| old.kind != e.kind || requested.contains(&e.handle))
            })
            .map(|e| e.handle)
            .collect();
        let direct: HashSet<_> = changed.iter().copied().collect();
        if let Some(&root) = changed.iter().find(|&&h| {
            Wheel::read(before, h)
                .ok()
                .zip(Wheel::read(doc, h).ok())
                .is_some_and(|(old, next)| old.teeth != next.teeth)
        }) {
            if changed.len() != 1 {
                return Err("请单独调整一个齿轮的齿数，其他齿轮保持不变。".into());
            }
            return self.retune_teeth(root, &graph[&root]);
        }
        // Standard ROTATE normalizes INSERT angles. Retain the full direct motion
        // before re-alignment, including turns that leave an identical driver pose.
        let raw_rotations: HashMap<_, _> = changed
            .iter()
            .map(|&h| Ok((h, Wheel::read(doc, h)?.ins.rotation)))
            .collect::<Result<_, String>>()?;
        let mut visited = HashSet::new();
        for root in changed {
            if !visited.insert(root) {
                continue;
            }
            let mut queue = VecDeque::from([root]);
            while let Some(parent) = queue.pop_front() {
                for &child in graph.get(&parent).into_iter().flatten() {
                    if !visited.insert(child) {
                        continue;
                    }
                    if direct.contains(&child) {
                        self.align_mesh(parent, child)?;
                    } else {
                        let unwrapped = turn.filter(|_| direct.contains(&parent)).map(|angle| {
                            let current = Wheel::read(self.session.doc().unwrap(), parent)
                                .unwrap()
                                .ins
                                .rotation;
                            angle + (current - raw_rotations[&parent] + PI).rem_euclid(TAU) - PI
                        });
                        self.follow_mesh_edge(before, parent, child, unwrapped, parent == root)?;
                    }
                    queue.push_back(child);
                }
            }
        }
        Ok(())
    }
    fn follow_mesh_edge(
        &mut self,
        before: &Drawing,
        parent: Handle,
        child: Handle,
        unwrapped: Option<f64>,
        root: bool,
    ) -> Result<(), String> {
        let doc = self.session.doc().map_err(|e| e.to_string())?;
        let d = Wheel::read(doc, parent)?;
        let f = Wheel::read(doc, child)?;
        validate(doc, &d, &f)?;
        let old = Wheel::read(before, d.handle)?;
        if (d.module() - old.module()).abs() > old.module() * 1e-10
            || d.teeth != old.teeth
            || d.ins.scale.x.signum() != old.ins.scale.x.signum()
            || d.ins.scale.y.signum() != old.ins.scale.y.signum()
        {
            self.align_mesh(d.handle, f.handle)?;
            return Ok(());
        }
        let delta = d.at() - old.at();
        let angle = if let Some(angle) = unwrapped {
            angle
        } else if !root {
            // Propagated rotations retain full turns and tooth ratios.
            d.ins.rotation - old.ins.rotation
        } else {
            (d.ins.rotation - old.ins.rotation + PI).rem_euclid(TAU) - PI
        };
        let (at, rotation) = if d.kind == "rack" {
            let axis = d.axis();
            let along = delta.x * axis.x + delta.y * axis.y;
            let at = d.at() + (f.at() - old.at()).rotate(angle) - axis * along;
            // The tangential displacement rolls the pinion, while normal motion carries it.
            (
                at,
                f.ins.rotation + angle + d.chirality() * along / f.radius(),
            )
        } else if f.kind == "rack" {
            (
                f.at() + delta + f.axis() * (f.chirality() * d.radius() * angle),
                f.ins.rotation,
            )
        } else {
            let sign = if d.kind == f.kind { -1.0 } else { 1.0 };
            (
                f.at() + delta,
                f.ins.rotation + sign * angle * d.teeth / f.teeth,
            )
        };
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        pose(Arc::make_mut(&mut state.doc), &f, at, rotation)?;
        Ok(())
    }
}
