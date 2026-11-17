//! Editable schematic side view of a compression spring. Dimensions illustrate shape only.
use crate::CadcraftSession;
use cadcraft_engine::{
    Snapshot,
    doc::{Block, Drawing, Entity, EntityKind, EntityStore, Handle, Insert, LwPolyline, Space},
    geom::{PolyVertex, Vec2, Vec3},
};
use serde_json::{Value, json};
use std::{
    f64::consts::TAU,
    sync::{Arc, OnceLock},
};

const PREFIX: &str = "PatentWorkbenchSpring:5:";
const EXTENSION_PREFIX: &str = "PatentWorkbenchExtensionSpring:2:";
const PREVIOUS_EXTENSION_PREFIX: &str = "PatentWorkbenchExtensionSpring:1:";
const V4_PREFIX: &str = "PatentWorkbenchSpring:4:";
const V3_PREFIX: &str = "PatentWorkbenchSpring:3:";
const PREVIOUS_PREFIX: &str = "PatentWorkbenchSpring:2:";
const LEGACY_PREFIX: &str = "PatentWorkbenchSpring:1:";

#[derive(Clone)]
struct Spec {
    turns: usize,
    wire: f64,
}

fn number(p: &Value, key: &str) -> Result<f64, String> {
    p[key]
        .as_f64()
        .filter(|n| n.is_finite() && n.abs() <= 1e9)
        .ok_or_else(|| format!("{key} 数值无效"))
}
fn point(p: &Value, key: &str) -> Result<Vec2, String> {
    let xy: [f64; 2] =
        serde_json::from_value(p[key].clone()).map_err(|_| format!("{key} 坐标无效"))?;
    if xy.iter().any(|n| !n.is_finite() || n.abs() > 1e9) {
        return Err(format!("{key} 坐标无效"));
    }
    Ok(Vec2::new(xy[0], xy[1]))
}
fn dimensions(length: f64, width: f64, turns: usize, wire: f64) -> Result<(), String> {
    if !length.is_finite()
        || !width.is_finite()
        || length <= 1e-6
        || width <= 1e-6
        || length > 1e8
        || width > 1e8
    {
        return Err("弹簧长度和宽度须大于 0 且不超过 100000000".into());
    }
    if !(3..=24).contains(&turns) {
        return Err("圈数须为 3～24 的整数".into());
    }
    if !wire.is_finite()
        || wire <= 1e-6
        || wire >= width / 3.0
        || wire >= length / (2.0 * turns as f64)
    {
        return Err("线径须大于 0，且小于弹簧宽度的三分之一和半圈间距".into());
    }
    Ok(())
}
fn spec(p: &Value) -> Result<Spec, String> {
    let turns = p["turns"].as_u64().ok_or("圈数须为整数")?;
    if !(3..=24).contains(&turns) {
        return Err("圈数须为 3～24 的整数".into());
    }
    Ok(Spec {
        turns: turns as usize,
        wire: number(p, "wire")?,
    })
}
pub(crate) fn polyline(points: impl IntoIterator<Item = Vec2>) -> EntityKind {
    EntityKind::LwPolyline(LwPolyline {
        vertices: points.into_iter().map(PolyVertex::new).collect(),
        closed: false,
        const_width: 0.0,
        elevation: 0.0,
        plinegen: false,
    })
}

fn visible_coil(
    length: f64,
    width: f64,
    wire: f64,
    side: f64,
    start: f64,
    span: f64,
    phase: f64,
    sweep: f64,
    reflected: bool,
    round_tip: bool,
) -> EntityKind {
    let radius = (width - wire) / 2.0;
    polyline((0..=32).map(|step| {
        let u = step as f64 / 32.0;
        let axial = start + span * (u - 0.1 * (TAU * u).sin());
        let axial = if reflected { length - axial } else { axial };
        let tip = if round_tip {
            wire * (1.0 - u).powi(2) / 2.0
        } else {
            0.0
        };
        let transverse = -(side * wire / 2.0 + radius * (phase + sweep * u).cos() + tip);
        Vec2::new(axial / length, transverse / width)
    }))
}

fn previous_profile_point(spec: &Spec, length: f64, width: f64, i: usize, side: f64) -> Vec2 {
    let t = i as f64 / (spec.turns * 24) as f64;
    let angle = TAU * spec.turns as f64 * t;
    let usable = 1.0 - spec.wire / length;
    let projection = 0.7 * usable / spec.turns as f64;
    let radius = 0.5 - spec.wire / (2.0 * width);
    let x = spec.wire / (2.0 * length) + usable * t + projection * angle.sin();
    let y = radius * angle.cos();
    let tangent_x = length * (usable / (TAU * spec.turns as f64) + projection * angle.cos());
    let tangent_y = -width * radius * angle.sin();
    let offset = side * spec.wire / (2.0 * tangent_x.hypot(tangent_y));
    Vec2::new(
        x - offset * tangent_y / length,
        y + offset * tangent_x / width,
    )
}

fn is_untouched_previous(children: &[Arc<Entity>], spec: &Spec, length: f64, width: f64) -> bool {
    if children.len() != 4 {
        return false;
    }
    children
        .iter()
        .enumerate()
        .all(|(index, entity)| match &entity.kind {
            EntityKind::LwPolyline(curve) if index < 2 => {
                let side = if index == 0 { -1.0 } else { 1.0 };
                !curve.closed
                    && curve.const_width.abs() < 1e-6
                    && curve.elevation.abs() < 1e-6
                    && !curve.plinegen
                    && curve.vertices.len() == spec.turns * 24 + 1
                    && curve.vertices.iter().enumerate().all(|(i, vertex)| {
                        let expected = previous_profile_point(spec, length, width, i, side);
                        (vertex.p.x - expected.x).abs() < 1e-6
                            && (vertex.p.y - expected.y).abs() < 1e-6
                            && vertex.bulge.abs() < 1e-6
                            && vertex.start_width.abs() < 1e-6
                            && vertex.end_width.abs() < 1e-6
                    })
            }
            EntityKind::Line(line) if index >= 2 => {
                let i = if index == 2 { 0 } else { spec.turns * 24 };
                let a = previous_profile_point(spec, length, width, i, -1.0);
                let b = previous_profile_point(spec, length, width, i, 1.0);
                (line.a.x - a.x).abs() < 1e-6
                    && (line.a.y - a.y).abs() < 1e-6
                    && (line.b.x - b.x).abs() < 1e-6
                    && (line.b.y - b.y).abs() < 1e-6
                    && line.a.z.abs() < 1e-6
                    && line.b.z.abs() < 1e-6
            }
            _ => false,
        })
}

