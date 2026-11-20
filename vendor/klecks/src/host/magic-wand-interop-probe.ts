import { HostDocument } from './host-document';
import { HostEditorRuntime } from './editor-runtime';
import { selectionMask } from './selection-mask';
import { HostFrameWorkspace } from './frame-workspace';
import { bindKlecksCommandPort } from '../../../../src/renderer/src/design-patent/correction/klecks-command-port';
import { connectKlecksFrame } from '../../../../src/renderer/src/design-patent/correction/klecks-frame-client';
import { KlecksNativeClipboard } from '../../../../src/renderer/src/design-patent/correction/klecks-native-clipboard';
import type { ClipboardImage } from '../../../../src/shared/ipc/contract';

const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const box=(x:number,y:number,w:number,h:number):[number,number][][][]=>[[[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]]];
export async function verifyMagicWandInteroperability():Promise<void>{
    const source=document.createElement('canvas');source.width=40;source.height=30;
    const context=source.getContext('2d')!;context.fillStyle='white';context.fillRect(0,0,40,30);
    context.fillStyle='red';context.fillRect(2,3,6,8);context.clearRect(4,5,2,2);
    context.fillStyle='blue';context.fillRect(20,3,6,8);
    const base=new HostDocument({projectId:'wand-interop',width:40,height:30,layers:[{name:'Base',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:source}]});
    const host=document.createElement('div');host.style.cssText='width:640px;height:480px';document.body.append(host);
    const errors:unknown[]=[],runtime=new HostEditorRuntime(host,'windows',{changed(){},error(e){errors.push(e);}});
    try{
        runtime.sync(['a','b']);await runtime.openProject('a',()=>base.exportProject());
        const image=runtime.workspace.document!,baseId=image.layerState().activeLayerId!;
        runtime.setTool('magicWand');runtime.setWandOptions({tolerance:0,contiguous:true,antiAlias:false,sampleSize:1,sampleAllLayers:false});
        await runtime.selectWithWand([2,3,1],'replace');
        const originalSelection=JSON.stringify(image.history.getComposed().selection),originalPixels=source.toDataURL();
        // A selected island must not carry full-document transparent padding into paste.
        const copied=image.copyPixels();
        check(copied.x===2&&copied.y===3&&copied.image.width===6&&copied.image.height===8,'Wand copy includes transparent document padding rather than selected pixels');
        check(copied.image.data[(2*6+2)*4+3]===0,'Wand copy filled a transparent hole');
        // Repeated Shift-clicks on already included colors must not exhaust mask history.
        await runtime.selectWithWand([20,3,1],'add');
        for(let i=0;i<20;i++)await runtime.selectWithWand([20,3,1],'add');
        check(image.selectionContains(2,3)&&image.selectionContains(20,3),'Repeated add lost a selected region');
        await runtime.selectWithWand([2,3,1],'replace');
        runtime.dispatch({action:'copy'});runtime.dispatch({action:'paste'});
        check(image.canvas.getLayerCount()===2&&!image.canvas.getSelection(),'Paste did not create a layer and clear selection');
        check(image.canvas.getLayer(1).context.getImageData(17,11,1,1).data[0]===255&&image.canvas.getLayer(1).context.getImageData(2,3,1,1).data[3]===0,'Normal paste did not center selected content');
        runtime.dispatch({action:'undo'});
        check(image.canvas.getLayerCount()===1&&JSON.stringify(image.history.getComposed().selection)===originalSelection,'Undo paste lost the wand selection');
        runtime.dispatch({action:'pasteInPlace'});
        check(image.canvas.getLayer(1).context.getImageData(2,3,1,1).data[3]===255&&!image.canvas.getSelection(),'Paste in place changed coordinates or left selection active');
        runtime.dispatch({action:'undo'});runtime.dispatch({action:'layerViaCopy'});
        check(image.canvas.getLayerCount()===2&&!image.canvas.getSelection(),'Layer via copy did not clear selection');
        runtime.dispatch({action:'undo'});
        for(const tool of ['rectangle','ellipse','lasso','polygon','magicWand'] as const){runtime.setTool(tool);check(JSON.stringify(image.history.getComposed().selection)===originalSelection,'Switching selection tool changed existing wand coverage');}
        image.select(box(20,3,6,8),'add',{antiAlias:false});
        check(image.selectionContains(2,3)&&image.selectionContains(20,3),'Shape add did not combine with wand');
        image.select(box(20,3,6,8),'subtract',{antiAlias:false});
        check(image.selectionContains(2,3)&&!image.selectionContains(20,3),'Shape subtract did not preserve wand region');
        await runtime.selectWithWand([20,3,1],'add');
        image.select(box(20,3,6,8),'intersect',{antiAlias:false});
        check(!image.selectionContains(2,3)&&image.selectionContains(20,3),'Shape intersect did not preserve wand region');
        runtime.dispatch({action:'deselect'});runtime.dispatch({action:'reselect'});
        check(image.selectionContains(20,3),'Reselect lost mixed selection');
        runtime.setTool('move');runtime.movePixels(2,1);runtime.movePixels(-2,-1);
        check(image.canvas.getLayer(0).canvas.toDataURL()===originalPixels,'Round-trip pixel move changed original layer');
        runtime.beginTransform('selection');runtime.previewTransform({a:1,b:0,c:0,d:1,e:2,f:1});runtime.cancelTransform();
        check(image.selectionContains(20,3),'Cancel selection transform lost coverage');
        runtime.setTool('magicWand');runtime.layer({action:'layer',operation:'locks',id:baseId,locks:{pixels:true}});
        await runtime.selectWithWand([2,3,1],'replace');
        const beforeCut=image.contentIdentity();let rejected=false;
        try{await runtime.copyForSystem(true,false);}catch{rejected=true;}
        check(rejected&&image.contentIdentity()===beforeCut,'Cut changed a locked layer');
        runtime.layer({action:'layer',operation:'locks',id:baseId,locks:{pixels:false}});
        runtime.dispatch({action:'cut'});check(image.canvas.getLayer(0).context.getImageData(2,3,1,1).data[3]===0,'Cut did not remove wand-selected pixels');
        runtime.dispatch({action:'undo'});check(image.canvas.getLayer(0).canvas.toDataURL()===originalPixels,'Undo cut did not restore pixels');
        await runtime.openProject('b',()=>base.exportProject());runtime.dispatch({action:'pasteInPlace'});
        check(runtime.workspace.document!.canvas.getLayerCount()===2,'Cross-document internal paste lost copied content');
        await runtime.activateCached('a');check(runtime.workspace.document!.selectionContains(2,3),'Document switching lost wand selection');
        const reopened=await HostDocument.openProject(await runtime.workspace.document!.exportProject());
        try{const mask=selectionMask(40,30,reopened.history.getComposed().selection)!;try{check(mask.getContext('2d')!.getImageData(4,5,1,1).data[3]===0,'Project reopen filled wand hole');}finally{mask.width=mask.height=0;}}finally{reopened.destroy();}
        check(errors.length===0,'Interop operations reported errors: '+errors.map(String).join('; '));
    }finally{runtime.destroy();base.destroy();host.remove();source.width=source.height=0;}
}

