use crate::CadcraftSession;
use cadcraft_engine::{
    Snapshot,
    doc::{EntityKind, Handle, MText, TextStyle},
    geom::Vec3,
};
use serde_json::{Value, json};
use std::sync::Arc;

pub(crate) fn text_origin(
    doc: &cadcraft_engine::doc::Drawing,
    kind: &EntityKind,
) -> Option<cadcraft_engine::geom::Vec2> {
    use cadcraft_engine::{geom::Vec2, render};
    match kind {
        EntityKind::MText(t) => {
            if t.style == "Patent Workbench Text" {
                return Some(t.insert.xy());
            }
            let layout = render::layout_mtext_entity(doc, t);
            let h = t.height
                + (layout.lines.len().saturating_sub(1) as f64) * t.height * 5.0 / 3.0
                    * t.line_spacing;
            let col = (t.attach.clamp(1, 9) - 1) % 3;
            let row = (t.attach.clamp(1, 9) - 1) / 3;
            Some(
                t.insert.xy()
                    + Vec2::new(-(col as f64) * t.width / 2.0, (row as f64) * h / 2.0)
                        .rotate(t.rotation),
            )
        }
        EntityKind::Text(t) => {
            let mut flat = t.clone();
            flat.rotation = 0.0;
            let (_, bounds) = render::place_text_entity(doc, &flat, &t.value);
            let pivot = t.justify_point();
            // Keep the visible upper-left corner when converting aligned/rotated TEXT.
            let local = Vec2::new(bounds.min.x, bounds.max.y) - pivot;
            Some(pivot + local.rotate(t.rotation))
        }
        _ => None,
    }
}

fn literal(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\\P")
}

