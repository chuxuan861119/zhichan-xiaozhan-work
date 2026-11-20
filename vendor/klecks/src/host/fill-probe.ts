import {HostDocument} from './host-document';
import {HostEditorRuntime} from './editor-runtime';
import {DEFAULT_FILL} from '../../../../src/shared/settings/design-fill';
const check=(ok:unknown,message:string)=>{if(!ok)throw Error(message);};
export async function verifyBucket(){
 const source=document.createElement('canvas');source.width=6;source.height=3;const c=source.getContext('2d')!;c.fillStyle='white';c.fillRect(0,0,6,3);c.fillStyle='black';c.fillRect(2,0,1,3);
 const base=new HostDocument({projectId:'bucket',width:6,height:3,layers:[{name:'Base',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:source}]});
 const host=document.createElement('div');host.style.cssText='width:800px;height:600px';document.body.append(host);const errors:unknown[]=[];const r=new HostEditorRuntime(host,'windows',{changed(){},error:e=>errors.push(e)});
 const settle=async()=>{for(let i=0;i<2000&&r.state.fill?.busy;i++)await new Promise(resolve=>setTimeout(resolve,1));check(!r.state.pending,'Bucket left pending state');};
 try{
 r.sync(['a']);await r.openProject('a',()=>base.exportProject());r.setColors({r:255,g:0,b:0},{r:255,g:255,b:255});r.beginFill();check(r.state.tool==='bucket'&&!r.state.fill&&!r.state.pending,'Fill entry did not select unified bucket');
 const image=r.workspace.document!,pixel=(x:number)=>Array.from(image.canvas.getLayer(0).context.getImageData(x,1,1,1).data),history=image.capture().history.totalActions;
 r.bucketAt([.5,1.5,1]);await settle();check(pixel(0)[0]===255&&pixel(0)[1]===0&&pixel(4)[1]===255&&pixel(2)[0]===0,'Contiguous bucket crossed the boundary');check(!image.canvas.getSelection()&&image.capture().history.totalActions===history+1,'Bucket created a selection or extra undo steps');image.undo();
 r.setBucketOptions({...r.state.controls.bucket,contiguous:false});r.bucketAt([.5,1.5,1]);await settle();check(pixel(4)[1]===0&&pixel(2)[0]===0,'Noncontiguous bucket missed disjoint colors');image.undo();
 image.select([[[[3,0],[6,0],[6,3],[3,3],[3,0]]]],'replace');const selection=JSON.stringify(image.history.getComposed().selection),before=image.capture().history.totalActions;
 r.bucketAt([.5,1.5,1]);await settle();check(errors.length===1&&image.capture().history.totalActions===before&&pixel(0)[1]===255,'Outside-selection click was not rejected safely');
 r.bucketAt([4.5,1.5,1]);await settle();check(pixel(4)[1]===0&&pixel(0)[1]===255&&JSON.stringify(image.history.getComposed().selection)===selection,'Bucket did not fill and preserve existing selection');
 image.undo();check(pixel(4)[1]===255,'Bucket undo failed');
 image.deselect();image.newLayer('Fill above');r.setBucketOptions({...r.state.controls.bucket,contiguous:true,sampleAllLayers:true});r.bucketAt([.5,1.5,1]);await settle();
 const overlay=image.canvas.getLayer(1).context;check(overlay.getImageData(0,1,1,1).data[0]===255&&overlay.getImageData(4,1,1,1).data[3]===0&&pixel(0)[1]===255,'All-layer sampling modified source layers or ignored composite boundaries');image.undo();
 }finally{r.destroy();base.destroy();host.remove();source.width=source.height=0;}
}
export async function verifyFill(){
 const source=document.createElement('canvas');source.width=4;source.height=2;
 const c=source.getContext('2d')!;c.fillStyle='rgba(0,0,255,0.5)';c.fillRect(0,0,4,2);c.clearRect(2,0,1,2);
 const image=new HostDocument({projectId:'fill-test',width:4,height:2,layers:[{name:'base',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:source}]});
 const color={r:255,g:0,b:0},options={...DEFAULT_FILL,source:'color' as const,color};
 const pixels=()=>image.canvas.getLayer(0).context.getImageData(0,0,4,2).data;
 const original=Array.from(pixels());
 try{
 const push=image.history.push.bind(image.history);let refused=false;
 image.history.push=()=>{throw Error('Injected history admission failure');};
 try{await image.fillPixels(color,options);}catch{refused=true;}finally{image.history.push=push;}
 check(refused&&pixels().every((v,i)=>v===original[i]),'History admission failure changed original pixels');
 const ring:[number,number][][][]=[[[[0,0],[2,0],[2,2],[0,2],[0,0]]]];
 image.select(ring,'replace',{coverage:{kind:'raster',width:4,height:2,runs:[1,255,1,128,2,0,1,255,1,128,2,0]}});
 const selection=JSON.stringify(image.history.getComposed().selection),history=image.capture().history.totalActions;
 await image.fillPixels(color,options);let p=pixels();check(p[0]===255&&p[3]===255&&Math.abs(p[4]!-170)<=1&&Math.abs(p[7]!-192)<=1&&p[11]===0&&p[14]===255,'Fill ignored soft coverage, transparency or outside selection');
 check(JSON.stringify(image.history.getComposed().selection)===selection&&image.capture().history.totalActions===history+1,'Fill changed selection or created extra undo steps');
 image.undo();check(pixels().every((v,i)=>v===original[i]),'Fill undo lost original pixels');image.redo();check(pixels()[0]===255,'Fill redo failed');
 const saved=await image.exportProject(),reopened=await HostDocument.openProject(saved);try{check(reopened.canvas.getLayer(0).context.getImageData(0,0,4,2).data.every((v,i)=>v===pixels()[i]),'Fill save/reopen pixels changed');}finally{reopened.destroy();}
 image.undo();image.deselect();await image.fillPixels(color,{...options,preserveTransparency:true});p=pixels();check(p[3]===128&&p[0]===255&&p[11]===0,'Preserve transparency changed alpha or painted transparent pixels');image.undo();
 const id=image.layerState().activeLayerId;image.setLayerLocks(id,{pixels:true});const lockedHistory=image.capture().history.totalActions;let rejected=false;try{await image.fillPixels(color,options);}catch{rejected=true;}check(rejected&&image.capture().history.totalActions===lockedHistory,'Locked fill modified history');image.setLayerLocks(id,{pixels:false,alpha:true});await image.fillPixels(color,options);check(pixels()[3]===128&&pixels()[11]===0,'Alpha lock ignored');image.undo();
 image.setLayerLocks(id,{alpha:false});image.setLayerVisibility(id,false);rejected=false;try{await image.fillPixels(color,options);}catch{rejected=true;}check(rejected,'Hidden layer fill not explained');image.setLayerVisibility(id,true);
 const controller=new AbortController(),beforeCancel=image.capture().history.totalActions;const pending=image.fillPixels(color,options,controller.signal);controller.abort();try{await pending;}catch{}check(image.capture().history.totalActions===beforeCancel&&pixels().every((v,i)=>v===original[i]),'Cancelled fill committed pixels');
 }finally{image.destroy();source.width=source.height=0;}
 const big=document.createElement('canvas');big.width=1600;big.height=1200;big.getContext('2d')!.fillRect(0,0,1600,1200);
 const base=new HostDocument({projectId:'fill-runtime',width:1600,height:1200,layers:[{name:'Base',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:big}]});
 const host=document.createElement('div');host.style.cssText='width:800px;height:600px';document.body.append(host);const errors:unknown[]=[];const r=new HostEditorRuntime(host,'windows',{changed(){},error(e){errors.push(e);}});
 let timer:ReturnType<typeof setInterval>|undefined;try{
 r.sync(['a']);await r.openProject('a',()=>base.exportProject());const before=r.workspace.document!.contentIdentity();
 r.dispatch({action:'fillDialog'});check(r.state.tool==='bucket'&&!r.state.fill&&!r.state.pending,'Legacy fill shortcut did not select bucket');r.cancelFill();check(!r.state.fill&&!r.state.pending&&before===r.workspace.document!.contentIdentity(),'Selecting bucket changed pixels');
 let last=performance.now(),maxGap=0;timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;},4);
 r.setColors({r:255,g:255,b:255},{r:0,g:0,b:0});r.dispatch({action:'fillForeground'});for(let i=0;i<3000&&r.state.fill?.busy;i++)await new Promise(resolve=>setTimeout(resolve,2));
 check(!r.state.fill&&r.workspace.document!.canvas.getLayer(0).context.getImageData(0,0,1,1).data[0]===255&&errors.length===0,'Quick fill failed or left pending state');check(maxGap<200,'Fill blocked event loop for '+maxGap+' ms');
 r.dispatch({action:'undo'});check(before===r.workspace.document!.contentIdentity(),'Runtime fill undo failed');
 r.dispatch({action:'fillForeground'});r.canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));for(let i=0;i<3000&&r.state.fill?.busy;i++)await new Promise(resolve=>setTimeout(resolve,2));
 check(!r.state.fill&&!r.state.pending&&before===r.workspace.document!.contentIdentity()&&errors.length===0,'Escape did not cancel quick fill cleanly');
 r.setTool('bucket');r.bucketAt([5,5,1]);r.canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));for(let i=0;i<3000&&r.state.fill?.busy;i++)await new Promise(resolve=>setTimeout(resolve,2));
 check(before===r.workspace.document!.contentIdentity()&&!r.state.pending&&errors.length===0,'Bucket region detection cancellation changed image');
 r.setTool('bucket');r.bucketAt([5,5,1]);for(let i=0;i<3000&&r.state.fill?.busy;i++)await new Promise(resolve=>setTimeout(resolve,2));check(!r.state.pending&&r.workspace.document!.canvas.getLayer(0).context.getImageData(0,0,1,1).data[0]===255,'Large bucket failed');r.dispatch({action:'undo'});
 console.log('1.92MP fill maximum event loop gap: '+Math.round(maxGap)+'ms');
 }finally{if(timer)clearInterval(timer);r.destroy();base.destroy();big.width=big.height=0;host.remove();}
}
