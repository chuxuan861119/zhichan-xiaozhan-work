//! Side projection with opposite open round hooks. Shared sampled outline with UI preview.
use cadcraft_engine::{doc::EntityKind, geom::Vec2};
use std::sync::OnceLock;

fn remove_seam_loop(path: Vec<Vec2>) -> Vec<Vec2> {
    for i in 0..path.len() - 1 {
        for j in i + 2..path.len() - 1 {
            let p = path[i];
            let b = path[i + 1];
            let q = path[j];
            let d = path[j + 1];
            let ux = b.x - p.x;
            let uy = b.y - p.y;
            let vx = d.x - q.x;
            let vy = d.y - q.y;
            let det = ux * vy - uy * vx;
            if det.abs() < 1e-12 {
                continue;
            }
            let t = ((q.x - p.x) * vy - (q.y - p.y) * vx) / det;
            let s = ((q.x - p.x) * uy - (q.y - p.y) * ux) / det;
            if t <= 1e-7 || t >= 1.0 - 1e-7 || s <= 1e-7 || s >= 1.0 - 1e-7 {
                continue;
            }
            let mut joined = path[..=i].to_vec();
            joined.push(Vec2::new(p.x + t * ux, p.y + t * uy));
            joined.extend_from_slice(&path[j + 1..]);
            return remove_seam_loop(joined);
        }
    }
    path
}

// Match preview clipping: sample-count midpoints are not the physical U-bend.
fn trim_coil_starts(paths: &mut [Vec<Vec2>], order: &[usize], extend: bool) {
    for pair in order.windows(2) {
        let current = &paths[pair[1]];
        let previous = &paths[pair[0]];
        let middle = (current[0].y + current.last().unwrap().y) / 2.0;
        let mut bend = 0;
        for (i, p) in current.iter().enumerate() {
            if (p.y - middle).abs() > (current[bend].y - middle).abs() {
                bend = i;
            }
        }
        if bend == 0 || bend == current.len() - 1 {
            bend = current.len() / 2;
        }
        let mut hit: Option<(Vec2, usize, f64)> = None;
        for i in 0..bend {
            let p = current[i];
            let b = current[i + 1];
            let ux = b.x - p.x;
            let uy = b.y - p.y;
            for j in 0..previous.len() - 1 {
                let q = previous[j];
                let d = previous[j + 1];
                let vx = d.x - q.x;
                let vy = d.y - q.y;
                let det = ux * vy - uy * vx;
                if det.abs() < 1e-12 {
                    continue;
                }
                let t = ((q.x - p.x) * vy - (q.y - p.y) * vx) / det;
                let s = ((q.x - p.x) * uy - (q.y - p.y) * ux) / det;
                if ((i > 0 || !extend) && t < 0.0) || t > 1.0 || s < 0.0 || s > 1.0 {
                    continue;
                }
                let position = i as f64 + t;
                if hit.as_ref().is_none_or(|h| position > h.2) {
                    hit = Some((Vec2::new(p.x + t * ux, p.y + t * uy), i, position));
                }
            }
        }
        if let Some((p, i, _)) = hit {
            let mut clipped = vec![p];
            clipped.extend_from_slice(&current[i + 1..]);
            paths[pair[1]] = clipped;
        }
    }
}

fn join_end(paths: &mut [Vec<Vec2>], a: usize, b: usize, extend: bool) {
    paths[a].reverse();
    trim_coil_starts(paths, &[b, a], extend);
    paths[a].reverse();
}

fn trim_stem(paths: &mut [Vec<Vec2>], stem: usize, coil: usize, occluder: usize) {
    let count = paths[stem].len();
    let mut joined = paths[stem].clone();
    joined.extend_from_slice(&paths[coil][1..]);
    paths[coil] = remove_seam_loop(joined);
    join_end(paths, coil, occluder, false);
    let seam = (count - 1).min(paths[coil].len() - 2);
    paths[stem] = paths[coil][..=seam].to_vec();
    paths[coil] = paths[coil][seam..].to_vec();
}

