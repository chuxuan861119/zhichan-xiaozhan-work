use cadcraft_engine::{doc::Space, geom::{Bounds2, Vec2}};
use crate::CadcraftSession;

fn frame(args: &[String]) -> Result<Option<Bounds2>, String> {
    if args.is_empty() {
        return Ok(None);
    }
    if args.len() != 5 || args[0] != "--frame" {
        return Err("Expected --frame x0 y1 width height".into());
    }
    let values = args[1..]
        .iter()
        .map(|s| s.parse::<f64>().map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let (x0, y1, w, h) = (values[0], values[1], values[2], values[3]);
    if values.iter().any(|v| !v.is_finite()) || w <= 0.0 || h <= 0.0 {
        return Err("Frame requires finite coordinates and positive width/height".into());
    }
    let bounds = Bounds2::new(Vec2::new(x0, y1 - h), Vec2::new(x0 + w, y1));
    cadcraft_io::check_window(&bounds).map_err(|e| e.to_string())?;
    Ok(Some(bounds))
}

pub fn convert(mode: &str, bytes: &[u8], args: &[String]) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > 100 << 20 { return Err("Input exceeds 100 MiB or is empty".into()); }
    let mut options = args.to_vec();
    let patent_preview = if let Some(index) = options.iter().position(|a| a == "--patent-preview") {
        if mode != "dxf-to-svg" {
            return Err("--patent-preview is only supported for dxf-to-svg".into());
        }
        options.remove(index);
        true
    } else {
        false
    };
    let window = if mode == "dxf-to-svg" {
        frame(&options)?
    } else if options.is_empty() {
        None
    } else {
        return Err("Unexpected extra arguments".into());
    };
    let output =
        match mode {
            "dwg-to-dxf" => cadcraft_dwg::dwg_to_dxf_with(
                bytes,
                cadcraft_dwg::Limits {
                    max_dwg_bytes: 100 << 20,
                    max_dxf_bytes: 100 << 20,
                },
            )?,
            "dxf-to-dwg" => {
                if cadcraft_dwg::is_dwg(bytes) {
                    return Err("Expected DXF input".into());
                }
                let d = cadcraft_io::read(bytes, "drawing.dxf").map_err(|e| e.to_string())?;
                let has_dimensions = d
                    .model
                    .iter()
                    .chain(d.layouts.iter().flat_map(|layout| layout.entities.iter()))
                    .any(|entity| {
                        matches!(entity.kind, cadcraft_engine::doc::EntityKind::Dimension(_))
                    });
                if has_dimensions {
                    // Retain the dimension's baked display block instead of regenerating
                    // ByLayer anonymous geometry on the second serialization step.
                    let dxf = crate::unified::write_dxf(&d)?;
                    let version = cadcraft_io::save_version(&d).max(cadcraft_io::Version::R2004);
                    cadcraft_dwg::dxf_to_dwg_as(&dxf, version.code())?
                } else {
                    cadcraft_io::write(&d, "drawing.dwg").map_err(|e| e.to_string())?
                }
            }
            "dxf-to-svg" => {
                if cadcraft_dwg::is_dwg(bytes) {
                    return Err("Expected DXF input".into());
                }
                let d = cadcraft_io::read(bytes, "drawing.dxf").map_err(|e| e.to_string())?;
                if patent_preview {
                    crate::unified::patent_svg(&d, window).into_bytes()
                } else {
                    cadcraft_io::svg::export_window(&d, &Space::Model, window).into_bytes()
                }
            }
            "dxf-to-scene" => {
                let mut session = CadcraftSession::new();
                session.load_dxf(bytes)?;
                session.scene()?.into_bytes()
            }
            _ => return Err(
                "Unknown operation; expected dwg-to-dxf, dxf-to-dwg, dxf-to-svg or dxf-to-scene"
                    .into(),
            ),
        };
    if output.len() > 100 << 20 {
        return Err("Output exceeds 100 MiB".into());
    }
    Ok(output)
}
