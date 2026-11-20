import type {KlCanvas} from '../app/script/klecks/canvas/kl-canvas';
import type {THistoryEntryDataComposed,THistoryEntryLayerComposed,THostLayerMask} from '../app/script/klecks/history/history.types';
import {canvasToLayerTiles} from '../app/script/klecks/history/push-helpers/canvas-to-layer-tiles';
import {selectionMask} from './selection-mask';
import {maskCoverage,maskToTiles} from './layer-mask';
import {backingToCanvas,mergeLayerBacking} from './layer-backing';
import {KlecksOperationRejected} from '../../../../src/renderer/src/design-patent/correction/klecks-operation-error';
import {traceSelectedPixelsSync} from '../../../../src/renderer/src/design-patent/correction/klecks-magic-wand';
import type {MultiPolygon} from 'polygon-clipping';
import type {DesignSelectionCoverage} from '../../../../src/shared/patent/design-selection-coverage';
import {encodeSelectionRaster} from '../../../../src/shared/patent/design-selection-raster';

export type MaskOperation='add'|'addHide'|'target'|'image'|'view'|'toggle'|'link'|'delete'|'apply'|'invert'|'selection';
export type MaskFocus={id:string;view:boolean};
type Owner={canvas:()=>KlCanvas;state:()=>THistoryEntryDataComposed;idle:()=>void;focus:(id:string)=>void;
 commit:(id:string,changes:Partial<THistoryEntryLayerComposed>)=>void;select:(region:MultiPolygon,coverage:DesignSelectionCoverage)=>void};

