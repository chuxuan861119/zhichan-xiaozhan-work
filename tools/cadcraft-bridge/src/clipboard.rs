//! Cross-drawing clipboard definitions and relationships. The target is never renamed.
use crate::CadcraftSession;
use cadcraft_engine::doc::{Block, Drawing, Entity, EntityKind, Group, Handle};
use std::{
    collections::{HashMap, hash_map::DefaultHasher},
    hash::{Hash, Hasher},
    sync::Arc,
};

type Names = HashMap<&'static str, HashMap<String, String>>;
fn isolated_name(prefix: &str, table: &str, name: &str) -> String {
    let mut hash = DefaultHasher::new();
    name.to_ascii_uppercase().hash(&mut hash);
    format!("{prefix}_{table}_{:016X}", hash.finish())
}
fn fix(names: &Names, table: &str, name: &mut String) {
    if let Some(to) = names
        .get(table)
        .and_then(|map| map.get(&name.to_ascii_uppercase()))
    {
        *name = to.clone();
    }
}
fn entity_names(e: &mut Entity, names: &Names) {
    fix(names, "layers", &mut e.common.layer);
    fix(names, "linetypes", &mut e.common.linetype);
    match &mut e.kind {
        EntityKind::Insert(i) => {
            fix(names, "blocks", &mut i.block);
            for a in &mut i.attribs {
                fix(names, "text_styles", &mut a.text.style);
            }
        }
        EntityKind::Text(t) => fix(names, "text_styles", &mut t.style),
        EntityKind::MText(t) => fix(names, "text_styles", &mut t.style),
        EntityKind::AttDef(a) => fix(names, "text_styles", &mut a.text.style),
        EntityKind::Dimension(d) => {
            fix(names, "dim_styles", &mut d.style);
            if let Some(b) = &mut d.block {
                fix(names, "blocks", b);
            }
        }
        EntityKind::Leader(l) => fix(names, "dim_styles", &mut l.style),
        EntityKind::Tolerance(t) => fix(names, "dim_styles", &mut t.style),
        EntityKind::MLeader(m) => {
            fix(names, "mleader_styles", &mut m.style);
            if let Some(t) = &mut m.text {
                fix(names, "text_styles", &mut t.style);
            }
            if let Some(b) = &mut m.block {
                fix(names, "blocks", &mut b.block);
            }
        }
        EntityKind::Table(t) => fix(names, "table_styles", &mut t.style),
        _ => {}
    }
}
pub(crate) fn same_block(a: &Block, b: &Block) -> bool {
    let mut am = a.clone();
    let mut bm = b.clone();
    am.entities = Default::default();
    bm.entities = Default::default();
    am.name.clear();
    bm.name.clear();
    am == bm
        && a.entities.len() == b.entities.len()
        && a.entities
            .iter()
            .zip(b.entities.iter())
            .all(|(a, b)| a.common == b.common && a.kind == b.kind)
}
impl CadcraftSession {
    /// Deterministic names let repeated pastes reuse definitions. Only referenced
    /// definitions collected by COPYBASE are walked, not every source model entity.
    pub(crate) fn isolate_clipboard(&self, source: &mut Self, data: &[u8]) -> Result<(), String> {
        let target = self.session.doc().map_err(|e| e.to_string())?;
        let clip = source
            .session
            .clipboard_source
            .as_mut()
            .ok_or("复制快照缺少定义")?;
        let defs = Arc::make_mut(&mut clip.defs);
        let mut hash = DefaultHasher::new();
        data.hash(&mut hash);
        let prefix = format!("PW_CLIP_{:016X}", hash.finish());
        let mut names = Names::new();
        let conflicts = defs.layers.iter().any(|a| {
            target
                .layers
                .iter()
                .any(|b| a.name.eq_ignore_ascii_case(&b.name) && a != b)
        }) || defs.linetypes.iter().any(|a| {
            target
                .linetypes
                .iter()
                .any(|b| a.name.eq_ignore_ascii_case(&b.name) && a != b)
        }) || defs.text_styles.iter().any(|a| {
            target
                .text_styles
                .iter()
                .any(|b| a.name.eq_ignore_ascii_case(&b.name) && a != b)
        }) || defs.dim_styles.iter().any(|a| {
            target
                .dim_styles
                .iter()
                .any(|b| a.name.eq_ignore_ascii_case(&b.name) && a != b)
        }) || defs.mleader_styles.iter().any(|a| {
            target
                .mleader_styles
                .iter()
                .any(|b| a.name.eq_ignore_ascii_case(&b.name) && a != b)
        }) || defs.table_styles.iter().any(|a| {
            target
                .table_styles
                .iter()
                .any(|b| a.name.eq_ignore_ascii_case(&b.name) && a != b)
        });
        macro_rules! table {
            ($field:ident) => {{
                let mut map = HashMap::new();
                for item in defs.$field.iter_mut() {
                    if conflicts {
                        let to = isolated_name(&prefix, stringify!($field), &item.name);
                        map.insert(item.name.to_ascii_uppercase(), to.clone());
                        item.name = to;
                    }
                }
                if !map.is_empty() {
                    names.insert(stringify!($field), map);
                }
            }};
        }
        table!(layers);
        table!(linetypes);
        table!(text_styles);
        table!(dim_styles);
        table!(mleader_styles);
        table!(table_styles);
        let block_conflict = defs.blocks.values().any(|b| {
            !b.anonymous
                && !b.name.starts_with('*')
                && target
                    .block(&b.name)
                    .is_some_and(|other| !same_block(b, other))
        });
        if !names.is_empty() || block_conflict {
            let mut map = HashMap::new();
            for b in defs
                .blocks
                .values()
                .filter(|b| !b.anonymous && !b.name.starts_with('*'))
            {
                map.insert(
                    b.name.to_ascii_uppercase(),
                    isolated_name(&prefix, "block", &b.name),
                );
            }
            names.insert("blocks", map);
        }
        if names.is_empty() {
            return Ok(());
        }
        for layer in &mut defs.layers {
            fix(&names, "linetypes", &mut layer.linetype);
        }
        for ltype in &mut defs.linetypes {
            for dash in &mut ltype.pattern {
                if let Some(style) = &mut dash.style {
                    fix(&names, "text_styles", style);
                }
            }
        }
        for style in &mut defs.dim_styles {
            fix(&names, "text_styles", &mut style.text_style);
            for block in [
                &mut style.arrow_block,
                &mut style.arrow_block1,
                &mut style.arrow_block2,
                &mut style.leader_arrow_block,
            ] {
                fix(&names, "blocks", block);
            }
            for ltype in [
                &mut style.dim_linetype,
                &mut style.ext_linetype1,
                &mut style.ext_linetype2,
            ] {
                fix(&names, "linetypes", ltype);
            }
        }
        for style in &mut defs.mleader_styles {
            fix(&names, "text_styles", &mut style.text_style);
        }
        for style in &mut defs.table_styles {
            for cell in &mut style.cell_styles {
                fix(&names, "text_styles", &mut cell.text_style);
            }
        }
        for block in defs.blocks.values_mut() {
            let block = Arc::make_mut(block);
            fix(&names, "blocks", &mut block.name);
            let handles: Vec<_> = block.entities.iter().map(|e| e.handle).collect();
            for h in handles {
                block.entities.modify(h, |e| entity_names(e, &names));
            }
        }
        defs.blocks = std::mem::take(&mut defs.blocks)
            .into_values()
            .map(|b| (b.name.clone(), b))
            .collect();
        for e in &mut source.session.clipboard {
            entity_names(e, &names);
        }
        Ok(())
    }
    pub(crate) fn paste_relationships(
        &mut self,
        source: &Drawing,
        old: &[Handle],
        new: &[Handle],
    ) -> Result<(), String> {
        let remap: HashMap<_, _> = old.iter().copied().zip(new.iter().copied()).collect();
        let doc = Arc::make_mut(&mut self.session.state_mut().map_err(|e| e.to_string())?.doc);
        for h in new {
            let mut e = doc.model.get(*h).ok_or("粘贴对象缺失")?.as_ref().clone();
            if let EntityKind::Hatch(hatch) = &mut e.kind {
                let mut complete = true;
                for boundary in &mut hatch.loops {
                    complete &= boundary.sources.iter().all(|h| remap.contains_key(h));
                    boundary.sources = boundary
                        .sources
                        .iter()
                        .filter_map(|h| remap.get(h).copied())
                        .collect();
                }
                if !complete {
                    hatch.associative = false;
                }
                doc.model.replace(e);
            }
        }
        for group in &source.groups {
            // Patent semantic membership is recreated from remapped metadata by
            // the existing synchronizer, never copied with its old business ID.
            if group.members.len() < 2
                || group.name.starts_with("PW_LABEL_")
                || group.name.starts_with("PW_DETAIL_")
                || !group.members.iter().all(|h| remap.contains_key(h))
            {
                continue;
            }
            let name = format!("PW_CLIP_GROUP_{}", doc.new_handle().hex());
            doc.groups.push(Group {
                name,
                description: group.description.clone(),
                selectable: group.selectable,
                members: group.members.iter().map(|h| remap[h]).collect(),
            });
        }
        Ok(())
    }
}
