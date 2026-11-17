import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ComponentProps, createRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CadPatentObject } from "../../../shared/drawing-markup/cad-objects";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { cornerCandidates, cornerGeometry } from "./cad-corner";
import { type CadEditingHandle, CadEditingPanel } from "./cad-editing-panel";
import type { CadScene } from "./cadcraft-client";

const request = vi.hoisted(() => vi.fn());
vi.mock("./cadcraft-client", () => ({
  CadcraftClient: class {
    request = (method:string,...args:unknown[])=>request(method==="edit"?"execute":method==="editPaste"?"paste":method,...args);
    close() {}
  },
  ensureCadcraftClient: (client:unknown)=>client??{request,close(){}},
}));
const scene: CadScene = {
  revision: 1,
  entityCount: 1,
  selection: [],
  bounds: null,
  svgFrame: { origin: [0, 0], width: 100, height: 100 },
  entities: [{ handle: "A", type: "Line", layer: "0" }],
  primitives: [
    {
      handle: "A",
      kind: "polyline",
      points: [
        [10, 90],
        [50, 90],
      ],
      color: [0, 0, 0],
      aci7: true,
      lineweight: 0,
    },
  ],
};
const bytes = new Uint8Array([1]);

test.each(["偏移", "打断"])("basic modify tool %s is directly available", async name => {
  await setup();
  expect(screen.getByRole("button", {name})).toBeDefined();
});

test("BREAK uses the background edit queue without blocking the document", async () => {
  request.mockImplementation(async (method: string) => method === "execute" ? {bytes, scene} : scene);
  const {ref, props} = await setup();
  act(()=>{ref.current?.cancel();ref.current?.selectHandles(["A"]);});
  fireEvent.click(screen.getByRole("button", {name:"打断"}));
  await act(async()=>{ref.current?.click({x:20,y:10},false,1);ref.current?.click({x:30,y:10},false,1);await ref.current?.flush();});
  expect(request).toHaveBeenCalledWith("execute","break",{handle:"A",p1:[20,90],p2:[30,90]});
  expect(props.onBusy).not.toHaveBeenCalledWith(true);
});

test("local window stretch is removed from the tool rail", async () => {
  await setup();
  expect(screen.queryByRole("button", {name:"局部拉伸"})).toBeNull();
});
test("selected geometry can start a local drag without worker picking, but empty space cannot", async () => {
  const {ref} = await setup();
  act(()=>{ref.current?.cancel();ref.current?.selectHandles(["A"]);});
  request.mockClear();
  expect(ref.current?.canDragSelection({x:20,y:10},1)).toBe(true);
  expect(ref.current?.canDragSelection({x:20,y:30},1)).toBe(false);
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"直线"}));
  expect(ref.current?.canDragSelection({x:20,y:10},1)).toBe(false);
});
test("direct movement previews the entire selection locally and commits one background move", async () => {
  const source = {...scene, entities:[...scene.entities,{handle:"B",type:"Line",layer:"0"}],
    primitives:[...scene.primitives,{...scene.primitives[0]!,handle:"B",points:[[10,70],[50,70]] as [number,number][]}]};
  request.mockImplementation(async(method:string)=>method==="execute"?{bytes,scene:source}:source);
  const {ref,props}=await setup();
  act(()=>{ref.current?.cancel();ref.current?.selectHandles(["A","B"]);});
  request.mockClear();
  vi.mocked(props.onEnabled).mockClear();
  act(()=>expect(ref.current?.beginMove({x:20,y:10},0.1)).toBe(true));
  expect(props.onEnabled).not.toHaveBeenCalled();
  act(()=>ref.current?.hover({x:40,y:40},0.1,false));
  expect(request).not.toHaveBeenCalled();
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toMatchObject({mode:"move",handles:["A","B"],anchor:{x:20,y:90},cursor:{x:40,y:60}});
  await act(async()=>{ref.current?.endMove({x:40,y:40},0.1,false);await ref.current?.flush();});
  expect(request.mock.calls.filter(c=>c[0]==="execute")).toEqual([["execute","move",{handles:["A","B"],delta:[20,-30]}]]);
  expect(props.onBusy).not.toHaveBeenCalledWith(true);
});
test("dropping a direct move back at its anchor leaves selection mode without an edit",async()=>{
  const {ref}=await setup();
  act(()=>{ref.current?.cancel();ref.current?.selectHandles(["A"]);});
  act(()=>ref.current?.beginMove({x:20,y:10},1));
  request.mockClear();
  act(()=>ref.current?.endMove({x:20,y:10},1,false));
  expect(request).not.toHaveBeenCalled();
  expect(ref.current?.canWindow()).toBe(true);
  expect(screen.getByRole("button",{name:"移动"}).getAttribute("aria-pressed")).toBe("false");
});
test("a selected grip takes priority over dragging and Escape cancels without writing", async () => {
  const source={...scene,entities:[{...scene.entities[0]!,grips:[[10,90],[30,90],[50,90]] as [number,number][]}]};
  request.mockResolvedValue(source);
  const {ref}=await setup();
  act(()=>{ref.current?.cancel();ref.current?.selectHandles(["A"]);});
  expect(ref.current?.canDragSelection({x:10,y:10},1)).toBe(false);
  act(()=>expect(ref.current?.beginGrip({x:10,y:10},1)).toBe(true));
  expect(ref.current?.canDragSelection({x:20,y:10},1)).toBe(false);
  act(()=>ref.current?.cancel());
  request.mockClear();
  act(()=>{ref.current?.beginMove({x:20,y:10},1);});
  act(()=>{ref.current?.hover({x:40,y:30},1,false);ref.current?.cancel();});
  expect(request).not.toHaveBeenCalled();
});
test("finishing a previous save does not replace the active tool's next-step instruction",async()=>{
  request.mockImplementation(async(method:string)=>method==="execute"?{bytes,scene}:scene);
  let release!:()=>void;
  const saving=new Promise<void>(resolve=>{release=resolve;});
  const {ref}=await setup({onCommit:async(_bytes,prepared)=>{
    await saving;prepared("saved");return {bytes,scene,objects:[]};
  }});
  await act(async()=>{ref.current?.click({x:10,y:20},false,1);ref.current?.click({x:30,y:40},false,1);});
  fireEvent.click(screen.getByRole("button",{name:"打断"}));
  const before=document.querySelector(".cad-instruction-card")!.textContent;
  await act(async()=>{release();await ref.current?.flush();});
  expect(document.querySelector(".cad-instruction-card")!.textContent).toBe(before);
});

test("suspending the sole CAD worker retains a pending LINE start point", async () => {
  request.mockImplementation(async (method: string) => method === "execute" ? {bytes, scene} : scene);
  const {ref, props, view} = await setup();
  await act(async () => ref.current?.click({x: 20, y: 20}, false, 1));
  await act(async () => view.rerender(<CadEditingPanel {...props} runtimeEnabled={false} enabled={false} />));
  await act(async () => view.rerender(<CadEditingPanel {...props} runtimeEnabled enabled />));
  await waitFor(() => expect(screen.getByRole("region", {name: "CAD实体编辑"}).getAttribute("data-cad-ready")).toBe("true"));
  request.mockClear();
  await act(async () => {
    ref.current?.click({x: 70, y: 40}, false, 1);
    await ref.current?.flush();
  });
  expect(request).toHaveBeenCalledWith("execute", "line", expect.objectContaining({
    points: [[20, 80], [70, 60]],
  }));
});

test.each(["leave","cancel"] as const)("mirror publishes native results during movement and discards results after %s",async(stop)=>{
  const initial={...scene,entities:[{...scene.entities[0]!,type:"MText"}]};
  const pending:((value:CadScene)=>void)[]=[];
  request.mockImplementation(async(method:string,command:string)=>method==="query"&&command==="bridge.preview_modify"?new Promise<CadScene>(resolve=>pending.push(resolve)):initial);
  const {ref,props}=await setup();
  act(()=>{ref.current?.cancel();ref.current?.selectHandles(["A"]);});
  fireEvent.click(screen.getByRole("button",{name:"镜像"}));
  await act(async()=>ref.current?.click({x:20,y:20},false,1));
  act(()=>ref.current?.hover({x:60,y:40},1,false));
  await waitFor(()=>expect(pending.length).toBe(1));
  act(()=>ref.current?.hover({x:70,y:50},1,false));
  const result={...initial,partial:true,entities:[{...initial.entities[0]!,handle:"B"}],primitives:[{...initial.primitives[0]!,handle:"B"}]};
  await act(async()=>pending[0]!(result));
  const published=vi.mocked(props.onPreview).mock.lastCall?.[0];
  expect(published?.curvePaths).toHaveLength(1);
  expect(published?.cursor).toEqual({x:70,y:50});
  await waitFor(()=>expect(pending.length).toBe(2));
  act(()=>ref.current?.[stop]());
  const calls=vi.mocked(props.onPreview).mock.calls.length;
  await act(async()=>pending[1]!(result));
  expect(vi.mocked(props.onPreview).mock.calls.length).toBe(calls);
});

test("hovering selected spring controls describes their functions instead of block insertion snaps", async () => {
  const spring: NonNullable<CadScene["entities"][number]["spring"]> = {kind:"extension",at:[10,80],end:[90,80],length:80,width:20,wire:2,turns:6,rotation:0};
  const initial: CadScene = {...scene, entities:[{handle:"S",type:"Block Reference",layer:"0",spring,grips:[[10,80],[90,80],[50,90],[70,90],[50,80]]}]};
  request.mockImplementation(async()=>initial);
  const {ref,props}=await setup();
  act(()=>{ref.current?.cancel();ref.current?.selectHandles(["S"]);});
  const expected=["调整起点与长度","调整长度与方向","调整宽度","调整圈数","移动弹簧"];
  initial.entities[0]!.grips!.forEach(([x,y],i)=>{
    act(()=>ref.current?.hover({x,y:100-y},1,false));
    expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.gripHint).toBe(expected[i]);
  });
  act(()=>ref.current?.hover({x:40,y:40},1,false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.gripHint).toBeUndefined();
  expect(request.mock.calls.some(([method])=>method==="execute")).toBe(false);
});

test("accepted ordinary geometry publishes its checkpoint without materialize, recomposition or restore", async () => {
  request.mockImplementation(async (method: string) => method === "execute" ? {bytes, scene} : scene);
  const onNativeCommit = vi.fn(() => ({checkpointId: "native-checkpoint", objects: [], scene}));
  const {ref, props} = await setup({onNativeCommit});
  request.mockClear();
  await act(async () => {
    ref.current?.click({x: 10, y: 10}, false, 1);
    ref.current?.click({x: 30, y: 30}, false, 1);
    await ref.current?.flush();
  });
  expect(onNativeCommit).toHaveBeenCalledOnce();
  expect(props.onCommit).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(c => ["restore", "materialize", "synchronize"].includes(c[0]))).toHaveLength(0);
});

test("two selected gears expose meshing at the top and commit through the nonblocking queue", async()=>{
  const gears:CadScene={...scene,entities:[
    {handle:"G1",type:"Block Reference",layer:"0",gear:{kind:"external",teeth:20,hole:true,size:80},grips:[[20,80],[60,80]]},
    {handle:"G2",type:"Block Reference",layer:"0",gear:{kind:"external",teeth:30,hole:true,size:90},grips:[[120,80],[165,80]]}]};
  request.mockImplementation(async(method:string)=>method==="execute"?{bytes,scene:{...gears,entities:gears.entities.map((e,i)=>({...e,gearMate:i?"G1":"G2"}))},result:{changed:true,handles:["G1","G2"]}}:gears);
  const {ref,props}=await setup();
  act(()=>{ref.current?.cancel();ref.current?.selectHandles(["G1","G2"]);});
  const settings=screen.getByRole("region",{name:"齿轮啮合设置"});
  const toggle=within(settings).getByRole("checkbox",{name:"啮合"});
  expect(toggle).toHaveProperty("checked",false);fireEvent.click(toggle);
  await waitFor(()=>expect(request).toHaveBeenCalledWith("execute","bridge.gear_mesh",{handles:["G1","G2"],enabled:true}));
  await act(async()=>ref.current?.flush());expect(props.onCommit).toHaveBeenCalledOnce();
  expect(props.onBusy).not.toHaveBeenCalledWith(true);
});

test("a meshed rotation grip previews both members without saving until release",async()=>{
  const gears:CadScene={...scene,entities:[
    {handle:"G1",type:"Block Reference",layer:"0",gear:{kind:"external",teeth:20,hole:true,size:80},gearMate:"G2",grips:[[20,80],[60,80],[-30,80],[20,136]]},
    {handle:"G2",type:"Block Reference",layer:"0",gear:{kind:"external",teeth:30,hole:true,size:120},gearMate:"G1",grips:[[120,80],[180,80]]}],
    primitives:[{...scene.primitives[0]!,handle:"G1"},{...scene.primitives[0]!,handle:"G2"}]};
  request.mockImplementation(async()=>gears);const {ref,props}=await setup();
  act(()=>{ref.current?.cancel();ref.current?.selectHandles(["G1"]);});
  act(()=>{expect(ref.current?.beginGrip({x:20,y:-36},2)).toBe(true);ref.current?.hover({x:-36,y:20},2,false);});
  await waitFor(()=>expect(request).toHaveBeenCalledWith("query","bridge.preview_draw",expect.objectContaining({command:"grip.move"})));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.trimOriginal?.map(p=>p.handle)).toEqual(["G1","G2"]);
  expect(props.onCommit).not.toHaveBeenCalled();act(()=>ref.current?.cancel());
});

test("a train rotation preview hides and redraws every connected gear, and exposes each direct link",async()=>{
  const gears:CadScene={...scene,entities:[
    {handle:"G1",type:"Block Reference",layer:"0",gear:{kind:"external",teeth:20,hole:true,size:80},gearMate:"G2",gearMates:["G2"],grips:[[20,80],[60,80],[-30,80],[20,136]]},
    {handle:"G2",type:"Block Reference",layer:"0",gear:{kind:"external",teeth:30,hole:true,size:120},gearMate:"G1",gearMates:["G1","G3"],grips:[[120,80],[180,80]]},
    {handle:"G3",type:"Block Reference",layer:"0",gear:{kind:"external",teeth:16,hole:true,size:60},gearMate:"G2",gearMates:["G2"],grips:[[220,80],[250,80]]}],
    primitives:["G1","G2","G3"].map(handle=>({...scene.primitives[0]!,handle}))};
  request.mockImplementation(async()=>gears); const {ref,props}=await setup();
  act(()=>{ref.current?.cancel();ref.current?.selectHandles(["G2"]);});
  expect(screen.getAllByRole("region",{name:"齿轮啮合关系"})).toHaveLength(2);
  act(()=>{ref.current?.selectHandles(["G1"]);expect(ref.current?.beginGrip({x:20,y:-36},2)).toBe(true);ref.current?.hover({x:-36,y:20},2,false);});
  await waitFor(()=>expect(request).toHaveBeenCalledWith("query","bridge.preview_draw",expect.objectContaining({command:"grip.move"})));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.trimOriginal?.map(p=>p.handle)).toEqual(["G1","G2","G3"]);
  expect(props.onCommit).not.toHaveBeenCalled(); act(()=>ref.current?.cancel());
});

test("gear rotation accumulates both turns and uses the same angle at release",async()=>{
  const gears:CadScene={...scene,entities:[{handle:"G1",type:"Block Reference",layer:"0",rotation:0,
    gear:{kind:"external",teeth:20,hole:true,size:80},gearMate:"G2",grips:[[20,80],[60,80],[-30,80],[20,136]]}],primitives:[]};
  request.mockImplementation(async(method:string)=>method==="execute"?{bytes,scene:gears,result:{changed:true}}:gears);
  const {ref,props}=await setup();act(()=>{ref.current?.cancel();ref.current?.selectHandles(["G1"]);});
  act(()=>expect(ref.current?.beginGrip({x:20,y:-36},0.001)).toBe(true));
  const at=(degrees:number)=>({x:20-56*Math.sin(degrees*Math.PI/180),y:20-56*Math.cos(degrees*Math.PI/180)});
  for(const degrees of [90,179,181,270,359,361,450]) await act(async()=>ref.current?.hover(at(degrees),0.001,false));
  await waitFor(()=>expect(request).toHaveBeenCalledWith("query","bridge.preview_draw",expect.objectContaining({params:expect.objectContaining({angle:expect.closeTo(450,5)})})));
  await act(async()=>{ref.current?.click(at(450),false,0.001);await ref.current?.flush();});
  expect(request).toHaveBeenCalledWith("execute","grip.move",expect.objectContaining({angle:expect.closeTo(450,5)}));
  expect(props.onCommit).toHaveBeenCalledOnce();
});

test("a selected meshed gear can select its partner and disconnect without ordinary ungroup",async()=>{
  const gears:CadScene={...scene,entities:["G1","G2"].map((handle,i)=>({handle,type:"Block Reference",layer:"0",gear:{kind:i?"internal":"external",teeth:i?40:20,hole:!i,size:80},gearMate:i?"G1":"G2"})),groups:[{name:"PW_GEAR_MESH_1",selectable:false,members:["G1","G2"]}]};
  request.mockImplementation(async(method:string)=>method==="execute"?{bytes,scene:gears,result:{changed:true}}:gears);
  const {ref,props}=await setup();act(()=>{ref.current?.cancel();ref.current?.selectHandles(["G1"]);});
  expect(screen.getByRole("button",{name:"取消编组"})).toHaveProperty("disabled",true);
  expect(screen.getByRole("region",{name:"齿轮啮合关系"}).textContent).toContain("内齿圈");
  fireEvent.click(screen.getByRole("button",{name:"选中配对对象"}));
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["G2"]);
  fireEvent.click(screen.getByRole("button",{name:"取消啮合"}));
  await waitFor(()=>expect(request).toHaveBeenCalledWith("execute","bridge.gear_mesh",{handles:["G2","G1"],enabled:false}));
});

test.each([true,false])("cancelling meshing validation and reselecting the same gears never commits its late result (Esc: %s)",async(escape)=>{
  const gears:CadScene={...scene,entities:["G1","G2"].map(handle=>({handle,type:"Block Reference",layer:"0",gear:{kind:"external",teeth:20,hole:true,size:80}}))};
  let release!:(value:CadScene)=>void;
  request.mockImplementation(async(method:string,command:string)=>method==="query"&&command==="bridge.preview_modify"
    ? new Promise<CadScene>(resolve=>{release=resolve;}) : method==="execute" ? {bytes,scene:gears,result:{changed:true}} : gears);
  const {ref,props}=await setup();act(()=>{ref.current?.cancel();ref.current?.selectHandles(["G1","G2"]);});
  fireEvent.click(screen.getByRole("checkbox",{name:"啮合"}));await waitFor(()=>expect(release).toBeTypeOf("function"));
  act(()=>{if(escape)ref.current?.cancel();else ref.current?.selectHandles(["G1"]);ref.current?.selectHandles(["G1","G2"]);});
  await act(async()=>{release(gears);await Promise.resolve();await ref.current?.flush();});
  expect(request.mock.calls.filter(c=>c[0]==="execute")).toHaveLength(0);expect(props.onCommit).not.toHaveBeenCalled();
});

