import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = new URL("../../../resources/cadcraft/wasm/", import.meta.url);
const source = await readFile(new URL("cadcraft.js", root), "utf8");
const bridge = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
bridge.initSync({ module: await readFile(new URL("cadcraft_bg.wasm", root)) });
function drawing() {
  const s = new bridge.CadcraftSession();
  return {
    s,
    run: (command, params = {}) => JSON.parse(s.execute(command, JSON.stringify(params))),
    scene: () => JSON.parse(s.scene()),
  };
}
test("stretch changes only requested endpoints, preserves unrelated geometry, and undoes atomically", () => {
  const { s, run, scene } = drawing();
  try {
    run("line", {
      points: [
        [0, 0],
        [20, 0],
      ],
    });
    run("line", {
      points: [
        [0, 2],
        [20, 2],
      ],
    });
    const before = scene(),
      h = before.entities[0].handle,
      other = before.entities[1];
    run("stretch", {
      handles: [h],
      moveHandles: [],
      window: [
        [15, -5],
        [25, 5],
      ],
      delta: [10, 5],
    });
    const after = scene();
    assert.deepEqual(after.entities.find((e) => e.handle === h).grips, [
      [0, 0],
      [15, 2.5],
      [30, 5],
    ]);
    assert.deepEqual(
      after.entities.find((e) => e.handle === other.handle).geometry,
      other.geometry,
    );
    run("undo");
    assert.deepEqual(
      scene().entities.map((e) => e.geometry),
      before.entities.map((e) => e.geometry),
    );
    run("redo");
    assert.deepEqual(
      scene().entities.map((e) => e.geometry),
      after.entities.map((e) => e.geometry),
    );
  } finally {
    s.free();
  }
});
test("stretch moves an arc endpoint, not just its centre", () => {
  const { s, run, scene } = drawing();
  try {
    run("arc", { p1: [0, 0], p2: [10, 10], p3: [20, 0] });
    const old = scene().entities[0],
      h = old.handle;
    run("stretch", {
      handles: [h],
      moveHandles: [],
      window: [
        [15, -5],
        [25, 5],
      ],
      delta: [5, 0],
    });
    const grips = scene().entities[0].grips;
    assert(grips.some((p) => Math.hypot(p[0] - 25, p[1]) < 1e-7));
    assert(grips.some((p) => Math.hypot(p[0], p[1]) < 1e-7));
    assert.notDeepEqual(scene().entities[0].geometry, old.geometry);
  } finally {
    s.free();
  }
});
test("BREAK and STRETCH previews return compact geometry without changing history", () => {
  for (const command of ["break", "stretch"]) {
    const { s, run, scene } = drawing();
    try {
      run("line", {
        points: [
          [0, 0],
          [20, 0],
        ],
      });
      const before = scene(),
        h = before.entities[0].handle;
      const params =
        command === "break"
          ? { handle: h, p1: [5, 0], p2: [10, 0] }
          : {
              handles: [h],
              moveHandles: [],
              window: [
                [15, -5],
                [25, 5],
              ],
              delta: [5, 0],
            };
      const preview = run("bridge.preview_modify", { command, params, compact: true });
      assert.equal(preview.partial, true);
      assert.deepEqual(scene().entities, before.entities);
      run("undo");
      assert.equal(scene().entities.length, 0);
    } finally {
      s.free();
    }
  }
});
test("OFFSET keeps the source, repeats and rejects an impossible inward radius atomically", () => {
  const { s, run, scene } = drawing();
  try {
    run("circle", { center: [0, 0], radius: 10 });
    const h = scene().entities[0].handle,
      original = scene().entities[0].geometry;
    run("offset", { handle: h, distance: 2, side: [20, 0] });
    run("offset", { handle: h, distance: 4, side: [20, 0] });
    assert.equal(scene().entities.length, 3);
    assert.deepEqual(scene().entities.find((e) => e.handle === h).geometry, original);
    const before = scene().entities;
    assert.throws(() => run("offset", { handle: h, distance: 20, side: [0, 0] }));
    assert.deepEqual(scene().entities, before);
    run("undo");
    assert.equal(scene().entities.length, 2);
  } finally {
    s.free();
  }
});
test("BREAK splits at one point, and removes the counterclockwise arc of a circle", () => {
  const { s, run, scene } = drawing();
  try {
    run("line", {
      points: [
        [0, 0],
        [20, 0],
      ],
    });
    const h = scene().entities[0].handle;
    run("break", { handle: h, p1: [8, 0], p2: [8, 0] });
    assert.equal(scene().entities.length, 2);
    assert(scene().entities.every((e) => e.grips.some((p) => Math.abs(p[0] - 8) < 1e-8)));
    run("circle", { center: [50, 0], radius: 10 });
    const circle = scene().entities.find((e) => e.type === "Circle");
    run("break", { handle: circle.handle, p1: [60, 0], p2: [50, 10] });
    const arc = scene().entities.find((e) => e.type === "Arc");
    assert(arc);
    assert(Math.abs(arc.geometry.start - Math.PI / 2) < 1e-7);
    assert(Math.abs(arc.geometry.end) < 1e-7 || Math.abs(arc.geometry.end - 2 * Math.PI) < 1e-7);
  } finally {
    s.free();
  }
});
test("stretch rejects degenerate geometry without changing any other selected object", () => {
  const { s, run, scene } = drawing();
  try {
    run("line", {
      points: [
        [0, 0],
        [20, 0],
      ],
    });
    run("circle", { center: [30, 0], radius: 2 });
    const before = scene(),
      [l, c] = before.entities;
    assert.throws(() =>
      run("stretch", {
        handles: [c.handle, l.handle],
        moveHandles: [c.handle],
        window: [
          [15, -5],
          [35, 5],
        ],
        delta: [-20, 0],
      }),
    );
    assert.deepEqual(scene().entities, before.entities);
  } finally {
    s.free();
  }
});
test("stretch edits spline fit nodes while retaining unselected endpoints", () => {
  const { s, run, scene } = drawing();
  try {
    run("spline", {
      fit: [
        [0, 0],
        [10, 10],
        [20, 0],
      ],
    });
    const h = scene().entities[0].handle;
    run("stretch", {
      handles: [h],
      moveHandles: [],
      window: [
        [15, -5],
        [25, 5],
      ],
      delta: [5, 3],
    });
    const fit = scene().entities[0].geometry.fit;
    assert.deepEqual(fit, [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 25, y: 3 },
    ]);
  } finally {
    s.free();
  }
});
test("modified geometry remains editable through DXF and DWG round trips",()=>{
  const {s,run,scene}=drawing(), restored=new bridge.CadcraftSession();
  try{
    run("line",{points:[[0,0],[20,0]]});
    const h=scene().entities[0].handle;
    run("offset",{handle:h,distance:3,side:[0,10]});
    run("break",{handle:h,p1:[5,0],p2:[10,0]});
    const handles=scene().entities.map(e=>e.handle);
    run("stretch",{handles,moveHandles:[],window:[[15,-5],[25,5]],delta:[10,5]});
    const dxf=s.export_dxf();
    const exe=fileURLToPath(new URL("../../../resources/cadcraft/cadcraft-codec.exe",import.meta.url));
    const dwg=execFileSync(exe,["dxf-to-dwg"],{input:dxf,windowsHide:true,maxBuffer:32*1024*1024});
    assert.equal(dwg.subarray(0,2).toString(),"AC");
    const roundtrip=execFileSync(exe,["dwg-to-dxf"],{input:dwg,windowsHide:true,maxBuffer:32*1024*1024});
    const geometry=(entities)=>entities.map(e=>JSON.stringify(e.geometry)).sort();
    for(const data of [dxf,roundtrip]){
      restored.load_dxf(data);
      const imported=JSON.parse(restored.scene());
      assert.equal(imported.entities.length,3);
      assert.deepEqual(geometry(imported.entities),geometry(scene().entities));
      restored.execute("move",JSON.stringify({handles:imported.entities.map(e=>e.handle),delta:[1,2]}));
      assert.match(restored.export_svg(),/<svg/);
    }
  }finally{s.free();restored.free();}
});
test("large-scene previews remain compact and bounded to the changed entities",()=>{
  const {s,run}=drawing();
  try{
    const dxf="0\nSECTION\n2\nENTITIES\n"+Array.from({length:10000},(_,i)=>`0\nLINE\n8\n0\n10\n${i*2}\n20\n100\n11\n${i*2+1}\n21\n101\n`).join("")+"0\nENDSEC\n0\nEOF\n";
    s.load_dxf(new TextEncoder().encode(dxf));
    const h=run("line",{points:[[0,0],[20,0]]}).handles[0];
    for(const command of ["offset","break","stretch"]){
      const params=command==="offset"?{handle:h,distance:2,side:[0,5]}:command==="break"?{handle:h,p1:[5,0],p2:[10,0]}:{handles:[h],moveHandles:[],window:[[15,-5],[25,5]],delta:[5,3]};
      const times=[];
      for(let i=0;i<8;i++){
        const start=performance.now(), result=run("bridge.preview_modify",{command,params,compact:true});
        times.push(performance.now()-start);
        assert.equal(result.partial,true);
        assert(result.entities.length<=2);assert(result.primitives.length<=2);
        assert(JSON.stringify(result).length<5000);
      }
      times.sort((a,b)=>a-b);
      console.log(`${command}: 10001 entities, preview median ${times[4].toFixed(1)} ms, max ${times[7].toFixed(1)} ms`);
    }
  }finally{s.free();}
});
test("a zero-area stretch window cannot select every vertex accidentally",()=>{
  const {s,run,scene}=drawing();
  try{
    run("line",{points:[[0,0],[20,0]]});
    const before=scene(),h=before.entities[0].handle;
    assert.throws(()=>run("stretch",{handles:[h],moveHandles:[],window:[[10,0],[10,0]],delta:[5,5]}));
    assert.deepEqual(scene().entities,before.entities);
  }finally{s.free();}
});
test("fully enclosed rigid shapes move without deformation and locked selections remain intact",()=>{
  const {s,run,scene}=drawing();
  try{
    run("circle",{center:[0,0],radius:10});
    const before=scene().entities[0], h=before.handle;
    run("stretch",{handles:[h],moveHandles:[h],window:[[-20,-20],[20,20]],delta:[5,7]});
    const moved=scene().entities[0];
    assert.equal(moved.geometry.radius,before.geometry.radius);
    assert.deepEqual(moved.geometry.center,{x:5,y:7,z:0});
    run("layer.set",{name:"0",locked:true});
    assert.throws(()=>run("stretch",{handles:[h],moveHandles:[h],window:[[-20,-20],[20,20]],delta:[5,7]}));
    assert.deepEqual(scene().entities[0].geometry,moved.geometry);
  }finally{s.free();}
});
test("stretch updates associated hatching and undo restores its original boundary",()=>{
  const {s,run,scene}=drawing();
  try{
    const boundary=run("rectang",{p1:[0,0],p2:[20,20]}).handle;
    const fill=run("hatch",{points:[[10,10]],pattern:"ANSI31",scale:1}).handle;
    const hatch=()=>scene().entities.find(e=>e.handle===fill).geometry;
    const original=hatch();
    run("stretch",{handles:[boundary],moveHandles:[],window:[[15,-5],[25,25]],delta:[10,5]});
    assert.equal(hatch().associative,true);
    assert(hatch().loops[0].vertices.some(v=>v.p.x>=30));
    run("undo");
    assert.deepEqual(hatch(),original);
    run("redo");
    assert(hatch().loops[0].vertices.some(v=>v.p.x>=30));
  }finally{s.free();}
});
