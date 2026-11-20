import type{HostDocument}from'./host-document';
import{ToneOptionsSchema,type ToneOptions,type ToneState}from'../../../../src/shared/settings/design-tone';
import{KlecksOperationRejected}from'../../../../src/renderer/src/design-patent/correction/klecks-operation-error';
function thumbnail(source:HTMLCanvasElement){const c=document.createElement('canvas'),scale=Math.min(1,224/Math.max(source.width,source.height));c.width=Math.max(1,Math.round(source.width*scale));c.height=Math.max(1,Math.round(source.height*scale));try{c.getContext('2d')!.drawImage(source,0,0,c.width,c.height);return c.toDataURL();}finally{c.width=c.height=0;}}
export class ToneSession{
 state:ToneState;private abort:AbortController|null=null;private closed=false;
 constructor(private image:HostDocument,options:ToneOptions,private hooks:{changed():void;finished():void;remember(o:ToneOptions):void;release():void}){
  const id=image.history.getComposed().activeLayerId,layer=image.canvas.getLayers().find(l=>l.id===id)!;
  this.state={options:{...options},busy:false,applying:false,canApply:false,error:'',before:thumbnail(layer.canvas),after:null,histogram:Array(256).fill(0)};
 }
 start(){this.queue();}
 update(raw:ToneOptions){if(this.state.applying)throw new KlecksOperationRejected('请先等待处理完成或取消。');this.state.options=ToneOptionsSchema.parse(raw);this.queue();}
 private queue(){this.abort?.abort();const abort=new AbortController();this.abort=abort;this.state.busy=true;this.state.canApply=false;this.state.error='';this.state.after=null;this.hooks.changed();const options={...this.state.options};
  void(async()=>{await new Promise(r=>setTimeout(r,60));if(abort.signal.aborted)return;const result=await this.image.tonePixels(options,abort.signal,false);try{if(this.closed||abort.signal.aborted)return;this.state.after=thumbnail(result.canvas);this.state.histogram=result.histogram;this.state.canApply=result.changed;if(!result.changed)this.state.error='本次调整未改变像素，或选区内没有不透明内容。';}finally{result.canvas.width=result.canvas.height=0;}})().catch(e=>{if(!this.closed&&!abort.signal.aborted)this.state.error=e instanceof KlecksOperationRejected?e.message:'预览未完成，请重试。';}).finally(()=>{if(!this.closed&&this.abort===abort){this.state.busy=false;this.abort=null;this.hooks.changed();}});
 }
 apply(){if(this.state.busy||!this.state.canApply)throw new KlecksOperationRejected('请等待有效预览后再应用。');const abort=new AbortController();this.abort=abort;this.state.busy=this.state.applying=true;this.state.canApply=false;this.hooks.changed();
  void this.image.tonePixels(this.state.options,abort.signal).then(result=>{result.canvas.width=result.canvas.height=0;if(!this.closed){this.hooks.remember(this.state.options);this.state.applying=false;this.hooks.finished();}}).catch(e=>{if(this.closed)return;if(abort.signal.aborted){this.state.applying=false;this.hooks.finished();}else{this.state.error=e instanceof KlecksOperationRejected?e.message:'处理未完成，原图和编辑内容已保留。';this.state.canApply=true;}}).finally(()=>{this.state.busy=this.state.applying=false;if(this.closed)this.release();else this.hooks.changed();});
 }
 cancel(){if(this.state.applying)this.abort?.abort();else this.hooks.finished();}
 close(){this.closed=true;this.abort?.abort();if(!this.state.applying)this.release();}
 private released=false;private release(){if(!this.released){this.released=true;this.hooks.release();}}
}
