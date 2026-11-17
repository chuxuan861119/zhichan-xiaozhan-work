import { expect, test } from "vitest";
import { hitsCadSelection } from "./cad-selection-hit";
import type { CadScene } from "./cadcraft-client";

const scene: CadScene = {
  revision:1, entityCount:2, selection:[], bounds:null,
  svgFrame:{origin:[0,0],width:100,height:100},
  entities:[{handle:"A",type:"Line",layer:"0"},{handle:"B",type:"Solid",layer:"0"}],
  primitives:[
    {handle:"A",kind:"polyline",points:[[0,0],[100,0]],color:[0,0,0],aci7:true,lineweight:0},
    {handle:"B",kind:"triangles",points:[[0,10],[20,10],[0,30]],color:[0,0,0],aci7:true,lineweight:0},
  ],
};
test("hits only selected visible unlocked strokes within screen-scaled tolerance",()=>{
  expect(hitsCadSelection(scene,["A"],{x:25,y:1},2)).toBe(true);
  expect(hitsCadSelection(scene,["A"],{x:25,y:3},2)).toBe(false);
  expect(hitsCadSelection(scene,["B"],{x:25,y:0},2)).toBe(false);
  for(const state of [{locked:true},{visible:false}])
    expect(hitsCadSelection({...scene,entities:[{...scene.entities[0]!,...state}]},["A"],{x:25,y:0},2)).toBe(false);
});
test("filled triangles are hittable but triangle bounds, masks and polyline interiors are not",()=>{
  expect(hitsCadSelection(scene,["B"],{x:5,y:15},1)).toBe(true);
  expect(hitsCadSelection(scene,["B"],{x:18,y:28},1)).toBe(false);
  for(const kind of ["mask","polyline"])
    expect(hitsCadSelection({...scene,primitives:[{...scene.primitives[1]!,kind}]},["B"],{x:5,y:15},1)).toBe(false);
});
test("point primitives and degenerate segments do not cause NaN hits",()=>{
  const point={...scene.primitives[0]!,kind:"point",points:[[1,1]] as [number,number][]};
  expect(hitsCadSelection({...scene,primitives:[point]},["A"],{x:1,y:1},0.1)).toBe(true);
  expect(hitsCadSelection({...scene,primitives:[{...point,kind:"polyline",points:[[1,1],[1,1]]}]},["A"],{x:4,y:1},0.1)).toBe(false);
});
test("imported rays and infinite lines are hit on their displayed extensions",()=>{
  const source=(kind:string)=>({...scene,primitives:[{...scene.primitives[0]!,kind,points:[[20,10],[1,0]] as [number,number][]}]});
  expect(hitsCadSelection(source("ray"),["A"],{x:150,y:10},1)).toBe(true);
  expect(hitsCadSelection(source("ray"),["A"],{x:-50,y:10},1)).toBe(false);
  expect(hitsCadSelection(source("infinite"),["A"],{x:-50,y:10},1)).toBe(true);
});