test("whole detail explode preserves the source marker and becomes independently selectable before saving finishes", async () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad = {version:1,engine:"cadcraft",engineVersion:"a".repeat(40),assetId:project.sourceAssetId,unified:1,
    mapping:{originX:0,originY:100,scale:1},objects:[{id:"detail",kind:"detail",body:["A"],frame:["B"],source:["C"]}]};
  project.detailViews = [{id:"detail",label:"A",source:{x:10,y:10},center:{x:50,y:50},title:{x:50,y:20},marker:{x:1,y:1},radius:10,ratio:2,fontSize:8,lineWidth:1,fragments:[{id:"f",offset:{x:0,y:0},clips:[[{x:0,y:0},{x:100,y:0},{x:100,y:100}]],holes:[]}]}];
  const detailScene:CadScene = {...scene,entities:[...scene.entities,{handle:"B",type:"Circle",layer:"0"},{handle:"C",type:"Text",layer:"0"}]};
  request.mockImplementation(async(method:string)=>method==="execute"?{bytes,scene:detailScene,result:{changed:true,exploded:1,detached:["detail"],handles:["A","B","C"],skipped:[]}}:detailScene);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const onCommit=vi.fn(async(_bytes:Uint8Array,prepared:(id:string)=>void)=>{await gate;prepared("saved");return {bytes,scene:detailScene,objects:[]};});
  const {ref,props}=await setup({project,onCommit});
  act(()=>{ref.current?.cancel();ref.current?.selectHandles(["A"]);});
  fireEvent.click(screen.getByRole("button",{name:"分解"}));
  try {
    await waitFor(()=>expect(onCommit).toHaveBeenCalledOnce());
    expect(request.mock.calls.find(c=>c[0]==="execute")?.[2]).toEqual(expect.objectContaining({handles:[],details:[expect.objectContaining({id:"detail",handles:["A","B","C"]})]}));
    expect((onCommit.mock.calls[0] as unknown as [unknown,unknown,typeof project])[2].detailViews).toEqual([]);
    act(()=>ref.current?.selectHandles(["A"]));
    expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["A"]);
    expect(props.onBusy).not.toHaveBeenCalledWith(true);
  } finally {await act(async()=>{release();await ref.current?.flush();});}
});

test("fillet picks one corner instead of starting a two-object selection",async()=>{
 const cornerScene:CadScene={...scene,entities:[
 {handle:"A",type:"Line",layer:"0",geometry:{type:"line",a:{x:90,y:10},b:{x:10,y:10}}},
 {handle:"B",type:"Line",layer:"0",geometry:{type:"line",a:{x:10,y:10},b:{x:10,y:90}}}]};
 request.mockImplementation(async(method:string)=>method==="execute"?{bytes,scene:cornerScene,result:{handles:["A","B"]}}:cornerScene);
 const {ref,props}=await setup();fireEvent.click(getTool("圆角"));
 await act(async()=>ref.current?.click({x:10,y:90},false,2));
 await waitFor(()=>expect(request).toHaveBeenCalledWith("execute","bridge.corner",expect.objectContaining({edits:expect.any(Array)})));
 expect(props.onBusy).not.toHaveBeenCalledWith(true);
 await act(async()=>{await ref.current?.flush();});
});
test("gear tools expose only diagram controls and create through the nonblocking drawing queue",async()=>{
  request.mockImplementation(async(method:string)=>method==="execute"?{bytes,scene,result:{handle:"G",handles:["G"]}}:scene);
  const {ref,props}=await setup();
  fireEvent.click(screen.getByRole("button",{name:"齿轮选项"}));
  expect(screen.getAllByRole("menuitemradio").map(e=>e.textContent)).toEqual(["外齿轮","内齿圈","齿条"]);
  fireEvent.click(screen.getByRole("menuitemradio",{name:"外齿轮"}));
  const settings=screen.getByRole("region",{name:"外齿轮设置"});
  const teeth=within(settings).getByRole("spinbutton");
  expect(teeth).toHaveProperty("value","20");
  expect(screen.queryByText("压力角")).toBeNull();
  fireEvent.change(teeth,{target:{value:"24"}});
  fireEvent.click(within(settings).getByRole("checkbox",{name:"中心孔"}));
  await act(async()=>{ref.current?.click({x:20,y:20},false,1);ref.current?.click({x:60,y:20},false,1);});
  await waitFor(()=>expect(request).toHaveBeenCalledWith("execute","bridge.gear",expect.objectContaining({teeth:24,hole:false,at:[20,80],size:80})));
  expect(props.onBusy).not.toHaveBeenCalledWith(true);
  await act(async()=>{await ref.current?.flush();});
});

test("hidden gear handles inside a non-editing detail cannot start a parameter gesture",async()=>{
  const gearScene:CadScene={...scene,entities:[{handle:"G",type:"Block Reference",layer:"0",gear:{kind:"external",teeth:20,hole:true,size:80},grips:[[20,80],[60,80],[-30,80],[20,136]]}]};
  request.mockImplementation(async(method:string)=>method==="pick"?"G":method==="execute"?{bytes,scene:gearScene}:gearScene);
  const project=drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad={version:1,engine:"cadcraft",engineVersion:"a".repeat(40),assetId:project.sourceAssetId,unified:1,mapping:{originX:0,originY:100,scale:1},objects:[{id:"detail",kind:"detail",body:["G"]}]};
  const {ref}=await setup({project});
  act(()=>{ref.current?.cancel();ref.current?.selectHandles(["G"]);});
  await act(async()=>ref.current?.click({x:60,y:20},false,2));
  await act(async()=>ref.current?.click({x:100,y:20},false,2));
  expect(request.mock.calls.filter(c=>c[0]==="execute")).toHaveLength(0);
});

test("gear grip hover names, live teeth preview and release use the normal nonblocking queue",async()=>{
  const entity={handle:"G",type:"Block Reference",layer:"0",gear:{kind:"external" as const,teeth:20,hole:true,size:80},grips:[[20,80],[60,80],[-30,80],[20,136]] as [number,number][]};
  const initial:CadScene={...scene,entities:[entity]};
  request.mockImplementation(async(method:string,command:string)=>method==="query"&&command==="bridge.preview_draw"?{...initial,entities:[{...entity,gear:{...entity.gear,teeth:24}}]}:method==="execute"?{bytes,scene:initial,result:{handle:"G"}}:initial);
  const {ref,props}=await setup();act(()=>{ref.current?.cancel();ref.current?.selectHandles(["G"]);});
  act(()=>ref.current?.hover({x:60,y:20},2,false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.gripHint).toContain("缩放");
  act(()=>expect(ref.current?.beginGrip({x:-30,y:20},2)).toBe(true));
  await act(async()=>ref.current?.hover({x:-38,y:20},2,false));
  await waitFor(()=>expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.gripHint).toContain("24"));
  act(()=>ref.current?.hover({x:-40,y:20},2,false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.gripHint).toContain("24");
  expect(props.onCommit).not.toHaveBeenCalled();
  await act(async()=>ref.current?.click({x:-38,y:20},false,2));
  await act(async()=>ref.current?.flush());
  expect(request).toHaveBeenCalledWith("execute","grip.move",{handle:"G",index:2,to:[-38,80]});
  expect(props.onCommit).toHaveBeenCalledOnce();
  expect(props.onBusy).not.toHaveBeenCalledWith(true);
});

test("cancelling a gear teeth grip discards a late native preview and never saves",async()=>{
  const initial:CadScene={...scene,entities:[{handle:"G",type:"Block Reference",layer:"0",gear:{kind:"external",teeth:20,hole:true,size:80},grips:[[20,80],[60,80],[-30,80],[20,136]]}]};
  let release!:(value:CadScene)=>void;
  request.mockImplementation(async(method:string,command:string)=>method==="query"&&command==="bridge.preview_draw"?new Promise<CadScene>(resolve=>{release=resolve;}):initial);
  const {ref,props}=await setup();act(()=>{ref.current?.cancel();ref.current?.selectHandles(["G"]);});
  act(()=>{expect(ref.current?.beginGrip({x:-30,y:20},2)).toBe(true);ref.current?.hover({x:-38,y:20},2,false);});
  await waitFor(()=>expect(release).toBeTypeOf("function"));
  act(()=>ref.current?.cancel());
  await act(async()=>release(initial));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toBeNull();
  expect(props.onCommit).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(c=>c[0]==="execute")).toHaveLength(0);
});

test("a rolled-back detail edit never saves or disables correction, undo and close flush",async()=>{
  let reject=true;
  request.mockImplementation(async(method:string)=>method==="execute"
    ? reject ? {rejected:"详图 A 的图形超出圆形范围，原工作稿未改变。"} : {bytes,scene,result:{handle:"G",handles:["G"]}}
    : scene);
  const {ref,props}=await setup();
  fireEvent.click(screen.getByRole("button",{name:"齿轮选项"}));
  fireEvent.click(screen.getByRole("menuitemradio",{name:"外齿轮"}));
  await act(async()=>{ref.current?.click({x:20,y:20},false,1);ref.current?.click({x:60,y:20},false,1);});
  await act(async()=>expect(await ref.current?.flush()).toBe(true));
  expect(props.onCommit).not.toHaveBeenCalled();
  expect(props.onError).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("超出圆形范围");
  expect(screen.getByRole("button",{name:"直线"})).toHaveProperty("disabled",false);
  reject=false;
  fireEvent.click(screen.getByRole("button",{name:/^齿轮$/}));
  await act(async()=>{ref.current?.click({x:20,y:20},false,1);ref.current?.click({x:30,y:20},false,1);});
  await act(async()=>expect(await ref.current?.flush()).toBe(true));
  expect(props.onCommit).toHaveBeenCalledOnce();
});

test("rejected detail text removes the pending overlay and reveals the saved text for editing",async()=>{
  const textScene:CadScene={...scene,entities:[{handle:"T",type:"Text",layer:"0",text:"原文字",height:3,grips:[[20,30]]}]};
  request.mockImplementation(async(method:string)=>method==="pick"?"T":method==="execute"?{rejected:"详图 A 的图形超出圆形范围，原工作稿未改变。"}:textScene);
  const canvas=document.createElementNS("http://www.w3.org/2000/svg","svg");document.body.append(canvas);
  const onTextEditing=vi.fn();
  try {
    const {ref,props}=await setup({getCanvas:()=>canvas,onTextEditing});
    act(()=>ref.current?.cancel());
    await act(async()=>ref.current?.editText({x:20,y:70},1));
    const input=screen.getByRole("textbox",{name:"画布文字"});
    input.textContent="越界的长文字";fireEvent.input(input);
    await act(async()=>fireEvent.keyDown(input,{key:"Enter",ctrlKey:true}));
    await act(async()=>expect(await ref.current?.flush()).toBe(true));
    expect(canvas.querySelector("[data-cad-pending-text]")).toBeNull();
    expect(onTextEditing).toHaveBeenLastCalledWith([]);
    expect(props.onCommit).not.toHaveBeenCalled();
    await act(async()=>ref.current?.editText({x:20,y:70},1));
    expect(screen.getByRole("textbox",{name:"画布文字"}).textContent).toBe("原文字");
  } finally {canvas.remove();}
});
test("gear first press supports drag placement and saving does not lock the next tool",async()=>{
  request.mockImplementation(async(method:string)=>method==="execute"?{bytes,scene,result:{handle:"G",handles:["G"]}}:scene);
  let release!:()=>void;
  const saving=new Promise<void>(resolve=>{release=resolve;});
  const onCommit=vi.fn(async(_bytes:Uint8Array,prepared:(id:string)=>void)=>{
    await saving;prepared("gear-saved");return {bytes,scene,objects:[]};
  });
  const {ref,props}=await setup({onCommit});
  fireEvent.click(screen.getByRole("button",{name:"齿轮选项"}));
  fireEvent.click(screen.getByRole("menuitemradio",{name:"外齿轮"}));
  await act(async()=>{expect(ref.current?.pointDown({x:20,y:20},1,false)).toBe(true);});
  expect(request.mock.calls.filter(c=>c[0]==="execute")).toHaveLength(0);
  await act(async()=>{ref.current?.click({x:60,y:20},false,1);});
  await waitFor(()=>expect(onCommit).toHaveBeenCalled());
  expect(props.onBusy).not.toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button",{name:"直线"}));
  expect(screen.getByRole("button",{name:"直线"}).getAttribute("aria-pressed")).toBe("true");
  await act(async()=>{release();await ref.current?.flush();});
});
test.each([false,true])("spring tool uses top-rail controls and keeps saving nonblocking (extension=%s)",async(extension)=>{
  request.mockImplementation(async(method:string)=>method==="execute"?{bytes,scene,result:{handle:"S",handles:["S"]}}:scene);
  let release!:()=>void;
  const saving=new Promise<void>(resolve=>{release=resolve;});
  const onCommit=vi.fn(async(_bytes:Uint8Array,prepared:(id:string)=>void)=>{
    await saving;prepared("spring-saved");return {bytes,scene,objects:[]};
  });
  const {ref,props}=await setup({onCommit});
  fireEvent.click(screen.getByRole("button",{name:"弹簧选项"}));
  fireEvent.click(screen.getByRole("menuitemradio",{name:extension ? "拉伸弹簧" : "压缩弹簧"}));
  const settings=screen.getByRole("region",{name:extension ? "拉伸弹簧设置" : "弹簧设置"});
  fireEvent.change(within(settings).getByRole("spinbutton",{name:"弹簧线径"}),{target:{value:"2"}});
  await act(async()=>{
    ref.current?.click({x:20,y:20},false,1);
    ref.current?.click({x:extension ? 100 : 60,y:20},false,1);
    ref.current?.click({x:40,y:extension ? 10 : 5},false,1);
  });
  await waitFor(()=>expect(request).toHaveBeenCalledWith("execute","bridge.spring",expect.objectContaining(extension ? {kind:"extension",turns:15,wire:2,width:20,at:[20,80],end:[100,80]} : {turns:6,wire:2,width:30,at:[20,80],end:[60,80]})));
  await waitFor(()=>expect(onCommit).toHaveBeenCalled());
  expect(props.onBusy).not.toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button",{name:"直线"}));
  expect(screen.getByRole("button",{name:"直线"}).getAttribute("aria-pressed")).toBe("true");
  await act(async()=>{release();await ref.current?.flush();});
});
test("unified text uses a multiline in-place surface and commits in the background", async () => {
  request.mockImplementation(async (method: string) => method === "execute" ? { bytes, scene, result: {} } : scene);
  const canvas = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  document.body.append(canvas);
  let release!: () => void;
  const saving = new Promise<void>(resolve => { release = resolve; });
  const onCommit = vi.fn(async (_bytes: Uint8Array, prepared: (id: string) => void) => {
    await saving; prepared("text-saved"); return {bytes, scene, objects: []};
  });
  const {ref, props} = await setup({getCanvas: () => canvas, onCommit});
  fireEvent.click(screen.getByRole("button", {name: "文字"}));
  act(() => ref.current?.click({x:20,y:20},false,1));
  const editor = screen.getByRole("textbox", {name:"画布文字"});
  expect(editor.getAttribute("contenteditable")).toBe("plaintext-only");
  editor.textContent = "第一行\n第二行"; fireEvent.input(editor);
  fireEvent.keyDown(editor, {key:"Enter"});
  expect(onCommit).not.toHaveBeenCalled();
  await act(async () => fireEvent.keyDown(editor, {key:"Enter",ctrlKey:true}));
  expect(request).toHaveBeenCalledWith("execute","bridge.text",expect.objectContaining({at:[20,80],text:"第一行\n第二行",height:10,width:120}));
  expect(props.onBusy).not.toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button",{name:"直线"}));
  expect(screen.getByRole("button",{name:"直线"}).getAttribute("aria-pressed")).toBe("true");
  await act(async () => { release(); await ref.current?.flush(); });
  canvas.remove();
});

