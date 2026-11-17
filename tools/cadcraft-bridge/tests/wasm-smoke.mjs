import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

const generated = new URL("../../../resources/cadcraft/wasm/", import.meta.url);
const source = await readFile(new URL("cadcraft.js", generated), "utf8");
const bridge = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
bridge.initSync({ module: await readFile(new URL("cadcraft_bg.wasm", generated)) });

test("dense disjoint segments preserve closed regions and near-endpoint intersections", () => {
  const s = new bridge.CadcraftSession();
  const run = (command, params) => JSON.parse(s.execute(command, JSON.stringify(params)));
  try {
    // These segments share spatial buckets but cannot intersect each other.
    for (let i = 0; i < 300; i++)
      run("line", { points: [[20 + i * 0.01, 0], [20 + i * 0.01, 10]] });
    for (const points of [
      [[0, 0], [10, 0]], [[10, 0], [10, 10]],
      [[10, 10], [0, 10]], [[0, 10], [0, 0]],
      [[5, 0.000000001], [5, 10]],
    ]) run("line", { points });
    const before = s.export_dxf();
    const params = { points: [[2, 5], [8, 5]], pattern: "ANSI31", separate: true };
    const preview = run("bridge.preview_modify", { compact: true, command: "hatch", params });
    assert.deepEqual(preview.acceptedPointIndices, [0, 1]);
    assert.deepEqual(preview.rejectedPointIndices, []);
    assert.equal(preview.entities.length, 2);
    assert.deepEqual(s.export_dxf(), before);
    run("hatch", params);
    run("undo", {});
    assert.deepEqual(s.export_dxf(), before);
  } finally { s.free(); }
});

test("hover locates small gaps and tolerates them without editing source lines or history", () => {
  const s = new bridge.CadcraftSession();
  const run = (c,p) => JSON.parse(s.execute(c,JSON.stringify(p)));
  try {
    for (const [a,b] of [[[0,0],[10,0]],[[10,0],[10,10]],[[10,10],[0,10]],[[0,10],[0,0.05]]])
      run("line",{points:[a,b]});
    const bytes=s.export_dxf(),before=s.scene();
    const preview = gapTolerance => run("bridge.preview_modify",{compact:true,command:"hatch",params:{points:[[5,5]],gapTolerance,pattern:"ANSI31"}});
    const rejected=preview(0);
    assert.deepEqual(rejected.rejectedPointIndices,[0]);
    assert.equal(rejected.gapPoints.length,2);
    const accepted=preview(0.1);
    assert.deepEqual(accepted.acceptedPointIndices,[0]);
    assert.ok(accepted.primitives.length>0);
    assert.equal(s.scene(),before);
    assert.deepEqual(s.export_dxf(),bytes);
    run("hatch",{points:[[5,5]],gapTolerance:0.1,pattern:"ANSI31"});
    assert.equal(JSON.parse(s.scene()).entityCount,5);
    run("undo",{});assert.deepEqual(s.export_dxf(),bytes);
  } finally {s.free();}
});

test("extension spring pointer previews agree with WASM after every grip change", () => {
  const compiled=buildSync({entryPoints:[fileURLToPath(new URL("../../../src/renderer/src/drawing-markup/cad-spring-geometry.ts",import.meta.url))],bundle:true,write:false,platform:"node",format:"cjs"});
  const module={exports:{}};
  new Function("module","exports",compiled.outputFiles[0].text)(module,module.exports);
  for(const turns of [3,6,15,24]) for(const index of [0,1,2,3,4]) {
    const s=new bridge.CadcraftSession();
    try {
      const length=80+turns*3;
      const {handle}=JSON.parse(s.execute("bridge.spring",JSON.stringify({kind:"extension",at:[10,20],end:[10,20+length],width:20,wire:2.3,turns})));
      const original=JSON.parse(s.scene()).entities[0].spring;
      const to=[[10,10],[15,30+length],[-4,20+length/2],[-8,20+length*0.75+length/turns],[15,25+length/2]][index];
      const preview=module.exports.springGripPreview(original,index,{x:to[0],y:to[1]});
      s.execute("grip.move",JSON.stringify({handle,index,to}));
      const actual=JSON.parse(s.scene()).primitives;
      assert.equal(actual.length,preview.length);
      actual.forEach((path,i)=>{
        assert.equal(path.points.length,preview[i].length, `turns=${turns} grip=${index} path=${i}`);
        path.points.forEach(([x,y],j)=>assert.ok(Math.hypot(x-preview[i][j].x,y-preview[i][j].y)<1e-7));
      });
    } finally {s.free();}
  }
});

