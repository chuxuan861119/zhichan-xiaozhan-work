import{HISTORY_TILE_SIZE}from'../app/script/klecks/history/kl-history';
import{drawStrokeRegion}from'./stroke-region';
export type RetouchOptions={tool:'clone'|'blur';size:number;hardness:number;opacity:number;flow?:number;strength:number;offset:{x:number;y:number};merged:boolean};
type Point=readonly[number,number,number];
function copy(source:HTMLCanvasElement){const c=document.createElement('canvas');c.width=source.width;c.height=source.height;c.getContext('2d')!.drawImage(source,0,0);return c;}
/** Immutable clone source; live preview is rolled back by the document owner on cancel/failure. */
export class RetouchStroke{
 readonly base:HTMLCanvasElement;private source:HTMLCanvasElement;private paint:HTMLCanvasElement;private last:Point|null=null;private patch=document.createElement('canvas');private tip=document.createElement('canvas');
 private dirty: {left:number;top:number;right:number;bottom:number}|null=null;private touched:boolean[]=[];
 private masked=document.createElement('canvas');
 changedTiles(){return this.touched;}
 constructor(private target:HTMLCanvasElement,source:HTMLCanvasElement,private mask:HTMLCanvasElement|null,private alphaLocked:boolean,private options:RetouchOptions){this.base=copy(target);this.source=copy(source);this.paint=document.createElement('canvas');this.paint.width=target.width;this.paint.height=target.height;}
 move(point:Point){const previous=this.last??point,dx=point[0]-previous[0],dy=point[1]-previous[1],steps=Math.max(1,Math.ceil(Math.hypot(dx,dy)/Math.max(1,this.options.size/4)));for(let i=1;i<=steps;i++)this.dab(previous[0]+dx*i/steps,previous[1]+dy*i/steps);if(this.options.tool==='clone'&&this.dirty)this.refreshClone();this.last=point;}
 private refreshClone(){const dirty=this.dirty;if(!dirty)return;if(this.masked.width!==this.paint.width||this.masked.height!==this.paint.height){this.masked.width=this.paint.width;this.masked.height=this.paint.height;}const path=new Path2D();path.rect(dirty.left,dirty.top,dirty.right-dirty.left,dirty.bottom-dirty.top);const m=this.masked.getContext('2d')!;m.save();m.clip(path);m.globalCompositeOperation='copy';drawStrokeRegion(m,this.paint,dirty);if(this.mask){m.globalCompositeOperation='destination-in';drawStrokeRegion(m,this.mask,dirty);}m.restore();const target=this.target.getContext('2d')!;target.save();target.clip(path);target.globalAlpha=1;target.globalCompositeOperation='copy';drawStrokeRegion(target,this.base,dirty);target.globalCompositeOperation=this.alphaLocked?'source-atop':'source-over';target.globalAlpha=this.options.opacity;drawStrokeRegion(target,this.masked,dirty);target.restore();this.dirty=null;}
 private dab(x:number,y:number){const o=this.options,r=o.size/2,left=Math.max(0,Math.floor(x-r)),top=Math.max(0,Math.floor(y-r)),right=Math.min(this.target.width,Math.ceil(x+r)),bottom=Math.min(this.target.height,Math.ceil(y+r)),w=right-left,h=bottom-top;if(w<=0||h<=0)return;
  const previous=this.dirty;this.dirty={left:Math.min(previous?.left??left,left),top:Math.min(previous?.top??top,top),right:Math.max(previous?.right??right,right),bottom:Math.max(previous?.bottom??bottom,bottom)};const cols=Math.ceil(this.target.width/HISTORY_TILE_SIZE);for(let row=Math.floor(top/HISTORY_TILE_SIZE);row<=Math.floor((bottom-1)/HISTORY_TILE_SIZE);row++)for(let col=Math.floor(left/HISTORY_TILE_SIZE);col<=Math.floor((right-1)/HISTORY_TILE_SIZE);col++)this.touched[row*cols+col]=true;
  this.patch.width=this.tip.width=w;this.patch.height=this.tip.height=h;const p=this.patch.getContext('2d')!,t=this.tip.getContext('2d')!;
  if(o.tool==='clone'){p.imageSmoothingEnabled=false;p.drawImage(this.source,Math.round(-left-o.offset.x),Math.round(-top-o.offset.y));}else{p.filter='blur(2px)';p.drawImage(this.target,-left,-top);p.filter='none';}
  if(o.hardness<1){const gradient=t.createRadialGradient(x-left,y-top,r*o.hardness,x-left,y-top,r);gradient.addColorStop(0,'white');gradient.addColorStop(1,'transparent');t.fillStyle=gradient;}else t.fillStyle='white';t.beginPath();t.arc(x-left,y-top,r,0,Math.PI*2);t.fill();
  if(this.mask&&o.tool==='blur'){t.globalCompositeOperation='destination-in';t.drawImage(this.mask,-left,-top);}
  p.globalCompositeOperation='destination-in';p.drawImage(this.tip,0,0);
  const target=this.target.getContext('2d')!;target.save();this.paint.getContext('2d')!.globalAlpha=o.flow??1;
  if(o.tool==='clone')this.paint.getContext('2d')!.drawImage(this.patch,left,top);else{target.globalCompositeOperation='source-atop';target.globalAlpha=o.strength;target.drawImage(this.patch,left,top);}
  target.restore();
 }
 changed(){const old=this.base.getContext('2d')!,next=this.target.getContext('2d')!,cols=Math.ceil(this.target.width/HISTORY_TILE_SIZE);for(let i=0;i<this.touched.length;i++){if(!this.touched[i])continue;const x=i%cols*HISTORY_TILE_SIZE,y=Math.floor(i/cols)*HISTORY_TILE_SIZE,w=Math.min(HISTORY_TILE_SIZE,this.target.width-x),h=Math.min(HISTORY_TILE_SIZE,this.target.height-y),a=old.getImageData(x,y,w,h).data,b=next.getImageData(x,y,w,h).data;if(a.some((n,i)=>n!==b[i]))return true;}return false;}
 rollback(){const c=this.target.getContext('2d')!;c.save();c.globalCompositeOperation='copy';c.globalAlpha=1;c.drawImage(this.base,0,0);c.restore();}
 destroy(){for(const c of[this.base,this.source,this.paint,this.masked,this.patch,this.tip,this.mask])if(c)c.width=c.height=0;}
}