test("text placement waits for mouse release and supports a reverse drag width", async () => {
  const canvas = document.createElementNS("http://www.w3.org/2000/svg", "svg"); document.body.append(canvas);
  const {ref} = await setup({getCanvas:()=>canvas});
  fireEvent.click(screen.getByRole("button",{name:"文字"}));
  act(() => ref.current?.pointDown({x:100,y:20},1,false));
  expect(screen.queryByRole("textbox",{name:"画布文字"})).toBeNull();
  act(() => ref.current?.pointUp({x:40,y:40},1,true));
  const editor = screen.getByRole("textbox",{name:"画布文字"});
  expect(editor.parentElement?.getAttribute("width")).toBe("60");
  canvas.remove();
});
test("oversized UTF-8 text stays editable instead of poisoning the save queue",async()=>{
  const canvas=document.createElementNS("http://www.w3.org/2000/svg","svg");document.body.append(canvas);
  const {ref,props}=await setup({getCanvas:()=>canvas});
  fireEvent.click(screen.getByRole("button",{name:"文字"})); act(()=>ref.current?.click({x:20,y:20},false,1));
  const editor=screen.getByRole("textbox",{name:"画布文字"});
  editor.textContent="中".repeat(70_000);fireEvent.input(editor);
  fireEvent.keyDown(editor,{key:"Enter",ctrlKey:true});
  expect(screen.getByRole("textbox",{name:"画布文字"})).toBe(editor);
  expect(props.onCommit).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("过长");
  fireEvent.keyDown(editor,{key:"Escape"});
  await act(async()=>expect(await ref.current?.flush()).toBe(true));canvas.remove();
});
beforeEach(() => {
  for (const key of Object.keys(localStorage)) if (key.startsWith("cad.tool-menu.")) localStorage.removeItem(key);
  localStorage.removeItem("patent-workbench:cad-aids:v1");
  localStorage.removeItem("patent-workbench:cad-hatch-preferences:v1");
  request.mockReset().mockResolvedValue(scene);
  vi.stubGlobal("patentApi", {
    assets: { readDrawingSource: vi.fn().mockResolvedValue({ ok: true, value: bytes }) },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function getTool(name: string): HTMLElement {
  const label = name === "三点圆弧" ? "圆弧" : name === "线性阵列" ? "阵列" : name;
  const existing = screen.queryByRole("button", { name: label });
  if (existing) return existing;
  const menus: Record<string, [string, string]> = {
    正多边形: ["正多边形选项", "正多边形 · 内接于圆"],
    倒角: ["圆角选项", "倒角"], 延伸: ["修剪选项", "延伸"],
    圆周阵列: ["阵列选项", "环形阵列"],
  };
  const item = menus[name]!;
  fireEvent.click(screen.getByRole("button", { name: item[0] }));
  return screen.getByRole("menuitemradio", { name: item[1] });
}
test("polygon is independent and rectangles expose four methods and top settings", async () => {
  await setup();
  expect(screen.getByRole("button", {name:"正多边形"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"矩形选项"}));
  expect(screen.getAllByRole("menuitemradio").map(item=>item.textContent)).toEqual([
    "两点矩形","中心矩形","三点矩形","中心倾斜矩形",
  ]);
  fireEvent.click(screen.getByRole("menuitemradio",{name:"中心矩形"}));
  expect(screen.getByRole("combobox",{name:"角部样式"})).toBeTruthy();
  expect(screen.getByRole("checkbox",{name:"正方形"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"正多边形"}));
  expect(screen.getByRole("region",{name:"正多边形设置"})).toBeTruthy();
});
test("center rectangle captures mouse-down, previews locally and commits its final corners once", async () => {
  request.mockImplementation(async(method:string)=>method==="execute"?{bytes,scene}:scene);
  const {ref,props}=await setup();
  fireEvent.click(screen.getByRole("button",{name:"矩形选项"}));
  fireEvent.click(screen.getByRole("menuitemradio",{name:"中心矩形"}));
  let drag=false;
  act(()=>{drag=ref.current!.pointDown({x:60,y:60},0,false);});
  expect(drag).toBe(true);
  act(()=>ref.current!.hover({x:80,y:70},0,false));
  const preview=vi.mocked(props.onPreview).mock.lastCall?.[0];
  expect(preview?.curvePaths?.[0]).toEqual([
    {x:40,y:30},{x:80,y:30},{x:80,y:50},{x:40,y:50},{x:40,y:30},
  ]);
  expect(request.mock.calls.filter(c=>c[1]==="bridge.preview_draw")).toHaveLength(0);
  await act(async()=>{
    ref.current!.click({x:80,y:70},false,0);
    ref.current!.click({x:90,y:80},false,0);
    await ref.current!.flush();
  });
  expect(request).toHaveBeenCalledWith("execute","rectang",{p1:[40,50],p2:[80,30]});
  expect(props.onCommit).toHaveBeenCalledOnce();
});
test("tilted rectangle previews corner changes, rejects invalid corners and cancels without saving",async()=>{
  const {ref,props}=await setup();
  fireEvent.click(screen.getByRole("button",{name:"矩形选项"}));
  fireEvent.click(screen.getByRole("menuitemradio",{name:"三点矩形"}));
  act(()=>{ref.current!.click({x:60,y:60},false,0);ref.current!.click({x:90,y:60},false,0);});
  fireEvent.change(screen.getByRole("combobox",{name:"角部样式"}),{target:{value:"round"}});
  fireEvent.change(screen.getByRole("spinbutton",{name:"矩形圆角半径"}),{target:{value:"2"}});
  act(()=>ref.current!.hover({x:90,y:80},0,false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.curvePaths?.[0]?.length).toBeGreaterThan(20);
  fireEvent.change(screen.getByRole("spinbutton",{name:"矩形圆角半径"}),{target:{value:"20"}});
  act(()=>ref.current!.click({x:90,y:80},false,0));
  expect(screen.getByRole("status").textContent).toContain("一半");
  expect(props.onCommit).not.toHaveBeenCalled();
  act(()=>ref.current!.cancel());
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toBeNull();
  expect(props.onCommit).not.toHaveBeenCalled();
});
test("alternate circle clicks commit once even with a rapid extra click", async () => {
  request.mockImplementation(async (method: string) => method === "execute" ? {bytes,scene} : scene);
  const {ref,props}=await setup();
  fireEvent.click(screen.getByRole("button",{name:"圆选项"}));
  fireEvent.click(screen.getByRole("menuitemradio",{name:"两点"}));
  await act(async()=>{
    ref.current?.click({x:10,y:10},false,1);
    ref.current?.click({x:40,y:30},false,1);
    ref.current?.click({x:50,y:50},false,1);
  });
  await waitFor(()=>expect(props.onCommit).toHaveBeenCalledTimes(1));
  expect(request).toHaveBeenCalledWith("execute","circle",{p1:[10,90],p2:[40,70]});
  expect(screen.queryByRole("group",{name:"两点设置"})).toBeNull();
});
test("cancelling while an alternate draw validation is pending cannot commit", async () => {
  let resolve!: (value: CadScene)=>void;
  const validation=new Promise<CadScene>(r=>{resolve=r;});
  request.mockImplementation(async(method:string,command:string)=>command === "bridge.preview_draw" ? validation : method === "execute" ? {bytes,scene}:scene);
  const {ref,props}=await setup();
  fireEvent.click(screen.getByRole("button",{name:"圆选项"}));
  fireEvent.click(screen.getByRole("menuitemradio",{name:"两点"}));
  await act(async()=>{ref.current?.click({x:10,y:10},false,1);ref.current?.click({x:40,y:30},false,1);});
  act(()=>ref.current?.cancel());
  await act(async()=>{resolve(scene);});
  expect(props.onCommit).not.toHaveBeenCalled();
});
test("every CAD dropdown shows its running method and restores the primary on cancellation", async () => {
  const {ref} = await setup();
  for (const name of ["圆", "圆弧", "椭圆", "矩形", "正多边形", "阵列", "修剪", "圆角", "齿轮", "弹簧"]) {
    const main = screen.getByRole("button", {name});
    const original = {icon:main.querySelector("svg")?.innerHTML,title:main.getAttribute("title"),text:main.textContent};
    fireEvent.click(screen.getByRole("button", {name: `${name}选项`}));
    const items = screen.getAllByRole("menuitemradio");
    const diagrams = items.map(item => item.querySelector("svg")?.innerHTML);
    expect(new Set(diagrams).size).toBe(items.length);
    const last = items.at(-1)!;
    const diagram = last.querySelector("svg")?.innerHTML;
    fireEvent.click(last);
    expect(screen.getByRole("button", {name:`${name}选项`}).previousElementSibling?.querySelector("svg")?.innerHTML).toBe(diagram);
    act(()=>ref.current?.cancel());
    const unchanged = screen.getByRole("button", {name});
    expect(unchanged.querySelector("svg")?.innerHTML).toBe(original.icon);
    expect(unchanged.getAttribute("title")).toBe(original.title);
    expect(unchanged.textContent).toBe(original.text);
  }
});

test("switching from a menu method to another tool restores its default button", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button",{name:"圆选项"}));
  fireEvent.click(screen.getByRole("menuitemradio",{name:"两点"}));
  expect(screen.getByRole("button",{name:"两点"}).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button",{name:"直线"}));
  expect(screen.getByRole("button",{name:"圆"}).getAttribute("aria-description")).toBe("圆 · 圆心、半径");
});
test("explode starts before selection, confirms with Enter and saves without blocking the next tool", async () => {
  const rectangle = {...scene,entities:[{handle:"A",type:"LwPolyline",layer:"0"}]};
  request.mockImplementation(async(method:string)=>method==="pick"?"A":method==="execute"?{bytes,scene:rectangle,result:{changed:true,exploded:1,handles:["B","C","D","E"],skipped:[]}}:rectangle);
  let release!:()=>void;
  const saving=new Promise<void>(resolve=>{release=resolve;});
  const onCommit=vi.fn(async(_bytes:Uint8Array,prepared:(id:string)=>void)=>{await saving;prepared("saved");return {bytes,objects:[],scene:rectangle};});
  const {ref,props}=await setup({onCommit});
  act(()=>ref.current?.cancel());
  const button=screen.getByRole("button",{name:"分解"});
  expect(button).toHaveProperty("disabled",false);
  fireEvent.click(button);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  await act(async()=>{ref.current?.click({x:20,y:20},false,1);ref.current?.finish();});
  await waitFor(()=>expect(onCommit).toHaveBeenCalledTimes(1));
  expect(props.onBusy).not.toHaveBeenCalledWith(true);
  expect(screen.getByRole("status").textContent).toContain("分解");
  fireEvent.click(screen.getByRole("button",{name:"直线"}));
  expect(screen.getByRole("button",{name:"直线"}).getAttribute("aria-pressed")).toBe("true");
  await act(async()=>{release();await ref.current?.flush();});
});
test("unsupported explode selections do not save or enter history", async()=>{
  request.mockImplementation(async(method:string)=>method==="pick"?"A":method==="execute"?{bytes,scene,result:{changed:false,exploded:0,handles:[],skipped:[{handle:"A",reason:"单一对象"}]}}:scene);
  const {ref,props}=await setup();act(()=>ref.current?.cancel());
  await act(async()=>ref.current?.click({x:20,y:20},false,1));
  fireEvent.click(screen.getByRole("button",{name:"分解"}));
  await act(async()=>{await ref.current?.flush();});
  expect(props.onCommit).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("无法分解");
});
test("a no-op queued behind explode adopts the durable checkpoint without another save", async()=>{
  let operations=0;
  const durable=new Uint8Array([9]);
  request.mockImplementation(async(method:string)=>method==="pick"?"A":method==="execute"?{bytes,scene,result:++operations===1?{changed:true,exploded:1,handles:["X"],skipped:[]}:{changed:false,exploded:0,handles:[],skipped:[{handle:"A"}]}}:scene);
  let release!:()=>void;const saving=new Promise<void>(resolve=>{release=resolve;});
  const onCommit=vi.fn(async(_bytes:Uint8Array,prepared:(id:string)=>void)=>{await saving;prepared("durable");return {bytes:durable,objects:[],scene};});
  const {ref}=await setup({onCommit});act(()=>ref.current?.cancel());
  await act(async()=>ref.current?.click({x:20,y:20},false,1));
  fireEvent.click(screen.getByRole("button",{name:"分解"}));
  await waitFor(()=>expect(onCommit).toHaveBeenCalledOnce());
  await act(async()=>ref.current?.click({x:20,y:20},false,1));
  fireEvent.click(screen.getByRole("button",{name:"分解"}));
  await waitFor(()=>expect(operations).toBe(2));
  await act(async()=>{release();await ref.current?.flush();});
  expect(onCommit).toHaveBeenCalledOnce();
  expect(request).toHaveBeenLastCalledWith("restore",durable,"durable");
});
test("explode preserves native objects backing patent labels",async()=>{
  const project=drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad={version:1,engine:"cadcraft",engineVersion:"a".repeat(40),assetId:project.sourceAssetId,unified:1,mapping:{originX:0,originY:100,scale:1},objects:[{id:"a1",kind:"label",label:["A"]}]};
  request.mockImplementation(async(method:string)=>method==="pick"?"A":scene);
  const {ref,props}=await setup({project});act(()=>ref.current?.cancel());
  await act(async()=>ref.current?.click({x:20,y:20},false,1));
  fireEvent.click(screen.getByRole("button",{name:"分解"}));
  await act(async()=>{await ref.current?.flush();});
  expect(props.onCommit).not.toHaveBeenCalled();
  expect(request.mock.calls.some(call=>call[0]==="execute")).toBe(false);
  expect(screen.getByRole("status").textContent).toContain("不能直接分解");
});
test("all CAD tools are grouped as drawing and editing with names under their icons", async () => {
  await setup();
  expect(screen.queryByRole("combobox", { name: "CAD更多工具" })).toBeNull();
  expect(screen.queryByText(/悬停节点获取追踪/u)).toBeNull();
  const drawing = screen.getByRole("group", { name: "绘图" });
  const editing = screen.getByRole("group", { name: "修改" });
  expect(within(drawing).getAllByRole("button")).toHaveLength(19);
  expect(within(editing).getAllByRole("button")).toHaveLength(19);
  for (const name of ["删除", "合并线段", "编组", "取消编组"]) {
    expect(within(editing).getByRole("button", { name })).toHaveProperty("disabled", true);
  }
  expect(screen.queryByRole("button", { name: /^选择$/ })).toBeNull();
  for (const name of ["线性标注", "对齐标注", "半径标注", "多段线"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  expect(within(editing).getByRole("button", { name: "修剪" })).toBeTruthy();
  const labels = [
    "直线",
    "矩形",
    "圆",
    "文字",
    "样条曲线",
    "三点圆弧",
    "椭圆",
    "正多边形",
    "镜像",
    "修剪",
    "延伸",
    "圆角",
    "倒角",
  ];
  for (const label of labels) {
    const button = getTool(label);
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.querySelector("span")?.textContent).toContain(label === "三点圆弧" ? "圆弧" : label);
    fireEvent.click(button);
    const primary = label === "三点圆弧" ? "圆弧" : label;
    expect(screen.getByRole("button", {name:primary}).getAttribute("aria-pressed")).toBe("true");
  }
  expect((screen.getByRole("button", { name: "移动" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button", { name: "复制" }) as HTMLButtonElement).disabled).toBe(false);
});

test("parameter entry keeps focus until Enter or Escape returns it to the canvas", async () => {
  const canvas = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  canvas.setAttribute("tabindex", "0");
  document.body.append(canvas);
  try {
    await setup({ getCanvas: () => canvas });
    fireEvent.click(getTool("正多边形"));
    const input = screen.getByRole("spinbutton", { name: "边数" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "6" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.activeElement).toBe(canvas);
    expect(screen.getByRole("button", {name:"正多边形"}).getAttribute("aria-pressed")).toBe("true");
    act(() => input.focus());
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).toBe(canvas);
    expect(screen.getByRole("button", {name:"矩形"}).getAttribute("aria-pressed")).toBe("false");
  } finally {
    canvas.remove();
  }
});

test("leaving a CAD tool shows the default selection guidance without a selection button", async () => {
  const { ref } = await setup();
  act(() => ref.current?.cancel());
  expect(screen.getByRole("status").querySelector("strong")?.textContent).toBe("选择对象");
  expect(screen.queryByRole("button", { name: /^选择$/ })).toBeNull();
});

test("Enter confirms every picked hatch region instead of cancelling the tool", async () => {
  request.mockImplementation(async (method: string, command: string) =>
    method === "execute"
      ? { bytes, scene, result: {} }
      : command === "hatch.patterns"
        ? { standard: ["ANSI31"], user: [] }
        : scene,
  );
  const { ref } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "剖面填充" }));
  act(() => {
    ref.current?.click({ x: 20, y: 20 }, false, 1);
  });
  act(() => {
    ref.current?.click({ x: 60, y: 40 }, false, 1);
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "应用" })).toHaveProperty("disabled", false),
  );
  act(() => ref.current?.finish());
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "execute",
      "hatch",
      expect.objectContaining({
        points: [
          [20, 80],
          [60, 60],
        ],
      }),
    ),
  );
});

test("right-click ends a line and repeats it with fresh points", async () => {
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene, result: {} } : scene,
  );
  const { ref } = await setup();
  act(() => ref.current?.click({ x: 20, y: 20 }, false, 1));
  await act(async () => ref.current?.click({ x: 40, y: 20 }, false, 1));
  act(() => ref.current?.rightClick());
  expect(screen.getByRole("button", { name: "直线" }).getAttribute("aria-pressed")).toBe("false");
  act(() => ref.current?.rightClick());
  expect(screen.getByRole("button", { name: "直线" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "闭合" })).toHaveProperty("disabled", true);
  const count = request.mock.calls.filter(([method]) => method === "execute").length;
  act(() => ref.current?.click({ x: 60, y: 40 }, false, 1));
  expect(request.mock.calls.filter(([method]) => method === "execute")).toHaveLength(count);
});

test("right-click exits an empty modify command but confirms a pending picked target", async () => {
  let release: (handle: string) => void = () => {};
  request.mockImplementation(async (method: string) =>
    method === "pick"
      ? new Promise<string>((resolve) => {
          release = resolve;
        })
      : scene,
  );
  const { ref } = await setup();
  const move = screen.getByRole("button", { name: "移动" });
  fireEvent.click(move);
  act(() => ref.current?.rightClick());
  expect(move.getAttribute("aria-pressed")).toBe("false");
  act(() => ref.current?.rightClick());
  expect(move.getAttribute("aria-pressed")).toBe("true");
  act(() => {
    ref.current?.click({ x: 20, y: 10 }, false, 1);
    ref.current?.rightClick();
  });
  await act(async () => release("A"));
  expect(ref.current?.isCommandPicking()).toBe(false);
  expect(screen.getByText("选择操作基点。")).toBeTruthy();
  act(() => ref.current?.rightClick());
  expect(move.getAttribute("aria-pressed")).toBe("false");
});

test("right-click finishes a spline once before repeating an empty curve", async () => {
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene, result: {} } : scene,
  );
  const { ref } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "样条曲线" }));
  act(() => ref.current?.click({ x: 10, y: 10 }, false, 1));
  act(() => ref.current?.click({ x: 20, y: 30 }, false, 1));
  await act(async () => ref.current?.rightClick());
  expect(
    request.mock.calls.filter(([method, command]) => method === "execute" && command === "spline"),
  ).toHaveLength(1);
  act(() => ref.current?.rightClick());
  expect(screen.getByRole("button", { name: "样条曲线" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(screen.getByRole("button", { name: /完成绘制/ })).toHaveProperty("disabled", true);
});

test("the text menu preserves its draft until canvas right-click commits it once", async () => {
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene, result: {} } : scene,
  );
  const canvas = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  Object.defineProperty(canvas, "viewBox", { value: { baseVal: { width: 100 } } });
  document.body.append(canvas);
  const { ref } = await setup({ getCanvas: () => canvas });
  fireEvent.click(screen.getByRole("button", { name: "文字" }));
  act(() => ref.current?.click({ x: 100, y: 100 }, false, 1));
  const input = screen.getByRole("textbox", { name: "画布文字" });
  input.textContent="保留文字"; fireEvent.input(input);
  expect(fireEvent.contextMenu(input)).toBe(true);
  expect(input.textContent).toBe("保留文字");
  await act(async () => ref.current?.rightClick());
  expect(request).toHaveBeenCalledWith("execute", "bridge.text", {
    at: [100, 0],
    text: "保留文字",
    height: 10,
    width:120,
  });
  expect(request.mock.calls.filter(([method]) => method === "execute")).toHaveLength(1);
  canvas.remove();
});

test("right-click applies a ready array preview before repeating the tool", async () => {
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene, result: {} } : scene,
  );
  const { ref } = await setup();
  act(() => ref.current?.cancel());
  act(() => ref.current?.selectHandles(["A"]));
  fireEvent.click(getTool("线性阵列"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "应用" })).toHaveProperty("disabled", false),
  );
  await act(async () => ref.current?.rightClick());
  expect(request).toHaveBeenCalledWith(
    "execute",
    "arrayrect",
    expect.objectContaining({ handles: ["A"] }),
  );
});