fn previous_v3_geometry(spec: &Spec, length: f64, width: f64) -> Vec<EntityKind> {
    let wire = spec.wire;
    let active_pitch = (length - 3.0 * wire) / (spec.turns - 2) as f64;
    let mut result = Vec::with_capacity(2 * spec.turns + 2);
    let end_left = |reflected| {
        visible_coil(
            length,
            width,
            wire,
            -1.0,
            0.0,
            2.1 * wire,
            0.0,
            TAU,
            reflected,
            true,
        )
    };
    let end_right = |reflected| {
        visible_coil(
            length,
            width,
            wire,
            1.0,
            0.55 * wire,
            2.85 * wire,
            std::f64::consts::PI,
            0.85 * TAU,
            reflected,
            false,
        )
    };
    result.push(end_left(false));
    result.push(end_right(false));
    for turn in 0..spec.turns - 2 {
        let left = 1.8 * wire + turn as f64 * active_pitch;
        let right = left + 0.38 * active_pitch;
        let span = active_pitch + 0.31 * wire;
        result.push(visible_coil(
            length,
            width,
            wire,
            -1.0,
            left,
            span,
            0.99,
            0.85 * TAU,
            false,
            false,
        ));
        result.push(visible_coil(
            length,
            width,
            wire,
            1.0,
            right,
            span.min(length - wire / 2.0 - right),
            std::f64::consts::PI + 0.99,
            0.85 * TAU,
            false,
            false,
        ));
    }
    result.push(end_left(true));
    result.push(end_right(true));
    let tip_radius = wire / 2.0;
    let outer_center = (width - wire) / 2.0;
    result.push(polyline((0..=32).map(|step| {
        let angle = TAU * step as f64 / 32.0;
        Vec2::new(
            (tip_radius + tip_radius * angle.sin()) / length,
            -(outer_center + tip_radius * angle.cos()) / width,
        )
    })));
    result.push(polyline((0..=16).map(|step| {
        let angle = -std::f64::consts::FRAC_PI_2 + std::f64::consts::PI * step as f64 / 16.0;
        Vec2::new(
            (length - tip_radius + tip_radius * angle.cos()) / length,
            -(outer_center + tip_radius * angle.sin()) / width,
        )
    })));
    result
}

// A simplified outline sampled from the supplied seven-turn side projection.
// The body turn is translated by pitch; close, unground ends have their own
// contours. The same compact template drives native/WASM output and UI grips.
struct SpringProfile {
    reference_length: f64,
    reference_width: f64,
    reference_pitch: f64,
    reference_wire: f64,
    reference_turns: usize,
    paths: Vec<Vec<[f64; 2]>>,
}

fn profile() -> &'static SpringProfile {
    static PROFILE: OnceLock<SpringProfile> = OnceLock::new();
    PROFILE.get_or_init(|| {
        let source: Value = serde_json::from_str(include_str!(
            "../../../src/shared/drawing-markup/spring-profile.json"
        ))
        .expect("bundled spring profile must be valid JSON");
        let field = |name: &str| {
            source[name]
                .as_f64()
                .expect("spring profile dimension missing")
        };
        SpringProfile {
            reference_length: field("referenceLength"),
            reference_width: field("referenceWidth"),
            reference_pitch: field("referencePitch"),
            reference_wire: field("referenceWire"),
            reference_turns: source["referenceTurns"]
                .as_u64()
                .expect("spring profile turn count missing") as usize,
            paths: serde_json::from_value(source["paths"].clone())
                .expect("bundled spring profile must contain paths"),
        }
    })
}

fn end_wire_adjustment(distance: f64, scale: f64) -> (f64, f64) {
    let change = scale - 1.0;
    if distance <= 5.0 {
        return (change * distance, change);
    }
    if distance >= 20.0 {
        return (0.0, 0.0);
    }
    // Preserve the end-face diameter, then smoothly rejoin the active turn.
    let t = (distance - 5.0) / 15.0;
    (
        (2.0 * t.powi(3) - 3.0 * t.powi(2) + 1.0) * change * 5.0
            + (t.powi(3) - 2.0 * t.powi(2) + t) * change * 15.0,
        (6.0 * t.powi(2) - 6.0 * t) * change / 3.0 + (3.0 * t.powi(2) - 4.0 * t + 1.0) * change,
    )
}

fn outline_normal(points: &[[f64; 2]], index: usize) -> Vec2 {
    let first = index.saturating_sub(1).min(points.len() - 3);
    let [ax, ay] = points[first];
    let [bx, by] = points[first + 1];
    let [cx, cy] = points[first + 2];
    let a = Vec2::new(bx - ax, by - ay);
    let b = Vec2::new(cx - bx, cy - by);
    let la = a.x.hypot(a.y);
    let lb = b.x.hypot(b.y);
    // Quadratic tangent for the template's unequally spaced samples.
    let wa = if index == 0 {
        (2.0 * la + lb) / (la + lb)
    } else if index == points.len() - 1 {
        -lb / (la + lb)
    } else {
        lb / (la + lb)
    };
    let tangent = a * (wa / la) + b * ((1.0 - wa) / lb);
    Vec2::new(tangent.y, -tangent.x) / tangent.x.hypot(tangent.y)
}