test("extension spring clipped dense outlines match the preview and survive DXF", () => {
  const compiled = buildSync({entryPoints:[fileURLToPath(new URL("../../../src/renderer/src/drawing-markup/cad-extension-spring-geometry.ts",import.meta.url))],bundle:true,write:false,platform:"node",format:"cjs"});
  const module = {exports:{}};
  new Function("module","exports",compiled.outputFiles[0].text)(module,module.exports);
  for (const [length,width,wire,turns] of [[82.7,20,2.3,15],[110,20,2.3,15],[80,30,2,6],[72.2,20,2.3,15],[155,20,5,24],[44.6,20,2.3,3],[53.52,20,2.3,3],[144.4,20,2.3,15]]) {
    const s = new bridge.CadcraftSession();
    try {
      s.execute("bridge.spring",JSON.stringify({kind:"extension",at:[0,0],end:[length,0],width,wire,turns}));
      const expected=module.exports.extensionSpringPaths(length,width,wire,turns);
      s.load_dxf(s.export_dxf());
      const actual=JSON.parse(s.scene()).primitives;
      assert.equal(actual.length,expected.length);
      actual.forEach((path,i)=>{
        assert.equal(path.points.length,expected[i].length,`${length}/${wire}: path ${i}`);
        path.points.forEach(([x,y],j)=>assert.ok(Math.hypot(x-expected[i][j][0],y-expected[i][j][1])<1e-7));
      });
    } finally { s.free(); }
  }
});

test("extension spring keeps hooks, editable grips and its type through DXF", () => {
  const s = new bridge.CadcraftSession();
  try {
    const run=(c,p)=>JSON.parse(s.execute(c,JSON.stringify(p)));
    const {handle}=run("bridge.spring",{kind:"extension",at:[0,0],end:[82.7,0],width:20,wire:2.3,turns:15});
    assert.equal(JSON.parse(s.scene()).primitives.length,42);
    run("grip.move",{handle,index:1,to:[110,0]});
    s.load_dxf(s.export_dxf());
    const spring=JSON.parse(s.scene()).entities[0];
    assert.equal(spring.spring.kind,"extension");
    assert.ok(Math.abs(spring.spring.length-110)<1e-8);
    assert.equal(spring.grips.length,5);
  } finally {s.free();}
});

test("WASM spring draws, edits grips and survives DXF without native-only code",()=>{
  const s=new bridge.CadcraftSession();
  const run=(command,params)=>JSON.parse(s.execute(command,JSON.stringify(params)));
  try {
    const {handle}=run("bridge.spring",{at:[0,0],end:[80,0],width:30,turns:6,wire:2});
    let entity=JSON.parse(s.scene()).entities.find(e=>e.handle===handle);
    assert.equal(entity.spring.turns,6);
    assert.equal(entity.grips.length,5);
    const outlines=JSON.parse(s.scene()).primitives;
    assert.equal(outlines.length,2*6+5);
    assert.ok(outlines.every(p=>p.points.length>=3));
    const crossings = (points) => points.slice(1).flatMap((b,i) => {
      const a=points[i];
      if(a[1]*b[1]>0 || a[1]===b[1]) return [];
      return [{x:a[0]-a[1]*(b[0]-a[0])/(b[1]-a[1]),dx:b[0]-a[0],dy:b[1]-a[1]}];
    });
    const outer=crossings(outlines[3].points).sort((a,b)=>b.x-a.x)[0];
    const inner=crossings(outlines[8].points).sort((a,b)=>a.x-b.x)[0];
    const thickness=Math.abs((outer.x-inner.x)*inner.dy)/Math.hypot(inner.dx,inner.dy);
    assert.ok(Math.abs(thickness-2)<0.12,`body wire ${thickness} must match end wire 2`);
    run("grip.move",{handle,index:3,to:[75,15]});
    entity=JSON.parse(s.scene()).entities.find(e=>e.handle===handle);
    assert.equal(entity.spring.turns,7);
    s.load_dxf(s.export_dxf());
    assert.equal(JSON.parse(s.scene()).entities[0].spring.turns,7);
  } finally {s.free();}
});

