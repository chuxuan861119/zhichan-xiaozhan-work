import { ColorRangeOptionsSchema, type ColorRangeOptions } from '../../../../src/shared/settings/design-color-range';
import { colorRangeMask, sampleRangeColor, type RangeSample } from '../../../../src/renderer/src/design-patent/correction/klecks-color-range';
import { traceSelectedPixels } from '../../../../src/renderer/src/design-patent/correction/klecks-magic-wand';
import type { ColorRangeState } from '../../../../src/renderer/src/design-patent/correction/klecks-color-range-state';
import { encodeSelectionRaster, type SelectionRaster } from '../../../../src/shared/patent/design-selection-raster';
import type { SelectionOutline } from '../../../../src/shared/patent/design-selection-coverage';
import type { HostDocument } from './host-document';
import { KlecksOperationRejected } from '../../../../src/renderer/src/design-patent/correction/klecks-operation-error';
import { selectionMask } from './selection-mask';
type Raster={width:number;height:number;data:Uint8ClampedArray};
export class ColorRangeSession{
 state:ColorRangeState;
 private source:Raster;private positive:RangeSample[]=[];private negative:RangeSample[]=[];
 private abort:AbortController|null=null;private closed=false;
 private result:{outline:SelectionOutline;coverage:SelectionRaster}|null=null;
 private readonly identity:string;
 private invalidInputs=new Set<'fuzziness'|'range'>();
 private inputsValid():boolean{return !this.invalidInputs.has('fuzziness')&&!(this.state.options.localized&&this.state.options.preset==='sampled'&&this.invalidInputs.has('range'));}
 inputValidity(field:'fuzziness'|'range',valid:boolean):void{
  if(this.closed)return;
  if(valid===!this.invalidInputs.has(field))return;
  if(valid)this.invalidInputs.delete(field);else this.invalidInputs.add(field);
  this.queue();
 }
 constructor(private readonly image:HostDocument,options:ColorRangeOptions,private readonly hooks:{read(all:boolean):Raster;preview(canvas:HTMLCanvasElement|null):void;changed():void;remember(options:ColorRangeOptions):void;release():void}){
  this.identity=image.contentIdentity();this.source=hooks.read(options.sampleAllLayers);
  this.state={options:{...options},sampling:'replace',positive:0,negative:0,busy:false,canApply:false,error:'请在图片上点击取样；Shift 加样，Alt 减样。',percent:0};
 }
 start():void{this.queue();}
 update(options:ColorRangeOptions):void{
  if(this.closed||!ColorRangeOptionsSchema.safeParse(options).success)throw new KlecksOperationRejected('色彩范围参数无效。');
  if(options.sampleAllLayers!==this.state.options.sampleAllLayers)this.source=this.hooks.read(options.sampleAllLayers);
  this.state.options={...options};this.hooks.remember(options);this.queue();
 }
 sampling(mode:'replace'|'add'|'subtract'):void{if(!['replace','add','subtract'].includes(mode))throw new Error('Invalid sampler');this.state.sampling=mode;this.hooks.changed();}
 sample(x:number,y:number,mode=this.state.sampling):void{
  if(this.closed)return;const sample=sampleRangeColor(this.source,x,y);
  if(!sample){this.state.error='此处透明或在图幅外，无法取色，请点击有颜色的像素。';this.hooks.changed();return;}
  if(mode==='replace'){this.positive=[sample];this.negative=[];}
  else{
   const points=mode==='add'?this.positive:this.negative;
   if(points.some(s=>s.r===sample.r&&s.g===sample.g&&s.b===sample.b&&(!this.state.options.localized||s.x===sample.x&&s.y===sample.y)))return;
   if(this.positive.length+this.negative.length>=32){this.state.error='最多保留 32 个取样点，请重置取样后重试。';this.hooks.changed();return;}
   points.push(sample);
  }
  this.state.options={...this.state.options,preset:'sampled'};this.state.positive=this.positive.length;this.state.negative=this.negative.length;
  this.hooks.remember(this.state.options);this.queue();
 }
 reset():void{this.positive=[];this.negative=[];this.state.positive=this.state.negative=0;this.state.options={...this.state.options,invert:false,preset:'sampled'};this.hooks.remember(this.state.options);this.queue();}
 apply():void{
  if(this.closed||this.state.busy||!this.result||!this.state.canApply||!this.inputsValid())throw new KlecksOperationRejected('请先完成有效的色彩范围预览，再确认选区。');
  if(this.image.contentIdentity()!==this.identity)throw new KlecksOperationRejected('图片已更改，请取消并重新建立色彩范围。');
  const {outline,coverage}=this.result;this.image.select(outline.length?outline:undefined,'replace',{antiAlias:true,feather:0,coverage});
 }
 close():void{if(this.closed)return;this.closed=true;this.abort?.abort();this.abort=null;this.result=null;this.source.data=new Uint8ClampedArray();this.hooks.preview(null);this.hooks.release();}
 private queue():void{
  this.abort?.abort();this.result=null;this.state.canApply=false;this.state.error='';
  if(!this.inputsValid()){this.state.busy=false;this.state.error='参数超出有效范围，请修正标红的输入项后再确认。';this.hooks.changed();return;}
  if(this.state.options.preset==='sampled'&&!this.positive.length){this.hooks.preview(null);this.state.busy=false;this.state.error='请在图片上点击取样；Shift 加样，Alt 减样。';this.hooks.changed();return;}
  const controller=new AbortController();this.abort=controller;this.state.busy=true;this.hooks.changed();
  const options={...this.state.options},positive=[...this.positive],negative=[...this.negative],source=this.source;
  void(async()=>{
   let clock=performance.now();
   const checkpoint=async()=>{if(controller.signal.aborted)throw new DOMException('已取消','AbortError');if(performance.now()-clock>=8){await new Promise<void>(r=>setTimeout(r,0));clock=performance.now();}if(controller.signal.aborted)throw new DOMException('已取消','AbortError');};
   // Coalesce slider bursts before allocating full-resolution working buffers.
   await new Promise<void>(resolve=>setTimeout(resolve,35));await checkpoint();
   const alpha=await colorRangeMask(source,options,positive,negative,controller.signal);
   if(options.mode!=='replace'){
    const mask=selectionMask(source.width,source.height,this.image.history.getComposed().selection);
    if(!mask&&options.mode!=='add')throw new KlecksOperationRejected('当前没有选区，请先创建选区，再进行减去或交叉。');
    try{
     if(mask){const c=mask.getContext('2d')!;
      for(let y=0;y<source.height;y+=64){const rows=Math.min(64,source.height-y),before=c.getImageData(0,y,source.width,rows).data;
       for(let i=0;i<source.width*rows;i++){const a=before[i*4+3]!,index=y*source.width+i,b=alpha[index]!;alpha[index]=options.mode==='add'?Math.max(a,b):options.mode==='intersect'?Math.min(a,b):Math.max(0,a-b);}await checkpoint();}
     }
    }finally{if(mask)mask.width=mask.height=0;}
   }
   const coverage=encodeSelectionRaster(source.width,source.height,alpha),flags=new Uint8Array(alpha.length);let count=0;
   for(let i=0;i<alpha.length;i++){if(alpha[i]){flags[i]=2;count++;}if((i&65535)===0)await checkpoint();}
   const emptyCombination=!count&&['subtract','intersect'].includes(options.mode);
   const outline=await traceSelectedPixels(flags,source.width,source.height,false,checkpoint);
   const preview=document.createElement('canvas');preview.width=source.width;preview.height=source.height;
   try{
    const c=preview.getContext('2d')!,pixels=c.createImageData(source.width,source.height);
    for(let row=0;row<source.height;row++){
     for(let x=0;x<source.width;x++){const i=row*source.width+x,p=i*4,a=alpha[i]!/255,visible=a*source.data[p+3]!/255,matte=options.preview==='black'||options.preview==='white';
      for(let k=0;k<3;k++){const color=source.data[p+k]!;pixels.data[p+k]=options.preview==='grayscale'?alpha[i]!:options.preview==='black'?color*visible:options.preview==='white'?255*(1-visible)+color*visible:options.preview==='overlay'?(k===0?255*(1-a)*.55:0)+color*(1-(1-a)*.55):color;}
      pixels.data[p+3]=options.preview==='grayscale'||matte?255:source.data[p+3]!;
     }if((row&63)===0)await checkpoint();
    }
    c.putImageData(pixels,0,0);if(this.closed||this.abort!==controller)return;
    this.result={outline,coverage};this.state.canApply=count>0||emptyCombination;this.state.error=!count?(emptyCombination?'结果为空；确认后将取消原选区。':'当前设置没有选中任何像素，请调整取样或模糊度。'):'';this.state.percent=Math.round(count/alpha.length*10000)/100;this.hooks.preview(preview);preview.dataset.transferred='true';
   }finally{if(preview.dataset.transferred!=='true')preview.width=preview.height=0;}
  })().catch(error=>{if(!controller.signal.aborted&&!this.closed&&this.abort===controller)this.state.error=(error instanceof Error?error.message:'色彩范围预览失败，请重试。').replace('请开启连续区域或调整容差后重试。','请调整模糊度或缩小局部范围后重试。');}).finally(()=>{if(!this.closed&&this.abort===controller){this.state.busy=false;this.abort=null;this.hooks.changed();}});
 }
}