pub(crate) fn dimensions(length: f64, width: f64, turns: usize, wire: f64) -> Result<(), String> {
    if !length.is_finite()
        || !width.is_finite()
        || length <= 1e-6
        || width <= 1e-6
        || length > 1e8
        || width > 1e8
        || !wire.is_finite()
        || wire <= 1e-6
        || wire >= width / 3.0
        || !(3..=24).contains(&turns)
    {
        return Err("弹簧尺寸无效；圈数须为 3～24，线径须小于宽度的三分之一".into());
    }
    if length + 1e-9 < 2.0 * width + (turns - 1) as f64 * wire {
        return Err("长度不足以容纳两端挂钩和线圈，请拉长弹簧、减小宽度、圈数或线径".into());
    }
    Ok(())
}

pub(crate) fn geometry(length: f64, width: f64, wire: f64, turns: usize) -> Vec<EntityKind> {
    build_geometry(length, width, wire, turns, false)
}

/// Exact old contour, used only to recognize unmodified generated blocks on load.
pub(crate) fn previous_geometry(
    length: f64,
    width: f64,
    wire: f64,
    turns: usize,
) -> Vec<EntityKind> {
    build_geometry(length, width, wire, turns, true)
}

fn build_geometry(
    length: f64,
    width: f64,
    wire: f64,
    turns: usize,
    legacy: bool,
) -> Vec<EntityKind> {
    static PROFILE: OnceLock<Vec<Vec<[f64; 2]>>> = OnceLock::new();
    let profile = PROFILE.get_or_init(|| {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/shared/drawing-markup/extension-spring-profile.json"
        ))
        .expect("valid extension spring profile");
        serde_json::from_value(value["paths"].clone()).expect("extension spring outlines")
    });
    let hook_scale = (width - wire) / 17.7;
    let extra = (turns as f64 - 15.0) * 3.0;
    let body_end = 63.85 + extra;
    let body_scale = (length - 2.0 * width + wire) / (turns as f64 * 3.0);
    let mut paths = Vec::new();
    let mut append = |index: usize, shift: f64| {
        // Ignore clipped-spline curl samples: they are not physical wire bends.
        let trim = if legacy {
            0
        } else if index == 7 {
            6
        } else if [4, 5, 8].contains(&index) {
            4
        } else {
            0
        };
        let template = &profile[index][..profile[index].len() - trim];
        paths.push(
            template
                .iter()
                .enumerate()
                .map(|(i, [x, y])| {
                    let a = template[i.saturating_sub(1)];
                    let b = template[(i + 1).min(template.len() - 1)];
                    let dx = b[0] - a[0];
                    let dy = b[1] - a[1];
                    let size = dx.hypot(dy);
                    let nx = dy / size;
                    let ny = -dx / size;
                    let center = x + shift - 1.15 * nx;
                    let across = y - 1.15 * ny;
                    let scale = if center <= 18.85 || center >= body_end {
                        hook_scale
                    } else {
                        body_scale
                    };
                    let along = if center <= 18.85 {
                        wire / 2.0 + (center - 1.15) * hook_scale
                    } else if center >= body_end {
                        length - wire / 2.0 - (81.55 + extra - center) * hook_scale
                    } else {
                        width - wire / 2.0 + (center - 18.85) * body_scale
                    };
                    let n = (nx / scale).hypot(ny / hook_scale);
                    Vec2::new(
                        along + wire / 2.0 * nx / scale / n,
                        wire / 2.0
                            + (across - 1.15) * hook_scale
                            + wire / 2.0 * ny / hook_scale / n,
                    )
                })
                .collect::<Vec<_>>(),
        );
    };
    for i in [0, 1, 2, 3, 4] {
        append(i, 0.0);
    }
    for i in 0..turns - 1 {
        append(5, i as f64 * 3.0);
    }
    append(6, extra);
    append(7, extra);
    for i in 0..turns - 1 {
        append(8, i as f64 * 3.0);
    }
    append(9, 0.0);
    for i in [10, 11, 12, 13] {
        append(i, extra);
    }
    let order: Vec<usize> = (4..=4 + turns)
        .chain(std::iter::once(5 + turns))
        .chain((0..turns - 1).map(|i| 4 + 2 * turns - i))
        .chain(std::iter::once(5 + 2 * turns))
        .collect();
    if legacy {
        let mut coils: Vec<_> = order.iter().map(|i| paths[*i].clone()).collect();
        super::spring::join_visible_turns(&mut coils, turns + 1, width, false);
        for (index, path) in order.into_iter().zip(coils) {
            paths[index] = path;
        }
    } else {
        let mut left = vec![2];
        left.extend_from_slice(&order[1..turns + 1]);
        let mut right = vec![7 + 2 * turns];
        right.extend_from_slice(&order[turns + 2..]);
        let top_stem = paths[2].clone();
        let bottom_stem = paths[7 + 2 * turns].clone();
        let top_coil = paths[4][1..].to_vec();
        let bottom_coil = paths[5 + turns][1..].to_vec();
        paths[2].extend(top_coil);
        paths[7 + 2 * turns].extend(bottom_coil);
        trim_coil_starts(&mut paths, &left, true);
        trim_coil_starts(&mut paths, &right, true);
        paths[2] = top_stem;
        paths[7 + 2 * turns] = bottom_stem;
        for i in 0..turns - 1 {
            join_end(&mut paths, 5 + i, 6 + turns + i, true);
            join_end(&mut paths, 6 + turns + i, 5 + i, true);
        }
        join_end(&mut paths, 4, 5 + 2 * turns, true);
        join_end(&mut paths, 5 + turns, 4 + turns, true);
        // Touching turns also hide the outgoing branch of the preceding coil.
        for i in 0..turns - 1 {
            let right = if i == turns - 2 {
                7 + 2 * turns
            } else {
                7 + turns + i
            };
            join_end(&mut paths, 5 + i, right, false);
        }
        join_end(&mut paths, 4, 6 + turns, false);
        for i in 0..turns - 1 {
            join_end(
                &mut paths,
                6 + turns + i,
                if i == 0 { 2 } else { 4 + i },
                false,
            );
        }
        join_end(&mut paths, 5 + turns, 3 + turns, false);
    }
    let mut snap = |a: usize, ai: isize, b: usize, bi: isize| {
        let ai = if ai < 0 {
            paths[a].len() - 1
        } else {
            ai as usize
        };
        let bi = if bi < 0 {
            paths[b].len() - 1
        } else {
            bi as usize
        };
        paths[b][bi] = paths[a][ai];
    };
    snap(0, -1, 2, 0);
    snap(1, 0, 3, -1);
    snap(2, -1, 4, 0);
    snap(3, 0, 5 + 2 * turns, -1);
    snap(4 + turns, -1, 6 + 2 * turns, 0);
    snap(5 + turns, 0, 7 + 2 * turns, -1);
    snap(8 + 2 * turns, 0, 6 + 2 * turns, -1);
    snap(9 + 2 * turns, -1, 7 + 2 * turns, 0);
    if !legacy {
        trim_stem(&mut paths, 2, 4, 6 + turns);
        trim_stem(&mut paths, 7 + 2 * turns, 5 + turns, 3 + turns);
        // Close only sub-wire sampling gaps left by clipping a neighbouring turn.
        for a in 4..=5 + 2 * turns {
            for index in [0, paths[a].len() - 1] {
                let p = paths[a][index];
                let mut distance = wire * 0.05;
                let mut nearest = None;
                for b in 2..=7 + 2 * turns {
                    if a == b {
                        continue;
                    }
                    for pair in paths[b].windows(2) {
                        let q = pair[0];
                        let end = pair[1];
                        let dx = end.x - q.x;
                        let dy = end.y - q.y;
                        let t = (((p.x - q.x) * dx + (p.y - q.y) * dy) / (dx * dx + dy * dy))
                            .clamp(0.0, 1.0);
                        let point = Vec2::new(q.x + t * dx, q.y + t * dy);
                        let gap = (point.x - p.x).hypot(point.y - p.y);
                        if gap < distance {
                            distance = gap;
                            nearest = Some(point);
                        }
                    }
                }
                if let Some(point) = nearest {
                    paths[a][index] = point;
                }
            }
        }
    }
    paths.push(vec![paths[0][0], *paths[1].last().unwrap()]);
    paths.push(vec![
        paths[9 + 2 * turns][0],
        *paths[8 + 2 * turns].last().unwrap(),
    ]);
    paths
        .into_iter()
        .map(|p| {
            super::spring::polyline(
                p.into_iter()
                    .map(|v| Vec2::new(v.x / length, (width / 2.0 - v.y) / width)),
            )
        })
        .collect()
}
