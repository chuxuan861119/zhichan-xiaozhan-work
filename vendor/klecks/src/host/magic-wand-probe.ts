import { HostDocument } from './host-document';
import { HostEditorRuntime } from './editor-runtime';
import { selectionMask } from './selection-mask';
import { DesignEditorMetadataSchema } from '../../../../src/shared/patent/design-editor-project';
import { magicWandSelection } from '../../../../src/renderer/src/design-patent/correction/klecks-magic-wand';

export async function verifyMagicWand():Promise<void> {
    const source=document.createElement('canvas');source.width=24;source.height=18;
    const context=source.getContext('2d')!;context.fillStyle='white';context.fillRect(0,0,24,18);
    context.fillStyle='black';context.fillRect(11,0,1,18);context.fillStyle='blue';context.fillRect(3,4,3,3);
    const top=document.createElement('canvas');top.width=24;top.height=18;
    const topContext=top.getContext('2d')!;topContext.fillStyle='red';topContext.fillRect(0,0,2,2);
    const base=new HostDocument({projectId:'wand-test',width:24,height:18,layers:[
        {name:'Base',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:source},
        {name:'Top',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:top},
    ]});
    const host=document.createElement('div');host.style.cssText='width:640px;height:480px';document.body.append(host);
    const errors:unknown[]=[];
    const runtime=new HostEditorRuntime(host,'windows',{changed(){},error(e){errors.push(e);}});
    const check=(value:boolean,message:string)=>{if(!value)throw Error(message);};
    const selected=(image:HostDocument,x:number,y:number)=>{
        const mask=selectionMask(24,18,image.history.getComposed().selection);
        if(!mask)return false;try{return mask.getContext('2d')!.getImageData(x,y,1,1).data[3]>127;}finally{mask.width=mask.height=0;}
    };
    try{
        runtime.sync(['wand']);await runtime.openProject('wand',()=>base.exportProject());
        const image=runtime.workspace.document!,ids=image.canvas.getLayers().map(l=>l.id);
        image.setActiveLayer(ids[0]);runtime.forwardToolKey('w',false);
        check(runtime.state.tool==='magicWand','W did not activate Magic Wand');
        runtime.setWandOptions({tolerance:32,contiguous:true,antiAlias:false,sampleSize:1,sampleAllLayers:false});
        const original=image.contentIdentity(),history=image.capture().history.totalActions;
        runtime.layer({action:'layer',operation:'locks',id:ids[0],locks:{pixels:true,position:true}});
        const afterLocks=image.capture().history.totalActions,afterLockIdentity=image.contentIdentity(),afterLockDirty=runtime.state.dirty;
        await runtime.selectWithWand([0,0,1],'replace');
        check(selected(image,1,1)&&!selected(image,14,1)&&!selected(image,4,5),'Contiguous current-layer selection leaked across borders or filled a hole');
        check(image.capture().history.totalActions===afterLocks+1,'Wand generated more than one history entry');
        check(image.contentIdentity()===afterLockIdentity&&runtime.state.dirty===afterLockDirty,'Selection changed pixels or dirty state');
        runtime.dispatch({action:'undo'});check(!image.canvas.getSelection(),'Wand undo failed');
        runtime.dispatch({action:'redo'});check(selected(image,1,1),'Wand redo failed');
        await runtime.selectWithWand([14,0,1],'add');check(selected(image,1,1)&&selected(image,14,1),'Wand add failed');
        await runtime.selectWithWand([0,0,1],'subtract');check(!selected(image,1,1)&&selected(image,14,1),'Wand subtract failed');
        await runtime.selectWithWand([0,0,1],'intersect');check(!image.canvas.getSelection(),'Wand intersect failed');
        runtime.setWandOptions({...runtime.state.controls.magicWand,contiguous:false});
        await runtime.selectWithWand([0,0,1],'replace');check(selected(image,1,1)&&selected(image,14,1),'Noncontiguous selection failed');
        runtime.setWandOptions({...runtime.state.controls.magicWand,contiguous:true,sampleAllLayers:true});
        await runtime.selectWithWand([0,0,1],'replace');check(selected(image,0,0)&&!selected(image,5,1),'Merged sampling ignored the top visible layer');
        image.setLayerVisibility(ids[1],false);await runtime.selectWithWand([0,0,1],'replace');
        check(selected(image,5,1),'Merged sampling included a hidden layer');
        runtime.layer({action:'layer',operation:'locks',id:ids[0],locks:{pixels:false,position:false}});
        const copied=image.copyPixels();
        check(copied.image.data[(1*copied.image.width+1)*4+3]===255&&copied.image.data[(5*copied.image.width+4)*4+3]===0,'Copy did not respect wand selection holes');
        runtime.dispatch({action:'clear'});
        check(image.canvas.getLayer(0).context.getImageData(1,1,1,1).data[3]===0&&image.canvas.getLayer(0).context.getImageData(14,1,1,1).data[3]===255,'Delete did not respect wand selection');
        runtime.dispatch({action:'undo'});
        const exported=await image.exportProject();DesignEditorMetadataSchema.parse(exported.metadata);
        const restored=await HostDocument.openProject(exported);
        try{check(selected(restored,5,1)&&!selected(restored,14,1),'Saved/restored wand selection changed');}finally{restored.destroy();}
        const previous=JSON.stringify(image.history.getComposed().selection),count=image.capture().history.totalActions;
        const pending=runtime.selectWithWand([14,0,1],'replace');
        runtime.canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
        await pending;await Promise.resolve();
        check(runtime.state.tool==='hand'&&!runtime.state.pending&&JSON.stringify(image.history.getComposed().selection)===previous&&image.capture().history.totalActions===count,'Escape committed a partial selection or did not release the tool');
        runtime.setTool('magicWand');runtime.setWandOptions({...runtime.state.controls.magicWand,tolerance:17,sampleSize:5});
        const preferences=runtime.preferences;runtime.setTool('rectangle');runtime.setTool('magicWand');
        check(runtime.state.controls.magicWand.tolerance===17&&runtime.state.controls.magicWand.sampleSize===5,'Wand preferences were not independent');
        runtime.applyPreferences(preferences);
        const actual=image.canvas.getLayer(0).context.getImageData(0,0,24,18).data,expected=context.getImageData(0,0,24,18).data;
        check(actual.every((value,index)=>value===expected[index])&&history<image.capture().history.totalActions&&errors.length===0,'Wand integration changed pixels or reported unexpected errors');
    }finally{runtime.destroy();base.destroy();host.remove();source.width=source.height=top.width=top.height=0;}
}

