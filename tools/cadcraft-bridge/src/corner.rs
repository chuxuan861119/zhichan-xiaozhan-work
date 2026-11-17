use crate::CadcraftSession;
use cadcraft_engine::{
    Snapshot,
    doc::{Entity, EntityKind, Handle, Space},
};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc};
fn geometry(v: &Value) -> Result<EntityKind, String> {
    fn bounded(v: &Value) -> bool {
        match v {
            Value::Number(n) => n.as_f64().is_some_and(|n| n.is_finite() && n.abs() <= 1e12),
            Value::Array(a) => a.iter().all(bounded),
            Value::Object(o) => o.values().all(bounded),
            _ => true,
        }
    }
    if !bounded(v) {
        return Err("角的坐标超出可用范围".into());
    }
    let k: EntityKind =
        serde_json::from_value(v.clone()).map_err(|e| format!("角的图形无效：{e}"))?;
    match &k {
        EntityKind::Line(l) if (l.a - l.b).len() > 1e-12 => {}
        EntityKind::Arc(a) if a.radius > 0.0 => {}
        EntityKind::LwPolyline(p) if (2..=100000).contains(&p.vertices.len()) => {}
        _ => return Err("仅支持有效的直线、圆弧和二维多段线角".into()),
    }
    Ok(k)
}
impl CadcraftSession {
    pub(crate) fn corner(&mut self, p: &Value) -> Result<String, String> {
        let edits = p["edits"]
            .as_array()
            .filter(|a| (1..=3).contains(&a.len()))
            .ok_or("请重新选择要调整的角")?;
        let state = self.session.state().map_err(|e| e.to_string())?;
        let mut doc = (*state.doc).clone();
        let mut seen = HashSet::new();
        let mut handles = Vec::new();
        for edit in edits {
            let h = edit["handle"]
                .as_str()
                .and_then(Handle::parse_hex)
                .ok_or("角的对象无效")?;
            if !seen.insert(h) {
                return Err("角的对象重复".into());
            }
            let old = doc.model.get(h).ok_or("角的对象已不存在")?;
            if doc.layer(&old.common.layer).is_some_and(|l| l.locked) || !doc.is_visible(old) {
                return Err("角的对象已锁定或不可见".into());
            }
            let before = geometry(&edit["before"])?;
            if old.kind != before {
                return Err("图形已发生变化，请重新选择角".into());
            }
            let kind = geometry(&edit["after"])?;
            let common = old.common.clone();
            doc.model.replace(Entity {
                handle: h,
                common,
                kind,
            });
            handles.push(h.hex());
        }
        let mut connector = p["connector"].as_str().map(str::to_owned);
        if let Some(create) = p.get("create") {
            let source = create["commonFrom"]
                .as_str()
                .and_then(Handle::parse_hex)
                .filter(|h| seen.contains(h))
                .ok_or("角缺少来源对象")?;
            let common = doc
                .model
                .get(source)
                .ok_or("角的来源已不存在")?
                .common
                .clone();
            let kind = geometry(&create["geometry"])?;
            if !matches!(kind, EntityKind::Line(_) | EntityKind::Arc(_)) {
                return Err("角连接只支持直线或圆弧".into());
            }
            let h = doc
                .add(&Space::Model, common, kind)
                .map_err(|e| e.to_string())?;
            handles.push(h.hex());
            connector = Some(h.hex());
        }
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        let before = state.doc.clone();
        state.push_undo(Snapshot {
            label: "调整角".into(),
            doc: state.doc.clone(),
            selection: state.selection.clone(),
        });
        state.doc = Arc::new(doc);
        state.revision += 1;
        cadcraft_engine::assoc::after_command(&mut self.session, Some(&before), None);
        self.hatch_preview = None;
        Ok(json!({"handles":handles,"cornerHandle":connector}).to_string())
    }
}
