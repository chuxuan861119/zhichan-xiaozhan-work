import { HostEditorRuntime } from './editor-runtime';
import { HostDocument } from './host-document';
import { selectionMask } from './selection-mask';
import { DesignEditorMetadataSchema } from '../../../../src/shared/patent/design-editor-project';
import { ColorRangeSession } from './color-range-session';
import { DEFAULT_COLOR_RANGE } from '../../../../src/shared/settings/design-color-range';
const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const settled=async(r:HostEditorRuntime)=>{for(let i=0;i<2000;i++){if(!r.state.colorRange?.busy)return;await new Promise(resolve=>setTimeout(resolve,1));}throw Error('Range calculation timed out');};
export async function verifyColorRangeAudit():Promise<void>{
 const source=document.createElement('canvas');source.width=4;source.height=1;const c=source.getContext('2d')!;
 c.fillStyle='white';c.fillRect(0,0,1,1);c.fillStyle='black';c.fillRect(1,0,1,1);c.fillStyle='rgba(100,150,200,0.5)';c.fillRect(3,0,1,1);
 const image=new HostDocument({projectId:'range-audit',width:4,height:1,layers:[{name:'Base',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:source}]});
 let preview:HTMLCanvasElement|null=null,draft:ColorRangeSession|null=null;
 const failures:string[]=[];
 const settle=async()=>{for(let i=0;i<2000;i++){if(!draft?.state.busy)return;await new Promise(r=>setTimeout(r,1));}throw Error('Audit timeout');};
 const open=(options:Partial<typeof DEFAULT_COLOR_RANGE>)=>{draft?.close();draft=new ColorRangeSession(image,{...DEFAULT_COLOR_RANGE,fuzziness:0,...options},{read:()=>({width:4,height:1,data:c.getImageData(0,0,4,1).data}),preview:value=>{preview?.remove();preview=value;},changed(){},remember(){},release(){}});draft.start();return draft;};
 try{
  const region:[number,number][][][]=[[[[0,0],[1,0],[1,1],[0,1],[0,0]]]];
  image.select(region,'replace');let s=open({mode:'intersect'});s.sample(1,0);await settle();
  if(!s.state.canApply)failures.push('A disjoint intersection cannot be confirmed to clear the old selection');else{s.apply();if(image.canvas.getSelection())failures.push('Empty intersection retained old selection');image.undo();}
  image.select(region,'replace');s=open({mode:'subtract'});s.sample(0,0);await settle();
  if(!s.state.canApply)failures.push('Subtracting the entire selection cannot be confirmed');else{s.apply();if(image.canvas.getSelection())failures.push('Empty subtraction retained old selection');image.undo();}
  s=open({preview:'black'});s.sample(3,0);await settle();
  let p=(preview as HTMLCanvasElement|null)?.getContext('2d')?.getImageData(2,0,2,1).data;
  if(!p||p[3]!==255||p[0]!==0||p[7]!==255||Math.abs(p[4]!-50)>1)failures.push('Black matte fails to render transparent and semi-transparent pixels against an opaque backdrop');
  s.update({...s.state.options,preview:'white'});await settle();p=(preview as HTMLCanvasElement|null)?.getContext('2d')?.getImageData(2,0,2,1).data;
  if(!p||p[3]!==255||p[0]!==255||p[7]!==255||Math.abs(p[4]!-177)>1)failures.push('White matte fails to render transparent and semi-transparent pixels against an opaque backdrop');
 }finally{draft?.close();image.destroy();source.width=source.height=0;}
 if(failures.length)throw Error(failures.join('\n'));
}
export async function verifyColorRange():Promise<void>{
 const blank=document.createElement('canvas');blank.width=2;blank.height=1;
 const soft=new HostDocument({projectId:'range-invert',width:2,height:1,layers:[{name:'Base',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:blank}]});
 try{
  const full:[number,number][][][]=[[[[0,0],[2,0],[2,1],[0,1],[0,0]]]];
  soft.select(full,'replace',{coverage:{kind:'raster',width:2,height:1,runs:[1,255,1,205]}});soft.invertSelection();
  let mask=selectionMask(2,1,soft.history.getComposed().selection);
  check(mask,'Invert lost a partially selected full-frame region');
  try{check(mask!.getContext('2d')!.getImageData(1,0,1,1).data[3]===50,'Invert did not complement exact soft weight');}finally{if(mask)mask.width=mask.height=0;}
  soft.invertSelection();check(soft.selectionContains(.5,.5)&&soft.selectionContains(1.5,.5),'Double invert restored mask weights but not selection hit testing');
  soft.select(full,'subtract',{coverage:{kind:'raster',width:2,height:1,runs:[2,100]}});
  mask=selectionMask(2,1,soft.history.getComposed().selection);
  try{check(mask&&mask.getContext('2d')!.getImageData(0,0,1,1).data[3]===155&&mask.getContext('2d')!.getImageData(1,0,1,1).data[3]===105,'Soft subtract lost remaining coverage');}finally{if(mask)mask.width=mask.height=0;}
  const largeRing=Array.from({length:50000},(_,i)=>[i%2,Math.floor(i/2)%2] as [number,number]);largeRing[largeRing.length-1]=[...largeRing[0]!] as [number,number];
  soft.history.push({selection:{value:undefined,previous:{value:[[largeRing]]}}});const priorHistory=soft.capture().history.totalActions;let budgetRejected=false;
  try{soft.select(full,'replace');}catch{budgetRejected=true;}
  check(budgetRejected&&soft.capture().history.totalActions===priorHistory,'Selection allowed an unsavable outline plus previous-selection history');
 }finally{soft.destroy();blank.width=blank.height=0;}
 const source=document.createElement('canvas');source.width=64;source.height=48;const c=source.getContext('2d')!;c.fillStyle='white';c.fillRect(0,0,64,48);c.fillStyle='rgb(100,100,100)';c.fillRect(2,3,8,8);c.fillStyle='rgb(110,110,110)';c.fillRect(30,3,8,8);c.clearRect(4,5,2,2);
 const base=new HostDocument({projectId:'range',width:64,height:48,layers:[{name:'Base',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:source}]});
 const host=document.createElement('div');host.style.cssText='width:800px;height:600px';document.body.append(host);const errors:unknown[]=[];
 const r=new HostEditorRuntime(host,'windows',{changed(){},error:e=>errors.push(e)});
 try{
 r.sync(['a','b']);await r.openProject('a',()=>base.exportProject());const doc=r.workspace.document!,pixels=doc.contentIdentity();
 doc.selectAll();const original=JSON.stringify(doc.history.getComposed().selection),history=doc.capture().history.totalActions;
 r.beginColorRange();r.sampleColorRange(2,3,'replace');await settled(r);
 check(r.state.colorRange?.canApply&&!r.state.colorRange.error,'Range did not calculate');
 check(doc.capture().history.totalActions===history&&doc.contentIdentity()===pixels&&JSON.stringify(doc.history.getComposed().selection)===original,'Preview changed source/history/selection');
 r.cancelColorRange();check(!r.state.pending&&JSON.stringify(doc.history.getComposed().selection)===original,'Cancel changed selection or left pending state');
 r.beginColorRange();r.sampleColorRange(2,3,'replace');await settled(r);r.applyColorRange();
 check(doc.capture().history.totalActions===history+1,'Range did not commit as one undo step');
 let mask=selectionMask(64,48,doc.history.getComposed().selection)!;
 try{const alpha=mask.getContext('2d')!;check(alpha.getImageData(2,3,1,1).data[3]===255&&alpha.getImageData(30,3,1,1).data[3]>0&&alpha.getImageData(30,3,1,1).data[3]<255&&alpha.getImageData(4,5,1,1).data[3]===0,'Partial weights or transparent holes wrong');}finally{mask.width=mask.height=0;}
 const copy=doc.copyPixels();check(copy.image.width<64,'Range copy kept document padding');doc.pastePixels(copy,true);check(!doc.canvas.getSelection(),'Range paste left selection');doc.undo();
 const selectedBefore=JSON.stringify(doc.history.getComposed().selection),clipboardBefore=doc.copyPixels();
 doc.moveSelection(2,1);doc.moveSelection(-2,-1);const clipboardAfter=doc.copyPixels();
 check(clipboardBefore.x===clipboardAfter.x&&clipboardBefore.y===clipboardAfter.y&&clipboardBefore.image.data.every((v,i)=>v===clipboardAfter.image.data[i]),'Range boundary round-trip changed mask weights');doc.undo();doc.undo();
 check(JSON.stringify(doc.history.getComposed().selection)===selectedBefore,'Undo boundary move lost original range');
 doc.flipCanvas('horizontal');doc.undo();check(JSON.stringify(doc.history.getComposed().selection)===selectedBefore,'Canvas mirror undo lost raster weights');
 const saved=await doc.exportProject();DesignEditorMetadataSchema.parse(saved.metadata);const reopened=await HostDocument.openProject(saved);
 try{const a=doc.copyPixels(),b=reopened.copyPixels();check(a.x===b.x&&a.y===b.y&&a.image.data.every((v,i)=>v===b.image.data[i]),'Saved range weights changed');}finally{reopened.destroy();}
 r.dispatch({action:'undo'});check(JSON.stringify(doc.history.getComposed().selection)===original,'Undo lost original selection');r.dispatch({action:'redo'});
 r.beginColorRange();r.sampleColorRange(2,3,'replace');r.setColorRangeOptions({...r.state.colorRange!.options,fuzziness:0});await settled(r);r.applyColorRange();check(!doc.selectionContains(30,3),'Zero fuzziness did not restrict exact colors');
 r.beginColorRange();r.sampleColorRange(2,3,'replace');r.sampleColorRange(30,3,'add');await settled(r);r.sampleColorRange(30,3,'subtract');await settled(r);r.cancelColorRange();
 r.beginColorRange();r.sampleColorRange(2,3,'replace');r.cancelColorRange();await new Promise(resolve=>setTimeout(resolve,10));check(!r.state.colorRange&&!r.state.pending,'Late calculation resurrected canceled draft');
 check(doc.contentIdentity()===pixels&&errors.length===0,'Color range changed document pixels or reported errors');
 }finally{r.destroy();base.destroy();host.remove();source.width=source.height=0;}
}
export async function verifyColorRangePerformance():Promise<{milliseconds:number;maxEventLoopGap:number}>{
 const source=document.createElement('canvas');source.width=1600;source.height=1200;source.getContext('2d')!.fillStyle='white';source.getContext('2d')!.fillRect(0,0,1600,1200);
 const base=new HostDocument({projectId:'range-performance',width:1600,height:1200,layers:[{name:'Base',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:source}]});
 const host=document.createElement('div');host.style.cssText='width:800px;height:600px';document.body.append(host);const r=new HostEditorRuntime(host,'windows',{changed(){},error(e){throw e;}});
 let timer:ReturnType<typeof setInterval>|undefined;
 try{r.sync(['large']);await r.openProject('large',()=>base.exportProject());const before=r.workspace.document!.contentIdentity(),start=performance.now();let previous=start,maxGap=0;
  timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-previous);previous=now;},4);
  r.beginColorRange();r.sampleColorRange(5,5,'replace');
  for(let i=0;i<12;i++)r.setColorRangeOptions({...r.state.colorRange!.options,fuzziness:i*10});
  await settled(r);check(r.state.colorRange!.canApply&&r.state.colorRange!.options.fuzziness===110,'Slider burst did not commit latest preview');
  r.applyColorRange();check(r.workspace.document!.contentIdentity()===before,'Large range changed pixels');
  r.beginColorRange();r.sampleColorRange(5,5,'replace');r.cancelColorRange();await new Promise(resolve=>setTimeout(resolve,50));
  check(!r.state.colorRange&&!r.state.pending&&maxGap<200,'Large range cancellation or responsiveness failed: '+maxGap);
  return {milliseconds:Math.round(performance.now()-start),maxEventLoopGap:Math.round(maxGap)};
 }finally{if(timer)clearInterval(timer);r.destroy();base.destroy();host.remove();source.width=source.height=0;}
}
