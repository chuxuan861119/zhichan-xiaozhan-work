use patent_cadcraft_bridge::CadcraftSession;
use std::io::{Read, Write};

fn convert() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().ok_or("Expected a codec operation")?;
    let mut options = args[1..].to_vec();
    let font_path = if let Some(index) = options.iter().position(|a| a == "--font") {
        let path = options
            .get(index + 1)
            .ok_or("Expected a font path after --font")?
            .clone();
        options.drain(index..index + 2);
        Some(path)
    } else {
        None
    };
    if let Some(path) = font_path {
        let mut font = Vec::new();
        std::fs::File::open(path)
            .map_err(|e| format!("Cannot open rendering font: {e}"))?
            .take((32 << 20) + 1)
            .read_to_end(&mut font)
            .map_err(|e| e.to_string())?;
        CadcraftSession::new().register_font("Source Han Serif CN", &font)?;
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .take((100 << 20) + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 100 << 20 {
        return Err("Input exceeds 100 MiB".into());
    }
    let output = patent_cadcraft_bridge::codec::convert(mode, &bytes, &options)?;
    std::io::stdout()
        .write_all(&output)
        .map_err(|e| e.to_string())
}

fn main() {
    if let Err(error) = convert() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