export async function verifyMagicWandClipboardTransport():Promise<void>{
    const host=document.createElement('div');host.style.cssText='width:640px;height:480px';document.body.append(host);
    const runtime=new HostEditorRuntime(host,'windows',{changed(){},error(e){throw e;}}),workspace=new HostFrameWorkspace('wand-clipboard',runtime),nonce='a'.repeat(64);
    const client=await connectKlecksFrame({postMessage(_data,_origin,ports){const port=ports![0]!;workspace.bind(port);bindKlecksCommandPort(port,()=>workspace.activeIdentity,command=>runtime.dispatch(command));port.postMessage({type:'klecks:ready',version:1,nonce});}},'http://127.0.0.1',nonce);
    let written:ClipboardImage|null=null,finishRead:((result:{ok:true;value:ClipboardImage|null})=>void)|undefined;
    let deferRead=false;
    const warnings:string[]=[],bridge=new KlecksNativeClipboard(client,{writeImage:async image=>{written=image;return {ok:true,value:undefined};},readImage:async()=>deferRead?new Promise(resolve=>{finishRead=resolve;}):{ok:true,value:written}},message=>warnings.push(message));
    const source=document.createElement('canvas');source.width=40;source.height=30;
    const context=source.getContext('2d')!;context.fillStyle='white';context.fillRect(0,0,40,30);context.fillStyle='red';context.fillRect(2,3,6,8);context.clearRect(4,5,2,2);
    try{
        await client.documents.sync('wand-clipboard',[{viewId:'front',generation:1}]);
        const blob=await new Promise<Blob>(resolve=>source.toBlob(value=>resolve(value!))),bytes=new Uint8Array(await blob.arrayBuffer()),identity={sessionId:'wand-clipboard',viewId:'front',generation:1};
        await client.documents.openRaster(identity,'front.png',{bytes,widthPx:40,heightPx:30,initialLayerKind:'regular'});await client.documents.activate(identity);
        await client.tools.send(identity,{action:'tool',tool:'magicWand'});
        runtime.setWandOptions({tolerance:0,contiguous:true,antiAlias:false,sampleSize:1,sampleAllLayers:false});
        await runtime.selectWithWand([2,3,1],'replace');
        // Await authenticated state publication rather than inspecting only the engine.
        const settled=async()=>{for(let i=0;i<100;i++){if(client.state.snapshot()?.checkpointRevision===runtime.state.checkpointRevision)return;await new Promise(resolve=>setTimeout(resolve,0));}throw Error('Frame state did not settle');};
        await settled();check(await bridge.execute('copy'),'Native copy did not complete');
        const png=written as ClipboardImage|null;check(png?.width===6&&png.height===8,'PNG clipboard kept document-sized padding');
        check(await bridge.execute('pasteInPlace'),'Native own-image paste failed');
        const image=runtime.workspace.document!;
        check(image.canvas.getLayerCount()===2&&!image.canvas.getSelection()&&image.canvas.getLayer(1).context.getImageData(2,3,1,1).data[3]===255,'Native paste lost coordinates, selection clearing or layer activation');
        runtime.dispatch({action:'undo'});await settled();
        deferRead=true;const pending=bridge.execute('paste');
        for(let i=0;i<100&&!finishRead;i++)await new Promise(resolve=>setTimeout(resolve,0));
        check(finishRead,'Native read did not start');
        await runtime.selectWithWand([20,20,1],'replace');await settled();
        finishRead!({ok:true,value:png});
        check(!await pending&&image.canvas.getLayerCount()===1,'Late clipboard response pasted after selection changed');
        deferRead=false;
        runtime.layer({action:'layer',operation:'locks',id:image.layerState().activeLayerId!,locks:{pixels:true}});await settled();
        const before=image.contentIdentity();let rejected=false;
        try{await bridge.execute('cut');}catch{rejected=true;}
        check(rejected&&image.contentIdentity()===before&&written===png,'Failed locked-layer cut changed content or overwrote the clipboard');
        check(warnings.length===0,'Unexpected native bridge warning');
    }finally{bridge.dispose();client.close();workspace.destroy();runtime.destroy();host.remove();source.width=source.height=0;}
}