test("unified text wraps continuous Chinese and exposes independent move width and scale grips", async () => {
  const s = new bridge.CadcraftSession();
  s.register_font("Source Han Serif CN",await readFile(new URL("../../../src/shared/document/fonts/SourceHanSerifCN-Regular.otf",import.meta.url)));
  const run=(c,p)=>JSON.parse(s.execute(c,JSON.stringify(p)));
  try {
    const {handle}=run("bridge.text",{at:[10,20],text:"连续中文测试文字",height:7.29,width:20});
    const entity=JSON.parse(s.scene()).entities.find(e=>e.handle===handle);
    assert.deepEqual(entity.textLines,["连续","中文","测试","文字"]);
    assert.equal(entity.grips.length,3);
    assert.deepEqual(entity.textOrigin,[10,20]);
    run("grip.move",{handle,index:1,to:[50,20]});
    const wider=JSON.parse(s.scene()).entities.find(e=>e.handle===handle);
    assert.equal(wider.width,40); assert.equal(wider.height,7.29);
    assert.deepEqual(wider.textLines,["连续中文","测试文字"]);
    run("grip.move",{handle,index:2,to:[90,20-7.29*5/3*4]});
    const scaled=JSON.parse(s.scene()).entities.find(e=>e.handle===handle);
    assert.equal(scaled.width,80); assert.equal(scaled.height,14.58);
  } finally {s.free();}
});

test("plain text renders percent control sequences as literal characters", async()=>{
  const s=new bridge.CadcraftSession();
  s.register_font("Source Han Serif CN",await readFile(new URL("../../../src/shared/document/fonts/SourceHanSerifCN-Regular.otf",import.meta.url)));
  try {
    s.execute("bridge.text",JSON.stringify({at:[0,0],text:"%%d",height:7.29,width:100}));
    const scene=JSON.parse(s.scene());
    assert.equal(scene.entities[0].plainText,"%%d");
    // Three visible characters, not the small degree-symbol control expansion.
    assert.ok(scene.bounds.max[0]-scene.bounds.min[0]>10);
  } finally{s.free();}
});

test("plain text uses one wrapping entity and preserves literal CAD formatting characters", () => {
  const s = new bridge.CadcraftSession();
  const run = (c,p) => JSON.parse(s.execute(c,JSON.stringify(p)));
  try {
    const created = run("bridge.text", {at:[10,20], text:"中文测试\\P{内容}\n第二行", height:3,width:12});
    const first = JSON.parse(s.scene()).entities.find(e=>e.handle===created.handle);
    assert.equal(first.type,"MText");
    assert.equal(first.plainText,"中文测试\\P{内容}\n第二行");
    assert.equal(first.width,12);
    run("bridge.text_grip",{handle:created.handle,index:1,to:[34,20]});
    assert.equal(JSON.parse(s.scene()).entities[0].width,24);
    assert.equal(JSON.parse(s.scene()).entities[0].height,3);
    run("undo",{});
    run("bridge.text", {handle:created.handle,text:"修改内容",height:4,width:20});
    assert.equal(JSON.parse(s.scene()).entityCount,1);
    run("undo",{});
    assert.equal(JSON.parse(s.scene()).entities[0].plainText,first.plainText);
    const bytes=s.export_dxf();
    s.load_dxf(bytes);
    assert.equal(JSON.parse(s.scene()).entities[0].plainText,first.plainText);
    const restored=s.export_dxf();
    assert.throws(()=>run("bridge.text",{handle:created.handle,text:"bad",height:0,width:5}));
    assert.deepEqual(s.export_dxf(),restored);
  } finally { s.free(); }
});