test.each([
  ["线性阵列", "arrayrect", "列数", "4", { cols: 4 }],
  ["圆周阵列", "arraypolar", "分布角度（°）", "180", { angle: 180 }],
  ["路径阵列", "arraypath", "项目数（含源对象）", "4", { count: 4 }],
  ["剖面填充", "hatch", "填充角度（°）", "45", { angle: 45 }],
] as const)("Enter in portalled %s fields applies the latest draft once", async (tool, command, label, value, expected) => {
  request.mockImplementation(async (method: string, name: string) =>
    method === "execute" ? { bytes, scene, result: {} }
      : method === "pick" ? "PATH"
        : name === "hatch.patterns" ? { standard: ["ANSI31"], user: [] } : scene,
  );
  const target = document.createElement("div");
  document.body.append(target);
  const { ref, props, view } = await setup({ settingsTarget: target });
  try {
    act(() => { ref.current?.cancel(); ref.current?.selectHandles(["A"]); });
    if (tool === "路径阵列") {
      fireEvent.click(screen.getByRole("button", { name: "阵列选项" }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "路径阵列" }));
    } else fireEvent.click(getTool(tool));
    if (command !== "arrayrect") await act(async () => ref.current?.click({ x: 60, y: 40 }, false, 1));
    await waitFor(() => expect(screen.getByRole("button", { name: "应用" })).toHaveProperty("disabled", false));
    const input = screen.getByRole("spinbutton", { name: label });
    expect(target.contains(input)).toBe(true);
    expect(view.container.contains(input)).toBe(false);
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyUp(input, { key: "Enter" });
    await waitFor(() => expect(request).toHaveBeenCalledWith("execute", command, expect.objectContaining(expected)));
    await act(async () => { await ref.current?.flush(); });
    expect(request.mock.calls.filter(([method]) => method === "execute")).toHaveLength(1);
    expect(props.onCommit).toHaveBeenCalledOnce();
  } finally { view.unmount(); target.remove(); }
});

test("portalled pattern Enter respects composing, modifiers, invalid drafts and disabled controls", async () => {
  request.mockImplementation(async (method: string) => method === "execute" ? { bytes, scene } : scene);
  const target = document.createElement("div");
  document.body.append(target);
  const { ref, props, view } = await setup({ settingsTarget: target });
  try {
    act(() => { ref.current?.cancel(); ref.current?.selectHandles(["A"]); });
    fireEvent.click(getTool("线性阵列"));
    await waitFor(() => expect(screen.getByRole("button", { name: "应用" })).toHaveProperty("disabled", false));
    const input = screen.getByRole("spinbutton", { name: "列数" });
    for (const options of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { repeat: true }])
      fireEvent.keyDown(input, { key: "Enter", ...options });
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveProperty("value", "0");
    fireEvent.change(input, { target: { value: "4" } });
    await act(async () => view.rerender(<CadEditingPanel {...props} disabled />));
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => { await ref.current?.flush(); });
    expect(request.mock.calls.filter(([method]) => method === "execute")).toHaveLength(0);
    expect(props.onCommit).not.toHaveBeenCalled();
  } finally { view.unmount(); target.remove(); }
});

test("Enter in the portalled hatch strategy select applies without a canvas refocus", async () => {
  request.mockImplementation(async (method: string, command: string) => method === "execute" ? { bytes, scene }
    : command === "hatch.patterns" ? { standard: ["ANSI31"], user: [] } : scene);
  const target = document.createElement("div");
  document.body.append(target);
  const { ref, view } = await setup({ settingsTarget: target });
  try {
    fireEvent.click(getTool("剖面填充"));
    act(() => ref.current?.click({ x: 60, y: 40 }, false, 1));
    await waitFor(() => expect(screen.getByRole("button", { name: "应用" })).toHaveProperty("disabled", false));
    const select = screen.getByRole("combobox", { name: "填充策略" });
    fireEvent.change(select, { target: { value: "outer" } });
    fireEvent.keyDown(select, { key: "Enter" });
    await waitFor(() => expect(request).toHaveBeenCalledWith("execute", "hatch", expect.objectContaining({ style: "outer" })));
  } finally { view.unmount(); target.remove(); }
});

test("the shared detail tool joins the modification group and owns its active instruction and controls", async () => {
  const { view } = await setup({
    enabled: false,
    detailTool: {
      button: (
        <button type="button" aria-pressed="true">
          局部放大
        </button>
      ),
      active: true,
      hint: "点击取图圆心。",
      controls: (
        <label>
          局部放大比例
          <input defaultValue="2:1" />
        </label>
      ),
    },
  });
  const drawing = screen.getByRole("group", { name: "绘图" });
  const modification = screen.getByRole("group", { name: "修改" });
  expect(within(modification).getByRole("button", { name: "局部放大" })).toBeTruthy();
  expect(view.container.querySelector(".cad-instruction-card")?.textContent).toContain(
    "点击取图圆心。",
  );
  expect(view.container.querySelector(".cad-instruction-card strong")?.textContent).toBe(
    "局部放大",
  );
  expect(screen.getByRole("textbox", { name: "局部放大比例" })).toHaveProperty("value", "2:1");
  expect(view.container.querySelector(".cad-editing-panel")?.firstElementChild).toBe(
    screen.getByRole("textbox", { name: "局部放大比例" }).parentElement,
  );
  expect(
    screen.getByRole("textbox", { name: "局部放大比例" }).compareDocumentPosition(drawing) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "闭合" })).toBeNull();
});

test("polygon side count appears in a top contextual panel and survives tool switching", async () => {
  const { view } = await setup();
  fireEvent.click(getTool("正多边形"));
  const panel = screen.getByRole("region", { name: "正多边形设置" });
  expect(view.container.querySelector(".cad-editing-panel")?.firstElementChild).toBe(panel);
  const sides = within(panel).getByRole("spinbutton", { name: "边数" }) as HTMLInputElement;
  expect(sides.min).toBe("3");
  expect(sides.max).toBe("20");
  expect(sides.step).toBe("1");
  fireEvent.change(sides, { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "圆" }));
  fireEvent.click(getTool("正多边形"));
  expect((screen.getByRole("spinbutton", { name: "边数" }) as HTMLInputElement).value).toBe("5");
});

test("canvas settings do not reset the function rail scroll position", async () => {
  const { view } = await setup();
  view.container.classList.add("patent-global-function-rail");
  view.container.scrollTop = 400;
  fireEvent.click(getTool("正多边形"));
  expect(view.container.scrollTop).toBe(400);
});

test("tool and detail settings portal into the canvas without moving the permanent tools", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const { view, ref } = await setup({ settingsTarget: target });
  try {
    fireEvent.click(getTool("正多边形"));
    const settings = screen.getByRole("dialog", { name: "正多边形设置" });
    expect(target.contains(settings)).toBe(true);
    expect(view.container.querySelector(".cad-tool-settings")).toBeNull();
    expect(view.container.querySelector(".cad-tool-group")).not.toBeNull();
    fireEvent.change(within(settings).getByRole("spinbutton", { name: "边数" }), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(getTool("矩形").getAttribute("aria-pressed")).toBe("false");
    act(() => ref.current?.cancel());
    fireEvent.click(getTool("正多边形"));
    expect(screen.getByRole("spinbutton", { name: "边数" })).toHaveProperty("value", "6");
    fireEvent.click(getTool("线性阵列"));
    expect(target.querySelector(".cad-pattern-panel")).not.toBeNull();
    expect(view.container.querySelector(".cad-pattern-panel")).toBeNull();
  } finally { view.unmount(); target.remove(); }
});

test("text height stays independent from polygon side count and appears above the tool grid", async () => {
  const { view } = await setup();
  fireEvent.click(getTool("正多边形"));
  fireEvent.change(screen.getByRole("spinbutton", { name: "边数" }), {
    target: { value: "7" },
  });
  fireEvent.click(screen.getByRole("button", { name: "文字" }));
  const panel = screen.getByRole("region", { name: "文字设置" });
  expect(view.container.querySelector(".cad-editing-panel")?.firstElementChild).toBe(panel);
  expect((within(panel).getByRole("spinbutton", { name: "字号" }) as HTMLInputElement).value).toBe(
    "10",
  );
  fireEvent.change(within(panel).getByRole("spinbutton", { name: "字号" }), {
    target: { value: "12" },
  });
  fireEvent.click(getTool("正多边形"));
  expect((screen.getByRole("spinbutton", { name: "边数" }) as HTMLInputElement).value).toBe("7");
  fireEvent.click(screen.getByRole("button", { name: "文字" }));
  expect((screen.getByRole("spinbutton", { name: "字号" }) as HTMLInputElement).value).toBe("12");
});

test("invalid polygon side count keeps the center point for correction", async () => {
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene, result: {} } : scene,
  );
  const { ref, props } = await setup();
  fireEvent.click(getTool("正多边形"));
  fireEvent.change(screen.getByRole("spinbutton", { name: "边数" }), {
    target: { value: "2" },
  });
  act(() => ref.current?.click({ x: 20, y: 20 }, false, 1));
  act(() => ref.current?.click({ x: 50, y: 20 }, false, 1));
  expect(props.onError).toHaveBeenCalled();
  fireEvent.change(screen.getByRole("spinbutton", { name: "边数" }), {
    target: { value: "5" },
  });
  await act(async () => ref.current?.click({ x: 50, y: 20 }, false, 1));
  expect(request).toHaveBeenCalledWith("execute", "polygon", {
    sides: 5,
    center: [20, 80],
    radius: 30,
    angle: 0,
  });
});

test("each numeric modification setting opens above the CAD tool groups with its own label", async () => {
  const { view } = await setup();
  for (const [tool, setting, field] of [
    ["圆角", "圆角设置", "圆角半径"],
    ["倒角", "倒角设置", "倒角大小"],
  ] as const) {
    fireEvent.click(getTool(tool));
    const panel = screen.getByRole("region", { name: setting });
    expect(view.container.querySelector(".cad-editing-panel")?.firstElementChild).toBe(panel);
    expect(within(panel).getByRole("spinbutton", { name: field })).toBeTruthy();
  }
});

test("line completion controls appear at the top when the line tool is active", async () => {
  const { view } = await setup();
  const panel = screen.getByRole("region", { name: "直线设置" });
  expect(view.container.querySelector(".cad-editing-panel")?.firstElementChild).toBe(panel);
  expect(within(panel).getByRole("button", { name: "闭合" })).toBeTruthy();
});

test("ordinary CAD picks accumulate and Shift picks remove without toggling additions", async () => {
  let picked = "B";
  const twoObjects = {
    ...scene,
    entities: [...scene.entities, { handle: "B", type: "Line", layer: "0" }],
  };
  request.mockImplementation(async (method: string) => (method === "pick" ? picked : twoObjects));
  const { ref, props } = await setup();
  act(() => ref.current?.cancel());
  act(() => ref.current?.selectHandles(["A"]));
  await act(async () => ref.current?.click({ x: 80, y: 80 }, false, 1));
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["A", "B"]);
  picked = "A";
  await act(async () => ref.current?.click({ x: 80, y: 80 }, true, 1));
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["B"]);
});

test("move can start before selection and confirms canvas picks before its base point", async () => {
  request.mockImplementation(async (method: string) => (method === "pick" ? "A" : scene));
  const { ref, props } = await setup();
  const move = screen.getByRole("button", { name: "移动" });
  expect((move as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(move);
  await act(async () => ref.current?.click({ x: 20, y: 10 }, false, 1));
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["A"]);
  act(() => ref.current?.finish());
  act(() => ref.current?.pointDown({ x: 100, y: 100 }, 1, false));
  act(() => ref.current?.hover({ x: 120, y: 140 }, 1, false));
  const preview = vi.mocked(props.onPreview).mock.lastCall?.[0];
  expect(preview?.mode).toBe("move");
  expect(preview?.anchor).toEqual({ x: 100, y: 0 });
});
test.each([["合并线段", "join"], ["编组", "group"], ["取消编组", "ungroup"]])("%s does not lock tools behind checkpoint persistence", async (label, command) => {
  const multiple = {...scene, entities: [...scene.entities, {handle:"B",type:"Line",layer:"0"}], groups:[{name:"G",selectable:true,members:["A","B"]}]};
  request.mockImplementation(async (method:string)=>method === "execute" ? {bytes,scene:multiple,result:{}} : multiple);
  let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;});
  const onCommit=vi.fn(async(_bytes:Uint8Array,prepared:(id:string)=>void)=>{await gate;prepared("saved");return {bytes,scene:multiple,objects:[]};});
  const {ref,props}=await setup({onCommit});
  act(()=>ref.current?.selectHandles(["A","B"]));
  fireEvent.click(screen.getByRole("button",{name:label}));
  try {
    await waitFor(()=>expect(onCommit).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("execute",command,{handles:["A","B"]});
    expect(props.onBusy).not.toHaveBeenCalledWith(true);
    expect(screen.getByRole("button",{name:label})).toHaveProperty("disabled",false);
    fireEvent.click(screen.getByRole("button",{name:"直线"}));
    expect(screen.getByRole("button",{name:"直线"}).getAttribute("aria-pressed")).toBe("true");
  } finally {await act(async()=>{release();await ref.current?.flush();});}
});

test("clipboard reuse and paste remain interactive while preserving an ordered save barrier", async()=>{
  request.mockImplementation(async(method:string)=>method === "export" ? bytes : method === "paste" ? {bytes,scene,result:{handles:["A"]}} : scene);
  let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;});
  const onCommit=vi.fn(async(_bytes:Uint8Array,prepared:(id:string)=>void)=>{await gate;prepared("pasted");return {bytes,scene,objects:[]};});
  const {ref,props}=await setup({onCommit});
  act(()=>ref.current?.selectHandles(["A"]));
  await act(async()=>ref.current?.copySelected());
  expect(request.mock.calls.filter(c=>c[0]==="export")).toHaveLength(0);
  act(()=>ref.current?.pasteSelected());
  await act(async()=>ref.current?.click({x:30,y:25},false,1));
  try {
    await waitFor(()=>expect(onCommit).toHaveBeenCalledOnce());
    expect(props.onBusy).not.toHaveBeenCalledWith(true);
    let flushed=false;
    const flushing=ref.current!.flush().then(()=>{flushed=true;});
    await Promise.resolve(); expect(flushed).toBe(false);
    fireEvent.click(screen.getByRole("button",{name:"直线"}));
    expect(screen.getByRole("button",{name:"直线"}).getAttribute("aria-pressed")).toBe("true");
    await act(async()=>{release();await flushing;});
  } finally {await act(async()=>{release();await ref.current?.flush();});}
});

test("slow checkpoint acceptance never occupies geometry and retries without materializing or re-editing",async()=>{
  const snapshot={source:bytes,edits:[{command:"move",params:{handles:["A"],delta:[20,-20]}}]};
  let release!:(value:Uint8Array)=>void;
  const gate=new Promise<Uint8Array>(resolve=>{release=resolve;});
  let commits=0;
  request.mockImplementation(async(method:string)=>{
    if(method==="execute")return {checkpoint:snapshot,scene,result:{}};
    return scene;
  });
  const onCommit=vi.fn(async(_data: unknown, prepared: (id:string)=>void)=>{
    if(++commits===1) {await gate;throw Error("snapshot failure");}
    prepared(`accepted-${commits}`);
    return {bytes:snapshot,scene,objects:[]};
  });
  const {ref,props}=await setup({onCommit});
  try {
    act(()=>ref.current?.selectHandles(["A"]));
    for(let i=0;i<2;i++) {
      fireEvent.click(screen.getByRole("button",{name:"移动"}));
      act(()=>ref.current?.click({x:20,y:10},false,1));
      act(()=>ref.current?.click({x:40,y:30},false,1));
      await waitFor(()=>expect(request.mock.calls.filter(c=>c[0]==="execute")).toHaveLength(i+1));
      await waitFor(()=>expect(screen.getByRole("button",{name:"移动"})).toHaveProperty("disabled",false));
    }
    expect(props.onCommit).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(c=>c[0]==="materialize")).toBe(false);
    expect(props.onBusy).not.toHaveBeenCalledWith(true);
    await act(async()=>{release(bytes);});
    await waitFor(()=>expect(props.onError).toHaveBeenCalledWith(expect.stringContaining("snapshot failure")));
    await act(async()=>expect(await ref.current?.flush()).toBe(true));
    expect(props.onCommit).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.filter(c=>c[0]==="execute")).toHaveLength(2);
  }finally{await act(async()=>{release(bytes);await ref.current?.flush();});}
});

test("drawing inside a detail saves in background and retains generated body membership",async()=>{
  const added={...scene,entities:[...scene.entities,{handle:"B",type:"Line",layer:"0"}]};
  request.mockImplementation(async(method:string)=>method==="execute"?{bytes,scene:added,result:{}}:scene);
  const project=drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad={version:1,engine:"cadcraft",engineVersion:"a".repeat(40),assetId:project.sourceAssetId,unified:1,mapping:{originX:0,originY:100,scale:1},objects:[{id:"detail",kind:"detail",body:["A"]}]};
  let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;});
  const onCommit=vi.fn(async(_bytes:Uint8Array,prepared:(id:string)=>void)=>{await gate;prepared("detail");return {bytes,scene:added,objects:project.cad!.objects!};});
  const {ref,props}=await setup({project,onCommit});
  act(()=>ref.current?.editDetail("detail"));
  fireEvent.click(screen.getByRole("button",{name:"直线"}));
  act(()=>ref.current?.click({x:20,y:10},false,1));
  act(()=>ref.current?.click({x:40,y:30},false,1));
  try {
    await waitFor(()=>expect(onCommit).toHaveBeenCalledOnce());
    expect(props.onBusy).not.toHaveBeenCalledWith(true);
    expect((onCommit.mock.calls[0] as unknown as [unknown,unknown,typeof project])[2].cad!.objects![0]!.body).toEqual(["A","B"]);
  } finally {await act(async()=>{release();await ref.current?.flush();});}
});

test("move publishes geometry and accepts another tool while checkpoint save is pending", async () => {
  request.mockImplementation(async (method: string) => method === "execute" ? {bytes,scene,result:{}} : scene);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => {release=resolve;});
  const onCommit=vi.fn(async (_bytes: Uint8Array, prepared: (id:string)=>void)=>{await waiting;prepared("moved");return {bytes,scene,objects:[]};});
  const {ref,props}=await setup({onCommit});
  act(()=>ref.current?.selectHandles(["A"]));
  fireEvent.click(screen.getByRole("button",{name:"移动"}));
  act(()=>ref.current?.click({x:20,y:10},false,1));
  act(()=>ref.current?.click({x:40,y:30},false,1));
  try {
    await waitFor(()=>expect(onCommit).toHaveBeenCalledOnce());
    expect(props.onBusy).not.toHaveBeenCalledWith(true);
    expect(screen.getByRole("button",{name:"移动"})).toHaveProperty("disabled",false);
    fireEvent.click(screen.getByRole("button",{name:"直线"}));
    expect(screen.getByRole("button",{name:"直线"}).getAttribute("aria-pressed")).toBe("true");
  } finally { await act(async()=>{release();await ref.current?.flush();}); }
});
test("consecutive moves retain cumulative patent label metadata while the first save is pending", async () => {
  request.mockImplementation(async (method:string)=>method === "execute" ? {bytes,scene,result:{}} : scene);
  const project=drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad={version:1,engine:"cadcraft",engineVersion:"a".repeat(40),assetId:project.sourceAssetId,unified:1,mapping:{originX:0,originY:100,scale:1},objects:[{id:"a1",kind:"label",label:["A"]}]};
  let release!:()=>void; const waiting=new Promise<void>(resolve=>{release=resolve;});
  const onCommit=vi.fn(async(_bytes:Uint8Array,prepared:(id:string)=>void)=>{await waiting;prepared("saved");return {bytes,scene,objects:project.cad!.objects!};});
  const {ref}=await setup({project,onCommit});
  try {
    act(()=>ref.current?.selectHandles(["A"]));
    for(let i=0;i<2;i++) {
      fireEvent.click(screen.getByRole("button",{name:"移动"}));
      act(()=>ref.current?.click({x:20,y:10},false,1));
      act(()=>ref.current?.click({x:40,y:30},false,1));
      await waitFor(()=>expect(request.mock.calls.filter(c=>c[0]==="execute" && c[1]==="move")).toHaveLength(i+1));
      await waitFor(()=>expect(screen.getByRole("button",{name:"移动"})).toHaveProperty("disabled",false));
    }
  } finally {await act(async()=>{release();await ref.current?.flush();});}
  const second=(onCommit.mock.calls as unknown as [unknown,unknown,typeof project][])[1]![2];
  expect(second.annotations.find(a=>a.id==="a1")!.x).toBeCloseTo(project.annotations[0]!.x+40, 8);
});

