//! TRIM selects hatch regions, not the empty spaces between their pattern strokes.
use cadcraft_engine::{doc::Space, geom::Vec2, select};
use serde_json::Value;

impl crate::CadcraftSession {
    pub(crate) fn trim_pick(&self, params: &Value) -> Result<Option<String>, String> {
        let x = params["point"][0].as_f64().ok_or("TRIM pick requires a point")?;
        let y = params["point"][1].as_f64().ok_or("TRIM pick requires a point")?;
        let aperture = params["aperture"].as_f64().filter(|a| a.is_finite() && *a > 0.0)
            .ok_or("TRIM pick requires a positive aperture")?;
        if !x.is_finite() || !y.is_finite() { return Err("TRIM pick requires finite coordinates".into()); }
        let doc = self.session.doc().map_err(|e| e.to_string())?;
        Ok(select::pick_trim(doc, &Space::Model, Vec2::new(x, y), aperture).map(|h| h.hex()))
    }
}