test("multiple points in the same region produce only one hatch and preserve distinct islands", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    run("rectang", { p1: [0, 0], p2: [100, 100] });
    run("circle", { center: [50, 50], radius: 10 });
    const params = { points: [[10, 10], [20, 20], [50, 50], [51, 51]], separate: true, pattern: "SOLID" };
    const preview = run("bridge.preview_modify", { command: "hatch", params, compact: true });
    assert.deepEqual(preview.acceptedPointIndices, [0, 2]);
    assert.equal(preview.entities.length, 2);
    const result = run("hatch", params);
    assert.equal(result.handles.length, 2);
    run("undo", {});
    assert.equal(JSON.parse(s.scene()).entities.length, 2);
  } finally { s.free(); }
});

test("open picks are rejected without losing valid regions or permitting an invalid cached commit", () => {
  const s = new bridge.CadcraftSession();
  const run = (c,p) => JSON.parse(s.execute(c,JSON.stringify(p)));
  try {
    run("rectang", {p1:[0,0],p2:[100,100]});
    const before=s.export_dxf();
    const params={points:[[20,20],[200,200]], separate:true, pattern:"ANSI31",scale:1};
    const preview=run("bridge.preview_modify",{command:"hatch",params,compact:true});
    assert.deepEqual(preview.acceptedPointIndices,[0]);
    assert.deepEqual(preview.rejectedPointIndices,[1]);
    assert.deepEqual(s.export_dxf(),before);
    assert.throws(()=>run("hatch",params));
    assert.deepEqual(s.export_dxf(),before);
    const empty=run("bridge.preview_modify",{command:"hatch",params:{...params,points:[[200,200]]},compact:true});
    assert.deepEqual(empty.acceptedPointIndices,[]);
    assert.equal(empty.entities.length,0);
  } finally {s.free();}
});

test("compact hatch previews exclude unrelated drawing and commit exactly one undoable result", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    run("rectang", { p1: [0, 0], p2: [100, 100] });
    run("circle", { center: [300, 300], radius: 5 });
    const before = s.export_dxf();
    let params = { points: [[50, 50]], pattern: "ANSI31", scale: 1 };
    const preview = () => run("bridge.preview_modify", { command: "hatch", params, compact: true });
    const first = preview();
    assert.equal(first.partial, true);
    assert.equal(first.entities.length, 1);
    assert.equal(first.entities[0].type, "Hatch");
    assert.deepEqual(s.export_dxf(), before);
    params = { ...params, scale: 2 };
    const second = preview();
    assert.equal(second.entities[0].geometry.scale, 2);
    const fill = run("hatch", params).handle;
    assert.equal(fill, second.entities[0].handle);
    assert.equal(JSON.parse(s.scene()).entities.length, 3);
    run("undo", {});
    assert.equal(JSON.parse(s.scene()).entities.length, 2);
    run("redo", {});
    assert.equal(JSON.parse(s.scene()).entities.length, 3);
    // A drawing edit invalidates prepared geometry, even if the request is identical.
    params = { points: [[50, 50]], pattern: "ANSI31", scale: 3 };
    preview();
    const added = run("circle", { center: [400, 400], radius: 3 }).handle;
    run("hatch", params);
    assert.ok(JSON.parse(s.scene()).entities.some((e) => e.handle === added));
    assert.equal(JSON.parse(s.scene()).entities.length, 5);
  } finally { s.free(); }
});