test("trim uses two empty clicks as a fence and stays active", async () => {
  request.mockImplementation(async (method: string) => method === "pick" ? undefined : method === "execute" ? { bytes, scene, result: {} } : scene);
  const { ref } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "修剪" }));
  await act(async () => ref.current?.click({x:20,y:10},false,1));
  await act(async () => ref.current?.click({x:40,y:30},false,1));
  expect(request).toHaveBeenCalledWith("execute", "trim", expect.objectContaining({fence:[[20,90],[40,70]], mode:"quick"}));
  expect(screen.getByRole("button", {name:"修剪"}).getAttribute("aria-pressed")).toBe("true");
});

test("trim remains interactive during checkpoint persistence", async () => {
  request.mockImplementation(async (method: string) => method === "pick" ? "A" : method === "execute" ? {bytes,scene,result:{}} : scene);
  let saved!: () => void;
  const waiting = new Promise<void>(resolve=>{saved=resolve;});
  const {ref,props}=await setup({onCommit:vi.fn(async (_bytes, prepared)=>{await waiting; prepared("trim-saved"); return {bytes,scene,objects:[]};})});
  fireEvent.click(screen.getByRole("button",{name:"修剪"}));
  await act(async()=>ref.current?.click({x:20,y:10},false,1));
  expect(props.onBusy).not.toHaveBeenCalledWith(true);
  expect(screen.getByRole("button",{name:"修剪"})).toHaveProperty("disabled",false);
  await act(async()=>ref.current?.click({x:30,y:10},false,1));
  expect(request.mock.calls.filter(c=>c[0]==="execute" && c[1]==="trim")).toHaveLength(2);
  act(()=>ref.current?.cancel());
  await act(async()=>saved());
});

test("trim hover keeps its settled gray preview until the next result is ready", async()=>{
  const removed:CadScene={...scene,partial:true,entities:[],primitives:[],removedHandles:["A"]};
  let release!:(value:CadScene)=>void;
  let delay=false;
  request.mockImplementation(async(method:string,command:string)=>method==="pick"?"A":method==="query"&&command==="bridge.preview_modify"?(delay?new Promise<CadScene>(resolve=>{release=resolve;}):removed):scene);
  const {ref,props}=await setup();fireEvent.click(screen.getByRole("button",{name:"修剪"}));
  await act(async()=>ref.current?.hover({x:20,y:10},1,false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.trimOriginal).toEqual(scene.primitives);
  vi.mocked(props.onPreview).mockClear();delay=true;
  act(()=>ref.current?.hover({x:21,y:10},1,false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.trimOriginal).toEqual(scene.primitives);
  await act(async()=>{await Promise.resolve();release(removed);});
  expect(vi.mocked(props.onPreview).mock.calls.every(([p])=>p?.trimOriginal?.length===1)).toBe(true);
});

test("trim hover tolerates brief boundary misses but clears a confirmed departure",async()=>{
  const removed:CadScene={...scene,partial:true,entities:[],primitives:[],removedHandles:["A"]};
  let hit=true;
  request.mockImplementation(async(method:string,command:string)=>method==="pick"?(hit?"A":undefined):method==="query"&&command==="bridge.preview_modify"?removed:scene);
  const {ref,props}=await setup();fireEvent.click(screen.getByRole("button",{name:"修剪"}));
  await act(async()=>ref.current?.hover({x:20,y:10},1,false));
  vi.useFakeTimers();vi.mocked(props.onPreview).mockClear();
  hit=false;await act(async()=>ref.current?.hover({x:35,y:11.1},1,false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.trimOriginal).toEqual(scene.primitives);
  act(()=>vi.advanceTimersByTime(40));
  hit=true;await act(async()=>ref.current?.hover({x:36,y:10.9},1,false));
  act(()=>vi.advanceTimersByTime(80));
  expect(vi.mocked(props.onPreview).mock.calls.every(([p])=>p?.trimOriginal?.length===1)).toBe(true);
  hit=false;await act(async()=>ref.current?.hover({x:37,y:11.1},1,false));
  act(()=>vi.advanceTimersByTime(100));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.trimOriginal).toBeUndefined();
});

test("late trim hover results cannot reappear after leaving the canvas",async()=>{
  const removed:CadScene={...scene,partial:true,entities:[],primitives:[],removedHandles:["A"]};
  let release!:(value:CadScene)=>void;
  request.mockImplementation(async(method:string,command:string)=>method==="pick"?"A":method==="query"&&command==="bridge.preview_modify"?new Promise<CadScene>(resolve=>{release=resolve;}):scene);
  const {ref,props}=await setup();fireEvent.click(screen.getByRole("button",{name:"修剪"}));
  await act(async()=>ref.current?.hover({x:20,y:10},1,false));
  act(()=>ref.current?.leave());
  await act(async()=>release(removed));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toBeNull();
});

test.each(["tool", "leave"])("trim boundary exit timer cannot revive an obsolete preview after %s changes",async(action)=>{
  const removed:CadScene={...scene,partial:true,entities:[],primitives:[],removedHandles:["A"]};
  let hit=true;
  request.mockImplementation(async(method:string,command:string)=>method==="pick"?(hit?"A":undefined):method==="query"&&command==="bridge.preview_modify"?removed:scene);
  const {ref,props}=await setup();fireEvent.click(screen.getByRole("button",{name:"修剪"}));
  await act(async()=>ref.current?.hover({x:20,y:10},1,false));
  vi.useFakeTimers();hit=false;
  await act(async()=>ref.current?.hover({x:20,y:11.1},1,false));
  if(action==="tool")fireEvent.click(screen.getByRole("button",{name:"直线"}));
  else act(()=>ref.current?.leave());
  act(()=>vi.advanceTimersByTime(200));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toBeNull();
});

test("a definite trim hover departure clears immediately and never expands the click aperture",async()=>{
  const removed:CadScene={...scene,partial:true,entities:[],primitives:[],removedHandles:["A"]};
  let hit=true;
  request.mockImplementation(async(method:string,command:string)=>method==="pick"?(hit?"A":undefined):method==="query"&&command==="bridge.preview_modify"?removed:scene);
  const {ref,props}=await setup();fireEvent.click(screen.getByRole("button",{name:"修剪"}));
  await act(async()=>ref.current?.hover({x:20,y:10},1,false));
  hit=false;
  await act(async()=>ref.current?.hover({x:20,y:30},1,false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.trimOriginal).toBeUndefined();
  await act(async()=>ref.current?.hover({x:20,y:11.1},1,false));
  await act(async()=>ref.current?.click({x:20,y:11.1},false,1));
  expect(request.mock.calls.filter(c=>c[0]==="execute")).toHaveLength(0);
  expect(request.mock.calls.filter(c=>c[0]==="pick").every(c=>c[3]===1)).toBe(true);
});

test("repeated hits on an untrimmable portion cannot keep an old gray preview indefinitely",async()=>{
  const removed:CadScene={...scene,partial:true,entities:[],primitives:[],removedHandles:["A"]};
  const unchanged:CadScene={...scene,partial:true,entities:[],primitives:[],removedHandles:[]};
  let changes=true;
  request.mockImplementation(async(method:string,command:string)=>method==="pick"?"A":method==="query"&&command==="bridge.preview_modify"?(changes?removed:unchanged):scene);
  const {ref,props}=await setup();fireEvent.click(screen.getByRole("button",{name:"修剪"}));
  await act(async()=>ref.current?.hover({x:20,y:10},1,false));
  vi.useFakeTimers();changes=false;
  await act(async()=>ref.current?.hover({x:21,y:10},1,false));
  act(()=>vi.advanceTimersByTime(40));
  await act(async()=>ref.current?.hover({x:22,y:10},1,false));
  act(()=>vi.advanceTimersByTime(40));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.trimOriginal).toBeUndefined();
});

test("trim fences cannot bypass protection of patent labels", async()=>{
  request.mockImplementation(async(method:string,command:string)=> method==="query" && command==="bridge.preview_modify" ? {...scene,entities:[],primitives:[]} : scene);
  const {ref,props}=await setup();
  props.project.cad!.objects=[{id:"label",kind:"label",label:["A"]}];
  fireEvent.click(screen.getByRole("button",{name:"修剪"}));
  await act(async()=>ref.current?.trimStroke([{x:20,y:0},{x:20,y:20}],1,false,false));
  expect(request.mock.calls.filter(c=>c[0]==="execute")).toHaveLength(0);
  expect(props.onError).toHaveBeenCalledWith(expect.stringContaining("标号"));
});

test("Escape cancels a pending trim preflight without writing geometry", async()=>{
  let release!:(s:CadScene)=>void;
  const pending=new Promise<CadScene>(resolve=>{release=resolve;});
  request.mockImplementation(async(method:string,command:string)=> method==="query" && command==="bridge.preview_modify" ? pending : scene);
  const {ref}=await setup();
  fireEvent.click(screen.getByRole("button",{name:"修剪"}));
  act(()=>ref.current?.trimStroke([{x:20,y:0},{x:20,y:20}],1,false,false));
  act(()=>ref.current?.cancel());
  await act(async()=>release(scene));
  expect(request.mock.calls.filter(c=>c[0]==="execute")).toHaveLength(0);
});

test.each([["修剪", "trim"], ["延伸", "extend"]])("%s always uses quick point/drag interaction without settings", async (label, command) => {
  request.mockImplementation(async (method: string) => method === "pick" ? "A" : method === "execute" ? { bytes, scene, result: {} } : scene);
  const { ref } = await setup();
  fireEvent.click(getTool(label));
  expect(screen.queryByLabelText("修剪模式")).toBeNull();
  expect(screen.queryByLabelText("修剪选择方式")).toBeNull();
  expect(screen.queryByRole("region", {name:`${label}设置`})).toBeNull();
  expect(screen.queryByRole("button", {name:"选择边界"})).toBeNull();
  expect(ref.current?.isCommandPicking()).toBe(false);
  expect(ref.current?.canTrimStroke()).toBe(true);
  await act(async () => ref.current?.click({x:20,y:10},false,1));
  expect(request).toHaveBeenCalledWith("execute",command,{handle:"A",pick:[20,90],mode:"quick"});
  act(()=>ref.current?.finish());
  expect(screen.getByRole("button",{name:label === "延伸" ? "修剪" : label}).getAttribute("aria-pressed")).toBe("false");
});

test("quick trim selects the clicked native object without a preselected target", async () => {
  request.mockImplementation(async (method: string) =>
    method === "pick" ? "A" : method === "execute" ? { bytes, scene, result: {} } : scene,
  );
  const { ref } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "修剪" }));
  await act(async () => ref.current?.click({ x: 20, y: 10 }, false, 1));
  expect(request).toHaveBeenCalledWith("execute", "trim", {
    handle: "A",
    pick: [20, 90],
    mode: "quick",
  });
});

test("trim hover and click use region picking at the exact cursor, while Shift keeps ordinary extend picking", async () => {
  request.mockImplementation(async (method: string) =>
    method === "pick" ? "A" : method === "execute" ? { bytes, scene, result: {} } : scene,
  );
  const { ref } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "修剪" }));
  await act(async () => ref.current?.hover({ x: 20.25, y: 10.25 }, 1, false));
  expect(request).toHaveBeenCalledWith("pick", 20.25, 89.75, 1, "trim");
  expect(request).toHaveBeenCalledWith("query", "bridge.preview_modify", expect.objectContaining({
    command: "trim", params: { handle: "A", pick: [20.25, 89.75], mode: "quick" },
  }));
  await act(async () => ref.current?.click({ x: 20.25, y: 10.25 }, false, 1));
  expect(request).toHaveBeenCalledWith("execute", "trim", {handle:"A",pick:[20.25,89.75],mode:"quick"});
  request.mockClear();
  await act(async () => ref.current?.click({ x: 20.25, y: 10.25 }, true, 1));
  expect(request).toHaveBeenCalledWith("pick", 20.25, 89.75, 1);
  expect(request).toHaveBeenCalledWith("execute", "extend", {handle:"A",pick:[20.25,89.75],mode:"quick"});
});

test("trim uses object pickbox, switches to point crosshairs for fences and clears it on Escape", async () => {
  request.mockImplementation(async (method: string) => method === "pick" ? undefined : scene);
  const onObjectCursor=vi.fn();
  const {ref}=await setup({onObjectCursor});
  fireEvent.click(screen.getByRole("button",{name:"修剪"}));
  expect(onObjectCursor.mock.lastCall?.[0]).toBe(true);
  await act(async()=>ref.current?.click({x:60,y:20},false,1));
  expect(onObjectCursor.mock.lastCall?.[0]).toBe(false);
  act(()=>ref.current?.cancel());
  expect(onObjectCursor.mock.lastCall?.[0]).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"修剪"}));
  expect(onObjectCursor.mock.lastCall?.[0]).toBe(true);
});

test("Enter waits for an in-flight target pick and confirms it without losing the command", async () => {
  let release: (handle: string) => void = () => {};
  request.mockImplementation(async (method: string) =>
    method === "pick"
      ? new Promise<string>((resolve) => {
          release = resolve;
        })
      : scene,
  );
  const { ref } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "移动" }));
  act(() => {
    ref.current?.click({ x: 25, y: 10 }, false, 1);
    ref.current?.finish();
  });
  await act(async () => release("A"));
  expect(ref.current?.isCommandPicking()).toBe(false);
  expect(screen.getByText("选择操作基点。")).toBeTruthy();
});

test("interactive rotation uses the picked base and previews the same transform", async () => {
  const { ref, props } = await setup();
  act(() => ref.current?.selectHandles(["A"]));
  fireEvent.click(
    within(screen.getByRole("group", { name: "修改" })).getByRole("button", { name: "旋转" }),
  );
  act(() => ref.current?.click({ x: 100, y: 100 }, false, 1));
  act(() => ref.current?.hover({ x: 100, y: 80 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.transform).toEqual({
    command: "rotate",
    base: [100, 0],
    angle: 90,
  });
});

test("mouse scaling reaches double size at half the previous travel and commits its preview once", async () => {
  request.mockImplementation(async (method:string) => method === "execute" ? {bytes,scene} : scene);
  const { ref, props } = await setup();
  act(() => ref.current?.selectHandles(["A"]));
  fireEvent.click(within(screen.getByRole("group", { name: "修改" })).getByRole("button", { name: "缩放" }));
  act(() => ref.current?.click({ x: 10, y: 10 }, false, 1));
  act(() => ref.current?.hover({ x: 50, y: 10 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.transform).toEqual({command:"scale",base:[10,90],factor:2});
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.points).toEqual([]);
  expect(screen.queryByText("选择参考长度的另一点。")).toBeNull();
  expect(request.mock.calls.filter(c => c[0] === "execute")).toHaveLength(0);
  await act(async () => { ref.current?.click({x:50,y:10},false,1); await ref.current?.flush(); });
  expect(request).toHaveBeenCalledWith("execute","scale",{handles:["A"],base:[10,90],factor:2});
  expect(props.onCommit).toHaveBeenCalledOnce();
});

test("scale factor input applies about the single picked base, rejects invalid values and Escape cancels", async () => {
  request.mockImplementation(async (method:string) => method === "execute" ? {bytes,scene} : scene);
  const { ref, props } = await setup();
  act(() => ref.current?.selectHandles(["A"]));
  fireEvent.click(within(screen.getByRole("group", { name: "修改" })).getByRole("button", { name: "缩放" }));
  const input = screen.getByRole("spinbutton",{name:"缩放比例"});
  const apply = within(screen.getByRole("region",{name:"缩放设置"})).getByRole("button",{name:"应用"});
  expect(apply).toHaveProperty("disabled",true);
  act(() => ref.current?.click({x:10,y:10},false,1));
  for (const value of ["", "0", "-2"]) {
    fireEvent.change(input,{target:{value}});
    expect(apply).toHaveProperty("disabled",true);
    fireEvent.keyDown(input,{key:"Enter"});
  }
  expect(props.onCommit).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:"0.512345"}});
  fireEvent.blur(input);
  expect(input).toHaveProperty("value", "0.5");
  fireEvent.keyDown(input,{key:"Enter"});
  await act(async () => { await ref.current?.flush(); });
  expect(request).toHaveBeenCalledWith("execute","scale",{handles:["A"],base:[10,90],factor:0.512345});
  expect(props.onCommit).toHaveBeenCalledOnce();
  fireEvent.click(within(screen.getByRole("group", { name: "修改" })).getByRole("button", { name: "缩放" }));
  act(() => ref.current?.click({x:10,y:10},false,1));
  const nextInput=screen.getByRole("spinbutton",{name:"缩放比例"});
  fireEvent.change(nextInput,{target:{value:"3"}});
  fireEvent.keyDown(nextInput,{key:"Escape"});
  await act(async () => { await ref.current?.flush(); });
  expect(props.onCommit).toHaveBeenCalledOnce();
});