/** Owns only editing focus and transient mask paint; history owns immutable coverage. */
export class HostLayerMasks {
 focus?:MaskFocus;
 paint?:{id:string;original:THostLayerMask;canvas:HTMLCanvasElement};
 private display?:HTMLCanvasElement;
 get displayBytes():number{return this.display?this.display.width*this.display.height*4:0;}
 gray=0;
 constructor(private owner:Owner){}
 get editing():boolean{return !!this.focus&&this.focus.id===this.owner.state().activeLayerId&&!!this.owner.state().layerMap[this.focus.id]?.hostMask;}
 get viewing():boolean{return this.editing&&!!this.focus?.view;}
 operate(id:string,operation:MaskOperation):void {
  this.owner.idle();const before=this.owner.state(),layer=before.layerMap[id],mask=layer?.hostMask;
  if(!layer)throw new KlecksOperationRejected('图层已不存在。');
  if(operation==='image'){this.focus=undefined;this.owner.focus(id);return;}
  if(operation==='target'||operation==='view'){if(!mask)throw new KlecksOperationRejected('当前图层没有蒙版。');this.owner.focus(id);this.focus={id,view:operation==='view'&&!(this.focus?.id===id&&this.focus.view)};return;}
  if(layer.hostLocks?.all&&operation!=='selection')throw new KlecksOperationRejected('图层已全部锁定，请先解锁后编辑蒙版。');
  if(operation==='selection'){
   if(!mask)throw new KlecksOperationRejected('当前图层没有蒙版。');
   const c=maskCoverage(mask,before.size.width,before.size.height),pixels=c.getContext('2d')!.getImageData(0,0,c.width,c.height),alpha=new Uint8Array(c.width*c.height);
   for(let i=0;i<alpha.length;i++)alpha[i]=pixels.data[i*4+3];
   const width=c.width,height=c.height,coverage=encodeSelectionRaster(width,height,alpha);c.width=c.height=0;this.owner.select(traceSelectedPixelsSync(alpha,width,height),coverage);return;
  }
  let next:THostLayerMask|null=mask??null;
  if(operation==='add'||operation==='addHide'){
   if(mask)throw new KlecksOperationRejected('每个图层只能有一个栅格蒙版。');
   const {width,height}=before.size,c=document.createElement('canvas');c.width=width;c.height=height;
   try{const context=c.getContext('2d')!,selected=selectionMask(width,height,before.selection);if(selected){context.drawImage(selected,0,0);selected.width=selected.height=0;}else{context.fillStyle='white';context.fillRect(0,0,width,height);}
    if(operation==='addHide'){context.globalCompositeOperation='source-out';context.fillStyle='white';context.fillRect(0,0,width,height);}
    next={x:0,y:0,width,height,outside:operation==='addHide'?(before.selection.value?255:0):(before.selection.value?0:255),enabled:true,linked:true,tiles:maskToTiles(c)};
   }finally{c.width=c.height=0;}
  }else{
   if(!mask)throw new KlecksOperationRejected('当前图层没有蒙版。');
   if(operation==='delete'||operation==='apply')next=null;
   if(operation==='toggle')next={...mask,enabled:!mask.enabled};
   if(operation==='link')next={...mask,linked:!mask.linked};
   if(operation==='invert'){const c=backingToCanvas(mask),context=c.getContext('2d')!;try{context.globalCompositeOperation='source-out';context.fillStyle='white';context.fillRect(0,0,c.width,c.height);next={...mask,outside:mask.outside?0:255,tiles:maskToTiles(c)};}finally{c.width=c.height=0;}}
  }
  const changes:Partial<THistoryEntryLayerComposed>={hostMask:next};
  if(layer.hostBackground&&next){changes.hostBackground=false;changes.name='图层 0';changes.hostLocks={all:false,pixels:false,position:false,alpha:false};}
  if(operation==='apply'&&mask){
   const source=this.owner.canvas().getLayers().find(l=>l.id===id)!,full=mergeLayerBacking(source.canvas,layer.hostBacking),coverage=maskCoverage({...mask,x:mask.x-full.x,y:mask.y-full.y},full.canvas.width,full.canvas.height);
   const visible=document.createElement('canvas');visible.width=before.size.width;visible.height=before.size.height;
   try{const c=full.canvas.getContext('2d')!;c.globalCompositeOperation='destination-in';c.drawImage(coverage,0,0);visible.getContext('2d')!.drawImage(full.canvas,full.x,full.y);changes.tiles=canvasToLayerTiles(visible);changes.hostBacking=layer.hostBacking?{x:full.x,y:full.y,width:full.canvas.width,height:full.canvas.height,tiles:canvasToLayerTiles(full.canvas)}:null;}
   finally{full.canvas.width=full.canvas.height=coverage.width=coverage.height=visible.width=visible.height=0;}
  }
  this.owner.commit(id,changes);this.focus={id,view:!!next&&this.focus?.id===id&&!!this.focus.view};
 }
 begin(color:{r:number;g:number;b:number}):HTMLCanvasElement|undefined {
  if(!this.editing)return;
  const state=this.owner.state(),id=state.activeLayerId,original=state.layerMap[id].hostMask!;
  this.gray=(.299*color.r+.587*color.g+.114*color.b)/255;
  this.paint={id,original,canvas:maskCoverage(original,state.size.width,state.size.height)};
  this.owner.canvas().getLayersReference().find(l=>l.id===id)!.hostMaskPreview=this.paint.canvas;
  return this.paint.canvas;
 }
 commitPaint():void {
  if(!this.paint)return;
  const {id,original,canvas}=this.paint,full=backingToCanvas(original),x=Math.min(0,original.x),y=Math.min(0,original.y);
  const width=Math.max(canvas.width,original.x+original.width)-x,height=Math.max(canvas.height,original.y+original.height)-y;
  if(width>10000||height>10000||width*height>40000000){full.width=full.height=0;throw new KlecksOperationRejected('蒙版外围像素超出安全范围，本次笔画未提交。');}
  const output=document.createElement('canvas');output.width=width;output.height=height;
  try{const c=output.getContext('2d')!;if(original.outside){c.fillStyle='white';c.fillRect(0,0,width,height);}c.clearRect(original.x-x,original.y-y,original.width,original.height);c.drawImage(full,original.x-x,original.y-y);c.clearRect(-x,-y,canvas.width,canvas.height);c.drawImage(canvas,-x,-y);
   this.owner.commit(id,{hostMask:{...original,x,y,width,height,tiles:maskToTiles(output)}});
  }finally{full.width=full.height=output.width=output.height=0;}
 }
 cancelPaint():void {if(!this.paint)return;const layer=this.owner.canvas().getLayersReference().find(l=>l.id===this.paint!.id);if(layer)delete layer.hostMaskPreview;this.paint.canvas.width=this.paint.canvas.height=0;this.paint=undefined;}
 editorDisplay():HTMLCanvasElement|undefined {
  if(!this.viewing)return;
  const state=this.owner.state(),mask=state.layerMap[state.activeLayerId].hostMask!;
  this.display??=document.createElement('canvas');const canvas=this.display;canvas.width=state.size.width;canvas.height=state.size.height;
  const c=canvas.getContext('2d')!;c.fillStyle='black';c.fillRect(0,0,canvas.width,canvas.height);const coverage=this.paint?.canvas??maskCoverage(mask,canvas.width,canvas.height);
  c.drawImage(coverage,0,0);if(!this.paint)coverage.width=coverage.height=0;return canvas;
 }
 fill(color:{r:number;g:number;b:number},opacity=1,override?:DesignSelectionCoverage):void {
  this.owner.idle();const canvas=this.begin(color);if(!canvas)throw new KlecksOperationRejected('请先选中蒙版缩略图。');
  const state=this.owner.state(),coverage=selectionMask(canvas.width,canvas.height,override?{value:[],coverage:override}:state.selection)??document.createElement('canvas');
  if(!override&&!state.selection.value&&!state.selection.coverage){coverage.width=canvas.width;coverage.height=canvas.height;const c=coverage.getContext('2d')!;c.fillStyle='white';c.fillRect(0,0,coverage.width,coverage.height);}
  try{const c=canvas.getContext('2d')!;c.globalAlpha=opacity;c.globalCompositeOperation='destination-out';c.drawImage(coverage,0,0);c.globalAlpha=opacity*this.gray;c.globalCompositeOperation='lighter';c.drawImage(coverage,0,0);
   if(!this.paintChanged())throw new KlecksOperationRejected('本次操作未改变蒙版：可能颜色相同或选区为空；撤销和重做记录未改变。');
   this.commitPaint();}
  finally{coverage.width=coverage.height=0;this.cancelPaint();}
 }
 /** Compare alpha in bounded bands, including shifted/off-canvas masks, before consuming redo. */
 private paintChanged():boolean {
  if(!this.paint)return false;
  const {canvas,original}=this.paint,source=backingToCanvas(original),strip=document.createElement('canvas');
  strip.width=canvas.width;strip.height=Math.min(64,canvas.height);
  const expected=strip.getContext('2d')!,actual=canvas.getContext('2d')!;
  try{
   for(let y=0;y<canvas.height;y+=strip.height){
    const rows=Math.min(strip.height,canvas.height-y);
    expected.clearRect(0,0,strip.width,strip.height);
    if(original.outside){expected.fillStyle='white';expected.fillRect(0,0,strip.width,strip.height);}
    expected.clearRect(original.x,original.y-y,original.width,original.height);
    expected.drawImage(source,original.x,original.y-y);
    const a=actual.getImageData(0,y,canvas.width,rows).data,b=expected.getImageData(0,0,strip.width,rows).data;
    for(let i=3;i<a.length;i+=4)if(a[i]!==b[i])return true;
   }
   return false;
  }finally{source.width=source.height=strip.width=strip.height=0;}
 }
 destroy():void{this.cancelPaint();if(this.display)this.display.width=this.display.height=0;}
}
