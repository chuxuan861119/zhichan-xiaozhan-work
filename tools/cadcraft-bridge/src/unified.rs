//! Import normalization and disposable patent preview views over the upstream document.
use cadcraft_engine::doc::{
    AttribProps, Common, Drawing, Entity, EntityKind, EntityStore, Insert, Layer, Lineweight,
    Transparency, color::Color,
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Context {
    layer: String,
    color: Color,
    linetype: String,
    lineweight: Lineweight,
    transparency: Transparency,
    plot_style: String,
}

impl Default for Context {
    fn default() -> Self {
        Self {
            layer: "0".into(),
            color: Color::Index(7),
            linetype: "Continuous".into(),
            lineweight: Lineweight::Default,
            transparency: Transparency::Percent(0),
            plot_style: "Normal".into(),
        }
    }
}

fn weight(d: &Drawing, value: Lineweight) -> Lineweight {
    match value {
        Lineweight::Mm100(_) => value,
        _ => Lineweight::Mm100(match d.header.i64("LWDEFAULT", 25) {
            value @ 0..=211 => value as u16,
            _ => 25,
        }),
    }
}

fn bake(d: &Drawing, c: &Common, context: &Context) -> (Common, Context) {
    // Layer 0 in a block follows the insertion layer; named layers never do.
    let layer_name = if c.layer == "0" {
        &context.layer
    } else {
        &c.layer
    };
    let layer = d.layer(layer_name);
    let layer_color = layer.map(|l| l.color).unwrap_or(Color::Index(7));
    let mut common = c.clone();
    common.color = match c.color {
        Color::ByLayer => layer_color,
        Color::ByBlock => context.color,
        color => color,
    };
    if matches!(common.color, Color::ByLayer | Color::ByBlock) {
        common.color = Color::Index(7);
    }
    common.lineweight = weight(
        d,
        match c.lineweight {
            Lineweight::ByLayer => layer.map(|l| l.lineweight).unwrap_or_default(),
            Lineweight::ByBlock => context.lineweight,
            value => value,
        },
    );
    common.linetype = match c.linetype.to_ascii_lowercase().as_str() {
        "bylayer" => layer
            .map(|l| l.linetype.clone())
            .unwrap_or_else(|| "Continuous".into()),
        "byblock" => context.linetype.clone(),
        _ => c.linetype.clone(),
    };
    common.transparency = match c.transparency {
        Transparency::ByLayer => Transparency::Percent(layer.map(|l| l.transparency).unwrap_or(0)),
        Transparency::ByBlock => context.transparency,
        value => value,
    };
    common.plot_style = match c.plot_style.trim().to_ascii_lowercase().as_str() {
        "" | "bylayer" => layer
            .map(|l| l.plot_style.clone())
            .unwrap_or_else(|| "Normal".into()),
        "byblock" => context.plot_style.clone(),
        _ => c.plot_style.clone(),
    };
    common.visible = c.visible && layer.is_none_or(Layer::visible);
    common.layer = "0".into();
    let next = Context {
        layer: layer_name.clone(),
        color: common.color,
        lineweight: common.lineweight,
        linetype: common.linetype.clone(),
        transparency: common.transparency,
        plot_style: common.plot_style.clone(),
    };
    (common, next)
}

struct Normalizer<'a> {
    original: &'a Drawing,
    output: Drawing,
    blocks: HashMap<(String, Context), String>,
    baked_blocks: HashMap<String, bool>,
    serial: usize,
    remaining: usize,
    depth: usize,
}