test("hatch boundaries use slanted block geometry without its rectangular pick box", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const boundary = run("pline", {
      points: [
        [0, 0],
        [100, 0],
        [140, 100],
        [40, 100],
      ],
      closed: true,
    }).handle;
    // A diagonal line's hit-test box crosses the interior; the real line does not.
    const line = run("line", {
      points: [
        [-20, 60],
        [80, 160],
      ],
    }).handles[0];
    run("block", { name: "DIAGONAL", handles: [line], base: [0, 0] });
    run("insert", { name: "DIAGONAL", at: [0, 0] });
    const fill = run("hatch", { points: [[70, 30]], pattern: "ANSI31", scale: 1 }).handle;
    const geometry = JSON.parse(s.scene()).entities.find((e) => e.handle === fill).geometry;
    const vertices = geometry.loops[0].vertices.map((v) => v.p);
    const area =
      Math.abs(
        vertices.reduce((a, p, i) => {
          const q = vertices[(i + 1) % vertices.length];
          return a + p.x * q.y - q.x * p.y;
        }, 0),
      ) / 2;
    assert.ok(Math.abs(area - 10000) < 1e-6, `clipped slanted area: ${area}`);
    assert.ok(geometry.loops[0].sources.includes(Number.parseInt(boundary, 16)));
    const all = JSON.parse(s.scene()).entities.map((e) => e.handle);
    run("rotate", { handles: all, base: [0, 0], angle: 37 });
    const checkpoint = s.export_dxf();
    s.load_dxf(checkpoint);
    run("hatchedit", { handles: [fill], scale: 0.5 });
    const updated = JSON.parse(s.scene()).entities.find((e) => e.handle === fill).geometry;
    const v = updated.loops[0].vertices.map((v) => v.p);
    const rotatedArea = Math.abs(v.reduce((sum, p, i) => {
      const q = v[(i + 1) % v.length];
      return sum + p.x * q.y - q.x * p.y;
    }, 0)) / 2;
    assert.ok(Math.abs(rotatedArea - 10000) < 1e-6);
  } finally {
    s.free();
  }
});

test("point-picked ellipse hatches remain associative through edits and checkpoints", () => {
  const s = new bridge.CadcraftSession();
  const reopened = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const ellipse = run("ellipse", { center: [50, 50], major: [40, 0], ratio: 0.5 }).handle;
    const fill = run("hatch", { points: [[50, 50]], pattern: "ANSI31", scale: 1 }).handle;
    const geometry = () => JSON.parse(s.scene()).entities.find((e) => e.handle === fill).geometry;
    assert.equal(geometry().associative, true);
    run("move", { handles: [ellipse], delta: [100, 0] });
    assert.ok(geometry().loops[0].vertices.every((v) => v.p.x >= 110));
    run("undo", {});
    assert.ok(geometry().loops[0].vertices.every((v) => v.p.x <= 90));
    reopened.load_dxf(s.export_dxf());
    assert.equal(
      JSON.parse(reopened.scene()).entities.find((e) => e.handle === fill).geometry.associative,
      true,
    );
  } finally {
    s.free();
    reopened.free();
  }
});

test("hatch boundary edits are atomic, undoable and preserve the fill handle", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const boundary = run("rectang", { p1: [0, 0], p2: [100, 100] }).handle;
    const hole = run("circle", { center: [50, 50], radius: 10 }).handle;
    const fill = run("hatch", { handles: [boundary], pattern: "ANSI31", scale: 1 }).handle;
    const geometry = () => JSON.parse(s.scene()).entities.find((e) => e.handle === fill).geometry;
    run("hatchedit", { handles: [fill], boundaryAdd: [hole], style: "normal" });
    assert.equal(geometry().loops.length, 2);
    run("hatchedit", { handles: [fill], boundaryRemove: [hole] });
    assert.equal(geometry().loops.length, 1);
    run("undo", {});
    assert.equal(geometry().loops.length, 2);
    assert.throws(() => run("hatchedit", { handles: [fill], boundaryRemove: [boundary, hole] }));
    assert.equal(geometry().loops.length, 2);
  } finally {
    s.free();
  }
});

test("small hatches accept small scales while excessive geometry is rejected atomically", () => {
  for (const [size, scale, valid] of [
    [0.1, 0.01, true],
    [100000, 0.00001, false],
  ]) {
    const s = new bridge.CadcraftSession();
    try {
      s.execute("rectang", JSON.stringify({ p1: [0, 0], p2: [size, size] }));
      const make = () =>
        s.execute(
          "hatch",
          JSON.stringify({ points: [[size / 2, size / 2]], scale, pattern: "ANSI31" }),
        );
      if (valid) assert.doesNotThrow(make);
      else {
        assert.throws(make, /过密/);
        assert.equal(JSON.parse(s.scene()).entityCount, 1);
      }
    } finally {
      s.free();
    }
  }
});