test("drawing aids are fixed on despite legacy disabled tracking and expose no master toggles", async () => {
  localStorage.setItem("patent-workbench:cad-aids:v1", JSON.stringify({
    tracking: false, angle45: false, enabled: ["endpoint"],
  }));
  const { ref, props } = await setup();
  expect(screen.queryAllByRole("checkbox", { name: /对象捕捉|正交绘制|对齐追踪/ })).toHaveLength(0);
  act(() => ref.current?.hover({ x: 11, y: 10 }, 2, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.snapType).toBe("endpoint");
  act(() => ref.current?.pointDown({ x: 100, y: 100 }, 1, false));
  act(() => ref.current?.hover({ x: 130, y: 100.5 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.cursor).toEqual({ x: 130, y: 0 });
  act(() => ref.current?.hover({ x: 130, y: 80 }, 1, true));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.cursor).toEqual({ x: 130, y: 20 });
  expect(JSON.parse(localStorage.getItem("patent-workbench:cad-aids:v1")!).tracking).toBe(true);
});

test("the initial modification distance follows drawing scale and keeps a user's explicit value", async () => {
  const { ref, props, view } = await setup();
  const project = {
    ...props.project,
    cad: { ...props.project.cad!, mapping: { ...props.project.cad!.mapping, scale: 1000 } },
  };
  await act(async () => view.rerender(<CadEditingPanel {...props} project={project} />));
  const fillet = screen.getByRole("button", { name: "圆角" });
  fireEvent.click(fillet);
  const input = screen.getByRole("spinbutton", { name: "圆角半径" }) as HTMLInputElement;
  expect(input.value).toBe("1e-2");
  fireEvent.change(input, { target: { value: "0.02" } });
  act(() => ref.current?.cancel());
  fireEvent.click(fillet);
  expect((screen.getByRole("spinbutton", { name: "圆角半径" }) as HTMLInputElement).value).toBe(
    "2e-2",
  );
});

test("continuous line closes to its own first point and offers a durable-history undo anchor", async () => {
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene, result: {} } : scene,
  );
  const { ref } = await setup();
  await act(async () => {
    ref.current?.click({ x: 100, y: 100 }, false, 1);
    ref.current?.click({ x: 120, y: 80 }, false, 1);
    ref.current?.click({ x: 140, y: 100 }, false, 1);
    await ref.current?.flush();
  });
  expect(ref.current?.prepareLineUndo()).toBe(true);
  await act(async () => ref.current?.closeLine());
  await act(async () => {
    await ref.current?.flush();
  });
  expect(request).toHaveBeenCalledWith("execute", "line", {
    points: [
      [expect.closeTo(120, 8), expect.closeTo(20, 8)],
      [100, 0],
    ],
  });
});

test("line undo survives checkpoint reload and resumes from the previous endpoint", async () => {
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene, result: {} } : scene,
  );
  const { ref, props, view } = await setup();
  await act(async () => {
    ref.current?.click({ x: 100, y: 100 }, false, 1);
    ref.current?.click({ x: 120, y: 80 }, false, 1);
    ref.current?.click({ x: 140, y: 100 }, false, 1);
    await ref.current?.flush();
  });
  act(() => ref.current?.prepareLineUndo());
  const project = { ...props.project, cad: { ...props.project.cad!, assetId: "undone-line" } };
  await act(async () => view.rerender(<CadEditingPanel {...props} project={project} />));
  act(() => ref.current?.hover({ x: 150, y: 70 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.anchor).toEqual({
    x: expect.closeTo(120, 8), y: expect.closeTo(20, 8),
  });
});

test("fillet on empty space never starts the obsolete asynchronous two-edge selection", async () => {
  const {ref}=await setup();fireEvent.click(getTool("圆角"));
  await act(async()=>{ref.current?.click({x:30,y:30},false,1);ref.current?.click({x:50,y:50},true,1);});
  expect(request.mock.calls.some(call=>call[0]==="pick"||call[0]==="execute")).toBe(false);
  expect(screen.getByText("请点击两条直边相接的角，或已有的圆角/倒角。")).toBeTruthy();
});
test("line redo restores the endpoint and a new segment clears the redo trail",async()=>{
  request.mockImplementation(async(method:string)=>method==="execute"?{bytes,scene,result:{}}:scene);
  const {ref,props,view}=await setup();
  await act(async()=>{for(const p of [{x:100,y:100},{x:120,y:80},{x:140,y:100}])ref.current?.click(p,false,1);await ref.current?.flush();});
  act(()=>expect(ref.current?.prepareLineUndo()).toBe(true));
  await act(async()=>view.rerender(<CadEditingPanel {...props} project={{...props.project,cad:{...props.project.cad!,assetId:"undo-line"}}}/>));
  act(()=>expect(ref.current?.prepareLineRedo()).toBe(true));
  await act(async()=>view.rerender(<CadEditingPanel {...props} project={{...props.project,cad:{...props.project.cad!,assetId:"redo-line"}}}/>));
  act(()=>ref.current?.hover({x:160,y:120},1,false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.anchor).toEqual({x:expect.closeTo(140,8),y:expect.closeTo(0,8)});
  act(()=>expect(ref.current?.prepareLineUndo()).toBe(true));
  await act(async()=>{ref.current?.click({x:170,y:110},false,1);await ref.current?.flush();});
  expect(ref.current?.prepareLineRedo()).toBe(false);
});

test("a cached history checkpoint restores editability without another read or DXF parse",async()=>{
  let cached=false;
  request.mockImplementation(async(method:string)=>method==="checkout"?{restored:cached,checkpoint:{source:bytes,edits:[]}}:scene);
  const readCheckpoint=vi.fn(async()=>bytes);
  const {props,view}=await setup({readCheckpoint,checkpointScene:()=>scene});
  request.mockClear();readCheckpoint.mockClear();cached=true;
  await act(async()=>view.rerender(<CadEditingPanel {...props} project={{...props.project,cad:{...props.project.cad!,assetId:"cached-history"}}}/>));
  expect(request).toHaveBeenCalledWith("checkout","cached-history");
  expect(request.mock.calls.some(c=>["load","restore"].includes(c[0]))).toBe(false);
  expect(readCheckpoint).not.toHaveBeenCalled();
  expect(screen.getByRole("button",{name:"直线"})).toHaveProperty("disabled",false);
});

test("checkpoint hydration does not impersonate a new user selection",async()=>{
  const {ref,props}=await setup();
  expect(vi.mocked(props.onSelection).mock.calls.find(([value])=>value?.scene)?.[0]).toMatchObject({passive:true});
  act(()=>ref.current?.selectHandles(["A"]));
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.passive).toBeUndefined();
});

test.each([false,true,"leave"] as const)("a reselect while undo restores the worker is retained unless cancelled (cancel: %s)",async(cancel)=>{
  const gears:CadScene={...scene,entities:[{handle:"R",type:"Block Reference",layer:"0",gear:{kind:"internal",teeth:40,hole:false,size:90},grips:[[60,40]]}]};
  request.mockImplementation(async(method:string)=>method==="pick"?"R":method==="execute"?{bytes,scene:gears,result:{changed:true}}:gears);
  let delayed=false,release!:(value:Uint8Array)=>void;
  const readCheckpoint=vi.fn(()=>delayed?new Promise<Uint8Array>(resolve=>{release=resolve;}):Promise.resolve(bytes));
  const {ref,props,view}=await setup({readCheckpoint});act(()=>ref.current?.cancel());delayed=true;
  await act(async()=>view.rerender(<CadEditingPanel {...props} project={{...props.project,cad:{...props.project.cad!,assetId:"undo-mesh"}}}/>));
  expect(screen.getByRole("region",{name:"CAD实体编辑"}).getAttribute("data-cad-ready")).toBe("false");
  act(()=>{ref.current?.click({x:60,y:60},false,1);ref.current?.click({x:60,y:60},false,1);ref.current?.click({x:80,y:80},false,1);if(cancel===true)ref.current?.cancel();});
  if(cancel==="leave"){
    const project={...props.project,cad:{...props.project.cad!,assetId:"undo-mesh"}};
    await act(async()=>view.rerender(<CadEditingPanel {...props} project={project} enabled={false}/>));
    await act(async()=>view.rerender(<CadEditingPanel {...props} project={project} enabled/>));
  }
  expect(request.mock.calls.some(c=>c[0]==="pick")).toBe(false);
  await act(async()=>{release(bytes);await Promise.resolve();});
  await waitFor(()=>expect(screen.getByRole("region",{name:"CAD实体编辑"}).getAttribute("data-cad-ready")).toBe("true"));
  if(cancel)expect(request.mock.calls.some(c=>c[0]==="pick")).toBe(false);
  else await waitFor(()=>expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["R"]));
  await act(async()=>{await Promise.resolve();await ref.current?.flush();});
  expect(request.mock.calls.some(c=>c[0]==="execute")).toBe(false);
  expect(props.onCommit).not.toHaveBeenCalled();
});

test("a late canvas pick cannot overwrite a newer explicit selection",async()=>{
  let release: ((handle:string)=>void) | undefined;
  request.mockImplementation((method:string)=>method==="pick"?new Promise(resolve=>{release=resolve;}):Promise.resolve(scene));
  const {ref,props}=await setup();
  act(()=>ref.current?.cancel());
  act(()=>ref.current?.click({x:80,y:80},false,1));
  await waitFor(()=>expect(release).toBeTypeOf("function"));
  act(()=>ref.current?.selectHandles([]));
  await act(async()=>release!("A"));
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual([]);
});

test.each([false, true])("a modify tool preserves an in-flight selection unless cancelled (%s)", async (cancelled) => {
  let release: ((handle: string) => void) | undefined;
  request.mockImplementation((method: string) => method === "pick"
    ? new Promise((resolve) => { release = resolve; })
    : Promise.resolve(scene));
  const { ref, props } = await setup();
  act(() => ref.current?.cancel());
  act(() => ref.current?.click({ x: 80, y: 80 }, false, 1));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "移动" }));
  if (cancelled) act(() => ref.current?.cancel());
  await act(async () => release!("A"));
  if (cancelled) {
    expect(screen.queryByText("点击基点，再指定目标位置；按住 Shift 限制方向。")).toBeNull();
    expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles ?? []).toEqual([]);
  } else {
    expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["A"]);
    expect(screen.getByText("点击基点，再指定目标位置；按住 Shift 限制方向。")).toBeDefined();
  }
});

test("a newer drawing tool supersedes a modify tool waiting for selection", async () => {
  let release: ((handle: string) => void) | undefined;
  request.mockImplementation((method: string) => method === "pick"
    ? new Promise((resolve) => { release = resolve; })
    : Promise.resolve(scene));
  const { ref, props } = await setup();
  act(() => ref.current?.cancel());
  act(() => ref.current?.click({ x: 80, y: 80 }, false, 1));
  fireEvent.click(screen.getByRole("button", { name: "移动" }));
  fireEvent.click(screen.getByRole("button", { name: "圆" }));
  await act(async () => release!("A"));
  expect(screen.queryByText("点击基点，再指定目标位置；按住 Shift 限制方向。")).toBeNull();
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual([]);
  expect(request.mock.calls.some(([method]) => method === "execute")).toBe(false);
});

test("corner hover is local and Escape cancels without writing geometry",async()=>{
 const corners:CadScene={...scene,entities:[{handle:"P",type:"Polyline",layer:"0",geometry:{type:"lwPolyline",closed:true,vertices:[{p:{x:0,y:0},bulge:0},{p:{x:80,y:0},bulge:0},{p:{x:80,y:80},bulge:0},{p:{x:0,y:80},bulge:0}]}}]};
 request.mockResolvedValue(corners);const {ref,props}=await setup();fireEvent.click(getTool("圆角"));
 act(()=>ref.current?.hover({x:80,y:100},2,false));
 expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.cornerGrips).toHaveLength(1);
 act(()=>ref.current?.cancel());expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toBeNull();
 expect(request.mock.calls.some(call=>call[0]==="execute"||call[0]==="pick"||call[0]==="query")).toBe(false);
});

test.each(["fillet", "chamfer"] as const)("Enter applies the active %s corner amount from its portalled input", async (kind) => {
  const corners: CadScene = { ...scene, entities: [{ handle: "P", type: "Polyline", layer: "0", geometry: {
    type: "lwPolyline", closed: true, vertices: [
      { p: { x: 0, y: 0 }, bulge: 0 }, { p: { x: 80, y: 0 }, bulge: 0 },
      { p: { x: 80, y: 80 }, bulge: 0 }, { p: { x: 0, y: 80 }, bulge: 0 },
    ],
  } }] };
  const original = cornerCandidates(corners, kind).find(t => t.corner.x === 80 && t.corner.y === 0)!;
  const change = cornerGeometry(original, { kind, a: 10, b: 10 });
  const modified = { ...corners, entities: [{ ...corners.entities[0]!, geometry: change.params.edits[0]!.after }] };
  const active = cornerCandidates(modified, kind).find(t => t.existing)!;
  request.mockImplementation(async (method: string) => method === "execute" ? { bytes, scene: modified } : modified);
  const target = document.createElement("div");
  document.body.append(target);
  const { ref, props, view } = await setup({ settingsTarget: target });
  try {
    fireEvent.click(getTool(kind === "fillet" ? "圆角" : "倒角"));
    act(() => ref.current?.click({ x: active.probe[0]!.x, y: 100 - active.probe[0]!.y }, false, 1));
    const input = screen.getByRole("spinbutton", { name: kind === "fillet" ? "圆角半径" : "倒角大小" });
    expect(target.contains(input)).toBe(true);
    fireEvent.change(input, { target: { value: "15" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => { await ref.current?.flush(); });
    expect(request.mock.calls.filter(([method, command]) => method === "execute" && command === "bridge.corner")).toHaveLength(1);
    expect(props.onCommit).toHaveBeenCalledOnce();
  } finally { view.unmount(); target.remove(); }
});

test("Shift window removes an entire selectable group instead of re-expanding leftovers", async () => {
  const grouped = {
    ...scene,
    entities: ["A", "B"].map((handle) => ({ handle, type: "Line", layer: "0" })),
    groups: [{ name: "group", selectable: true, members: ["A", "B"] }],
  };
  request.mockImplementation(async (method: string) =>
    method === "query" ? { handles: ["A"] } : grouped,
  );
  const { ref, props } = await setup();
  act(() => ref.current?.cancel());
  act(() => ref.current?.selectHandles(["A", "B"]));
  await act(async () => ref.current?.window({ x: 0, y: 0 }, { x: 70, y: 70 }, true, 1, false));
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual([]);
});

test("clipboard paste places frozen geometry without requesting fresh object selection", async () => {
  request.mockImplementation(async (method: string) =>
    method === "export"
      ? bytes
      : method === "paste"
        ? { bytes, scene, result: { handles: ["A"] } }
        : scene,
  );
  const { ref } = await setup();
  act(() => ref.current?.selectHandles(["A"]));
  await act(async () => ref.current?.copySelected());
  act(() => ref.current?.selectHandles([]));
  act(() => expect(ref.current?.pasteSelected()).toBe(true));
  expect(ref.current?.isCommandPicking()).toBe(false);
  expect(ref.current?.canWindow()).toBe(false);
  await act(async () => ref.current?.click({ x: 30, y: 25 }, false, 1));
  expect(request.mock.calls.some(([method]) => method === "paste")).toBe(true);
});

test("a patent clipboard survives source panel disposal and paste uses the target drawing", async () => {
  const clipboard={current:null};
  request.mockImplementation(async(method:string)=>method==="paste"?{bytes,scene,result:{handles:["B"]}}:scene);
  const source=await setup({clipboard});
  act(()=>{source.ref.current?.selectHandles(["A"]);source.ref.current?.copySelected();});
  source.view.unmount();
  const target=await setup({clipboard,project:{...source.props.project,projectId:"00000000-0000-4000-8000-000000000999"}});
  request.mockClear();
  act(()=>expect(target.ref.current?.pasteSelected()).toBe(true));
  expect(request).not.toHaveBeenCalled();
  await act(async()=>{target.ref.current?.click({x:45,y:45},false,1);await target.ref.current?.flush();});
  expect(request.mock.calls.some(([method])=>method==="paste")).toBe(true);
  expect(target.props.onCommit).toHaveBeenCalledOnce();
  expect(source.props.onCommit).not.toHaveBeenCalled();
});

test("paste permits an unchanged world position and cancelled placement never writes",async()=>{
  request.mockImplementation(async(method:string)=>method==="paste"?{bytes,scene,result:{handles:["B"]}}:scene);
  const {ref}=await setup();
  act(()=>{ref.current?.selectHandles(["A"]);ref.current?.copySelected();});
  act(()=>{ref.current?.pasteSelected();ref.current?.cancel();});
  request.mockClear();
  act(()=>ref.current?.pasteSelected());
  expect(request).not.toHaveBeenCalled();
  await act(async()=>{ref.current?.click({x:30,y:10},false,0.001);await ref.current?.flush();});
  expect(request).toHaveBeenCalledWith("paste",bytes,expect.objectContaining({delta:[0,0]}),expect.anything());
});

test("a clipboard is not exposed to another patent session",async()=>{
  const clipboard={current:null};const source=await setup({clipboard});
  act(()=>{source.ref.current?.selectHandles(["A"]);source.ref.current?.copySelected();});source.view.unmount();
  const target=await setup({clipboard,sessionId:"other-patent"});
  act(()=>expect(target.ref.current?.pasteSelected()).toBe(false));
});

test("cancelling a tool cancels the previous stationary hover refresh", async () => {
  const { ref, props } = await setup();
  vi.useFakeTimers();
  act(() => ref.current?.hover({ x: 10, y: 10 }, 1, false));
  act(() => ref.current?.cancel());
  const calls = vi.mocked(props.onPreview).mock.calls.length;
  act(() => vi.advanceTimersByTime(300));
  expect(vi.mocked(props.onPreview).mock.calls).toHaveLength(calls);
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toBeNull();
});

test("all capture types and diagonal tracking stay enabled across reopening despite old preferences", async () => {
  localStorage.setItem("patent-workbench:cad-aids:v1", JSON.stringify({
    tracking: false, angle45: false, enabled: [],
  }));
  const { ref, props } = await setup();
  expect(screen.queryByText("捕捉设置")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "本次捕捉" })).toBeNull();
  act(() => ref.current?.hover({ x: 11, y: 10 }, 2, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.snapType).toBe("endpoint");
  act(() => ref.current?.pointDown({ x: 100, y: 100 }, 1, false));
  act(() => ref.current?.hover({ x: 130, y: 70.5 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.snapType).toBe("polar");
  cleanup();
  await setup();
  const settings = JSON.parse(localStorage.getItem("patent-workbench:cad-aids:v1")!);
  expect(settings.tracking).toBe(true);
  expect(settings.angle45).toBe(true);
  expect(settings.enabled).toHaveLength(12);
});
async function setup(overrides: Partial<ComponentProps<typeof CadEditingPanel>> = {}) {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "a".repeat(40),
    assetId: project.sourceAssetId,
    unified: 1,
    mapping: { originX: 0, originY: 100, scale: 1 },
  };
  const ref = createRef<CadEditingHandle>();
  const props: ComponentProps<typeof CadEditingPanel> = {
    ref,
    project,
    sessionId: "session",
    enabled: true,
    disabled: false,
    onEnabled: vi.fn(),
    onSelection: vi.fn(),
    onPreview: vi.fn(),
    onBusy: vi.fn(),
    onError: vi.fn(),
    onCommit: vi.fn(async (_bytes, prepared) => {
      prepared(project.sourceAssetId);
      return { bytes, objects: [], scene };
    }),
    ...overrides,
  };
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<CadEditingPanel {...props} />);
  });
  expect((screen.getByRole("button", { name: "直线" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "直线" }));
  return { ref, props, view };
}