impl Normalizer<'_> {
    fn block_baked(&mut self, name: &str) -> bool {
        if self.original.layer("0") != Some(&Layer::default()) || !self.original.hidden_objects.is_empty() {
            return false;
        }
        if let Some(baked) = self.baked_blocks.get(name) { return *baked; }
        let mut pending = vec![name.to_owned()];
        let mut visited = HashSet::new();
        while let Some(name) = pending.pop() {
            let Some(block) = self.original.block(&name) else { continue; };
            if !visited.insert(block.name.clone()) { continue; }
            for entity in block.entities.iter() {
                if !block_entity_baked(entity) {
                    self.baked_blocks.insert(name, false);
                    return false;
                }
                let reference = match &entity.kind {
                    EntityKind::Insert(insert) => Some(&insert.block),
                    EntityKind::MLeader(leader) => leader.block.as_ref().map(|i| &i.block),
                    EntityKind::Dimension(dimension) => dimension.block.as_ref(),
                    _ => None,
                };
                if let Some(reference) = reference { pending.push(reference.clone()); }
            }
        }
        for name in visited { self.baked_blocks.insert(name, true); }
        true
    }

    fn block(&mut self, name: &str, context: &Context) -> Result<String, String> {
        let Some(source) = self.original.block(name) else {
            // Unresolved source references remain unresolved, not replaced with fake geometry.
            return Ok(name.into());
        };
        let source = source.clone();
        // New ByLayer annotations invalidate the document-wide fast path, not
        // already explicit block definitions. Reuse the entire baked closure,
        // including legacy normalized blocks, without purging user definitions.
        if self.block_baked(&source.name) { return Ok(source.name.clone()); }
        let key = (source.name.clone(), context.clone());
        if let Some(name) = self.blocks.get(&key) {
            return Ok(name.clone());
        }
        if self.depth >= cadcraft_engine::doc::MAX_BLOCK_DEPTH {
            return Err("嵌套块超过 CAD 内核支持的深度，未修改原工作稿。".into());
        }
        let new_name = if *context == Context::default() {
            source.name.clone()
        } else {
            loop {
                self.serial += 1;
                let candidate = format!("PW_NORMALIZED_{}", self.serial);
                if self.output.block(&candidate).is_none()
                    && !self
                        .blocks
                        .values()
                        .any(|name| name.eq_ignore_ascii_case(&candidate))
                {
                    break candidate;
                }
            }
        };
        // Reserve before recursion: legal cyclic block references remain cyclic.
        self.blocks.insert(key, new_name.clone());
        let mut block = (*source).clone();
        block.name = new_name.clone();
        self.depth += 1;
        block.entities = self.store(&source.entities, context, new_name != source.name)?;
        self.depth -= 1;
        self.output.blocks.insert(new_name.clone(), Arc::new(block));
        Ok(new_name)
    }

    fn insertion(&mut self, insert: &mut Insert, context: &Context) -> Result<(), String> {
        let original_name = insert.block.clone();
        let mut attribute_visibility = BTreeMap::new();
        // ATTRIB overrides and definition inheritance are baked in this insertion context too.
        for attribute in &mut insert.attribs {
            let definition = self.original.block(&original_name).and_then(|block| {
                block.entities.iter().find(|entity| matches!(&entity.kind,
                    EntityKind::AttDef(definition) if definition.tag.eq_ignore_ascii_case(&attribute.tag)))
            });
            let base = definition
                .map(|entity| entity.common.clone())
                .unwrap_or(Common {
                    color: Color::ByBlock,
                    lineweight: Lineweight::ByBlock,
                    linetype: "ByBlock".into(),
                    ..Default::default()
                });
            let original=attribute.props.over(&base);
            let (mut common, _) = bake(self.original, &original, context);
            if original.color==Color::ByBlock {common.color=Color::ByBlock;}
            if original.lineweight==Lineweight::ByBlock {common.lineweight=Lineweight::ByBlock;}
            if original.linetype.eq_ignore_ascii_case("ByBlock") {common.linetype="ByBlock".into();}
            let tag = attribute.tag.to_ascii_lowercase();
            if attribute_visibility
                .insert(tag, common.visible)
                .is_some_and(|previous| previous != common.visible)
            {
                return Err("同名块属性具有不同可见性，无法安全合并图层。".into());
            }
            attribute.props = AttribProps {
                layer: Some("0".into()),
                color: Some(common.color),
                linetype: Some(common.linetype),
                lineweight: Some(common.lineweight),
            };
        }
        insert.block = self.block(&original_name, context)?;
        if !attribute_visibility.is_empty() {
            let block = self.output.block(&insert.block).cloned();
            let needs_visibility_definition = |tag: &str, visible: bool| {
                let definition = block.as_ref().and_then(|block| {
                    block.entities.iter().find(|entity| {
                        matches!(&entity.kind,
                    EntityKind::AttDef(attribute) if attribute.tag.eq_ignore_ascii_case(tag))
                    })
                });
                definition
                    .map(|entity| entity.common.visible)
                    .unwrap_or(true)
                    != visible
            };
            if attribute_visibility
                .iter()
                .any(|(tag, visible)| needs_visibility_definition(tag, *visible))
            {
                let mut block = block
                    .ok_or("缺少块定义，无法安全固化块属性可见性。")?
                    .as_ref()
                    .clone();
                loop {
                    self.serial += 1;
                    block.name = format!("PW_ATTRIBUTE_{}", self.serial);
                    if self.output.block(&block.name).is_none()
                        && !self
                            .blocks
                            .values()
                            .any(|name| name.eq_ignore_ascii_case(&block.name))
                    {
                        break;
                    }
                }
                let mut entities = EntityStore::new();
                for source in block.entities.iter() {
                    let mut entity = (**source).clone();
                    entity.handle = self.output.new_handle();
                    if let EntityKind::AttDef(attribute) = &entity.kind {
                        if let Some(visible) =
                            attribute_visibility.get(&attribute.tag.to_ascii_lowercase())
                        {
                            entity.common.visible = *visible;
                        }
                    }
                    entities.push(entity);
                }
                for attribute in &insert.attribs {
                    let found = entities.iter().any(|entity|matches!(&entity.kind,EntityKind::AttDef(definition) if definition.tag.eq_ignore_ascii_case(&attribute.tag)));
                    if !found && !attribute_visibility[&attribute.tag.to_ascii_lowercase()] {
                        let (mut common, _) = bake(
                            self.original,
                            &attribute.props.over(&Common::default()),
                            context,
                        );
                        common.visible = false;
                        entities.push(Entity {
                            handle: self.output.new_handle(),
                            common,
                            kind: EntityKind::AttDef(attribute.clone()),
                        });
                    }
                }
                block.entities = entities;
                insert.block = block.name.clone();
                self.output
                    .blocks
                    .insert(block.name.clone(), Arc::new(block));
            }
        }
        Ok(())
    }

    fn entity(
        &mut self,
        source: &Entity,
        context: &Context,
        cloned: bool,
    ) -> Result<Entity, String> {
        self.remaining = self
            .remaining
            .checked_sub(1)
            .ok_or("图层归一化超过块内容安全上限。")?;
        let mut entity = source.clone();
        let (mut common, next) = bake(self.original, &source.common, context);
        if self.depth > 0 {
            if source.common.color == Color::ByBlock { common.color=Color::ByBlock; }
            if source.common.lineweight == Lineweight::ByBlock { common.lineweight=Lineweight::ByBlock; }
            if source.common.linetype.eq_ignore_ascii_case("ByBlock") { common.linetype="ByBlock".into(); }
        }
        common.visible &= !self.original.is_hidden_object(source.handle);
        entity.common = common;
        if cloned {
            entity.handle = self.output.new_handle();
        }
        match &mut entity.kind {
            EntityKind::Insert(insert) => self.insertion(insert, &next)?,
            EntityKind::MLeader(leader) => {
                if let Some(insert) = &mut leader.block {
                    self.insertion(insert, &next)?;
                }
            }
            EntityKind::Dimension(dimension) => {
                if let Some(block) = &dimension.block {
                    dimension.block = Some(self.block(block, &next)?);
                }
                // DIMCLRx/DIMLWx/DIMLTx can independently inherit the original layer.
                let style = self
                    .original
                    .dim_style(&dimension.style)
                    .cloned()
                    .unwrap_or_default()
                    .with_overrides(&dimension.overrides);
                let layer_name = if source.common.layer == "0" {
                    &context.layer
                } else {
                    &source.common.layer
                };
                let layer = self.original.layer(layer_name);
                for (field, color) in [
                    ("dimLineColor", style.dim_line_color),
                    ("extLineColor", style.ext_line_color),
                    ("textColor", style.text_color),
                ] {
                    if color == Color::ByLayer {
                        dimension.overrides.insert(
                            field.into(),
                            serde_json::json!(layer.map(|l| l.color).unwrap_or(Color::Index(7))),
                        );
                    }
                }
                for (field, value) in [
                    ("dimLineweight", style.dim_lineweight),
                    ("extLineweight", style.ext_lineweight),
                ] {
                    if Lineweight::from_dxf(value) == Lineweight::ByLayer {
                        dimension.overrides.insert(
                            field.into(),
                            serde_json::json!(
                                weight(
                                    self.original,
                                    layer.map(|l| l.lineweight).unwrap_or_default()
                                )
                                .to_dxf()
                            ),
                        );
                    }
                }
                for (field, value) in [
                    ("dimLinetype", &style.dim_linetype),
                    ("extLinetype1", &style.ext_linetype1),
                    ("extLinetype2", &style.ext_linetype2),
                ] {
                    if value.eq_ignore_ascii_case("bylayer") {
                        dimension.overrides.insert(
                            field.into(),
                            serde_json::json!(
                                layer.map(|l| l.linetype.as_str()).unwrap_or("Continuous")
                            ),
                        );
                    }
                }
            }
            _ => {}
        }
        Ok(entity)
    }

    fn store(
        &mut self,
        source: &EntityStore,
        context: &Context,
        cloned: bool,
    ) -> Result<EntityStore, String> {
        let mut store = EntityStore::new();
        for entity in source.iter() {
            store.push(self.entity(entity, context, cloned)?);
        }
        Ok(store)
    }
}