test("multiple picked regions stay separate and undo and redo preserve their boundary links", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    run("rectang", { p1: [0, 0], p2: [10, 10] });
    run("rectang", { p1: [20, 0], p2: [30, 10] });
    const result = run("hatch", {
      points: [
        [5, 5],
        [25, 5],
      ],
      separate: true,
      pattern: "ANSI31",
      scale: 1,
    });
    assert.equal(result.handles.length, 2);
    assert.equal(result.hatches.length, 2);
    run("undo", {});
    assert.equal(JSON.parse(s.scene()).entityCount, 2);
    run("redo", {});
    assert.equal(
      JSON.parse(s.scene()).entities.filter((e) => e.type === "Hatch" && e.geometry.associative)
        .length,
      2,
    );
  } finally {
    s.free();
  }
});

test("selected LINE segments can form an associative hatch boundary", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const lines = [];
    for (const points of [
      [
        [0, 0],
        [10, 0],
      ],
      [
        [10, 0],
        [10, 10],
      ],
      [
        [10, 10],
        [0, 10],
      ],
      [
        [0, 10],
        [0, 0],
      ],
    ])
      lines.push(...run("line", { points }).handles);
    const { handle } = run("hatch", { handles: lines, pattern: "ANSI31", scale: 1 });
    let fill = JSON.parse(s.scene()).entities.find((e) => e.handle === handle);
    assert.equal(fill.geometry.associative, true);
    assert.equal(JSON.parse(s.scene()).entityCount, 5);
    run("move", { handles: lines, delta: [20, 0] });
    fill = JSON.parse(s.scene()).entities.find((e) => e.handle === handle);
    assert.ok(fill.geometry.loops[0].vertices.every((v) => v.p.x >= 20));
  } finally {
    s.free();
  }
});

test("an ellipse containing a circular island retains both source links", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const outer = run("ellipse", { center: [50, 50], major: [40, 0], ratio: 0.5 }).handle;
    const inner = run("circle", { center: [50, 50], radius: 5 }).handle;
    const { handle } = run("hatch", { points: [[70, 50]], pattern: "ANSI31", scale: 1 });
    const geometry = () => JSON.parse(s.scene()).entities.find((e) => e.handle === handle).geometry;
    assert.equal(geometry().associative, true);
    assert.equal(geometry().loops.length, 2);
    run("move", { handles: [outer, inner], delta: [100, 0] });
    assert.ok(geometry().loops.every((l) => l.vertices.every((v) => v.p.x >= 110)));
  } finally {
    s.free();
  }
});

test("removing one outer area also removes its holes and keeps other filled areas", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const a = run("rectang", { p1: [0, 0], p2: [10, 10] }).handle;
    const hole = run("circle", { center: [5, 5], radius: 1 }).handle;
    const b = run("rectang", { p1: [20, 0], p2: [30, 10] }).handle;
    const { handle } = run("hatch", { handles: [a, hole, b], pattern: "ANSI31", scale: 1 });
    run("hatchedit", { handles: [handle], boundaryRemove: [a] });
    const h = JSON.parse(s.scene()).entities.find((e) => e.handle === handle).geometry;
    assert.equal(h.loops.length, 1);
    assert.ok(h.loops[0].vertices.every((v) => v.p.x >= 20));
  } finally {
    s.free();
  }
});

test("normal, outer and ignore island styles retain distinct solid fill areas", () => {
  const areas = [];
  for (const style of ["outer", "normal", "ignore"]) {
    const s = new bridge.CadcraftSession();
    const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
    try {
      run("rectang", { p1: [0, 0], p2: [100, 100] });
      run("circle", { center: [50, 50], radius: 20 });
      run("circle", { center: [50, 50], radius: 10 });
      const { handle } = run("hatch", { points: [[10, 10]], pattern: "SOLID", style });
      const primitives = JSON.parse(s.scene()).primitives.filter(
        (p) => p.handle === handle && p.kind === "triangles",
      );
      let area = 0;
      for (const p of primitives)
        for (let i = 0; i < p.points.length; i += 3) {
          const [a, b, c] = p.points.slice(i, i + 3);
          area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
        }
      areas.push(area);
    } finally {
      s.free();
    }
  }
  assert.ok(areas[0] < areas[1] && areas[1] < areas[2], JSON.stringify(areas));
});

