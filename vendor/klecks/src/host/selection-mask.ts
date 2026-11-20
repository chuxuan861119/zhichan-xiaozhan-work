import type { THistoryEntryDataComposed } from '../app/script/klecks/history/history.types';
import { getSelectionPath2d } from '../app/script/bb/multi-polygon/get-selection-path-2d';
import { isSelectionCoverage, type DesignSelectionCoverage } from '../../../../src/shared/patent/design-selection-coverage';
import { decodeSelectionRaster } from '../../../../src/shared/patent/design-selection-raster';

// A single raster, never a history-indexed map: bounded independently of document/undo count.
const MAX_CACHED_MASK_BYTES = 64 * 1024 * 1024;
let cachedMask: { key: string; kind: DesignSelectionCoverage['kind']; canvas: HTMLCanvasElement } | undefined;

export function clearSelectionMaskCache(): void {
    if (cachedMask) cachedMask.canvas.width = cachedMask.canvas.height = 0;
    cachedMask = undefined;
}

function copyMask(source: HTMLCanvasElement): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = source.width; canvas.height = source.height;
    canvas.getContext('2d')!.drawImage(source, 0, 0);
    return canvas;
}

// The public selection data is not deeply frozen. A content key also covers cloned undo
// states and in-place edits without retaining any document, history or caller-owned objects.
function coverageKey(width: number, height: number, node: DesignSelectionCoverage): string {
    return `${width}:${height}:${JSON.stringify(node)}`;
}

export function coverageForSelection(selection: THistoryEntryDataComposed['selection']): DesignSelectionCoverage {
    return selection.coverage ?? {kind:'shape',value:structuredClone(selection.value ?? []),feather:selection.feather ?? 0,antiAlias:selection.antiAlias ?? true};
}
export function selectionMaskWorkBytes(width:number,height:number,selection:THistoryEntryDataComposed['selection']):number {
    const retainedBytes=cachedMask?cachedMask.canvas.width*cachedMask.canvas.height*4:0;
    if(!selection.coverage)return (selection.value?width*height*4*3:0)+retainedBytes;
    if(!isSelectionCoverage(selection.coverage))throw new Error('Invalid selection coverage');
    const stack=[{node:selection.coverage,width,height}];let bytes=0;
    while(stack.length){const {node,width,height}=stack.pop()!;bytes+=width*height*4*3;
        if(node.kind==='transform')stack.push({node:node.source,width:node.width,height:node.height});
        else if(node.kind==='invert')stack.push({node:node.source,width,height});
        else if(node.kind!=='shape'&&node.kind!=='raster')stack.push({node:node.left,width,height},{node:node.right,width,height});
    }
    return bytes+retainedBytes;
}

function renderCoverage(width:number,height:number,node:DesignSelectionCoverage):HTMLCanvasElement {
    if(cachedMask&&cachedMask.kind===node.kind&&cachedMask.canvas.width===width&&cachedMask.canvas.height===height&&cachedMask.key===coverageKey(width,height,node))return copyMask(cachedMask.canvas);
    if(node.kind==='shape')return renderShape(width,height,{value:node.value,feather:node.feather,antiAlias:node.antiAlias});
    if(node.kind==='raster'){
        const alpha=decodeSelectionRaster(node),canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
        const c=canvas.getContext('2d')!,pixels=c.createImageData(Math.min(width,node.width),Math.min(height,node.height));
        for(let y=0;y<pixels.height;y++)for(let x=0;x<pixels.width;x++){const i=(y*pixels.width+x)*4;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=255;pixels.data[i+3]=alpha[y*node.width+x]!;}
        c.putImageData(pixels,0,0);return canvas;
    }
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d')!;
    const source=renderCoverage(node.kind==='transform'?node.width:width,node.kind==='transform'?node.height:height,'source' in node?node.source:node.left);
    let right:HTMLCanvasElement|undefined;
    try {
        if(node.kind==='transform') {
            const m=node.matrix;context.setTransform(m.a,m.b,m.c,m.d,m.e,m.f);context.drawImage(source,0,0);
        }else if(node.kind==='invert') {
            context.fillStyle='#fff';context.fillRect(0,0,width,height);context.globalCompositeOperation='destination-out';context.drawImage(source,0,0);
        }else {
            right=renderCoverage(width,height,node.right);
            for(let top=0;top<height;top+=128){const rows=Math.min(128,height-top),a=source.getContext('2d')!.getImageData(0,top,width,rows),b=right.getContext('2d')!.getImageData(0,top,width,rows);
                for(let i=3;i<a.data.length;i+=4)a.data[i]=node.kind==='add'?Math.max(a.data[i],b.data[i]):node.kind==='intersect'?Math.min(a.data[i],b.data[i]):Math.max(0,a.data[i]-b.data[i]);
                context.putImageData(a,0,top);
            }
        }
        return canvas;
    }catch(error){canvas.width=0;canvas.height=0;throw error;}
    finally{source.width=0;source.height=0;if(right){right.width=0;right.height=0;}}
}

/** Shared pixel coverage for host paint, clipboard and clear operations. */
export function selectionMask(width: number, height: number, selection: THistoryEntryDataComposed['selection']): HTMLCanvasElement | null {
    if (!selection.value) {clearSelectionMaskCache();return null;}
    if(selection.coverage){
        if(!isSelectionCoverage(selection.coverage))throw new Error('Selection mask exceeds complexity budget');
        const key=coverageKey(width,height,selection.coverage);
        if(cachedMask?.key===key)return copyMask(cachedMask.canvas);
        const result=renderCoverage(width,height,selection.coverage);
        clearSelectionMaskCache();
        if(width*height*4<=MAX_CACHED_MASK_BYTES){
            // Return a separate disposable canvas; host callers routinely resize masks to zero.
            const copy=copyMask(result);
            cachedMask={key,kind:selection.coverage.kind,canvas:result};
            return copy;
        }
        return result;
    }
    clearSelectionMaskCache();
    return renderShape(width,height,selection);
}

function renderShape(width: number, height: number, selection: THistoryEntryDataComposed['selection']): HTMLCanvasElement {
    const mask = document.createElement('canvas');
    mask.width = width; mask.height = height;
    const context = mask.getContext('2d')!;
    context.fillStyle = '#fff';
    context.fill(getSelectionPath2d(selection.value!));
    if (selection.antiAlias === false) {
        const pixels = context.getImageData(0, 0, width, height);
        for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = pixels.data[i] >= 128 ? 255 : 0;
        context.putImageData(pixels, 0, 0);
    }
    if (!selection.feather) return mask;
    const softened = document.createElement('canvas');
    softened.width = width; softened.height = height;
    const softContext = softened.getContext('2d')!;
    softContext.filter = `blur(${selection.feather}px)`;
    softContext.drawImage(mask, 0, 0);
    mask.width=0;mask.height=0;
    return softened;
}