export async function verifyMagicWandSoftEdges():Promise<void>{
    const source=document.createElement('canvas');source.width=30;source.height=24;
    const context=source.getContext('2d')!;context.fillStyle='rgba(220,40,30,0.5)';context.fillRect(4,5,5,6);
    const image=new HostDocument({projectId:'wand-alpha',width:30,height:24,layers:[{name:'Soft',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:source}]});
    const host=document.createElement('div');host.style.cssText='width:640px;height:480px';document.body.append(host);
    const runtime=new HostEditorRuntime(host,'windows',{changed(){},error(e){throw e;}});
    try{
        runtime.sync(['soft']);await runtime.openProject('soft',()=>image.exportProject());runtime.setTool('magicWand');
        await runtime.selectWithWand([5,6,1],'replace');const doc=runtime.workspace.document!;
        // A feathered shape combined with a wand must retain the actual mask, not vector bounds alone.
        const region=box(3,4,8,8);doc.select(region,'intersect',{antiAlias:true,feather:2,coverage:{kind:'shape',value:region,antiAlias:true,feather:2}});
        const mask=selectionMask(30,24,doc.history.getComposed().selection)!,expected=document.createElement('canvas');expected.width=30;expected.height=24;
        try{
            const c=expected.getContext('2d')!;c.drawImage(source,0,0);c.globalCompositeOperation='destination-in';c.drawImage(mask,0,0);
            const pixels=c.getImageData(0,0,30,24).data;
            const clipboard=doc.copyPixels();doc.pastePixels(clipboard,true);
            const actual=doc.canvas.getLayer(1).context.getImageData(0,0,30,24).data;
            check(actual.every((value,index)=>value===pixels[index]),'Paste clipped or multiplied semi-transparent/feathered wand edge alpha');
            doc.undo();doc.moveSelection(2,1);doc.moveSelection(-2,-1);
            const moved=doc.copyPixels();check(moved.x===clipboard.x&&moved.y===clipboard.y&&moved.image.data.every((value,index)=>value===clipboard.image.data[index]),'Boundary movement changed feathered clipboard pixels');
            const restored=await HostDocument.openProject(await doc.exportProject());
            try{const copy=restored.copyPixels();check(copy.x===moved.x&&copy.y===moved.y&&copy.image.data.every((value,index)=>value===moved.image.data[index]),'Save/reopen changed mixed soft-edge clipboard pixels');}finally{restored.destroy();}
        }finally{mask.width=mask.height=expected.width=expected.height=0;}
    }finally{runtime.destroy();image.destroy();host.remove();source.width=source.height=0;}
}