test("every offered hatch pattern renders and survives a DXF checkpoint", () => {
  const catalog = new bridge.CadcraftSession();
  const names = JSON.parse(catalog.execute("hatch.patterns", "{}")).standard;
  catalog.free();
  assert.equal(names.length, 23);
  for (const pattern of names) {
    const session = new bridge.CadcraftSession();
    const reopened = new bridge.CadcraftSession();
    try {
      session.execute("rectang", JSON.stringify({ p1: [0, 0], p2: [100, 100] }));
      const result = JSON.parse(
        session.execute("hatch", JSON.stringify({ points: [[50, 50]], pattern, scale: 0.5 })),
      );
      reopened.load_dxf(session.export_dxf());
      const scene = JSON.parse(reopened.scene());
      assert.equal(scene.entities.filter((e) => e.type === "Hatch").length, 1, pattern);
      assert.ok(
        scene.primitives.some(
          (p) => p.handle === result.handle && p.points.length >= (p.kind === "point" ? 1 : 2),
        ),
        `${pattern} has visible geometry`,
      );
      const props = JSON.parse(
        reopened.execute("properties", JSON.stringify({ handles: [result.handle] })),
      );
      assert.equal(props.objects[0].geometry.pattern, pattern);
    } finally {
      session.free();
      reopened.free();
    }
  }
});

test("generated WebAssembly executes native CAD commands and preserves DXF checkpoints", () => {
  const session = new bridge.CadcraftSession();
  const restored = new bridge.CadcraftSession();
  try {
    const line = JSON.parse(
      session.execute(
        "line",
        JSON.stringify({
          points: [
            [0, 0],
            [10, 4],
          ],
        }),
      ),
    );
    session.execute("move", JSON.stringify({ handles: line.handles, delta: [2, 3] }));
    assert.deepEqual(JSON.parse(session.scene()).primitives[0].points[0], [2, 3]);
    session.execute("undo", "{}");
    assert.deepEqual(JSON.parse(session.scene()).primitives[0].points[0], [0, 0]);
    restored.load_dxf(session.export_dxf());
    assert.equal(JSON.parse(restored.scene()).entityCount, 1);
    assert.equal(restored.pick(5, 2, 0.1), line.handles[0]);
    assert.match(restored.export_svg(), /<polyline/);
    assert.throws(() => restored.load_dxf(new TextEncoder().encode("broken")));
    assert.equal(JSON.parse(restored.scene()).entityCount, 1);
  } finally {
    session.free();
    restored.free();
  }
});

test("WASM renders Chinese text with the existing licensed CJK font", async () => {
  const session = new bridge.CadcraftSession();
  try {
    const font = await readFile(
      new URL("../../../src/shared/document/fonts/SourceHanSerifCN-Regular.otf", import.meta.url),
    );
    session.register_font("Source Han Serif CN", font);
    session.execute("text", JSON.stringify({ at: [0, 0], text: "专利工作台", height: 5 }));
    assert.ok(JSON.parse(session.scene()).primitives.some((p) => p.kind === "triangles"));
    assert.match(new TextDecoder().decode(session.export_dxf()), /专利工作台/);
    assert.throws(() => session.register_font("invalid", new Uint8Array([1, 2, 3])));
  } finally {
    session.free();
  }
});

test("generated WASM normalizes layer inheritance and renders a transparent patent preview", () => {
  const session = new bridge.CadcraftSession();
  try {
    session.execute(
      "line",
      JSON.stringify({
        points: [
          [0, 0],
          [10, 0],
        ],
      }),
    );
    session.execute("layer.set", JSON.stringify({ name: "0", on: false, locked: true }));
    const normalized = JSON.parse(session.execute("bridge.flatten_layers", "{}"));
    assert.equal(normalized.layer, "0");
    const hidden = JSON.parse(session.scene()).entities[0];
    assert.equal(hidden.visible, false);
    assert.equal(hidden.locked, false);
    assert.equal(hidden.geometry.type, "line");
    assert.equal(hidden.lineweight, 0.25);
    session.execute("circle", JSON.stringify({ center: [20, 20], radius: 5 }));
    assert.equal(JSON.parse(session.scene()).entities[1].radius, 5);
    assert.doesNotMatch(session.export_patent_svg(), /<rect width="100%"/);
    assert.match(session.export_svg(), /<rect width="100%"/);
  } finally {
    session.free();
  }
});