fn baked(common: &Common) -> bool {
    common.layer == "0"
        && !matches!(common.color, Color::ByBlock | Color::ByLayer)
        && !common.linetype.eq_ignore_ascii_case("bylayer")
        && !common.linetype.eq_ignore_ascii_case("byblock")
        && matches!(common.lineweight, Lineweight::Mm100(_))
        && matches!(common.transparency, Transparency::Percent(_))
        && !common.plot_style.eq_ignore_ascii_case("bylayer")
        && !common.plot_style.eq_ignore_ascii_case("byblock")
}

fn entity_baked(entity: &Entity) -> bool {
    let insert = match &entity.kind {
        EntityKind::Insert(insert) => Some(insert),
        EntityKind::MLeader(leader) => leader.block.as_ref(),
        _ => None,
    };
    baked(&entity.common)
        && insert.is_none_or(|insert| {
            insert.attribs.iter().all(|a| {
                a.props.layer.as_deref() == Some("0")
                    && a.props
                        .color
                        .is_some_and(|color| !matches!(color, Color::ByLayer))
                    && a.props
                        .lineweight
                        .is_some_and(|value| matches!(value, Lineweight::Mm100(_) | Lineweight::ByBlock))
                    && a.props.linetype.as_ref().is_some_and(|value| {
                        !value.eq_ignore_ascii_case("bylayer")
                    })
            })
        })
}

