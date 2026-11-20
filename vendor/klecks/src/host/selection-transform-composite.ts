import { opaquePixelBounds, transformPixelCanvas, type TransformedPixels } from './pixel-transform';
import type { KlecksTransformMatrix } from '../../../../src/renderer/src/design-patent/correction/klecks-transform';
import { selectionRemainderCoverage } from '../../../../src/renderer/src/design-patent/correction/klecks-selection-composite';

function readBand(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): Uint8ClampedArray {
    const left=Math.max(0,x),top=Math.max(0,y),right=Math.min(context.canvas.width,x+width),bottom=Math.min(context.canvas.height,y+height);
    if(left===x&&top===y&&right===x+width&&bottom===y+height)return context.getImageData(x,y,width,height).data;
    const result=new Uint8ClampedArray(width*height*4);
    if(right<=left||bottom<=top)return result;
    const pixels=context.getImageData(left,top,right-left,bottom-top).data;
    const stride=(right-left)*4;
    for(let row=0;row<bottom-top;row++)result.set(pixels.subarray(row*stride,(row+1)*stride),((top-y+row)*width+left-x)*4);
    return result;
}

/** Recombine cut pixels without applying antialiased/feathered edge coverage twice. */
export function compositeTransformedSelection(
    target: HTMLCanvasElement,
    targetOrigin: { x: number; y: number },
    original: HTMLCanvasElement,
    originalOrigin: { x: number; y: number },
    mask: HTMLCanvasElement,
    moved: TransformedPixels,
    matrix: KlecksTransformMatrix,
): void {
    const transformedMask = transformPixelCanvas(mask, { x: 0, y: 0 }, matrix);
    const context = target.getContext('2d')!;
    try {
        context.drawImage(original, originalOrigin.x - targetOrigin.x, originalOrigin.y - targetOrigin.y);
        if (!transformedMask) return;
        const removedBounds=opaquePixelBounds(mask)!;
        const left=Math.max(0,Math.min(removedBounds.left,transformedMask.x)-targetOrigin.x);
        const right=Math.min(target.width,Math.max(removedBounds.left+removedBounds.width,transformedMask.x+transformedMask.canvas.width)-targetOrigin.x);
        const start=Math.max(0,Math.min(removedBounds.top,transformedMask.y)-targetOrigin.y);
        const bottom=Math.min(target.height,Math.max(removedBounds.top+removedBounds.height,transformedMask.y+transformedMask.canvas.height)-targetOrigin.y);
        if(right<=left||bottom<=start)return;
        const removedContext=mask.getContext('2d')!,destinationContext=transformedMask.canvas.getContext('2d')!,movedContext=moved.canvas.getContext('2d')!;
        // Touch only the source/destination union; keep temporary reads in small bands.
        for(let top=start;top<bottom;top+=64) {
            const rows=Math.min(64,bottom-top),width=right-left,docX=targetOrigin.x+left;
            const result=context.getImageData(left,top,width,rows),pixels=result.data;
            const removed=readBand(removedContext,docX,targetOrigin.y+top,width,rows);
            const destination=readBand(destinationContext,docX-transformedMask.x,targetOrigin.y+top-transformedMask.y,width,rows);
            const transformed=readBand(movedContext,docX-moved.x,targetOrigin.y+top-moved.y,width,rows);
            for(let i=0;i<pixels.length;i+=4) {
                // Most pixels are unchanged or fully selected; avoid per-channel
                // floating-point blending except at actual partial-coverage edges.
                if(removed[i+3]===0&&transformed[i+3]===0)continue;
                if(removed[i+3]===255||transformed[i+3]===255||pixels[i+3]===0) {
                    for(let channel=0;channel<4;channel++)pixels[i+channel]=transformed[i+channel]!;
                    continue;
                }
                const coverage=destination[i+3]!/255,alpha=transformed[i+3]!/255;
                const opacity=coverage>0?Math.min(1,alpha/coverage):0;
                const remaining=pixels[i+3]!/255*selectionRemainderCoverage(removed[i+3]!/255,coverage,opacity);
                const total=alpha+remaining;
                for(let channel=0;channel<3;channel++)pixels[i+channel]=total>0?Math.round((transformed[i+channel]!*alpha+pixels[i+channel]!*remaining)/total):0;
                pixels[i+3]=Math.min(255,Math.round(total*255));
            }
            context.putImageData(result,left,top);
        }
    } finally {if(transformedMask)transformedMask.canvas.width=transformedMask.canvas.height=0;}
}
