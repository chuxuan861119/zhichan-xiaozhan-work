// Patent Workbench's plain-text style. The in-place editor uses the same bundled
// font, cap-height units, character advances and baseline spacing. Keep imported
// rich MTEXT on the original layout path.
pub fn layout_plain_text(t: &cadcraft_doc::MText) -> cadcraft_fonts::MTextLayout {
    use cadcraft_fonts::{MTextLayout, MTextPiece, TextFont, plain_mtext, shape_line, text_width};
    let font = TextFont::resolve("Source Han Serif CN");
    let text = plain_mtext(&t.contents);
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut width = 0.0;
    for c in text.chars() {
        if c == '\n' {
            lines.push(std::mem::take(&mut line));
            width = 0.0;
            continue;
        }
        let ch = c.to_string();
        let advance = text_width(&font, &ch, t.height, 1.0);
        if t.width > 0.0 && !line.is_empty() && width + advance > t.width + 1e-8 {
            lines.push(std::mem::take(&mut line));
            width = 0.0;
        }
        line.push(c);
        width += advance;
    }
    lines.push(line);
    let mut out = MTextLayout {
        lines,
        ..Default::default()
    };
    let step = t.height * 5.0 / 3.0 * t.line_spacing;
    for (i, line) in out.lines.iter().enumerate() {
        // The CAD shaper decodes %%d/%%p controls. This editor accepts literal text.
        let mut shaped = shape_line(&font, &line.replace('%', "%%%"), t.height, 1.0, 0.0);
        let offset = cadcraft_geom::Vec2::new(0.0, -t.height - i as f64 * step);
        shaped.map(|p| t.insert.xy() + (p + offset).rotate(t.rotation));
        out.strokes.extend(shaped.outlines());
        out.pieces.push(MTextPiece {
            color: None,
            shaped,
        });
    }
    for path in &out.strokes {
        for point in path {
            out.bounds.add(*point);
        }
    }
    out
}