test("legacy image compatibility keeps the checkpoint handle but renders no CAD portals or commands", async () => {
  const { ref, props, view } = await setup();
  await act(async () => view.rerender(<CadEditingPanel {...props} enabled={false} compatibilityOnly
    detailTool={{ button: <button type="button">CAD局部放大</button>, active: true,
      controlsOpen: true, hint: "CAD提示", controls: <input aria-label="CAD重复参数" />, close: vi.fn() }} />));
  expect(screen.queryByRole("region", { name: "CAD实体编辑" })).toBeNull();
  expect(screen.queryByLabelText("CAD重复参数")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(ref.current).not.toBeNull();
  expect(await ref.current?.flush()).toBe(true);
  expect(props.onCommit).not.toHaveBeenCalled();
});

test("explicit load retry recreates the editing worker without changing the saved checkpoint", async () => {
  const onLoadError = vi.fn();
  const { props, view } = await setup({ onLoadError, retryGeneration: 0 });
  request.mockRejectedValueOnce(new Error("CAD 编辑会话已关闭。"));
  await act(async () => view.rerender(<CadEditingPanel {...props} retryGeneration={1} />));
  await vi.waitFor(() => expect(onLoadError).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "直线" }).hasAttribute("disabled")).toBe(true);
  await act(async () => view.rerender(<CadEditingPanel {...props} retryGeneration={2} />));
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "直线" }).hasAttribute("disabled")).toBe(false),
  );
  expect(props.onCommit).not.toHaveBeenCalled();
});
test("retrying a post-save worker refresh does not create another persisted stroke or history entry", async () => {
  let loads = 0;
  request.mockImplementation(async (method: string) => {
    if (method === "execute") return { bytes, scene };
    if ((method === "load" || method === "restore") && ++loads === 2)
      throw new Error("refresh failed");
    return scene;
  });
  const { ref, props } = await setup();
  await act(async () => {
    ref.current?.pointDown({ x: 200, y: 200 }, 1, false);
    ref.current?.click({ x: 300, y: 220 }, false, 1);
    await vi.waitFor(() => expect(props.onError).toHaveBeenCalled());
  });
  expect(screen.getByRole("button", { name: "重试保存图纸" })).toBeTruthy();
  expect(props.onCommit).toHaveBeenCalledTimes(1);
  let saved = false;
  await act(async () => {
    if (!ref.current) throw new Error("CAD panel missing");
    saved = await ref.current.flush();
  });
  expect(saved).toBe(true);
  expect(props.onCommit).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.filter(([method]) => method === "execute")).toHaveLength(1);
});
test("free drawing remains unconstrained away from tracking axes", async () => {
  const { ref, props } = await setup();
  act(() => ref.current?.hover({ x: 11, y: 10 }, 2, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.snapped).toBe(true);
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.snapType).toBe("endpoint");
  act(() => {
    ref.current?.pointDown({ x: 200, y: 200 }, 1, false);
    ref.current?.hover({ x: 300, y: 220 }, 1, false);
  });
  const preview = vi.mocked(props.onPreview).mock.lastCall?.[0];
  expect(preview?.cursor).toEqual({ x: 300, y: -120 });
  expect(preview?.snapped).toBe(false);
  expect(preview?.snapType).toBeUndefined();
});

test("dragging a selected grip snaps to horizontal and vertical axes with guides", async () => {
  const gripped: CadScene = {
    ...scene,
    entities: [
      {
        ...scene.entities[0]!,
        grips: [
          [10, 90],
          [30, 90],
          [50, 90],
        ],
      },
    ],
  };
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene: gripped, result: {} } : gripped,
  );
  const { ref, props } = await setup();
  act(() => {
    ref.current?.cancel();
    ref.current?.selectHandles(["A"]);
  });
  act(() => expect(ref.current?.beginGrip({ x: 10, y: 10 }, 8)).toBe(true));
  act(() => ref.current?.hover({ x: 60, y: 16 }, 8, false));
  const horizontal = vi.mocked(props.onPreview).mock.lastCall?.[0];
  expect(horizontal?.cursor).toEqual({ x: 60, y: 90 });
  expect(horizontal?.snapType).toBe("polar");
  expect(horizontal?.guides).toEqual([
    [
      { x: 10, y: 90 },
      { x: 60, y: 90 },
    ],
  ]);
  act(() => ref.current?.hover({ x: 16, y: 65 }, 8, false));
  const vertical = vi.mocked(props.onPreview).mock.lastCall?.[0];
  expect(vertical?.cursor).toEqual({ x: 10, y: 35 });
  expect(vertical?.snapType).toBe("polar");
  expect(vertical?.guides).toEqual([
    [
      { x: 10, y: 90 },
      { x: 10, y: 35 },
    ],
  ]);
  await act(async () => {
    ref.current?.click({ x: 16, y: 65 }, false, 8);
    await ref.current?.flush();
  });
  expect(request).toHaveBeenCalledWith("execute", "grip.move", {
    handle: "A",
    index: 0,
    to: [10, 35],
  });
});

test("a grip edit remains interactive while its durable checkpoint is saving", async () => {
  const gripped: CadScene = {
    ...scene,
    entities: [
      {
        ...scene.entities[0]!,
        grips: [
          [10, 90],
          [30, 90],
          [50, 90],
        ],
      },
    ],
  };
  request.mockImplementation(async (method: string) => {
    if (method === "execute") return { bytes, scene: gripped, result: {} };
    if (method === "pick") return undefined;
    return gripped;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const onCommit = vi.fn(async (_bytes: Uint8Array, prepared: (id: string) => void) => {
    prepared("saved-grip");
    await gate;
    return { bytes, objects: [] as CadPatentObject[], scene: gripped };
  });
  const onWorkingScene = vi.fn();
  const { ref, props, view } = await setup({ onCommit, onWorkingScene });
  act(() => {
    ref.current?.cancel();
    ref.current?.selectHandles(["A"]);
  });
  act(() => expect(ref.current?.beginGrip({ x: 10, y: 10 }, 8)).toBe(true));
  act(() => ref.current?.click({ x: 60, y: 10 }, false, 8));
  try {
    await vi.waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(props.onBusy).not.toHaveBeenCalledWith(true);
    expect(ref.current?.canWindow()).toBe(true);
    vi.mocked(props.onPreview).mockClear();
    act(() => ref.current?.hover({ x: 65, y: 20 }, 8, false));
    expect(props.onPreview).toHaveBeenCalled();
    act(() => expect(ref.current?.beginGrip({ x: 10, y: 10 }, 8)).toBe(true));
    act(() => ref.current?.click({ x: 70, y: 10 }, false, 8));
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "execute")).toHaveLength(2),
    );
    expect(onCommit).toHaveBeenCalledTimes(1);
    act(() => ref.current?.click({ x: 120, y: 50 }, false, 8));
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === "pick")).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "直线" }));
    act(() => ref.current?.click({ x: 100, y: 30 }, false, 8));
    act(() => ref.current?.click({ x: 130, y: 30 }, false, 8));
    await vi.waitFor(() => expect(onWorkingScene).toHaveBeenCalledTimes(3));
  } finally {
    await act(async () => {
      release();
      await ref.current?.flush();
    });
  }
  const savedProject = {
    ...props.project,
    cad: { ...props.project.cad!, assetId: "saved-grip" },
  };
  await act(async () => view.rerender(<CadEditingPanel {...props} project={savedProject} />));
  expect((screen.getByRole("button", { name: "直线" }) as HTMLButtonElement).disabled).toBe(false);
});

test("a released grip keeps its final preview until the edited scene takes over", async () => {
  const initial: CadScene = {
    ...scene,
    entities: [
      {
        ...scene.entities[0]!,
        grips: [
          [10, 90],
          [30, 90],
          [50, 90],
        ],
      },
    ],
  };
  const gripped: CadScene = {
    ...scene,
    entities: [
      {
        ...scene.entities[0]!,
        grips: [
          [60, 90],
          [70, 90],
          [80, 90],
        ],
      },
    ],
  };
  let finishExecute!: (value: { bytes: Uint8Array; scene: CadScene; result: object }) => void;
  request.mockImplementation(async (method: string) => {
    if (method === "execute")
      return new Promise((resolve) => {
        finishExecute = resolve;
      });
    return initial;
  });
  const onWorkingScene = vi.fn();
  const { ref, props } = await setup({ onWorkingScene });
  act(() => {
    ref.current?.cancel();
    ref.current?.selectHandles(["A"]);
  });
  act(() => expect(ref.current?.beginGrip({ x: 10, y: 10 }, 8)).toBe(true));
  act(() => ref.current?.click({ x: 60, y: 10 }, false, 8));
  await vi.waitFor(() => expect(finishExecute).toBeTypeOf("function"));
  act(() => {
    ref.current?.hover({ x: 75, y: 30 }, 8, false);
    ref.current?.leave();
  });
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.gripTarget).toEqual({
    handle: "A",
    index: 0,
  });
  await act(async () => {
    finishExecute({ bytes, scene: gripped, result: {} });
    await ref.current?.flush();
  });
  expect(onWorkingScene).toHaveBeenCalledWith(
    gripped,
    expect.any(Array),
    expect.any(Number),
    props.project.projectId,
    "grip.move",
  );
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toBeNull();
  expect(onWorkingScene.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(props.onPreview).mock.invocationCallOrder.at(-1)!,
  );
});

test("cancelling an active drawing tool releases the retained backdrop", async () => {
  const onDrawingActive = vi.fn();
  const { ref } = await setup({ onDrawingActive });
  expect(onDrawingActive).toHaveBeenLastCalledWith(true);
  act(() => ref.current?.cancel());
  expect(onDrawingActive).toHaveBeenLastCalledWith(false);
});

test("captures a rectangle corner on hover and uses it as the first mouse-down point", async () => {
  request.mockResolvedValue({
    ...scene,
    entities: [
      {
        handle: "A",
        type: "LWPolyline",
        layer: "0",
        grips: [
          [10, 90],
          [30, 90],
          [50, 90],
          [50, 70],
          [50, 50],
          [30, 50],
          [10, 50],
          [10, 70],
        ],
      },
    ],
    primitives: [
      {
        ...scene.primitives[0],
        points: [
          [10, 90],
          [50, 90],
          [50, 50],
          [10, 50],
          [10, 90],
        ],
      },
    ],
  });
  const { ref, props } = await setup();
  act(() => ref.current?.hover({ x: 50.5, y: 50.5 }, 2, false));
  const hover = vi.mocked(props.onPreview).mock.lastCall?.[0];
  expect(hover?.anchor).toBeNull();
  expect(hover?.snapped).toBe(true);
  expect(hover?.cursor).toEqual({ x: 50, y: 50 });
  act(() => ref.current?.pointDown({ x: 50.5, y: 50.5 }, 2, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.anchor).toEqual({ x: 50, y: 50 });
});

test("completed single shapes do not leave their transient construction outline over the drawing", async () => {
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene } : scene,
  );
  const { ref, props } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "圆" }));
  await act(async () => {
    ref.current?.pointDown({ x: 200, y: 200 }, 1, false);
    ref.current?.hover({ x: 250, y: 200 }, 1, false);
    ref.current?.click({ x: 250, y: 200 }, false, 1);
    await vi.waitFor(() => expect(props.onCommit).toHaveBeenCalled());
  });
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toBeNull();
});

test("a new point during a worker refresh inherits the refreshed patent bindings", async () => {
  let releaseLoad = () => {},
    releaseSave = () => {};
  const loading = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  const saving = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let loads = 0,
    commits = 0;
  let queue = Promise.resolve<unknown>(undefined);
  request.mockImplementation((method: string) => {
    const next = queue.then(async () => {
      if ((method === "load" || method === "restore") && ++loads === 2) await loading;
      return method === "execute" ? { bytes, scene } : scene;
    });
    queue = next;
    return next;
  });
  const objects: CadPatentObject[] = [{ id: "label", kind: "label", label: ["A"] }];
  const { ref, props } = await setup({
    onCommit: vi.fn(async (_bytes, prepared) => {
      if (++commits === 2) await saving;
      prepared("00000000-0000-4000-8000-000000000001");
      return { bytes, scene, objects };
    }),
  });
  await act(async () => {
    ref.current?.pointDown({ x: 200, y: 200 }, 1, false);
    ref.current?.click({ x: 300, y: 220 }, false, 1);
    await vi.waitFor(() => expect(loads).toBe(2));
  });
  await act(async () => {
    ref.current?.click({ x: 400, y: 240 }, false, 1);
    releaseLoad();
    await vi.waitFor(() => expect(commits).toBe(2));
  });
  const inherited = vi.mocked(props.onSelection).mock.lastCall?.[0]?.objects;
  releaseSave();
  await act(async () => {
    await ref.current?.flush();
  });
  expect(inherited).toEqual(objects);
});

test("a hatch interior pick uses the cursor point without snapping or stale preselected boundaries", async () => {
  const { ref } = await setup();
  act(() => ref.current?.selectHandles(["A"]));
  fireEvent.click(screen.getByRole("button", { name: "剖面填充" }));
  act(() => ref.current?.click({ x: 10.5, y: 10.5 }, false, 2));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("query", "bridge.preview_modify", {
      command: "hatch",
      params: { points: [[10.5, 89.5]], pattern: "ANSI31", scale: 1, angle: 0, style: "normal" },
    }),
  );
});

test("double clicks during a pending pick cannot cancel a new selection window", async () => {
  let release!: (handle: undefined) => void;
  request.mockImplementation(async (method: string) =>
    method === "pick"
      ? new Promise<undefined>((resolve) => {
          release = resolve;
        })
      : scene,
  );
  const { ref, props } = await setup();
  act(() => ref.current?.cancel());
  act(() => {
    ref.current?.click({ x: 0, y: 0 }, false, 1);
    ref.current?.editText({ x: 0, y: 0 }, 1);
  });
  expect(request.mock.calls.filter(([method]) => method === "pick")).toHaveLength(1);
  await act(async () => release(undefined));
  act(() => ref.current?.hover({ x: 50, y: 50 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.window).toBeDefined();
});

test("consecutive drag windows retain both results even when the first query is slow", async () => {
  const releases: ((result: { handles: string[] }) => void)[] = [];
  request.mockImplementation(async (method: string, command: string) =>
    method === "query" && command === "bridge.select_polygon"
      ? new Promise((resolve) => {
          releases.push(resolve);
        })
      : { ...scene, entities: [...scene.entities, { handle: "B", type: "Line", layer: "0" }] },
  );
  const { ref, props } = await setup();
  act(() => ref.current?.cancel());
  act(() => {
    ref.current?.window({ x: 0, y: 0 }, { x: 25, y: 25 }, false, 1, false);
    ref.current?.window({ x: 30, y: 0 }, { x: 70, y: 25 }, false, 1, false);
  });
  await act(async () => releases[0]!({ handles: ["A"] }));
  await act(async () => releases[1]!({ handles: ["B"] }));
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["A", "B"]);
});

test("Escape discards both pending window selection and a queued second window", async () => {
  let release!: (result: { handles: string[] }) => void;
  request.mockImplementation(async (method: string, command: string) =>
    method === "query" && command === "bridge.select_polygon"
      ? new Promise((resolve) => {
          release = resolve;
        })
      : scene,
  );
  const { ref, props } = await setup();
  act(() => ref.current?.cancel());
  act(() => {
    ref.current?.window({ x: 0, y: 0 }, { x: 50, y: 50 }, false, 1, false);
    ref.current?.window({ x: 10, y: 0 }, { x: 60, y: 50 }, true, 1, false);
    ref.current?.cancel();
  });
  await act(async () => release({ handles: ["A"] }));
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles ?? []).toEqual([]);
  expect(
    request.mock.calls.filter(
      ([method, command]) => method === "query" && command === "bridge.select_polygon",
    ),
  ).toHaveLength(1);
});

test("empty-space clicks start and complete a window in ordinary selection mode", async () => {
  request.mockImplementation(async (method: string) => {
    if (method === "pick") return undefined;
    if (method === "query") return { handles: ["A"] };
    return scene;
  });
  const { ref, props } = await setup();
  act(() => ref.current?.cancel());
  await act(async () => ref.current?.click({ x: 0, y: 0 }, false, 1));
  act(() => ref.current?.hover({ x: 60, y: 20 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.window?.crossing).toBe(false);
  expect(ref.current?.canWindow()).toBe(false);
  await act(async () => ref.current?.click({ x: 60, y: 20 }, false, 1));
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["A"]);
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toBeNull();
  expect(ref.current?.canWindow()).toBe(true);
});

test("a selected grip cannot steal the second corner and Escape preserves the existing selection", async () => {
  const grippedScene: CadScene = {
    ...scene,
    entities: scene.entities.map((entity) => ({
      ...entity,
      grips: [
        [10, 90],
        [50, 90],
      ],
    })),
  };
  request.mockImplementation(async (method: string) =>
    method === "pick" ? undefined : grippedScene,
  );
  const { ref, props } = await setup();
  act(() => ref.current?.cancel());
  act(() => ref.current?.selectHandles(["A"]));
  await act(async () => ref.current?.click({ x: 60, y: 20 }, false, 1));
  act(() => ref.current?.hover({ x: 0, y: 0 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.window?.crossing).toBe(true);
  expect(ref.current?.beginGrip({ x: 10, y: 10 }, 1)).toBe(false);
  act(() => ref.current?.cancel());
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["A"]);
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toBeNull();
  act(() => ref.current?.hover({ x: 10, y: 10 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.window).toBeUndefined();
});

test("quick second clicks wait for picking without losing the corner or hover preview", async () => {
  let releasePick: (handle: string | undefined) => void = () => {};
  request.mockImplementation(async (method: string) => {
    if (method === "pick")
      return new Promise<string | undefined>((resolve) => {
        releasePick = resolve;
      });
    if (method === "query") return { handles: ["A"] };
    return scene;
  });
  const { ref, props } = await setup();
  act(() => ref.current?.cancel());
  act(() => {
    ref.current?.click({ x: 0, y: 0 }, false, 1);
    ref.current?.hover({ x: 60, y: 20 }, 1, false);
  });
  await act(async () => releasePick(undefined));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.window).toBeDefined();
  act(() => ref.current?.cancel());
  act(() => {
    ref.current?.click({ x: 0, y: 0 }, false, 1);
    ref.current?.click({ x: 60, y: 20 }, false, 1);
  });
  await act(async () => releasePick(undefined));
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["A"]);
});

test("an object click stays a pick and a cancelled delayed pick cannot reopen a window", async () => {
  request.mockImplementation(async (method: string) => (method === "pick" ? "A" : scene));
  const { ref, props } = await setup();
  act(() => ref.current?.cancel());
  await act(async () => ref.current?.click({ x: 25, y: 10 }, false, 1));
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["A"]);
  act(() => ref.current?.hover({ x: 60, y: 20 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.window).toBeUndefined();
  let releasePick: () => void = () => {};
  request.mockImplementation(async (method: string) =>
    method === "pick"
      ? new Promise<undefined>((resolve) => {
          releasePick = () => resolve(undefined);
        })
      : scene,
  );
  act(() => {
    ref.current?.click({ x: 60, y: 20 }, false, 1);
    ref.current?.cancel();
  });
  await act(async () => releasePick());
  act(() => ref.current?.hover({ x: 0, y: 0 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.window).toBeUndefined();
});

test("default two-corner selection retains Shift removals and Enter cancels an unfinished window", async () => {
  request.mockImplementation(async (method: string) =>
    method === "pick" ? undefined : method === "query" ? { handles: [] } : scene,
  );
  const { ref, props } = await setup();
  act(() => ref.current?.selectHandles(["A"]));
  act(() => ref.current?.cancel());
  await act(async () => {
    ref.current?.click({ x: 0, y: 0 }, true, 1);
    ref.current?.hover({ x: 60, y: 20 }, 1, false);
  });
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.window).toBeDefined();
  await act(async () => ref.current?.pointDown({ x: 60, y: 20 }, 1, false, true));
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["A"]);
  await act(async () => ref.current?.click({ x: 0, y: 0 }, false, 1));
  act(() => {
    ref.current?.finish();
    ref.current?.hover({ x: 60, y: 20 }, 1, false);
  });
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]?.window).toBeUndefined();
  expect(vi.mocked(props.onSelection).mock.lastCall?.[0]?.handles).toEqual(["A"]);
});

test("reports tool activity for cursor changes through command choice, cancellation and two-click selection", async () => {
  request.mockImplementation(async (method: string) => (method === "pick" ? undefined : scene));
  const onToolActive = vi.fn();
  const { ref } = await setup({ onToolActive });
  expect(onToolActive.mock.lastCall?.[0]).toBe(true);
  act(() => ref.current?.cancel());
  expect(onToolActive.mock.lastCall?.[0]).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "矩形" }));
  expect(onToolActive.mock.lastCall?.[0]).toBe(true);
  act(() => ref.current?.cancel());
  await act(async () => ref.current?.click({ x: 60, y: 20 }, false, 1));
  expect(onToolActive.mock.lastCall?.[0]).toBe(true);
  act(() => ref.current?.cancel());
  expect(onToolActive.mock.lastCall?.[0]).toBe(false);
});

