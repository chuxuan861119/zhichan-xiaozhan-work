import type{HostDocument}from'./host-document';import{WhitespaceOptionsSchema,type WhitespaceOptions,type WhitespacePlan}from'../../../../src/shared/settings/design-whitespace';import type{WhitespaceState}from'../../../../src/renderer/src/design-patent/correction/klecks-whitespace-state';import{scanWhitespace,planWhitespace,type WhitespaceBounds}from'../../../../src/renderer/src/design-patent/correction/klecks-whitespace';import{KlecksOperationRejected}from'../../../../src/renderer/src/design-patent/correction/klecks-operation-error';
export class WhitespaceSession{
 state:WhitespaceState;private source:HTMLCanvasElement;private identity:string;private controller:AbortController|null=null;private closed=false;private disposed=false;
 private boundsCache=new Map<number,WhitespaceBounds|null>();
 constructor(private image:HostDocument,options:WhitespaceOptions,private hooks:{changed():void;apply(plan:WhitespacePlan,color:'white'|'transparent',signal:AbortSignal):Promise<void>;finished():void;remember(o:WhitespaceOptions):void;release():void}){
  this.identity=image.contentIdentity();const original=image.getDisplayComposite();this.source=document.createElement('canvas');this.source.width=original.width;this.source.height=original.height;this.source.getContext('2d')!.drawImage(original,0,0);
  this.state={options:{...options},busy:false,applying:false,canApply:false,error:'',plan:null,before:this.preview(null),after:null};
 }
 start(){this.queue();}
 update(options:WhitespaceOptions){if(this.closed||this.state.applying)throw new KlecksOperationRejected('请等待当前处理完成或取消。');this.state.options=WhitespaceOptionsSchema.parse(options);this.queue();}
 private preview(plan:WhitespacePlan|null){const w=plan?.rect.width??this.source.width,h=plan?.rect.height??this.source.height,s=Math.min(1,224/Math.max(w,h)),c=document.createElement('canvas');c.width=Math.max(1,Math.round(w*s));c.height=Math.max(1,Math.round(h*s));try{const x=c.getContext('2d')!;if(plan){if(this.state.options.color==='white'){x.fillStyle='white';x.fillRect(0,0,c.width,c.height);x.clearRect(plan.padding.left*s,plan.padding.top*s,plan.crop.width*s,plan.crop.height*s);}x.drawImage(this.source,plan.crop.left,plan.crop.top,plan.crop.width,plan.crop.height,plan.padding.left*s,plan.padding.top*s,plan.crop.width*s,plan.crop.height*s);}else x.drawImage(this.source,0,0,c.width,c.height);return c.toDataURL();}finally{c.width=c.height=0;}}
 private queue(){
  this.controller?.abort();const controller=new AbortController();this.controller=controller;this.state.busy=true;this.state.canApply=false;this.state.error='';this.state.plan=null;this.state.after=null;this.hooks.changed();const options={...this.state.options};
  void(async()=>{await new Promise<void>(r=>setTimeout(r,35));if(controller.signal.aborted)return;const width=this.source.width,height=this.source.height;
   let bounds:WhitespaceBounds|null=null;
   if(options.trim){if(this.boundsCache.has(options.tolerance))bounds=this.boundsCache.get(options.tolerance)!;else{bounds=await scanWhitespace({width,height,data:this.source.getContext('2d')!.getImageData(0,0,width,height).data},options.tolerance,controller.signal);if(!controller.signal.aborted)this.boundsCache.set(options.tolerance,bounds);}}
   if(this.closed||controller.signal.aborted)return;const plan=planWhitespace(width,height,bounds,options);this.state.plan=plan;this.state.after=this.preview(plan);this.state.canApply=plan.changed;if(!plan.changed)this.state.error='当前没有可裁白边，且未增加留白；图片保持不变。';
  })().catch(e=>{if(!controller.signal.aborted&&!this.closed)this.state.error=e instanceof Error?e.message:'预览失败，请重试。';}).finally(()=>{if(!this.closed&&this.controller===controller){this.state.busy=false;this.controller=null;this.hooks.changed();}});
 }
 apply(){
  if(this.closed||this.state.busy||!this.state.canApply||!this.state.plan)throw new KlecksOperationRejected('请等待有效预览后再确认。');
  if(this.image.contentIdentity()!==this.identity)throw new KlecksOperationRejected('图片已改变，请重新打开并预览。');
  const controller=new AbortController();this.controller=controller;this.state.busy=this.state.applying=true;this.state.canApply=false;this.hooks.changed();
  void this.hooks.apply(this.state.plan,this.state.options.color,controller.signal).then(()=>{if(this.closed)return;this.hooks.remember(this.state.options);this.state.applying=false;this.hooks.finished();}).catch(e=>{if(this.closed)return;if(controller.signal.aborted){this.state.applying=false;this.hooks.finished();}else{this.state.error=e instanceof KlecksOperationRejected?e.message:'处理未完成，原图和编辑内容已保留。';this.state.canApply=true;}}).finally(()=>{this.state.busy=this.state.applying=false;this.controller=null;if(this.closed)this.dispose();else this.hooks.changed();});
 }
 cancel(){if(this.state.applying){this.controller?.abort();return;}this.hooks.finished();}
 close(){if(this.closed)return;this.closed=true;this.controller?.abort();if(!this.state.applying)this.dispose();}
 private dispose(){if(this.disposed)return;this.disposed=true;this.source.width=this.source.height=0;this.hooks.release();}
}