test("generated WASM pastes native snapshot geometry after erasing the source", () => {
  const session = new bridge.CadcraftSession();
  try {
    const circle = JSON.parse(
      session.execute("circle", JSON.stringify({ center: [2, 3], radius: 5 })),
    );
    const snapshot = session.export_dxf();
    session.execute("erase", JSON.stringify({ handles: [circle.handle] }));
    session.load_dxf(session.export_dxf());
    const pasted = JSON.parse(
      session.paste_dxf(snapshot, JSON.stringify({ handles: [circle.handle], delta: [10, 20] })),
    );
    assert.equal(pasted.handles.length, 1);
    const state = JSON.parse(session.scene());
    assert.equal(state.entities[0].handle, pasted.handles[0]);
    assert.equal(state.entities[0].radius, 5);
    assert.deepEqual(state.entities[0].geometry.center, { x: 12, y: 23, z: 0 });
    const before = session.export_dxf();
    assert.throws(() =>
      session.paste_dxf(snapshot, JSON.stringify({ handles: ["FFFF"], delta: [10, 20] })),
    );
    assert.deepEqual(session.export_dxf(), before);
  } finally {
    session.free();
  }
});

test("generated WASM keeps BODY mask frames off through DXF checkpoint reload", () => {
  const session = new bridge.CadcraftSession();
  try {
    session.execute("wipeout", JSON.stringify({ frames: "off" }));
    session.execute(
      "bridge.add_primitives",
      JSON.stringify({
        primitives: [
          {
            kind: "mask",
            points: [
              [0, 0],
              [20, 0],
              [20, 20],
              [0, 20],
            ],
            color: [255, 255, 255],
            lineweight: 0,
          },
          {
            kind: "mask",
            points: [
              [25, 0],
              [45, 0],
              [45, 20],
              [25, 20],
            ],
            color: [255, 255, 255],
            lineweight: 0,
          },
          {
            kind: "polyline",
            points: [
              [0, 10],
              [45, 10],
            ],
            color: [0, 0, 0],
            lineweight: 0.25,
          },
        ],
      }),
    );
    const before = JSON.parse(session.scene()).primitives;
    assert.deepEqual(
      before.map((primitive) => primitive.kind),
      ["mask", "mask", "polyline"],
    );
    for (let iteration = 0; iteration < 3; iteration++) {
      session.load_dxf(session.export_dxf());
      assert.deepEqual(JSON.parse(session.scene()).primitives, before);
    }
    session.execute("wipeout", JSON.stringify({ frames: "on" }));
    assert.equal(JSON.parse(session.scene()).primitives.length, 5);
    const preview = session.export_patent_svg();
    assert.equal((preview.match(/<polyline/g) ?? []).length, 1);
    assert.equal((preview.match(/<path fill="#ffffff"/g) ?? []).length, 2);
    assert.equal(JSON.parse(session.scene()).primitives.length, 5);
  } finally {
    session.free();
  }
});

test("lasso selects a concave six-point region using the shipped WASM", () => {
  const s = new bridge.CadcraftSession();
  const run = (c,p) => JSON.parse(s.execute(c,JSON.stringify(p)));
  try {
    const inside = run("line",{points:[[1,1],[2,2]]}).handles[0];
    run("line",{points:[[7,7],[8,8]]});
    const before = s.export_dxf();
    assert.deepEqual(run("bridge.select_polygon", {polygon:[[0,0],[10,0],[10,3],[3,3],[3,10],[0,10]],crossing:true}).handles, [inside]);
    assert.deepEqual(s.export_dxf(), before);
  } finally {s.free();}
});
