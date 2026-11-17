// Extend the pinned MIT/Apache font layout with the same placed text used to draw MTEXT.
// EXPLODE must use actual wrapped/justified baselines instead of laying paragraphs out again.
import { readFile, writeFile } from "node:fs/promises";
const root = new URL(
  "../out-cadcraft-archive/storytold-cadcraft-00c7613/crates/fonts/src/",
  import.meta.url,
);
async function patch(file, edits) {
  const url = new URL(file, root);
  let text = await readFile(url, "utf8");
  const previous = text;
  for (const [before, after] of edits) {
    if (text.includes(after)) continue;
    if (text.split(before).length !== 2)
      throw Error(`Cadcraft explode patch no longer matches ${file}: ${before.slice(0, 50)}`);
    text = text.replace(before, after);
  }
  if (text !== previous) await writeFile(url, text);
}
const additions = String.raw`
// Text and decoration positions retained by the renderer for non-destructive EXPLODE.
thread_local! { static EXPLODE_LAYOUT: std::cell::Cell<bool> = const {std::cell::Cell::new(false)}; }
pub fn with_explode_layout<T>(f: impl FnOnce()->T)->T {
    struct Reset(bool);impl Drop for Reset {fn drop(&mut self){EXPLODE_LAYOUT.with(|flag|flag.set(self.0));}}
    let _reset=Reset(EXPLODE_LAYOUT.with(|flag|flag.replace(true)));f()
}
#[derive(Clone, Debug, PartialEq)]
pub struct ExplodeText {
    pub value: String, pub at: Vec2, pub height: f64, pub width_factor: f64,
    pub oblique: f64, pub font: String, pub color: Option<MTextColor>,
}
fn explode_segment(out: &mut MTextLayout, seg: &Seg, f: &Fmt, x: f64, xf: impl Fn(Vec2)->Vec2) {
    if !EXPLODE_LAYOUT.with(|flag|flag.get()) {return;}
    let h=f.height; let w=seg_width(seg,f);
    let mut put=|value: &str, height: f64, at: Vec2| {
        if !value.is_empty() {out.explode_text.push(ExplodeText {value:value.into(),at:xf(at),height,
            width_factor:f.wf,oblique:f.oblique,font:f.font_name.clone(),color:f.color});}
    };
    match seg {
        Seg::Text(t)=>put(t,h,Vec2::new(x,0.0)),
        Seg::Stack(a,b,sep)=>{
            let hs=h*STACK_SCALE;
            let wa=text_width(&f.font,a,hs,f.wf);let wb=text_width(&f.font,b,hs,f.wf);
            match sep {
                '#'=>{put(a,hs,Vec2::new(x,h*0.4));put(b,hs,Vec2::new(x+wa+h*0.5,-h*0.05));},
                '^'=>{let (yt,yb)=match f.valign {0=>(hs+h*0.1,0.0),2=>(0.0,-hs-h*0.1),_=>(h*0.55,h*0.45-hs)};put(a,hs,Vec2::new(x,yt));put(b,hs,Vec2::new(x,yb));},
                _=>{put(a,hs,Vec2::new(x+(w-wa)/2.0,h*0.57));put(b,hs,Vec2::new(x+(w-wb)/2.0,h*0.33-hs));}
            }
        }
    }
    let mut line=|a,b|out.explode_lines.push((vec![xf(a),xf(b)],f.color));
    if let Seg::Stack(a,_,sep)=seg {
        if *sep=='#' {let sx=x+text_width(&f.font,a,h*STACK_SCALE,f.wf)+h*0.1;
            line(Vec2::new(sx,-h*0.1),Vec2::new(sx+h*0.3,h*1.1));}
        else if *sep!='^' {line(Vec2::new(x,h*0.45),Vec2::new(x+w,h*0.45));}
    }
    if f.under {line(Vec2::new(x,-h*0.2),Vec2::new(x+w,-h*0.2));}
    if f.over {line(Vec2::new(x,h*1.2),Vec2::new(x+w,h*1.2));}
}
fn explode_font_name(a: &str, font: &TextFont)->String {
    let name=a.split('|').next().unwrap_or("").trim();
    let bold=a.split('|').any(|s|s=="b1");let italic=a.split('|').any(|s|s=="i1");
    let style=match(bold,italic){(true,true)=>"bold italic",(true,false)=>"bold",(false,true)=>"italic",_=>""};
    for candidate in [format!("{name} {style}"),format!("{name}-{}",style.replace(' ',"")),format!("{name}{}",if bold {"bd"} else {"i"}),name.into()] {
        if let (TextFont::Outline(a),TextFont::Outline(b))=(font,TextFont::resolve(&candidate)) {if *a==b {return candidate;}}
    }
    name.into()
}
`;
await patch("mtext.rs", [
  [
    "pub struct MTextLayout {",
    "pub struct MTextLayout {\n    pub explode_text: Vec<ExplodeText>,\n    pub explode_lines: Vec<(Vec<Vec2>, Option<MTextColor>)>,",
  ],
  ["struct Fmt {", "struct Fmt {\n    font_name: String,"],
  [
    "            font: TextFont::Stroke,\n            height:",
    "            font: TextFont::Stroke,\n            font_name: String::new(),\n            height:",
  ],
  [
    "let base = Fmt { font: p.font.clone(),",
    "let base = Fmt { font_name: String::new(), font: p.font.clone(),",
  ],
  [
    "derive(&mut fmts, &mut cur, &|f| f.font = font.clone());",
    "derive(&mut fmts, &mut cur, &|f| { f.font_name=explode_font_name(&a,&font); f.font = font.clone(); });",
  ],
  [
    "            sh.map(|q| xf(q + off));",
    "            explode_segment(&mut out, sg, fm, it.x, |q|xf(q+off));\n            sh.map(|q| xf(q + off));",
  ],
  ["#[cfg(test)]\nmod tests {", additions + "\n#[cfg(test)]\nmod tests {"],
]);
await patch("mtext/para.rs", [
  [
    "            sh.map(|q| xf(q + off));",
    "            super::explode_segment(&mut out, &it.seg, fm, it.x, |q|xf(q+off));\n            sh.map(|q| xf(q + off));",
  ],
]);
await patch("lib.rs", [
  ["pub use mtext::{MTextColor,", "pub use mtext::{with_explode_layout, MTextColor,"],
]);