fn block_entity_baked(entity: &Entity) -> bool {
    let mut probe=entity.clone();
    if probe.common.color == Color::ByBlock {probe.common.color=Color::Index(7);}
    if probe.common.lineweight == Lineweight::ByBlock {probe.common.lineweight=Lineweight::Mm100(25);}
    if probe.common.linetype.eq_ignore_ascii_case("ByBlock") {probe.common.linetype="Continuous".into();}
    entity_baked(&probe)
}

/// Returns a normalized clone; the caller publishes it only after the entire conversion succeeds.
pub fn flatten_layers(drawing: &Drawing) -> Result<Drawing, String> {
    if drawing.model.iter()
        .chain(drawing.layouts.iter().flat_map(|layout|layout.entities.iter()))
        .chain(drawing.blocks.values().flat_map(|block|block.entities.iter()))
        .any(|entity|matches!(&entity.kind,EntityKind::Viewport(viewport) if !viewport.frozen_layers.is_empty() || !viewport.layer_colors.is_empty())) {
        return Err("图纸含视口专属图层冻结或颜色，无法无损合并为单一图层，未修改原工作稿。".into());
    }
    // The reader starts with an unused Defpoints layer even when not saved. Strip unused
    // tables from an already normalized document without specializing its blocks again.
    let fully_baked = drawing.layer("0") == Some(&Layer::default())
        && drawing.hidden_objects.is_empty()
        && drawing.model.iter().all(|e| entity_baked(e))
        && drawing
            .layouts
            .iter()
            .all(|l| l.entities.iter().all(|e| entity_baked(e)))
        && drawing
            .blocks
            .values()
            .all(|b| b.entities.iter().all(|e| block_entity_baked(e)));
    if fully_baked {
        let mut normalized = drawing.clone();
        normalized.layers = vec![Layer::default()];
        normalized.header.set_str("CLAYER", "0");
        return Ok(normalized);
    }
    let mut normalizer = Normalizer {
        original: drawing,
        output: drawing.clone(),
        blocks: HashMap::new(),
        baked_blocks: HashMap::new(),
        serial: 0,
        remaining: cadcraft_engine::render::MAX_BLOCK_EXPANSION,
        depth: 0,
    };
    let context = Context::default();
    normalizer.output.model = normalizer.store(&drawing.model, &context, false)?;
    for (index, layout) in drawing.layouts.iter().enumerate() {
        normalizer.output.layouts[index].entities =
            normalizer.store(&layout.entities, &context, false)?;
    }
    for block in drawing.blocks.values() {
        normalizer.block(&block.name, &context)?;
    }
    normalizer.output.layers = vec![Layer::default()];
    normalizer.output.hidden_objects.clear();
    normalizer.output.header.set_str("CLAYER", "0");
    Ok(normalizer.output)
}