pub(crate) fn join_visible_turns(
    paths: &mut [Vec<Vec2>],
    turns: usize,
    width: f64,
    extend_ends: bool,
) {
    let cross = |a: Vec2, b: Vec2| a.x * b.y - a.y * b.x;
    for index in 1..2 * turns {
        if index == turns {
            continue;
        }
        let current = &paths[index];
        let previous = &paths[index - 1];
        let mut best: Option<(Vec2, f64, usize, bool)> = None;
        // Recompute the occlusion join after resizing the wire. Both exposed
        // branches may need an extension before the next turn hides them.
        for i in 0..current.len() / 2 {
            let p = current[i];
            let u = current[i + 1] - p;
            for j in previous.len() / 2..previous.len() - 1 {
                let q = previous[j];
                let v = previous[j + 1] - q;
                let determinant = cross(u, v);
                if determinant.abs() < 1e-12 {
                    continue;
                }
                let delta = q - p;
                let t = cross(delta, v) / determinant;
                let s = cross(delta, u) / determinant;
                if (i > 0 && t < 0.0)
                    || t > 1.0
                    || s < 0.0
                    || ((!extend_ends || j < previous.len() - 2) && s > 1.0)
                {
                    continue;
                }
                let point = p + u * t;
                if point.y < 0.0 || point.y > width {
                    continue;
                }
                let distance = (point.x - current[0].x).hypot(point.y - current[0].y);
                if best.is_none_or(|(_, old, _, _)| distance < old) {
                    best = Some((point, distance, i, s > 1.0));
                }
            }
        }
        if let Some((point, _, segment, extend)) = best {
            paths[index].drain(..=segment);
            paths[index].insert(0, point);
            if extend {
                paths[index - 1].push(point);
            }
        }
    }
}

fn geometry(spec: &Spec, length: f64, width: f64) -> Vec<EntityKind> {
    let profile = profile();
    let extra = (spec.turns as f64 - profile.reference_turns as f64) * profile.reference_pitch;
    let reference_length = profile.reference_length + extra;
    let radius = profile.reference_wire / 2.0;
    let axial_scale = (length - spec.wire) / (reference_length - profile.reference_wire);
    let across_scale = (width - spec.wire) / (profile.reference_width - profile.reference_wire);
    let axial_wire_scale = spec.wire / (profile.reference_wire * axial_scale);
    let source = &profile.paths;
    let mut result: Vec<Vec<Vec2>> = Vec::with_capacity(2 * spec.turns + 5);
    let mut append = |index: usize, shift: f64| {
        let points = source[index]
            .iter()
            .enumerate()
            .map(|(vertex, [raw_axial, raw_across])| {
                let normal = outline_normal(&source[index], vertex);
                // Transform the centreline, then restore a constant wire radius
                // along its transformed normal instead of stretching the wire.
                let position = (raw_axial + shift - radius * normal.x - radius)
                    .clamp(0.0, reference_length - 2.0 * radius);
                let across = (raw_across - radius * normal.y)
                    .clamp(radius, profile.reference_width - radius);
                let (top, top_slope) = end_wire_adjustment(position, axial_wire_scale);
                let (bottom, bottom_slope) = end_wire_adjustment(
                    reference_length - 2.0 * radius - position,
                    axial_wire_scale,
                );
                let nx = normal.x / (axial_scale * (1.0 + top_slope + bottom_slope));
                let ny = normal.y / across_scale;
                let size = nx.hypot(ny);
                Vec2::new(
                    spec.wire / 2.0
                        + axial_scale * (position + top - bottom)
                        + spec.wire / 2.0 * nx / size,
                    spec.wire / 2.0
                        + across_scale * (across - radius)
                        + spec.wire / 2.0 * ny / size,
                )
            });
        result.push(points.collect());
    };
    append(0, 0.0); // first close turn, left outline
    append(1, 0.0); // transition to active turns
    for turn in 0..spec.turns - 3 {
        append(2, (turn as f64 - 1.0) * profile.reference_pitch);
    }
    append(3, extra); // last close turn, left outline
    append(4, extra); // last close turn, right outline
    append(5, extra);
    for turn in 0..spec.turns - 3 {
        append(6, extra + (1.0 - turn as f64) * profile.reference_pitch);
    }
    append(7, 0.0);
    append(8, 0.0);
    append(9, 0.0);
    append(10, 0.0);
    append(11, extra);
    append(12, extra);
    join_visible_turns(&mut result, spec.turns, width, true);
    // Keep shared seams exact when independently sampled cap arcs are offset.
    let face_start = result[2 * spec.turns + 2][0];
    *result[2 * spec.turns + 2].last_mut().unwrap() = face_start;
    *result[2 * spec.turns + 1].last_mut().unwrap() = face_start;
    let cap_start = *result[2 * spec.turns + 4].last().unwrap();
    result[2 * spec.turns + 3][0] = cap_start;
    let tip_start = result[2 * spec.turns + 4][0];
    *result[spec.turns - 1].last_mut().unwrap() = tip_start;
    let cap_end = *result[2 * spec.turns + 3].last().unwrap();
    result[spec.turns][0] = cap_end;
    result
        .into_iter()
        .map(|points| {
            polyline(
                points
                    .into_iter()
                    .map(|p| Vec2::new(p.x / length, (width / 2.0 - p.y) / width)),
            )
        })
        .collect()
}