export async function verifyMagicWandScheduling():Promise<{milliseconds:number;maxEventLoopGap:number;yields:number}> {
    const width=1600,height=1200,data=new Uint8ClampedArray(width*height*4);data.fill(255);
    const options={tolerance:32,contiguous:true,antiAlias:true,sampleSize:1 as const,sampleAllLayers:false};
    const started=performance.now();let previous=started,maxGap=0,yields=0;
    const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-previous);previous=now;},4);
    try {
        const region=await magicWandSelection({width,height,data},0,0,options,{yieldControl:async()=>{yields++;await new Promise<void>(resolve=>setTimeout(resolve,0));}});
        if(region.length!==1||region[0][0].length!==5||yields<2||maxGap>200)throw Error(`Large wand computation did not stay responsive: ${maxGap} ms, ${yields} yields`);
        const controller=new AbortController();setTimeout(()=>controller.abort(),5);
        let aborted=false;
        try{await magicWandSelection({width,height,data},0,0,options,{signal:controller.signal});}catch(error){aborted=error instanceof DOMException&&error.name==='AbortError';}
        if(!aborted)throw Error('Large wand computation ignored cancellation');
        return {milliseconds:Math.round(performance.now()-started),maxEventLoopGap:Math.round(maxGap),yields};
    }finally{clearInterval(timer);}
}
