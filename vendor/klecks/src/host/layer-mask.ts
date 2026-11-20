import type {THostLayerMask,THistoryEntryLayerTile} from '../app/script/klecks/history/history.types';
import {backingToCanvas} from './layer-backing';
import {canvasToLayerTiles} from '../app/script/klecks/history/push-helpers/canvas-to-layer-tiles';
import {transformPixelCanvas} from './pixel-transform';
import type {KlecksTransformMatrix} from '../../../../src/renderer/src/design-patent/correction/klecks-transform';
import {HISTORY_TILE_SIZE} from '../app/script/klecks/history/kl-history';
import {isLayerFill} from '../app/script/klecks/kl-types';
export function maskAlphaAt(mask:THostLayerMask,x:number,y:number):number {
 const px=Math.floor(x-mask.x),py=Math.floor(y-mask.y);if(px<0||py<0||px>=mask.width||py>=mask.height)return mask.outside;
 const col=Math.floor(px/HISTORY_TILE_SIZE),row=Math.floor(py/HISTORY_TILE_SIZE),tile=mask.tiles[row*Math.ceil(mask.width/HISTORY_TILE_SIZE)+col];
 return isLayerFill(tile)?tile.fill==='transparent'?0:tile.fill==='white'?255:Math.round(Number(tile.fill.match(/,([\d.]+)\)$/)?.[1]??1)*255):tile.data.data[((py%HISTORY_TILE_SIZE)*tile.data.width+px%HISTORY_TILE_SIZE)*4+3];
}
export function maskToTiles(canvas:HTMLCanvasElement):THistoryEntryLayerTile[]{
 return canvasToLayerTiles(canvas).map(tile=>{
  if(isLayerFill(tile))return tile;const data=tile.data.data,alpha=data[3];
  for(let i=7;i<data.length;i+=4)if(data[i]!==alpha)return tile;
  return{fill:alpha===0?'transparent':alpha===255?'white':`rgba(255,255,255,${alpha/255})`};
 });
}

/** White alpha stores coverage; RGB is irrelevant. Never premultiply the source pixels. */
export function maskCoverage(mask:THostLayerMask,width:number,height:number):HTMLCanvasElement {
 const output=document.createElement('canvas');output.width=width;output.height=height;
 const c=output.getContext('2d')!;if(mask.outside){c.fillStyle='white';c.fillRect(0,0,width,height);}
 const raster=backingToCanvas(mask);
 try{c.clearRect(mask.x,mask.y,mask.width,mask.height);c.drawImage(raster,mask.x,mask.y);}finally{raster.width=raster.height=0;}
 return output;
}
export function maskGray(mask:THostLayerMask):HTMLCanvasElement {
 const output=backingToCanvas(mask),c=output.getContext('2d')!,data=c.getImageData(0,0,output.width,output.height);
 for(let p=0;p<data.data.length;p+=4){const value=data.data[p+3];data.data[p]=data.data[p+1]=data.data[p+2]=value;data.data[p+3]=255;}
 c.putImageData(data,0,0);return output;
}
export function grayMask(canvas:HTMLCanvasElement,properties:Omit<THostLayerMask,'tiles'>):THostLayerMask {
 const c=canvas.getContext('2d')!,data=c.getImageData(0,0,canvas.width,canvas.height);
 for(let p=0;p<data.data.length;p+=4){const gray=Math.round((.299*data.data[p]+.587*data.data[p+1]+.114*data.data[p+2])*data.data[p+3]/255+properties.outside*(1-data.data[p+3]/255));data.data[p]=data.data[p+1]=data.data[p+2]=255;data.data[p+3]=gray;}
 const output=document.createElement('canvas');output.width=canvas.width;output.height=canvas.height;
 try{output.getContext('2d')!.putImageData(data,0,0);return{...properties,tiles:maskToTiles(output)};}finally{output.width=output.height=0;}
}
export function transformMask(mask:THostLayerMask,matrix:KlecksTransformMatrix):THostLayerMask {
 const source=backingToCanvas(mask);let output:ReturnType<typeof transformPixelCanvas>=null;
 try{output=transformPixelCanvas(source,{x:mask.x,y:mask.y},matrix);if(!output)return {...mask,x:Math.round(matrix.a*mask.x+matrix.c*mask.y+matrix.e),y:Math.round(matrix.b*mask.x+matrix.d*mask.y+matrix.f)};
 return{...mask,x:output.x,y:output.y,width:output.canvas.width,height:output.canvas.height,tiles:maskToTiles(output.canvas)};
 }finally{source.width=source.height=0;if(output){output.canvas.width=output.canvas.height=0;}}
}