// Retain the old generator only to recognize untouched saved V4 blocks.
// A mismatch means somebody edited the geometry and it must not be replaced.
fn previous_v4_geometry(spec: &Spec, length: f64, width: f64) -> Vec<EntityKind> {
    let profile = profile();
    let extra = (spec.turns as f64 - profile.reference_turns as f64) * profile.reference_pitch;
    let reference_length = profile.reference_length + extra;
    let wire_scale = spec.wire * reference_length / (profile.reference_wire * length);
    let across = |raw: f64| {
        let outer = profile.reference_width;
        let inner = outer - profile.reference_wire;
        let target = outer * (1.0 - spec.wire / width);
        let first = target / inner;
        let last = (outer - target) / profile.reference_wire;
        let middle = 2.0 * first * last / (first + last);
        let (start, end, from, to, slope_start, slope_end) = if raw <= inner {
            (0.0, inner, 0.0, target, first, middle)
        } else {
            (inner, outer, target, outer, middle, last)
        };
        let span = end - start;
        let t = (raw.clamp(0.0, outer) - start) / span;
        (2.0 * t.powi(3) - 3.0 * t.powi(2) + 1.0) * from
            + (t.powi(3) - 2.0 * t.powi(2) + t) * span * slope_start
            + (-2.0 * t.powi(3) + 3.0 * t.powi(2)) * to
            + (t.powi(3) - t.powi(2)) * span * slope_end
    };
    let mut result = Vec::with_capacity(2 * spec.turns + 5);
    let mut append = |index: usize, shift: f64| {
        result.push(polyline(profile.paths[index].iter().map(|[x, y]| {
            let position = x + shift;
            let axial = position + end_wire_adjustment(position, wire_scale).0
                - end_wire_adjustment(reference_length - position, wire_scale).0;
            Vec2::new(
                axial / reference_length,
                (profile.reference_width / 2.0 - across(*y)) / profile.reference_width,
            )
        })));
    };
    append(0, 0.0);
    append(1, 0.0);
    for turn in 0..spec.turns - 3 {
        append(2, (turn as f64 - 1.0) * profile.reference_pitch);
    }
    append(3, extra);
    append(4, extra);
    append(5, extra);
    for turn in 0..spec.turns - 3 {
        append(6, extra + (1.0 - turn as f64) * profile.reference_pitch);
    }
    for index in 7..=10 {
        append(index, 0.0);
    }
    append(11, extra);
    append(12, extra);
    result
}

fn is_untouched_profile(children: &[Arc<Entity>], expected: Vec<EntityKind>) -> bool {
    children.len() == expected.len()
        && children
            .iter()
            .zip(expected)
            .all(|(child, kind)| match (&child.kind, kind) {
                (EntityKind::LwPolyline(actual), EntityKind::LwPolyline(expected)) => {
                    !actual.closed
                        && actual.const_width.abs() < 1e-6
                        && actual.elevation.abs() < 1e-6
                        && !actual.plinegen
                        && actual.vertices.len() == expected.vertices.len()
                        && actual.vertices.iter().zip(expected.vertices).all(|(a, b)| {
                            (a.p.x - b.p.x).abs() < 1e-6
                                && (a.p.y - b.p.y).abs() < 1e-6
                                && a.bulge.abs() < 1e-6
                                && a.start_width.abs() < 1e-6
                                && a.end_width.abs() < 1e-6
                        })
                }
                _ => false,
            })
}