// Replace only the changed character range; retain formatting controls and
// unchanged fraction tokens from imported MTEXT, rather than flattening it.
fn replace_plain(source: &str, text: &str) -> String {
    let old: Vec<char> = cadcraft_fonts::plain_mtext(source).chars().collect();
    let new: Vec<char> = text.chars().collect();
    let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let end = old.len() - suffix;
    let replacement = literal(&new[prefix..new.len() - suffix].iter().collect::<String>());
    let chars: Vec<char> = source.chars().collect();
    let (mut i, mut pos, mut inserted) = (0, 0, false);
    let mut out = String::new();
    while i < chars.len() {
        let start = i;
        i += 1;
        if chars[start] == '\\' && i < chars.len() {
            let code = chars[i];
            i += 1;
            if !matches!(
                code,
                'P' | 'N' | '~' | '\\' | '{' | '}' | 'L' | 'l' | 'O' | 'o' | 'K' | 'k'
            ) {
                while i < chars.len() && chars[i] != ';' {
                    i += 1;
                }
                if i < chars.len() {
                    i += 1;
                }
            }
        }
        let raw: String = chars[start..i].iter().collect();
        let mut plain = cadcraft_fonts::plain_mtext(&raw);
        if raw.starts_with("\\S")
            && pos > 0
            && old[pos - 1].is_ascii_digit()
            && plain.starts_with(|c: char| c.is_ascii_digit())
        {
            plain.insert(0, ' ');
        }
        let visible: Vec<char> = plain.chars().collect();
        if visible.is_empty() {
            out.push_str(&raw);
            continue;
        }
        let next = pos + visible.len();
        if !inserted && prefix < next {
            let keep = prefix.saturating_sub(pos).min(visible.len());
            if keep > 0 {
                out.push_str(&literal(&visible[..keep].iter().collect::<String>()));
            }
            out.push_str(&replacement);
            inserted = true;
            if next > end {
                out.push_str(&literal(
                    &visible[end.saturating_sub(pos)..]
                        .iter()
                        .collect::<String>(),
                ));
            }
        } else if next <= prefix || pos >= end {
            // A stack inserts an implicit space after a digit. Editing its
            // neighbour can change that rule: preserve the visible characters.
            if raw.starts_with("\\S") {
                let before = cadcraft_fonts::plain_mtext(&out);
                let combined = cadcraft_fonts::plain_mtext(&format!("{out}{raw}"));
                if combined.strip_prefix(&before) != Some(plain.as_str()) {
                    out.push_str(&literal(&plain));
                } else {
                    out.push_str(&raw);
                }
            } else {
                out.push_str(&raw);
            }
        } else if next > end {
            out.push_str(&literal(&visible[end - pos..].iter().collect::<String>()));
        }
        pos = next;
    }
    if !inserted {
        out.push_str(&replacement);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imported_text_edit_retains_attachment_rotation_style_and_spacing() {
        let mut s = CadcraftSession::new();
        let result:Value=serde_json::from_str(&s.execute("mtext", &json!({"at":[30,40],"text":r"{\C1;红色}{\H2x;大字}","height":3,"width":100,"attach":5,"rotation":35,"lineSpacing":1.5}).to_string()).unwrap()).unwrap();
        let handle = Handle::parse_hex(result["handle"].as_str().unwrap()).unwrap();
        let EntityKind::MText(before) = s
            .session
            .state()
            .unwrap()
            .doc
            .model
            .get(handle)
            .unwrap()
            .kind
            .clone()
        else {
            panic!()
        };
        s.edit_text(&json!({"handle":handle.hex(),"text":"红色大字修改","height":3,"width":100}))
            .unwrap();
        let state = s.session.state().unwrap();
        let EntityKind::MText(after) = &state.doc.model.get(handle).unwrap().kind else {
            panic!()
        };
        assert_eq!(after.insert, before.insert);
        assert_eq!(after.rotation, before.rotation);
        assert_eq!(after.attach, before.attach);
        assert_eq!(after.style, before.style);
        assert_eq!(after.line_spacing, before.line_spacing);
        assert_eq!(cadcraft_fonts::plain_mtext(&after.contents), "红色大字修改");
        assert!(after.contents.contains(r"\C1;"));
        assert!(after.contents.contains(r"\H2x;"));
    }
    #[test]
    fn edits_preserve_inline_formatting_and_unchanged_stacks() {
        let original = r"{\C1;红色}{\H2x;大字}\P6\S1/2;";
        let result = replace_plain(original, "红色大字改\n6 1/2");
        assert_eq!(cadcraft_fonts::plain_mtext(&result), "红色大字改\n6 1/2");
        assert!(result.contains(r"\C1;"));
        assert!(result.contains(r"\H2x;"));
        assert!(result.contains(r"\S1/2;"));
        for changed in ["", "替换全部", "红色大字\n6 2/3", "红色大字\n6 1/2末尾"] {
            assert_eq!(
                cadcraft_fonts::plain_mtext(&replace_plain(original, changed)),
                changed
            );
        }
        for (source, target) in [(r"6\S1/2;", "A 1/2"), (r"A\S1/2;", "61/2")] {
            assert_eq!(
                cadcraft_fonts::plain_mtext(&replace_plain(source, target)),
                target
            );
        }
    }
}

impl CadcraftSession {
    pub(crate) fn text_grip(&mut self, p: &Value) -> Result<Option<String>, String> {
        let Some(handle) = p["handle"].as_str().and_then(Handle::parse_hex) else {
            return Ok(None);
        };
        let state = self.session.state().map_err(|e| e.to_string())?;
        let Some(entity) = state.doc.model.get(handle) else {
            return Ok(None);
        };
        let EntityKind::MText(t) = &entity.kind else {
            return Ok(None);
        };
        if t.style != "Patent Workbench Text" {
            return Ok(None);
        }
        if p["index"] == 0 {
            return Ok(None);
        };
        let to: [f64; 2] = serde_json::from_value(p["to"].clone()).map_err(|_| "夹点位置无效")?;
        if to.iter().any(|v| !v.is_finite()) {
            return Err("夹点位置无效".into());
        }
        let delta =
            (cadcraft_engine::geom::Vec2::new(to[0], to[1]) - t.insert.xy()).rotate(-t.rotation);
        let (width, height) = match p["index"].as_u64() {
            Some(1) => (delta.x.max(t.height), t.height),
            Some(2) => {
                let factor = (delta.x / t.width.max(t.height)).max(0.01);
                (t.width.max(t.height) * factor, t.height * factor)
            }
            _ => return Err("无效的文字控制点".into()),
        };
        let params = json!({"handle":handle.hex(),"text":cadcraft_fonts::plain_mtext(&t.contents),"height":height,"width":width});
        self.edit_text(&params).map(Some)
    }
    pub(crate) fn edit_text(&mut self, p: &Value) -> Result<String, String> {
        let height = p["height"]
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0.0)
            .ok_or("字号须大于零")?;
        let width = p["width"]
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0.0)
            .ok_or("文字宽度须大于零")?;
        let text = p["text"].as_str().ok_or("缺少文字内容")?;
        if text.len() > 200_000 {
            return Err("文字内容过长".into());
        }
        let handle = p
            .get("handle")
            .map(|h| h.as_str().and_then(Handle::parse_hex).ok_or("文字对象无效"))
            .transpose()?;
        let state = self.session.state().map_err(|e| e.to_string())?;
        let mut doc = (*state.doc).clone();
        const STYLE: &str = "Patent Workbench Text";
        if doc.text_style(STYLE).is_none() {
            doc.text_styles.push(TextStyle {
                name: STYLE.into(),
                font: "Source Han Serif CN".into(),
                ..Default::default()
            });
        }
        if let Some(handle) = handle {
            let entity = doc.model.get(handle).ok_or("文字对象已不存在")?;
            if doc.layer(&entity.common.layer).is_some_and(|l| l.locked) {
                return Err("文字位于锁定图层".into());
            }
            let origin = text_origin(&doc, &entity.kind).ok_or("选中对象不是文字")?;
            let updated = match &entity.kind {
                EntityKind::MText(t) => {
                    let mut t = t.clone();
                    // Retain imported inline formatting when only sizing the object.
                    if cadcraft_fonts::plain_mtext(&t.contents) != text {
                        t.contents = replace_plain(&t.contents, text);
                    }
                    t.height = height;
                    t.width = width;
                    t
                }
                EntityKind::Text(t) => MText {
                    insert: Vec3::new(origin.x, origin.y, t.insert.z),
                    height,
                    width,
                    attach: 1,
                    rotation: t.rotation,
                    style: t.style.clone(),
                    contents: literal(text),
                    line_spacing: 1.0,
                    line_spacing_exact: false,
                    columns: None,
                },
                _ => return Err("选中对象不是文字".into()),
            };
            if text.trim().is_empty() {
                doc.remove_entity(handle);
            } else {
                doc.modify_entity(handle, |e| e.kind = EntityKind::MText(updated))
                    .map_err(|e| e.to_string())?;
            }
            let state = self.session.state_mut().map_err(|e| e.to_string())?;
            state.push_undo(Snapshot {
                label: "编辑文字".into(),
                doc: state.doc.clone(),
                selection: state.selection.clone(),
            });
            state.doc = Arc::new(doc);
            state.revision += 1;
            return Ok(json!({"handle":handle.hex()}).to_string());
        }
        let at: [f64; 2] = serde_json::from_value(p["at"].clone()).map_err(|_| "文字位置无效")?;
        if at.iter().any(|v| !v.is_finite()) {
            return Err("文字位置无效".into());
        }
        // Execute against a staged document. An invalid command cannot partially change the live one.
        let mut staged = Self::new();
        let mut state = state.clone();
        state.undo.clear();
        state.redo.clear();
        state.doc = Arc::new(doc);
        *staged.session.state_mut().map_err(|e| e.to_string())? = state;
        let result = staged
            .session
            .execute(
                "mtext",
                &json!({"at":at,"text":literal(text),"height":height,"width":width,"style":STYLE}),
            )
            .map_err(|e| e.to_string())?;
        let state = self.session.state_mut().map_err(|e| e.to_string())?;
        state.push_undo(Snapshot {
            label: "文字".into(),
            doc: state.doc.clone(),
            selection: state.selection.clone(),
        });
        state.doc = staged
            .session
            .state()
            .map_err(|e| e.to_string())?
            .doc
            .clone();
        state.revision += 1;
        Ok(result.to_string())
    }
}