/// Preview-only copy: groups and the saved document remain intact for editable DWG/DXF export.
pub fn patent_preview(drawing: &Drawing) -> Drawing {
    let mut view = drawing.clone();
    // The patent view retains the opaque wipeout mask, not its CAD editing frame.
    view.header.set_i64("WIPEOUTFRAME", 0);
    for group in &drawing.groups {
        let label = group
            .name
            .strip_prefix("PW_LABEL_")
            .is_some_and(|id| !id.is_empty());
        let detail = group.name.strip_prefix("PW_DETAIL_").is_some_and(|suffix| {
            suffix
                .strip_suffix("_FRAME")
                .or_else(|| suffix.strip_suffix("_SOURCE"))
                .is_some_and(|id| !id.is_empty())
        });
        if label || detail {
            view.hidden_objects.extend(group.members.iter().copied());
        }
    }
    view
}

pub fn patent_svg(drawing: &Drawing, window: Option<cadcraft_engine::geom::Bounds2>) -> String {
    let svg = crate::appearance::svg(
        &patent_preview(drawing),
        window,
    );
    // Only the document background is removed. White paths from real WIPEOUTs stay opaque.
    svg.replacen(
        "<rect width=\"100%\" height=\"100%\" fill=\"white\"/>",
        "",
        1,
    )
}