test("deferred tangency previews and commits the same solved first point, never the initial placeholder", async () => {
  const native: CadScene = {
    ...scene,
    primitives: [],
    entities: [
      {
        handle: "C",
        type: "Circle",
        layer: "0",
        radius: 5,
        grips: [
          [0, 0],
          [5, 0],
          [0, 5],
          [-5, 0],
          [0, -5],
        ],
        geometry: { type: "circle", center: { x: 0, y: 0 }, radius: 5 },
      },
    ],
  };
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene: native } : native,
  );
  const { ref, props } = await setup();
  act(() => ref.current?.click({ x: 3, y: 96 }, false, 0.5));
  expect(request.mock.calls.filter((c) => c[0] === "execute")).toHaveLength(0);
  act(() => ref.current?.hover({ x: 13, y: 100 }, 0.5, false));
  const preview = vi.mocked(props.onPreview).mock.lastCall?.[0];
  expect(preview?.snapType).toBe("tangent");
  expect(preview?.anchor).not.toEqual({ x: 3, y: 4 });
  await act(async () => ref.current?.click({ x: 13, y: 100 }, false, 0.5));
  await act(async () => ref.current?.flush());
  const points = request.mock.calls.find((c) => c[0] === "execute")?.[2].points;
  expect(points[0]).toEqual([preview!.anchor!.x, preview!.anchor!.y]);
  expect(points[1]).toEqual([13, 0]);
});

test("Escape preserves the accepted spline points", async () => {
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene, result: {} } : scene,
  );
  const { ref, props } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "样条曲线" }));
  await act(async () => {
    ref.current?.click({ x: 10, y: 10 }, false, 1);
    ref.current?.click({ x: 20, y: 30 }, false, 1);
    ref.current?.click({ x: 30, y: 10 }, false, 1);
  });
  await act(async () => ref.current?.cancel());
  await vi.waitFor(() => expect(props.onCommit).toHaveBeenCalled());
  expect(
    request.mock.calls.some(([method, command]) => method === "execute" && command === "spline"),
  ).toBe(true);
});

test("drawing tools clear selected objects and polygon focuses its side count", async () => {
  const { ref, props } = await setup();
  act(() => ref.current?.selectHandles(["A"], false));
  fireEvent.click(getTool("正多边形"));
  expect(props.onSelection).toHaveBeenLastCalledWith(expect.objectContaining({ handles: [] }));
  expect(document.activeElement).toBe(screen.getByRole("spinbutton", { name: "边数" }));
  expect(screen.getByRole("button", { name: "偏移" })).toBeDefined();
  expect(screen.getByRole("button", { name: "打断" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "框选 / 交叉选择" })).toBeNull();
  expect(screen.queryByLabelText("所选图形设置")).toBeNull();
});

test("dragging a grip captures an endpoint before axis tracking", async () => {
  const grippedScene: CadScene = {
    ...scene,
    entities: [
      {
        handle: "A",
        type: "Line",
        layer: "0",
        grips: [
          [10, 90],
          [30, 90],
          [50, 90],
        ],
      },
    ],
  };
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene: grippedScene, result: {} } : grippedScene,
  );
  const { ref, props } = await setup();
  act(() => ref.current?.cancel());
  act(() => ref.current?.selectHandles(["A"]));
  act(() => {
    expect(ref.current?.beginGrip({ x: 10, y: 10 }, 1)).toBe(true);
  });
  act(() => ref.current?.hover({ x: 80, y: 10.5 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toMatchObject({
    cursor: { x: 80, y: 90 },
    snapType: "polar",
  });
  act(() => ref.current?.hover({ x: 49.8, y: 10.1 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toMatchObject({
    cursor: { x: 50, y: 90 },
    snapped: true,
    snapType: "endpoint",
  });
  await act(async () => ref.current?.click({ x: 49.8, y: 10.1 }, false, 1));
  expect(request).toHaveBeenCalledWith("execute", "grip.move", {
    handle: "A",
    index: 0,
    to: [50, 90],
  });
});

test("spline captures its own accepted fit point", async () => {
  const { ref, props } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "样条曲线" }));
  act(() => ref.current?.click({ x: 100, y: 100 }, false, 1));
  act(() => ref.current?.click({ x: 120, y: 120 }, false, 1));
  act(() => ref.current?.hover({ x: 100.2, y: 100.1 }, 1, false));
  expect(vi.mocked(props.onPreview).mock.lastCall?.[0]).toMatchObject({
    cursor: { x: 100, y: 0 },
    snapped: true,
    snapType: "endpoint",
  });
});

test("mirror remembers deletion choice and submits it atomically", async () => {
  localStorage.removeItem("cad.mirror.delete-source");
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene, result: {} } : scene,
  );
  const { ref, view } = await setup();
  act(() => ref.current?.selectHandles(["A"]));
  fireEvent.click(screen.getByRole("button", { name: "镜像" }));
  const option = screen.getByRole("checkbox", { name: "删除源对象" });
  expect((option as HTMLInputElement).checked).toBe(false);
  fireEvent.click(option);
  act(() => ref.current?.click({ x: 100, y: 100 }, false, 1));
  await act(async () => ref.current?.click({ x: 100, y: 150 }, false, 1));
  expect(request).toHaveBeenCalledWith(
    "execute",
    "mirror",
    expect.objectContaining({ handles: ["A"], erase: true }),
  );
  view.unmount();
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "镜像" }));
  expect((screen.getByRole("checkbox", { name: "删除源对象" }) as HTMLInputElement).checked).toBe(
    true,
  );
  localStorage.removeItem("cad.mirror.delete-source");
});

test("canvas text commits once and Escape cancels without modifying the document", async () => {
  request.mockImplementation(async (method: string) =>
    method === "execute" ? { bytes, scene, result: {} } : scene,
  );
  const canvas = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  Object.defineProperty(canvas, "viewBox", { value: { baseVal: { width: 100 } } });
  document.body.append(canvas);
  const { ref } = await setup({ getCanvas: () => canvas });
  fireEvent.click(screen.getByRole("button", { name: "文字" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  act(() => ref.current?.click({ x: 100, y: 100 }, false, 1));
  const input = screen.getByRole("textbox", { name: "画布文字" });
  input.textContent="测试文字"; fireEvent.input(input);
  await act(async () => fireEvent.keyDown(input, { key: "Enter",ctrlKey:true }));
  expect(request).toHaveBeenCalledWith("execute", "bridge.text", {
    at: [100, 0],
    text: "测试文字",
    height: 10,
    width:120,
  });
  const count = request.mock.calls.filter(([m]) => m === "execute").length;
  fireEvent.click(screen.getByRole("button", { name: "文字" }));
  act(() => ref.current?.click({ x: 120, y: 100 }, false, 1));
  const cancelled=screen.getByRole("textbox", { name: "画布文字" });
  cancelled.textContent="放弃"; fireEvent.input(cancelled);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "画布文字" }), { key: "Escape" });
  expect(request.mock.calls.filter(([m]) => m === "execute")).toHaveLength(count);
  canvas.remove();
});

test("Shift trim persists an EXTEND result that contains null metadata", async () => {
  request.mockImplementation(async (method: string) =>
    method === "pick" ? "A" : method === "execute" ? { bytes, scene, result: null } : scene,
  );
  const { ref, props } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "修剪" }));
  await act(async () => ref.current?.click({ x: 49, y: 10 }, true, 1, true));
  expect(request).toHaveBeenCalledWith(
    "execute",
    "extend",
    expect.objectContaining({ handle: "A", mode: "quick" }),
  );
  expect(props.onError).not.toHaveBeenCalled();
  expect(props.onCommit).toHaveBeenCalledOnce();
});

test("a confirmed hatch stays interactive while its checkpoint is being saved", async () => {
  const filled: CadScene = {
    ...scene,
    entities: [...scene.entities, { handle: "H", type: "Hatch", layer: "0" }],
  };
  request.mockImplementation(async (method: string, command?: string) => {
    if (method === "execute")
      return {
        bytes,
        scene: filled,
        result: { handles: ["H"], hatches: [{ handle: "H", sources: ["A"] }] },
      };
    if (method === "query" && command === "bridge.preview_modify") return filled;
    if (method === "query" && command === "hatch.patterns")
      return { standard: ["ANSI31"], user: [] };
    if (method === "query" && command === "bridge.hatch_swatches") return [];
    return scene;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const onCommit = vi.fn(async (_bytes: Uint8Array, prepared: (id: string) => void) => {
    prepared("saved-hatch");
    await gate;
    return { bytes, objects: [] as CadPatentObject[], scene: filled };
  });
  const { ref, props } = await setup({ onCommit });
  try {
    fireEvent.click(screen.getByRole("button", { name: "剖面填充" }));
    fireEvent.change(screen.getByLabelText("填充比例"), {target:{value:"7.5"}});
    fireEvent.change(screen.getByLabelText("填充角度（°）"), {target:{value:"30"}});
    fireEvent.change(screen.getByLabelText("缺口容差"), {target:{value:"0.2"}});
    fireEvent.change(screen.getByLabelText("填充策略"), {target:{value:"outer"}});
    act(() => ref.current?.click({ x: 20, y: 70 }, false, 1));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "应用" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledOnce());
    expect(localStorage.getItem("patent-workbench:cad-hatch-preferences:v1")).toBeNull();
    expect(props.onBusy).not.toHaveBeenCalledWith(true);
    expect((screen.getByRole("button", { name: "剖面填充" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByRole("button", { name: "直线" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  } finally {
    await act(async () => {
      release();
      await ref.current?.flush();
    });
  }
  expect(JSON.parse(localStorage.getItem("patent-workbench:cad-hatch-preferences:v1")!)).toEqual({
    pattern:"ANSI31",scale:"7.5",hatchAngle:"30",gapTolerance:"0.2",islandStyle:"outer",
  });
  fireEvent.click(screen.getByRole("button", {name:"剖面填充"}));
  expect((screen.getByLabelText("填充比例") as HTMLInputElement).value).toBe("7.5");
});

test("double-click a hatch opens its existing settings and its centre cannot start grip move", async () => {
  const hatchScene: CadScene = {
    ...scene,
    entities: [{ handle: "H", type: "Hatch", layer: "0", grips: [[20, 30]] }],
  };
  request.mockImplementation(async (method: string, command?: string) => {
    if (method === "pick") return "H";
    if (method === "query" && command === "properties")
      return { objects: [{ geometry: { pattern: "ANSI31", scale: 2, angle: 0 } }] };
    if (method === "query" && command === "hatch.patterns")
      return { standard: ["ANSI31"], user: [] };
    if (method === "query" && command === "bridge.hatch_swatches") return [];
    return hatchScene;
  });
  const { ref } = await setup();
  act(() => ref.current?.cancel());
  act(() => ref.current?.selectHandles(["H"]));
  await act(async () => ref.current?.click({ x: 20, y: 70 }, false, 1));
  expect(screen.queryByText("已选中夹点，点击新位置；Esc 取消。")).toBeNull();
  await act(async () => ref.current?.editText({ x: 20, y: 70 }, 1));
  expect(screen.getByRole("button", { name: "剖面填充" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(request).toHaveBeenCalledWith("query", "properties", { handles: ["H"] });
});

test.each(["cancel", "rejected", "geometry-error", "save-error"])("%s hatch cannot overwrite the last successful appearance", async failure => {
  const storageKey = "patent-workbench:cad-hatch-preferences:v1";
  const previous = JSON.stringify({pattern:"ANSI31",scale:"2",hatchAngle:"0",islandStyle:"normal",gapTolerance:"0.2"});
  localStorage.setItem(storageKey, previous);
  request.mockImplementation(async (method: string, command?: string) => {
    if (method === "execute") {
      if (failure === "geometry-error") throw new Error("hatch geometry failed");
      if (failure === "rejected") return {scene, rejected:"No closed region"};
      return {bytes, scene, result:{handles:["H"]}};
    }
    if (method === "query" && command === "hatch.patterns") return {standard:["ANSI31"],user:[]};
    if (method === "query" && command === "bridge.hatch_swatches") return [];
    return scene;
  });
  const overrides = failure === "save-error" ? {onCommit:vi.fn().mockRejectedValue(new Error("checkpoint failed"))} : {};
  const {ref, props} = await setup(overrides);
  fireEvent.click(screen.getByRole("button",{name:"剖面填充"}));
  fireEvent.change(screen.getByLabelText("填充比例"),{target:{value:"9"}});
  if (failure === "cancel") act(()=>ref.current?.cancel());
  else {
    act(()=>ref.current?.click({x:20,y:70},false,1));
    await waitFor(()=>expect((screen.getByRole("button",{name:"应用"}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button",{name:"应用"}));
    await act(async()=>{await ref.current?.flush();});
    if (failure.endsWith("error")) expect(props.onError).toHaveBeenCalled();
  }
  expect(localStorage.getItem(storageKey)).toBe(previous);
});

test("double-click text editing updates the same object and invalid height retains the draft", async () => {
  const textScene: CadScene = {
    ...scene,
    entities: [
      { handle: "T", type: "Text", layer: "0", text: "原文字", height: 3, grips: [[20, 30]] },
    ],
  };
  request.mockImplementation(async (method: string) =>
    method === "pick"
      ? "T"
      : method === "execute"
        ? { bytes, scene: textScene, result: null }
        : textScene,
  );
  const canvas = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  document.body.append(canvas);
  const { ref, props } = await setup({ getCanvas: () => canvas });
  act(() => ref.current?.cancel());
  await act(async () => ref.current?.editText({ x: 20, y: 70 }, 1));
  const input = screen.getByRole("textbox", { name: "画布文字" });
  expect(input.textContent).toBe("原文字");
  input.textContent="修改文字"; fireEvent.input(input);
  fireEvent.change(screen.getByRole("spinbutton", { name: "字号" }), { target: { value: "0" } });
  fireEvent.keyDown(input, { key: "Enter",ctrlKey:true });
  expect(screen.getByRole("textbox", { name: "画布文字" })).toBe(input);
  expect(props.onCommit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("spinbutton", { name: "字号" }), { target: { value: "4" } });
  await act(async () => fireEvent.keyDown(input, { key: "Enter",ctrlKey:true }));
  expect(request).toHaveBeenCalledWith("execute", "bridge.text", {
    handle: "T",
    text: "修改文字",
    height: 4,
    width:36,
  });
  expect(props.onError).not.toHaveBeenCalled();
  canvas.remove();
});

test("selected object actions remain available as tools without the property card", async () => {
  const { ref } = await setup();
  act(() => ref.current?.selectHandles(["A"]));
  expect(screen.queryByLabelText("所选图形设置")).toBeNull();
  const editing = screen.getByRole("group", { name: "修改" });
  for (const name of ["删除", "合并线段", "分解", "编组", "取消编组", "剖面填充"]) {
    expect(within(editing).getByRole("button", { name })).toBeTruthy();
  }
});

test.each(["canvas", "enter"])(
  "text survives a height adjustment before completing via %s",
  async (finishBy) => {
    request.mockImplementation(async (method: string) =>
      method === "execute" ? { bytes, scene, result: {} } : scene,
    );
    const canvas = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    document.body.append(canvas);
    const { ref, props } = await setup({ getCanvas: () => canvas });
    fireEvent.click(screen.getByRole("button", { name: "文字" }));
    act(() => ref.current?.click({ x: 100, y: 100 }, false, 1));
    const input = screen.getByRole("textbox", { name: "画布文字" });
    input.textContent="保留输入"; fireEvent.input(input);
    const height = screen.getByRole("spinbutton", { name: "字号" });
    fireEvent.blur(input, { relatedTarget: height });
    fireEvent.change(height, { target: { value: "2" } });
    await act(async () => {
      if (finishBy === "canvas") ref.current?.click({ x: 130, y: 130 }, false, 1);
      else fireEvent.keyDown(height, { key: "Enter" });
    });
    expect(request).toHaveBeenCalledWith("execute", "bridge.text", {
      at: [100, 0],
      text: "保留输入",
      height: 2,
      width:120,
    });
    expect(screen.queryByRole("textbox", { name: "画布文字" })).toBeNull();
    expect(props.onCommit).toHaveBeenCalledOnce();
    canvas.remove();
  },
);

test("command guidance lives in the canvas status target and follows tool changes", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const { ref, view } = await setup({ instructionTarget: target });
  expect(screen.getByLabelText("CAD实体编辑").querySelector('[role="status"]')).toBeNull();
  fireEvent.click(getTool("正多边形"));
  expect(target.textContent).toContain("正多边形");
  expect(target.textContent).toContain("输入边数");
  act(() => ref.current?.cancel());
  expect(target.textContent).toContain("选择对象");
  expect(target.textContent).toContain("已取消当前操作");
  view.unmount();
  expect(target.textContent).toBe("");
  target.remove();
});
