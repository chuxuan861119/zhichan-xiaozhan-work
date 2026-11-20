import { HISTORY_TILE_SIZE } from '../app/script/klecks/history/kl-history';
import {createImageDataTile,getTileSize} from '../app/script/klecks/history/image-data-tile';
import type {THistoryEntryLayerTile} from '../app/script/klecks/history/history.types';
import {getImageDataSafely} from '../app/script/bb/base/canvas';
import { fillPixel } from '../../../../src/renderer/src/design-patent/correction/klecks-fill';
import type { FillColor, FillOptions } from '../../../../src/shared/settings/design-fill';

// Full readback preserves Canvas rounding; only changed tiles get new pixel buffers/IDs.
export function changedAdjustmentTiles(canvas:HTMLCanvasElement,changed:readonly boolean[]):(THistoryEntryLayerTile|undefined)[]{
    const columns=Math.ceil(canvas.width/HISTORY_TILE_SIZE),rows=Math.ceil(canvas.height/HISTORY_TILE_SIZE);
    const result:(THistoryEntryLayerTile|undefined)[]=Array(columns*rows).fill(undefined);
    if(!changed.some(Boolean))return result;
    const pixels=getImageDataSafely(canvas.getContext('2d')!,0,0,canvas.width,canvas.height);
    for(let row=0;row<rows;row++)for(let col=0;col<columns;col++){
        const index=row*columns+col;if(!changed[index])continue;
        const size=getTileSize(col,row,canvas),tile=new ImageData(size.width,size.height),x=col*HISTORY_TILE_SIZE,y=row*HISTORY_TILE_SIZE;
        for(let line=0;line<size.height;line++){
            const start=((y+line)*canvas.width+x)*4;
            tile.data.set(pixels.data.subarray(start,start+size.width*4),line*size.width*4);
        }
        result[index]=createImageDataTile(tile);
    }
    return result;
}

// Retain only changed tiles; preserve full-strip Canvas alpha rounding from the original path.
export async function regionalFill(source:HTMLCanvasElement,mask:HTMLCanvasElement|null,color:FillColor,options:FillOptions,preserve:boolean,check:()=>void) {
    const columns=Math.ceil(source.width/HISTORY_TILE_SIZE),changedTiles:boolean[]=[];
    const context=source.getContext('2d')!,maskContext=mask?.getContext('2d');let clock=performance.now();
    const output=document.createElement('canvas');output.width=source.width;output.height=source.height;
    try{
    const target=output.getContext('2d')!;
    for(let y=0;y<source.height;y+=32){
        check();const rows=Math.min(32,source.height-y),pixels=context.getImageData(0,y,source.width,rows),alpha=maskContext?.getImageData(0,y,source.width,rows).data;
            for(let p=0;p<pixels.data.length;p+=4){
                const amount=options.opacity/100*(alpha?alpha[p+3]!/255:1);if(!amount)continue;
                const old=[pixels.data[p]!,pixels.data[p+1]!,pixels.data[p+2]!,pixels.data[p+3]!],next=fillPixel(old,color,amount,options.blend,preserve);
                for(let k=0;k<4;k++){if(old[k]!==next[k])changedTiles[Math.floor((y+Math.floor(p/4/source.width))/HISTORY_TILE_SIZE)*columns+Math.floor(((p/4)%source.width)/HISTORY_TILE_SIZE)]=true;pixels.data[p+k]=next[k]!;}
            }
        target.putImageData(pixels,0,y);
        if(performance.now()-clock>=8){await new Promise<void>(resolve=>setTimeout(resolve,0));check();clock=performance.now();}
    }
    return changedAdjustmentTiles(output,changedTiles);
    }finally{output.width=output.height=0;}
}
