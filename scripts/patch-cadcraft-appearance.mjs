import { readFile, writeFile } from "node:fs/promises";
const root = new URL("../out-cadcraft-archive/storytold-cadcraft-00c7613/crates/", import.meta.url);
async function patch(path, changes) {
  const file = new URL(path, root);
  const original = await readFile(file, "utf8");
  let source = original;
  for (const [before, after] of changes) {
    if (source.includes(after)) continue;
    if (!source.includes(before)) throw new Error(`Cadcraft appearance patch mismatch: ${path}`);
    source = source.replaceAll(before, after);
  }
  if (source !== original) await writeFile(file, source);
}
await patch("render/src/lib.rs", [
  [
    "fn point(&mut self, ctx: &Ctx, color: Ink, p: Vec2) {\n        let (color, _) = self.styled(color, 0.0);",
    "fn point(&mut self, ctx: &Ctx, color: Ink, p: Vec2) { self.weighted_point(ctx,color,0.0,p); }\n    fn weighted_point(&mut self, ctx: &Ctx, color: Ink, lw: f32, p: Vec2) {\n        let (color, lw) = self.styled(color, lw);",
  ],
  ["aci7: color.aci7, lw: 0.0, kind: Kind::Point", "aci7: color.aci7, lw, kind: Kind::Point"],
  ["b.point(ctx, rgb,", "b.weighted_point(ctx, rgb, lw,"],
]);
await patch("render/src/hatch.rs", [
  ["b.point(ctx, rgb, *p);", "b.weighted_point(ctx, rgb, lw, *p);"],
]);
await patch("io/src/svg.rs", [
  [
    'r#"<circle cx="{:.6}" cy="{:.6}" r="{:.6}" fill="{c}"/>"#, tx(q.x), ty(q.y), stroke',
    'r#"<polyline points="{:.6},{:.6} {:.6},{:.6}" stroke="{c}" stroke-width="{stroke:.6}" stroke-linecap="round" fill="none"/>"#, tx(q.x), ty(q.y), tx(q.x), ty(q.y)',
  ],
]);