/// Upgrade only untouched earlier profiles. Externally edited blocks stay as-is.
pub(crate) fn upgrade_legacy_blocks(doc: &mut Drawing) {
    let names: Vec<String> = doc
        .blocks
        .iter()
        .filter(|(_, block)| {
            block.description.starts_with(LEGACY_PREFIX)
                || block.description.starts_with(PREVIOUS_PREFIX)
                || block.description.starts_with(V3_PREFIX)
                || block.description.starts_with(V4_PREFIX)
                || block.description.starts_with(PREVIOUS_EXTENSION_PREFIX)
        })
        .map(|(name, _)| name.clone())
        .collect();
    for name in names {
        let Some(block) = doc.blocks.get(&name) else {
            continue;
        };
        let is_v1 = block.description.starts_with(LEGACY_PREFIX);
        let is_v3 = block.description.starts_with(V3_PREFIX);
        let is_v4 = block.description.starts_with(V4_PREFIX);
        let extension = block.description.starts_with(PREVIOUS_EXTENSION_PREFIX);
        let prefix = if extension {
            PREVIOUS_EXTENSION_PREFIX
        } else if is_v1 {
            LEGACY_PREFIX
        } else if is_v3 {
            V3_PREFIX
        } else if is_v4 {
            V4_PREFIX
        } else {
            PREVIOUS_PREFIX
        };
        let Ok(stored) = serde_json::from_str::<Value>(&block.description[prefix.len()..]) else {
            continue;
        };
        let Ok(original) = spec(&stored) else {
            continue;
        };
        let Some(base_width) = stored["baseWidth"]
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.0)
        else {
            continue;
        };
        let samples = original.turns * 24;
        let children: Vec<_> = block.entities.iter().cloned().collect();
        let half_wire = original.wire / (2.0 * base_width);
        let radius = 0.5 - half_wire;
        let generated = children.len() == 4
            && children
                .iter()
                .enumerate()
                .all(|(index, entity)| match &entity.kind {
                    EntityKind::LwPolyline(curve) if index < 2 => {
                        let side = if index == 0 { -1.0 } else { 1.0 };
                        !curve.closed
                            && curve.const_width.abs() < 1e-6
                            && curve.elevation.abs() < 1e-6
                            && !curve.plinegen
                            && curve.vertices.len() == samples + 1
                            && curve.vertices.iter().enumerate().all(|(i, vertex)| {
                                let t = i as f64 / samples as f64;
                                (vertex.p.x - t).abs() < 1e-6
                                    && (vertex.p.y
                                        - radius * (TAU * original.turns as f64 * t).sin()
                                        - side * half_wire)
                                        .abs()
                                        < 1e-6
                                    && vertex.bulge.abs() < 1e-6
                                    && vertex.start_width.abs() < 1e-6
                                    && vertex.end_width.abs() < 1e-6
                            })
                    }
                    EntityKind::Line(line) if index >= 2 => {
                        let x = if index == 2 { 0.0 } else { 1.0 };
                        (line.a.x - x).abs() < 1e-6
                            && (line.b.x - x).abs() < 1e-6
                            && (line.a.y + half_wire).abs() < 1e-6
                            && (line.b.y - half_wire).abs() < 1e-6
                            && line.a.z.abs() < 1e-6
                            && line.b.z.abs() < 1e-6
                    }
                    _ => false,
                });
        if children.is_empty() || (is_v1 && !generated) {
            continue;
        }
        if children
            .iter()
            .any(|child| child.common != children[0].common)
        {
            continue;
        }
        let references: Vec<_> = doc
            .model
            .iter()
            .chain(doc.layouts.iter().flat_map(|layout| layout.entities.iter()))
            .chain(doc.blocks.values().flat_map(|block| block.entities.iter()))
            .filter(|entity| matches!(&entity.kind, EntityKind::Insert(insert) if insert.block.eq_ignore_ascii_case(&name)))
            .collect();
        let Some(display) = references.first().and_then(|entity| info(doc, entity)) else {
            continue;
        };
        let (Some(length), Some(width), Some(wire)) = (
            display["length"].as_f64(),
            display["width"].as_f64(),
            display["wire"].as_f64(),
        ) else {
            continue;
        };
        let validate = if extension {
            crate::extension_spring::dimensions
        } else {
            dimensions
        };
        if validate(length, width, original.turns, wire).is_err() {
            continue;
        }
        if extension {
            if !is_untouched_profile(
                &children,
                crate::extension_spring::previous_geometry(length, width, wire, original.turns),
            ) {
                continue;
            }
        } else if is_v3 || is_v4 {
            let current = Spec {
                turns: original.turns,
                wire,
            };
            let expected = if is_v4 {
                previous_v4_geometry(&current, length, width)
            } else {
                previous_v3_geometry(&current, length, width)
            };
            if !is_untouched_profile(&children, expected) {
                continue;
            }
        } else if !is_v1
            && !is_untouched_previous(
                &children,
                &Spec {
                    turns: original.turns,
                    wire,
                },
                length,
                width,
            )
        {
            continue;
        }
        // A block can have several INSERTs. Its normalized contour is only
        // reusable when every reference has the same wire-to-length ratio.
        let compatible_references = references.iter().all(|entity| {
            let Some(other) = info(doc, entity) else {
                return false;
            };
            let (Some(other_length), Some(other_width), Some(other_wire)) = (
                other["length"].as_f64(),
                other["width"].as_f64(),
                other["wire"].as_f64(),
            ) else {
                return false;
            };
            validate(other_length, other_width, original.turns, other_wire).is_ok()
                && (other_wire / other_length - wire / length).abs() < 1e-9
        });
        if !compatible_references {
            continue;
        }
        let mut upgraded = (**block).clone();
        let style = children[0].common.clone();
        let mut entities = EntityStore::new();
        let replacement_geometry = if extension {
            crate::extension_spring::geometry(length, width, wire, original.turns)
        } else {
            geometry(
                &Spec {
                    turns: original.turns,
                    wire,
                },
                length,
                width,
            )
        };
        for (index, kind) in replacement_geometry.into_iter().enumerate() {
            let mut replacement = if let Some(child) = children.get(index) {
                (**child).clone()
            } else {
                Entity::new(doc.new_handle(), kind.clone())
            };
            replacement.kind = kind;
            replacement.common = style.clone();
            entities.push(replacement);
        }
        upgraded.entities = entities;
        let current_prefix = if extension { EXTENSION_PREFIX } else { PREFIX };
        upgraded.description = format!("{current_prefix}{stored}");
        doc.blocks.insert(name, Arc::new(upgraded));
    }
}
pub(crate) fn info(doc: &Drawing, entity: &Entity) -> Option<Value> {
    let EntityKind::Insert(insert) = &entity.kind else {
        return None;
    };
    let block = doc.block(&insert.block)?;
    let description = block
        .description
        .strip_prefix(PREFIX)
        .or_else(|| block.description.strip_prefix(EXTENSION_PREFIX))
        .or_else(|| block.description.strip_prefix(PREVIOUS_EXTENSION_PREFIX))
        .or_else(|| block.description.strip_prefix(V4_PREFIX))
        .or_else(|| block.description.strip_prefix(V3_PREFIX))
        .or_else(|| block.description.strip_prefix(PREVIOUS_PREFIX))
        .or_else(|| block.description.strip_prefix(LEGACY_PREFIX))?;
    let stored: Value = serde_json::from_str(description).ok()?;
    let spec = spec(&stored).ok()?;
    let length = insert.scale.x.abs();
    let width = insert.scale.y.abs();
    let base_width = stored["baseWidth"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.0)?;
    let wire = spec.wire * width / base_width;
    // Generic CAD transforms may produce an aspect ratio outside the creation
    // limits. Keep the block recognizable so the user can adjust it again.
    if !length.is_finite()
        || length <= 1e-6
        || !width.is_finite()
        || width <= 1e-6
        || !wire.is_finite()
        || wire <= 0.0
    {
        return None;
    }
    let start = Vec2::new(insert.insert.x, insert.insert.y);
    let angle = insert.rotation
        + if insert.scale.x < 0.0 {
            std::f64::consts::PI
        } else {
            0.0
        };
    let end = start + Vec2::new(angle.cos(), angle.sin()) * length;
    Some(
        json!({"kind":if block.description.starts_with(EXTENSION_PREFIX) || block.description.starts_with(PREVIOUS_EXTENSION_PREFIX) {"extension"} else {"compression"},"turns":spec.turns,"wire":wire,"length":length,"width":width,
        "at":[start.x,start.y],"end":[end.x,end.y],"rotation":angle.to_degrees()}),
    )
}
pub(crate) fn grips(doc: &Drawing, entity: &Entity) -> Option<Vec<Vec2>> {
    let info = info(doc, entity)?;
    let start = point(&info, "at").ok()?;
    let end = point(&info, "end").ok()?;
    let axis = (end - start) / info["length"].as_f64()?;
    let perp = Vec2::new(-axis.y, axis.x);
    let center = (start + end) * 0.5;
    let width = info["width"].as_f64()?;
    Some(vec![
        start,
        end,
        center + perp * width * 0.5,
        start + axis * info["length"].as_f64()? * 0.75 + perp * width * 0.5,
        center,
    ])
}

