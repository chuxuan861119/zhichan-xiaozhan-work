use crate::CadcraftSession;
use cadcraft_engine::{
    Snapshot,
    doc::{Drawing, Handle},
};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc};

// One prepared result only. Document identity invalidates it across edits,
// restore, undo and reload; preview never mutates the live document/history.
pub(crate) struct PreparedHatch {
    base: Arc<Drawing>,
    doc: Arc<Drawing>,
    command: String,
    params: Value,
    result: Value,
    gap_points: Value,
}

fn boundary_key(p: &Value) -> Value {
    let mut p = p.clone();
    if let Some(fields) = p.as_object_mut() {
        for key in ["pattern", "scale", "angle", "style"] {
            fields.remove(key);
        }
    }
    p
}

fn same_hover_region(c: &PreparedHatch, p: &Value) -> bool {
    let Some(points) = p["points"].as_array().filter(|ps| ps.len() == 1) else {
        return false;
    };
    if c.params["points"].as_array().is_none_or(|ps| ps.len() != 1) {
        return false;
    }
    let mut a = boundary_key(&c.params);
    let mut b = boundary_key(p);
    a.as_object_mut().unwrap().remove("points");
    b.as_object_mut().unwrap().remove("points");
    if a != b {
        return false;
    }
    let Some((x, y)) = points[0][0].as_f64().zip(points[0][1].as_f64()) else {
        return false;
    };
    let point = cadcraft_engine::geom::Vec2::new(x, y);
    c.result["hatches"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|h| {
            let Some(handle) = h["handle"].as_str().and_then(Handle::parse_hex) else {
                return false;
            };
            let Some(e) = c.doc.entity(handle) else {
                return false;
            };
            let cadcraft_engine::doc::EntityKind::Hatch(h) = &e.kind else {
                return false;
            };
            // Preserve island membership even when the displayed island style ignores holes.
            h.loops
                .iter()
                .filter(|l| {
                    cadcraft_engine::geom::point_in_polygon(
                        &cadcraft_engine::geom::Polyline {
                            vertices: l.vertices.clone(),
                            closed: true,
                        }
                        .tessellate(1e-3),
                        point,
                    )
                })
                .count()
                % 2
                == 1
        })
}

impl CadcraftSession {
    pub(crate) fn preview_hatch(
        &mut self,
        command: &str,
        params: &Value,
    ) -> Result<String, String> {
        self.validate_edit(command, params)?;
        let mut state = self.session.state().map_err(|e| e.to_string())?.clone();
        let base = state.doc.clone();
        let cached = self.hatch_preview.as_ref().filter(|c| {
            Arc::ptr_eq(&c.base, &base)
                && c.command == command
                && (boundary_key(&c.params) == boundary_key(params) || same_hover_region(c, params))
                && ["pattern", "scale", "angle", "style"]
                    .iter()
                    .all(|k| c.params.get(k).is_some() == params.get(k).is_some())
        });
        let mut preview = Self::new();
        let cached_gaps = cached.map(|c| c.gap_points.clone());
        state.undo.clear();
        state.redo.clear();
        let result = if let Some(c) = cached {
            state.doc = c.doc.clone();
            *preview.session.state_mut().map_err(|e| e.to_string())? = state;
            let mut appearance = json!({"handles": c.result["hatches"].as_array().unwrap().iter().map(|h|h["handle"].clone()).collect::<Vec<_>>()});
            for key in ["pattern", "scale", "angle", "style"] {
                if let Some(v) = params.get(key) {
                    appearance[key] = v.clone();
                }
            }
            crate::hatch::execute(&mut preview.session, "hatchedit", &appearance)?;
            c.result.clone()
        } else {
            *preview.session.state_mut().map_err(|e| e.to_string())? = state;
            crate::hatch::preview(&mut preview.session, command, params)?
        };
        let touched: HashSet<Handle> = result["hatches"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|h| h["handle"].as_str().and_then(Handle::parse_hex))
            .collect();
        let mut scene: Value = serde_json::from_str(&preview.scene_filtered(Some(&touched))?)
            .map_err(|e| e.to_string())?;
        scene["acceptedPointIndices"] = result["acceptedPointIndices"].clone();
        scene["rejectedPointIndices"] = result["rejectedPointIndices"].clone();
        let gap_points = if result["rejectedPointIndices"]
            .as_array()
            .is_some_and(|v| !v.is_empty())
            || params["gapTolerance"].as_f64().is_some_and(|v| v > 0.0)
        {
            cached_gaps.unwrap_or_else(|| crate::hatch::gap_points(&base, params))
        } else {
            json!([])
        };
        scene["gapPoints"] = gap_points.clone();
        self.hatch_preview = if touched.is_empty()
            || result["rejectedPointIndices"]
                .as_array()
                .is_some_and(|v| !v.is_empty())
        {
            None
        } else {
            Some(PreparedHatch {
                base,
                doc: preview
                    .session
                    .state()
                    .map_err(|e| e.to_string())?
                    .doc
                    .clone(),
                command: command.into(),
                params: params.clone(),
                result,
                gap_points,
            })
        };
        Ok(scene.to_string())
    }

    pub(crate) fn commit_hatch_preview(
        &mut self,
        command: &str,
        params: &Value,
    ) -> Result<Option<Value>, String> {
        let Some(c) = self.hatch_preview.take() else {
            return Ok(None);
        };
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        if c.command != command || c.params != *params || !Arc::ptr_eq(&c.base, &state.doc) {
            return Ok(None);
        }
        state.push_undo(Snapshot {
            label: "剖面填充".into(),
            doc: state.doc.clone(),
            selection: state.selection.clone(),
        });
        state.doc = c.doc;
        state.revision += 1;
        Ok(Some(c.result))
    }
}
