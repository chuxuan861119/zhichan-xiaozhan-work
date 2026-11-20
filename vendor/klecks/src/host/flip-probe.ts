import { HostDocument } from './host-document';
import { HostEditorRuntime } from './editor-runtime';
import { grantedKlecksResourcePolicy } from '../../../../src/renderer/src/design-patent/correction/klecks-resource-budget';

// Development-only pixel assertions; never loaded by the application.
export async function verifyFlips(): Promise<void> {
    // Mouse positions at non-integer zoom produce fractional marquee coordinates.
    const lines=document.createElement('canvas');lines.width=370;lines.height=169;
    const lineContext=lines.getContext('2d')!;
    lineContext.fillStyle='white';lineContext.fillRect(0,0,370,169);
    lineContext.fillStyle='black';
    for(let y=0;y<169;y+=3)lineContext.fillRect(0,y,370,1);
    for(let x=9;x<370;x+=7)lineContext.fillRect(x,0,1,169);
    const lineImage=new HostDocument({projectId:'fractional-mirror',width:370,height:169,layers:[{name:'Lines',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:lines}]});
    try {
        for(const axis of ['horizontal','vertical'] as const)for(const feather of [0,1])for(const alpha of [255,128]) {
            const source=document.createElement('canvas');source.width=40;source.height=30;
            const context=source.getContext('2d')!,data=context.createImageData(40,30);
            for(let i=0;i<data.data.length;i+=4){data.data[i]=40;data.data[i+1]=90;data.data[i+2]=140;data.data[i+3]=alpha;}
            context.putImageData(data,0,0);
            const fixture=new HostDocument({projectId:'mirror-alpha',width:40,height:30,layers:[{name:'Alpha',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:source}]});
            const host=document.createElement('div');host.style.cssText='width:640px;height:480px';document.body.append(host);
            const runtime=new HostEditorRuntime(host,'windows',{changed(){},error(e){throw e;}},grantedKlecksResourcePolicy(512*1024*1024));
            try {
                runtime.sync(['alpha']);await runtime.openProject('alpha',()=>fixture.exportProject());
                const image=runtime.workspace.document!;
                image.select([[[[7.2,6.2],[32.8,6.2],[32.8,23.8],[7.2,23.8],[7.2,6.2]]]],'replace',{antiAlias:true,feather});
                for(let repeat=0;repeat<4;repeat++) {
                    runtime.flip(axis,'pixels');
                    const result=image.canvas.getLayer(0).context.getImageData(0,0,40,30).data;
                    for(let i=3;i<result.length;i+=4)if(Math.abs(result[i]-alpha)>1)throw Error(`${axis} mirror left a transparent seam: alpha ${result[i]}, expected ${alpha}, feather ${feather}`);
                }
                image.select([[[[4,4],[10,4],[10,10],[4,10],[4,4]]]],'replace',{antiAlias:false});
                image.transformPixels({a:1,b:0,c:0,d:1,e:15,f:0});
                const context=image.canvas.getLayer(0).context;
                const destination=context.getImageData(20,5,1,1).data[3];
                const expected=Math.round(alpha+alpha*(1-alpha/255));
                if(Math.abs(destination-expected)>1||context.getImageData(5,5,1,1).data[3]!==0||Math.abs(context.getImageData(35,20,1,1).data[3]-alpha)>1)throw Error('Selection recomposition changed unrelated alpha or filled a genuinely vacated area');
            } finally {runtime.destroy();fixture.destroy();host.remove();source.width=source.height=0;}
        }
        for(const axis of ['vertical','horizontal'] as const)for(const draft of [false,true])for(const antiAlias of [false,true]) {
            const host=document.createElement('div');host.style.cssText='width:640px;height:480px';document.body.append(host);
            const runtime=new HostEditorRuntime(host,'windows',{changed(){},error(e){throw e;}},grantedKlecksResourcePolicy(512*1024*1024));
            try {
                runtime.sync(['lines']);await runtime.openProject('lines',()=>lineImage.exportProject());
                const image=runtime.workspace.document!;
                image.select([[[[5.2,5.2],[358.2,5.2],[358.2,158.2],[5.2,158.2],[5.2,5.2]]]],'replace',{antiAlias});
                const before=Array.from(image.canvas.getLayer(0).context.getImageData(0,0,370,169).data);
                if(draft)runtime.beginTransform();
                runtime.flip(axis,'pixels');
                if(draft)runtime.applyTransform();
                const after=image.canvas.getLayer(0).context.getImageData(0,0,370,169).data;
                if(after[4]!==before[4])throw Error(`Outside selection changed on first flip: ${axis}, ${after[4]}, expected ${before[4]}`);
                for(let y=12;y<145;y++)for(let x=12;x<345;x++) {
                    const value=after[(y*370+x)*4];
                    if(value!==0&&value!==255)throw Error(`${axis} mirror blurred binary line pixels with fractional selection (${draft?'transform':'direct'})`);
                }
                if(draft)runtime.beginTransform();
                runtime.flip(axis,'pixels');
                if(draft)runtime.applyTransform();
                const restored=image.canvas.getLayer(0).context.getImageData(0,0,370,169).data;
                if(!antiAlias&&before.some((value,index)=>restored[index]!==value)){
                    const index=before.findIndex((value,index)=>restored[index]!==value);
                    throw Error(`Double mirror did not restore exact original pixels (${axis}, draft ${draft}, pixel ${Math.floor(index/4)%370},${Math.floor(index/4/370)}, channel ${index%4}: ${before[index]} => ${restored[index]})`);
                }
            } finally {runtime.destroy();host.remove();}
        }
    } finally {lineImage.destroy();lines.width=lines.height=0;}
    const source=document.createElement('canvas');source.width=20;source.height=16;
    const ctx=source.getContext('2d')!;
    ctx.fillStyle='red';ctx.fillRect(2,3,1,1);
    ctx.fillStyle='blue';ctx.fillRect(5,3,1,1);
    ctx.fillStyle='lime';ctx.fillRect(10,4,1,1);
    const base=new HostDocument({projectId:'mirror-fixture',width:20,height:16,layers:[{name:'Source',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:source}]});
    const pixel=(image:HostDocument,x:number,y:number,index=0)=>Array.from(image.canvas.getLayer(index).context.getImageData(x,y,1,1).data);
    const check=(ok:boolean,message:string)=>{if(!ok)throw new Error(message);};
    const original=base.capture();
    try {
        for(const axis of ['horizontal','vertical'] as const){
            const image=HostDocument.restore(original);
            try{
                const before=image.contentIdentity(),history=image.capture().history.totalActions;
                image.flipCanvas(axis);
                check(pixel(image,axis==='horizontal'?17:2,axis==='vertical'?12:3)[0]===255,'Canvas mirror mapped the wrong pixel');
                check(image.canvas.getWidth()===20&&image.canvas.getHeight()===16,'Mirror changed dimensions');
                check(image.capture().history.totalActions===history+1,'Mirror was not one undo step');
                image.undo();check(image.contentIdentity()===before,'Canvas mirror undo lost pixels');
                image.redo();image.flipCanvas(axis);check(pixel(image,2,3)[0]===255,'Double reflection failed');
            }finally{image.destroy();}
        }
        const all=new HostDocument({projectId:'mirror-layers',width:20,height:16,layers:[
            {name:'Base',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:source},
            {name:'Hidden',opacity:0.5,isVisible:false,hasClipping:false,mixModeStr:'source-over',image:source},
        ]});
        try{
            const ids=all.canvas.getLayers().map(layer=>layer.id);
            all.setSelectedLayers(ids,ids[1]);
            all.transformPixels({a:-1,b:0,c:0,d:1,e:13,f:0});
            check(pixel(all,10,3,0)[0]===255&&pixel(all,10,3,1)[0]===255,'Selected-layer group mirror lost a layer');
            all.undo();
            all.setLayerLocks(all.canvas.getLayer(1).id,{all:true});
            all.select([[[[1,2],[6,2],[6,6],[1,6],[1,2]]]],'replace');
            all.flipCanvas('horizontal');
            check(pixel(all,17,3,0)[0]===255&&pixel(all,17,3,1)[0]===255,'Canvas mirror skipped hidden or locked layer');
            check(!all.canvas.getLayer(1).isVisible&&all.getLayerLocks(all.canvas.getLayer(1).id).all,'Canvas mirror lost layer properties');
            check(all.canvas.getSelection()!.flat(2).some(p=>p[0]===19),'Canvas mirror did not reflect selection');
        }finally{all.destroy();}
        const backing=HostDocument.restore(original);
        try{
            backing.resizeCanvas(8,6,{horizontal:'left',vertical:'top'});
            backing.flipCanvas('horizontal');
            const reopened=await HostDocument.openProject(await backing.exportProject());
            try{
                reopened.flipCanvas('horizontal');reopened.resizeCanvas(20,16,{horizontal:'left',vertical:'top'});
                check(pixel(reopened,10,4)[1]===255,'Saved mirror lost off-canvas pixels');
            }finally{reopened.destroy();}
        }finally{backing.destroy();}
        const host=document.createElement('div');host.style.cssText='width:640px;height:480px';document.body.append(host);
        const errors:unknown[]=[];
        const runtime=new HostEditorRuntime(host,'windows',{changed(){},error(e){errors.push(e);}},grantedKlecksResourcePolicy(512*1024*1024));
        try{
            runtime.sync(['mirror']);await runtime.openProject('mirror',()=>base.exportProject());
            const image=runtime.workspace.document!;
            runtime.flip('horizontal','pixels');
            check(pixel(image,10,3)[0]===255&&pixel(image,2,4)[1]===255,'Whole layer mirror used the canvas center instead of content bounds');
            runtime.dispatch({action:'undo'});
            image.select([[[[2,3],[6,3],[6,5],[2,5],[2,3]]]],'replace');
            const history=image.capture().history.totalActions;
            runtime.flip('horizontal','pixels');
            check(pixel(image,5,3)[0]===255&&pixel(image,2,3)[2]===255&&pixel(image,10,4)[1]===255,'Selected mirror changed unrelated pixels or used canvas pivot');
            check(image.capture().history.totalActions===history+1,'Selected mirror created extra undo steps');
            runtime.dispatch({action:'undo'});check(pixel(image,2,3)[0]===255,'Selected mirror undo failed');
            runtime.dispatch({action:'redo'});check(pixel(image,5,3)[0]===255,'Selected mirror redo failed');
            runtime.dispatch({action:'undo'});
            runtime.beginTransform();const identity=image.contentIdentity();
            runtime.flip('horizontal','pixels');
            check(image.contentIdentity()===identity&&runtime.state.pending,'Transform mirror committed before confirmation');
            runtime.dispatch({action:'undo'});check(runtime.state.controls.transform!.matrix.a===1,'Transform mirror Ctrl Z failed');
            runtime.dispatch({action:'redo'});check(runtime.state.controls.transform!.matrix.a===-1,'Transform mirror redo failed');
            runtime.cancelTransform();check(image.contentIdentity()===identity,'Cancel mirror changed pixels');
            runtime.beginTransform();runtime.flip('vertical','pixels');runtime.applyTransform();
            check(pixel(image,2,4)[0]===255&&pixel(image,2,3)[3]===0&&pixel(image,10,4)[1]===255,'Vertical selected mirror commit failed');
            runtime.dispatch({action:'undo'});
            image.deselect();
            image.select([[[[2,3],[6,3],[2,5],[2,3]]]],'replace');
            const outlineIdentity=image.contentIdentity();
            runtime.beginTransform('selection');runtime.flip('horizontal','pixels');runtime.applyTransform();
            check(image.contentIdentity()===outlineIdentity&&image.canvas.getSelection()!.flat(2).some(p=>p[0]===6&&p[1]===5),'Transform-selection mirror modified pixels or failed to flip the outline');
            image.deselect();
            const id=image.layerState().activeLayerId;image.setLayerLocks(id,{pixels:true});
            const locked=image.contentIdentity(),lockedHistory=image.capture().history.totalActions;
            let refused=false;try{runtime.flip('horizontal','pixels');}catch{refused=true;}
            check(refused&&image.contentIdentity()===locked&&image.capture().history.totalActions===lockedHistory,'Mirror bypassed lock or changed pixels on rejection');
            runtime.flip('horizontal','canvas');
            check(pixel(image,17,3)[0]===255,'Whole canvas incorrectly refused a locked layer');
            check(errors.length===0,'Runtime mirror reported an unexpected error');
        }finally{runtime.destroy();host.remove();}
    }finally{base.destroy();source.width=source.height=0;}
}
