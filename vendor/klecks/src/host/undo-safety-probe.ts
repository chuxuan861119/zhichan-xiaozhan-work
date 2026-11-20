import{HostDocument}from'./host-document';import{DEFAULT_TONE}from'../../../../src/shared/settings/design-tone';import{DEFAULT_FILL}from'../../../../src/shared/settings/design-fill';
export async function verifyUndoSafety(){
 await verifyLargeSelectionEdits();
 for(const action of ['crop','rotate','fill','tone','paint','clear','paste','duplicate']){
  const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d')!;x.fillStyle='white';x.fillRect(0,0,64,64);x.fillStyle='black';x.fillRect(0,0,16,16);const d=new HostDocument({projectId:action,width:64,height:64,layers:[{name:'Base',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:c}]});d.setHistoryPolicy({maxUndoSteps:100,maxEstimatedBytes:25000});const before=d.contentIdentity();
  try{let committed=false;try{if(action==='crop')d.crop({left:1,top:0,width:63,height:64},false);if(action==='rotate')d.rotateCanvas(180);if(action==='fill')await d.fillPixels({r:1,g:2,b:3},DEFAULT_FILL);if(action==='tone'){const r=await d.tonePixels({...DEFAULT_TONE,outWhite:200});r.canvas.width=0;}if(action==='paint')d.paint([[32,32,1]],{tool:'brush',size:10,opacity:1,hardness:1,color:{r:0,g:0,b:0}});if(action==='clear')d.clearPixels();if(action==='paste')d.pastePixels(d.copyPixels());if(action==='duplicate')d.duplicateLayer(d.canvas.getLayer(0).id);committed=true;}catch(e){if(!(e instanceof Error)||!e.message.includes('撤销'))throw e;}if(committed)d.undo();if(d.contentIdentity()!==before||d.canvas.getWidth()!==64||d.canvas.getLayerCount()!==1||d.canvas.getLayer(0).context.getImageData(0,0,1,1).data[0]!==0)throw Error(action+' lost undo or leaked live preview after rejection');const snapshot=d.capture();const reopened=HostDocument.restore(snapshot);reopened.destroy();}finally{d.destroy();c.width=0;}
 }
 const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d')!;x.fillStyle='white';x.fillRect(0,0,64,64);x.fillStyle='black';x.fillRect(0,0,16,16);
 const d=new HostDocument({projectId:'cancel',width:64,height:64,layers:[{name:'Base',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:c},{name:'Top',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:c}]});
 try{d.select([[[[1,1],[10,1],[10,10],[1,10],[1,1]]]],'replace');d.setHistoryPolicy({maxUndoSteps:100,maxEstimatedBytes:50000});const original=d.contentIdentity(),selection=JSON.stringify(d.canvas.getSelection()),snapshot=JSON.stringify(d.capture());d.movePixels(1,0);d.cancelFloatingMove();if(d.contentIdentity()!==original||JSON.stringify(d.canvas.getSelection())!==selection||JSON.stringify(d.capture())!==snapshot)throw Error('Cancelling a floating move must restore its original history without allocating a new undo step');}finally{d.destroy();c.width=0;}
}

async function verifyLargeSelectionEdits(): Promise<void> {
    // A full 5472 × 3072 tile plane plus a duplicate is just over the default
    // 128 MiB history cap. A small selection must not need a second plane.
    const canvas = document.createElement('canvas');
    canvas.width = 5472;
    canvas.height = 3072;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'black';
    context.fillRect(10, 10, 32, 32);
    context.fillRect(canvas.width - 16, 10, 16, 32);
    const image = new HostDocument({
        projectId: 'large-selection',
        width: canvas.width,
        height: canvas.height,
        layers: [{ name: 'Base', opacity: 1, isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: canvas }],
    });
    canvas.width = canvas.height = 0;
    const pixel = (x: number, y: number) => [...image.canvas.getLayer(0).context.getImageData(x,y,1,1).data].join(',');
    const select = (x: number, y: number, size: number) =>
        image.select([[[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]]]],'replace');
    const black = '0,0,0,255', white = '255,255,255,255', transparent = '0,0,0,0';
    const expectPixel = (x: number, y: number, expected: string) => {
        if (pixel(x,y) !== expected) throw new Error(`Unexpected pixel at ${x}, ${y}`);
    };
    try {
        select(10, 10, 20);
        image.clearPixels();
        expectPixel(12,12,transparent);
        expectPixel(33,12,black);
        image.undo(); expectPixel(12,12,black);
        image.redo(); expectPixel(12,12,transparent);
        image.undo();
        image.movePixels(90,0);
        expectPixel(12,12,transparent);
        expectPixel(102,12,black);
        image.movePixels(260,0);
        expectPixel(102,12,white);
        expectPixel(362,12,black);
        image.undo(); expectPixel(102,12,black);
        image.redo(); expectPixel(362,12,black);
        image.cancelFloatingMove(); expectPixel(12,12,black);
        select(5456,10,16);
        image.movePixels(10,0);
        expectPixel(5457,12,transparent);
        if (!JSON.parse(image.contentIdentity()).layers[0].backing) throw new Error('Off-canvas pixels were not preserved');
        image.undo(); expectPixel(5457,12,black);
        image.redo(); expectPixel(5457,12,transparent);
        const project = await image.exportProject();
        image.destroy();
        const reopened = await HostDocument.openProject(project);
        try {
            reopened.deselect();
            reopened.movePixels(-10,0);
            if ([...reopened.canvas.getLayer(0).context.getImageData(5470,12,1,1).data].join(',') !== black)
                throw new Error('Off-canvas pixels did not survive project save and reopen');
        } finally { reopened.destroy(); }
    } finally {
        image.destroy();
    }
}