/// The pinned writer regenerates DIMENSION anonymous geometry with ByLayer children.
/// Keep the semantic dimension record but restore its existing baked display block. This
/// operates only on our own canonical ASCII output, never on untrusted DXF text directly.
pub fn write_dxf(drawing: &Drawing) -> Result<Vec<u8>, String> {
    let mut staged = drawing.clone();
    let mut sources = HashMap::new();
    let dimensions: Vec<_> = drawing
        .model
        .iter()
        .chain(
            drawing
                .layouts
                .iter()
                .flat_map(|layout| layout.entities.iter()),
        )
        .filter_map(|entity| match &entity.kind {
            EntityKind::Dimension(dimension) => dimension
                .block
                .as_ref()
                .and_then(|name| drawing.block(name))
                .map(|block| (entity.handle, block.clone())),
            _ => None,
        })
        .collect();
    let referenced_blocks: std::collections::BTreeSet<_> = drawing
        .model
        .iter()
        .chain(
            drawing
                .layouts
                .iter()
                .flat_map(|layout| layout.entities.iter()),
        )
        .chain(
            drawing
                .blocks
                .values()
                .flat_map(|block| block.entities.iter()),
        )
        .filter_map(|entity| match &entity.kind {
            EntityKind::Insert(insert) => Some(insert.block.to_ascii_uppercase()),
            EntityKind::MLeader(leader) => leader
                .block
                .as_ref()
                .map(|insert| insert.block.to_ascii_uppercase()),
            EntityKind::Dimension(dimension) => dimension
                .block
                .as_ref()
                .map(|name| name.to_ascii_uppercase()),
            _ => None,
        })
        .collect();
    const CACHE_DESCRIPTION: &str = "Patent Workbench dimensional display cache";
    for (handle, source) in dimensions {
        let base_name = format!("PW_DIM_EXPORT_{}", handle.hex());
        let mut name = base_name.clone();
        let mut serial = 0;
        while staged.block(&name).is_some_and(|block| {
            block.description != CACHE_DESCRIPTION
                || referenced_blocks.contains(&name.to_ascii_uppercase())
        }) {
            serial += 1;
            name = format!("{base_name}_{serial}");
        }
        let mut block = (*source).clone();
        block.name = name.clone();
        block.description = CACHE_DESCRIPTION.into();
        let mut entities = EntityStore::new();
        for source in block.entities.iter() {
            let mut entity = (**source).clone();
            entity.handle = staged.new_handle();
            entities.push(entity);
        }
        block.entities = entities;
        staged.blocks.insert(name.clone(), Arc::new(block));
        staged
            .modify_entity(handle, |entity| {
                if let EntityKind::Dimension(dimension) = &mut entity.kind {
                    dimension.block = Some(name.clone());
                }
            })
            .map_err(|error| error.to_string())?;
        sources.insert(handle.hex(), name);
    }
    let bytes = cadcraft_io::write(&staged, "drawing.dxf").map_err(|error| error.to_string())?;
    // The pinned writer's header whitelist omits these drawing frame settings. The reader
    // already supports their integer header records; preserve the live values explicitly.
    let frame_variables: Vec<_> = ["WIPEOUTFRAME", "IMAGEFRAME", "FRAME"]
        .into_iter()
        .filter_map(|name| {
            staged
                .header
                .get(name)
                .and_then(|value| value.as_i64())
                .map(|value| (format!("${name}"), value))
        })
        .collect();
    if sources.is_empty() && frame_variables.is_empty() {
        return Ok(bytes);
    }
    let text = String::from_utf8(bytes).map_err(|error| error.to_string())?;
    let lines: Vec<_> = text.lines().collect();
    if lines.len() % 2 != 0 {
        return Err("尺寸标注 DXF 输出记录不完整。".into());
    }
    let mut tags: Vec<(i32, String)> = lines
        .chunks_exact(2)
        .map(|pair| {
            pair[0]
                .trim()
                .parse::<i32>()
                .map(|code| (code, pair[1].to_owned()))
                .map_err(|error| error.to_string())
        })
        .collect::<Result<_, _>>()?;
    let mut header_end = tags
        .iter()
        .position(|tag| tag.0 == 0 && tag.1 == "ENDSEC")
        .ok_or("DXF 输出缺少 HEADER 结尾。")?;
    for (name, value) in frame_variables {
        let indices: Vec<_> = tags[..header_end]
            .iter()
            .enumerate()
            .filter_map(|(index, tag)| (tag.0 == 9 && tag.1 == name).then_some(index))
            .collect();
        if indices.is_empty() {
            tags.splice(header_end..header_end, [(9, name), (70, value.to_string())]);
            header_end += 2;
        } else {
            for index in indices {
                let tag = tags.get_mut(index + 1).ok_or("DXF 框线设置缺少值。")?;
                *tag = (70, value.to_string());
            }
        }
    }
    let record_starts: Vec<_> = tags
        .iter()
        .enumerate()
        .filter_map(|(index, (code, _))| (*code == 0).then_some(index))
        .collect();
    let mut replacements = BTreeMap::new();
    for (position, start) in record_starts.iter().copied().enumerate() {
        if tags[start].1 != "DIMENSION" {
            continue;
        }
        let end = record_starts
            .get(position + 1)
            .copied()
            .unwrap_or(tags.len());
        let value = |code| {
            tags[start + 1..end]
                .iter()
                .find(|tag| tag.0 == code)
                .map(|tag| tag.1.clone())
        };
        if let (Some(handle), Some(target)) = (value(5), value(2)) {
            if let Some(source) = sources.get(&handle) {
                replacements.insert(target, source.clone());
            }
        }
    }
    let mut blocks = HashMap::new();
    for (position, start) in record_starts.iter().copied().enumerate() {
        if tags[start].1 != "BLOCK" {
            continue;
        }
        let body = record_starts
            .get(position + 1)
            .copied()
            .ok_or("尺寸块 DXF 输出缺少内容。")?;
        let end = record_starts[position + 1..]
            .iter()
            .copied()
            .find(|index| tags[*index].1 == "ENDBLK")
            .ok_or("尺寸块 DXF 输出未闭合。")?;
        let name = tags[start + 1..body]
            .iter()
            .find(|tag| tag.0 == 2)
            .map(|tag| tag.1.clone())
            .ok_or("尺寸块 DXF 输出缺少名称。")?;
        let owner = tags[start + 1..body]
            .iter()
            .find(|tag| tag.0 == 330)
            .map(|tag| tag.1.clone())
            .unwrap_or_default();
        blocks.insert(name, (body, end, owner));
    }
    let mut next_handle = tags
        .iter()
        .filter(|tag| matches!(tag.0, 5 | 105))
        .filter_map(|tag| u64::from_str_radix(tag.1.trim(), 16).ok())
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or("尺寸块 DXF handle 已耗尽。")?;
    let mut edits = Vec::new();
    for (target, source) in replacements {
        let (start, end, owner) = blocks.get(&target).ok_or("尺寸块 DXF 输出缺少目标块。")?;
        let (source_start, source_end, _) =
            blocks.get(&source).ok_or("尺寸块 DXF 输出缺少保留块。")?;
        let mut body = tags[*source_start..*source_end].to_vec();
        for (code, value) in &mut body {
            if *code == 5 {
                *value = format!("{next_handle:X}");
                next_handle = next_handle
                    .checked_add(1)
                    .ok_or("尺寸块 DXF handle 已耗尽。")?;
            } else if *code == 330 {
                *value = owner.clone();
            }
        }
        edits.push((*start, *end, body));
    }
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.0));
    for (start, end, body) in edits {
        tags.splice(start..end, body);
    }
    if !sources.is_empty()
        && let Some(index) = tags
            .iter()
            .position(|tag| tag.0 == 9 && tag.1 == "$HANDSEED")
    {
        if let Some(tag) = tags.get_mut(index + 1) {
            tag.1 = format!("{next_handle:X}");
        }
    }
    let mut output = String::new();
    use std::fmt::Write;
    for (code, value) in tags {
        writeln!(&mut output, "{code:>3}\n{value}").map_err(|error| error.to_string())?;
    }
    Ok(output.into_bytes())
}