impl CadcraftSession {
    pub(crate) fn spring(&mut self, p: &Value) -> Result<String, String> {
        let desired = spec(p)?;
        let mut extension = match p.get("kind") {
            None => false,
            Some(kind) if kind == "compression" => false,
            Some(kind) if kind == "extension" => true,
            _ => return Err("弹簧类型无效".into()),
        };
        let handle = p
            .get("handle")
            .map(|h| h.as_str().and_then(Handle::parse_hex).ok_or("弹簧对象无效"))
            .transpose()?;
        let state = self.session.state().map_err(|e| e.to_string())?;
        let mut doc = (*state.doc).clone();
        let mut common = self.current_common();
        let (mut insert, length, width) = if let Some(h) = handle {
            let entity = doc.model.get(h).ok_or("弹簧已不存在")?;
            if doc.layer(&entity.common.layer).is_some_and(|l| l.locked) {
                return Err("弹簧位于锁定图层".into());
            }
            let old = info(&doc, entity).ok_or("选中对象已不是可调整的弹簧")?;
            if p.get("kind").is_none() {
                extension = old["kind"] == "extension";
            }
            common = entity.common.clone();
            let EntityKind::Insert(existing) = &entity.kind else {
                unreachable!()
            };
            let mut insert = existing.clone();
            let old_length = old["length"].as_f64().unwrap();
            let old_width = old["width"].as_f64().unwrap();
            let old_start = point(&old, "at")?;
            let old_end = point(&old, "end")?;
            let start = if p.get("at").is_some() {
                point(p, "at")?
            } else {
                old_start
            };
            let end = if p.get("end").is_some() {
                point(p, "end")?
            } else if p.get("at").is_some() {
                start + (old_end - old_start)
            } else {
                old_end
            };
            let length = if p.get("length").is_some() {
                number(p, "length")?
            } else {
                (end - start).len()
            };
            let width = if p.get("width").is_some() {
                number(p, "width")?
            } else {
                old_width
            };
            if (end - start).len() <= 1e-6 {
                return Err("弹簧轴线不能为零".into());
            }
            insert.insert.x = start.x;
            insert.insert.y = start.y;
            if p.get("at").is_some() || p.get("end").is_some() {
                insert.rotation = (end.y - start.y).atan2(end.x - start.x)
                    - if insert.scale.x < 0.0 {
                        std::f64::consts::PI
                    } else {
                        0.0
                    };
            }
            insert.scale.x *= length / old_length;
            insert.scale.y *= width / old_width;
            (insert, length, width)
        } else {
            if doc.layer(&common.layer).is_some_and(|l| l.locked) {
                return Err("当前图层已锁定".into());
            }
            let start = point(p, "at")?;
            let end = point(p, "end")?;
            let length = (end - start).len();
            let width = number(p, "width")?;
            let insert = Insert {
                block: String::new(),
                insert: Vec3::new(start.x, start.y, 0.0),
                scale: Vec3::new(length, width, 1.0),
                rotation: (end.y - start.y).atan2(end.x - start.x),
                attribs: vec![],
                rows: 1,
                cols: 1,
                row_spacing: 0.0,
                col_spacing: 0.0,
            };
            (insert, length, width)
        };
        if extension {
            crate::extension_spring::dimensions(length, width, desired.turns, desired.wire)?;
        } else {
            dimensions(length, width, desired.turns, desired.wire)?;
        }
        let previous = handle.map(|_| insert.block.clone());
        let name = format!(
            "{}_{}",
            if extension {
                "PW_EXTENSION_SPRING_V1"
            } else {
                "PW_SPRING_V5"
            },
            doc.new_handle().hex()
        );
        let mut block = Block::new(&name);
        block.description = format!(
            "{}{}",
            if extension { EXTENSION_PREFIX } else { PREFIX },
            json!({"turns":desired.turns,"wire":desired.wire,"baseWidth":width})
        );
        for kind in if extension {
            crate::extension_spring::geometry(length, width, desired.wire, desired.turns)
        } else {
            geometry(&desired, length, width)
        } {
            let mut child = Entity::new(doc.new_handle(), kind);
            child.common.color = cadcraft_engine::doc::color::Color::ByBlock;
            child.common.lineweight = cadcraft_engine::doc::Lineweight::ByBlock;
            child.common.linetype = "ByBlock".into();
            block.entities.push(child);
        }
        doc.blocks.insert(name.clone(), Arc::new(block));
        insert.block = name;
        let h = if let Some(h) = handle {
            doc.model.replace(Entity {
                handle: h,
                common,
                kind: EntityKind::Insert(insert),
            });
            h
        } else {
            doc.add(&Space::Model, common, EntityKind::Insert(insert))
                .map_err(|e| e.to_string())?
        };
        if let Some(old) = previous {
            let referenced = doc
                .model
                .iter()
                .chain(doc.layouts.iter().flat_map(|layout| layout.entities.iter()))
                .chain(doc.blocks.values().flat_map(|block| block.entities.iter()))
                .any(|entity| {
                    matches!(&entity.kind, EntityKind::Insert(insert) if insert.block.eq_ignore_ascii_case(&old))
                });
            if !referenced {
                if let Some(key) = doc
                    .blocks
                    .keys()
                    .find(|name| name.eq_ignore_ascii_case(&old))
                    .cloned()
                {
                    doc.blocks.remove(&key);
                }
            }
        }
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        state.push_undo(Snapshot {
            label: "弹簧".into(),
            doc: state.doc.clone(),
            selection: state.selection.clone(),
        });
        state.doc = Arc::new(doc);
        state.revision += 1;
        self.hatch_preview = None;
        Ok(json!({"handle":h.hex(),"handles":[h.hex()]}).to_string())
    }
    pub(crate) fn spring_grip(&mut self, p: &Value) -> Result<Option<String>, String> {
        let h = p["handle"]
            .as_str()
            .and_then(Handle::parse_hex)
            .ok_or("控制点对象无效")?;
        let doc = self.session.doc().map_err(|e| e.to_string())?;
        let Some(entity) = doc.model.get(h) else {
            return Ok(None);
        };
        let Some(info) = info(doc, entity) else {
            return Ok(None);
        };
        let to = point(p, "to")?;
        let index = p["index"].as_u64().ok_or("控制点序号无效")?;
        let start = point(&info, "at")?;
        let end = point(&info, "end")?;
        let length = info["length"].as_f64().unwrap();
        let width = info["width"].as_f64().unwrap();
        let axis = (end - start) / length;
        let perp = Vec2::new(-axis.y, axis.x);
        let turns = info["turns"].as_u64().unwrap() as i64;
        let wire = info["wire"].as_f64().unwrap();
        let extension = info["kind"] == "extension";
        let minimum_length = if extension {
            2.0 * width + (turns - 1) as f64 * wire
        } else {
            2.02 * turns as f64 * wire
        };
        let mut change = json!({"handle":h.hex(),"turns":turns,"wire":info["wire"]});
        match index {
            0 => {
                let at = if (end - to).len() < minimum_length {
                    end - axis * minimum_length
                } else {
                    to
                };
                change["at"] = json!([at.x, at.y]);
                change["end"] = json!([end.x, end.y]);
            }
            1 => {
                let end = if (to - start).len() < minimum_length {
                    start + axis * minimum_length
                } else {
                    to
                };
                change["end"] = json!([end.x, end.y]);
            }
            2 => {
                let mut new_width = (2.0 * (to - (start + end) * 0.5).dot(perp))
                    .abs()
                    .max(wire * 3.01);
                if extension {
                    new_width = new_width.min((length - (turns - 1) as f64 * wire) / 2.0);
                }
                change["width"] = json!(new_width);
            }
            3 => {
                let base = start + axis * length * 0.75 + perp * width * 0.5;
                let shift = (to - base).dot(axis);
                let maximum = if extension {
                    ((length - 2.0 * width) / wire + 1.0 + 1e-8).floor() as i64
                } else {
                    ((length / (2.0 * wire)) - 1e-8).floor() as i64
                };
                if maximum < 3 {
                    return Err("弹簧长度不足以容纳 3 圈，请先拉长弹簧".into());
                }
                change["turns"] = json!(
                    (turns + (shift / (length / turns as f64)).round() as i64)
                        .clamp(3, 24.min(maximum))
                );
            }
            4 => {
                let delta = to - (start + end) * 0.5;
                change["at"] = json!([start.x + delta.x, start.y + delta.y]);
                change["end"] = json!([end.x + delta.x, end.y + delta.y]);
            }
            _ => return Err("控制点序号无效".into()),
        }
        self.spring(&change).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_outline_stays_finite_and_within_the_requested_bounds() {
        for turns in [3, 6, 24] {
            for wire in [0.02, 2.0, 9.9] {
                let length = 80.0 + 2.1 * wire * turns as f64;
                for kind in geometry(&Spec { turns, wire }, length, 30.0) {
                    let EntityKind::LwPolyline(curve) = kind else {
                        unreachable!()
                    };
                    assert!(
                        curve.vertices.iter().all(|v| {
                            v.p.x.is_finite()
                                && v.p.y.is_finite()
                                && (-1e-3..=1.001).contains(&v.p.x)
                                && (-0.501..=0.501).contains(&v.p.y)
                        }),
                        "wire={wire}, turns={turns}"
                    );
                }
            }
        }
    }

    fn old_profile_document(version: &str) -> (CadcraftSession, Drawing, String) {
        let mut session = CadcraftSession::new();
        session
            .spring(&json!({
                "at": [0.0, 0.0], "end": [88.25, 0.0], "width": 45.0,
                "turns": 7, "wire": 4.5
            }))
            .unwrap();
        let mut doc = cadcraft_io::read(&session.export_dxf().unwrap(), "spring.dxf").unwrap();
        let name = doc
            .blocks
            .keys()
            .find(|name| name.starts_with("PW_SPRING_V5_"))
            .unwrap()
            .clone();
        let mut block = (**doc.blocks.get(&name).unwrap()).clone();
        block.description = block.description.replacen(PREFIX, version, 1);
        let old_children: Vec<_> = block.entities.iter().cloned().collect();
        let mut entities = EntityStore::new();
        let spec = Spec {
            turns: 7,
            wire: 4.5,
        };
        let old_geometry = if version == V4_PREFIX {
            previous_v4_geometry(&spec, 88.25, 45.0)
        } else {
            previous_v3_geometry(&spec, 88.25, 45.0)
        };
        for (source, kind) in old_children.iter().zip(old_geometry) {
            let mut child = (**source).clone();
            child.kind = kind;
            entities.push(child);
        }
        block.entities = entities;
        doc.blocks.insert(name.clone(), Arc::new(block));
        (session, doc, name)
    }

    #[test]
    fn untouched_v3_spring_is_upgraded_to_the_reference_profile() {
        let (mut session, doc, name) = old_profile_document(V3_PREFIX);
        session
            .load_dxf(&cadcraft_io::write(&doc, "old-v3.dxf").unwrap())
            .unwrap();
        let exported = cadcraft_io::read(&session.export_dxf().unwrap(), "new-v5.dxf").unwrap();
        assert!(exported.blocks[&name].description.starts_with(PREFIX));
        assert_eq!(exported.blocks[&name].entities.len(), 19);
    }

    #[test]
    fn extension_upgrade_only_replaces_untouched_compatible_profiles() {
        for mode in ["untouched", "edited", "shared-stretched"] {
            let mut session = CadcraftSession::new();
            session.spring(&json!({"kind":"extension","at":[0,0],"end":[82.7,0],"width":20,"turns":15,"wire":2.3})).unwrap();
            let mut doc = cadcraft_io::read(&session.export_dxf().unwrap(), "spring.dxf").unwrap();
            let name = doc
                .blocks
                .keys()
                .find(|n| n.starts_with("PW_EXTENSION_SPRING_"))
                .unwrap()
                .clone();
            let mut block = (**doc.blocks.get(&name).unwrap()).clone();
            block.description =
                block
                    .description
                    .replacen(EXTENSION_PREFIX, PREVIOUS_EXTENSION_PREFIX, 1);
            let children: Vec<_> = block.entities.iter().cloned().collect();
            let mut entities = EntityStore::new();
            for (source, kind) in children
                .iter()
                .zip(crate::extension_spring::previous_geometry(
                    82.7, 20.0, 2.3, 15,
                ))
            {
                let mut child = (**source).clone();
                child.kind = kind;
                entities.push(child);
            }
            block.entities = entities;
            if mode == "edited" {
                let mut child = (**block.entities.iter().next().unwrap()).clone();
                let EntityKind::LwPolyline(ref mut curve) = child.kind else {
                    unreachable!()
                };
                curve.vertices[5].p.y += 0.1;
                block.entities.replace(child);
            }
            if mode == "shared-stretched" {
                let EntityKind::Insert(mut insert) = doc.model.iter().next().unwrap().kind.clone()
                else {
                    unreachable!()
                };
                insert.scale.x *= 2.0;
                doc.add(
                    &Space::Model,
                    cadcraft_engine::doc::Common::default(),
                    EntityKind::Insert(insert),
                )
                .unwrap();
            }
            let before: Vec<_> = block.entities.iter().map(|e| e.kind.clone()).collect();
            doc.blocks.insert(name.clone(), Arc::new(block));
            session
                .load_dxf(&cadcraft_io::write(&doc, "legacy.dxf").unwrap())
                .unwrap();
            let exported =
                cadcraft_io::read(&session.export_dxf().unwrap(), "upgraded.dxf").unwrap();
            let children: Vec<_> = exported.blocks[&name].entities.iter().cloned().collect();
            let expected = if mode == "untouched" {
                crate::extension_spring::geometry(82.7, 20.0, 2.3, 15)
            } else {
                before
            };
            assert!(is_untouched_profile(&children, expected), "{mode}");
            let prefix = if mode == "untouched" {
                EXTENSION_PREFIX
            } else {
                PREVIOUS_EXTENSION_PREFIX
            };
            assert!(exported.blocks[&name].description.starts_with(prefix));
            let stable = session.export_dxf().unwrap();
            session.load_dxf(&stable).unwrap();
            assert_eq!(session.export_dxf().unwrap(), stable);
        }
    }

    #[test]
    fn externally_edited_v3_spring_keeps_its_original_lines() {
        let (mut session, mut doc, name) = old_profile_document(V3_PREFIX);
        let mut block = (**doc.blocks.get(&name).unwrap()).clone();
        let mut child = (**block.entities.iter().next().unwrap()).clone();
        let EntityKind::LwPolyline(ref mut curve) = child.kind else {
            unreachable!()
        };
        curve.vertices[5].p.y += 0.1;
        block.entities.replace(child);
        doc.blocks.insert(name.clone(), Arc::new(block));
        session
            .load_dxf(&cadcraft_io::write(&doc, "edited-v3.dxf").unwrap())
            .unwrap();
        let exported =
            cadcraft_io::read(&session.export_dxf().unwrap(), "after-import.dxf").unwrap();
        assert!(exported.blocks[&name].description.starts_with(V3_PREFIX));
        assert_eq!(exported.blocks[&name].entities.len(), 16);
    }

    #[test]
    fn untouched_v4_spring_is_upgraded_to_uniform_wire_geometry() {
        let (mut session, doc, name) = old_profile_document(V4_PREFIX);
        session
            .load_dxf(&cadcraft_io::write(&doc, "old-v4.dxf").unwrap())
            .unwrap();
        let exported = cadcraft_io::read(&session.export_dxf().unwrap(), "new-v5.dxf").unwrap();
        assert!(exported.blocks[&name].description.starts_with(PREFIX));
        let children: Vec<_> = exported.blocks[&name].entities.iter().cloned().collect();
        assert!(is_untouched_profile(
            &children,
            geometry(
                &Spec {
                    turns: 7,
                    wire: 4.5
                },
                88.25,
                45.0
            )
        ));
    }

    #[test]
    fn externally_edited_v4_spring_keeps_its_original_lines() {
        let (mut session, mut doc, name) = old_profile_document(V4_PREFIX);
        let mut block = (**doc.blocks.get(&name).unwrap()).clone();
        let mut child = (**block.entities.iter().next().unwrap()).clone();
        let EntityKind::LwPolyline(ref mut curve) = child.kind else {
            unreachable!()
        };
        curve.vertices[5].p.y += 0.1;
        let edited_point = curve.vertices[5].p;
        block.entities.replace(child);
        doc.blocks.insert(name.clone(), Arc::new(block));
        session
            .load_dxf(&cadcraft_io::write(&doc, "edited-v4.dxf").unwrap())
            .unwrap();
        let exported =
            cadcraft_io::read(&session.export_dxf().unwrap(), "after-import.dxf").unwrap();
        assert!(exported.blocks[&name].description.starts_with(V4_PREFIX));
        let EntityKind::LwPolyline(curve) =
            &exported.blocks[&name].entities.iter().next().unwrap().kind
        else {
            unreachable!()
        };
        assert!((curve.vertices[5].p - edited_point).len() < 1e-8);
    }
}
