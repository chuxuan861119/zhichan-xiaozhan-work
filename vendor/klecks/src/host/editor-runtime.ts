import { HostDocument, THostDocumentSnapshot, TStrokeOptions, THostCanvasAnchor, THostRasterSource, THostProject } from './host-document';
import { HostWorkspace } from './host-workspace';
import { KlecksSessionCache, createKlecksSessionStore } from '../../../../src/renderer/src/design-patent/correction/klecks-session-cache';
import { HostCanvasSurface } from './canvas-surface';
import { bindKlecksPointerInput, KlecksPointerDriver } from '../../../../src/renderer/src/design-patent/correction/klecks-pointer-input';
import { bindKlecksKeyboard, KlecksKeyboardCommand } from '../../../../src/renderer/src/design-patent/correction/klecks-keyboard';
import { clickZoom } from '../../../../src/renderer/src/design-patent/correction/klecks-navigation';
import { routeKlecksCommand } from '../../../../src/renderer/src/design-patent/correction/klecks-command-router';
import { bindKlecksWheelInput } from '../../../../src/renderer/src/design-patent/correction/klecks-wheel-input';
import { zoomViewport, imageToScreen, screenToImage, KlecksViewport } from '../../../../src/renderer/src/design-patent/correction/klecks-viewport';
import { KlecksDocumentSessions, KlecksSessionToken } from '../../../../src/renderer/src/design-patent/correction/klecks-document-sessions';
import type { KlecksLayerCommand } from '../../../../src/renderer/src/design-patent/correction/klecks-layer-controls';
import { translateMultiPolygon } from '../app/script/bb/multi-polygon/translate-multi-polygon';
import { KlecksOperationRejected } from '../../../../src/renderer/src/design-patent/correction/klecks-operation-error';
import { showKlecksContextMenu, type KlecksMenuItem } from '../../../../src/renderer/src/design-patent/correction/klecks-context-menu';
import { DEFAULT_DESIGN_EDITOR_PREFERENCES, DesignEditorPreferencesSchema, type DesignEditorPreferences } from '../../../../src/shared/settings/design-editor-preferences';
import { KlecksResourceBudget, KlecksResourcePolicy } from '../../../../src/renderer/src/design-patent/correction/klecks-resource-budget';
import type { KlecksTransformMatrix, KlecksTransformBounds } from '../../../../src/renderer/src/design-patent/correction/klecks-transform';
import { bindKlecksToolCursor } from '../../../../src/renderer/src/design-patent/correction/klecks-tool-cursor';
import { bindKlecksToolExit } from '../../../../src/renderer/src/design-patent/correction/klecks-tool-exit';
import { klecksToolShape } from '../../../../src/renderer/src/design-patent/correction/klecks-cursor-shapes';
import { dragTransformHandle, hitTransformHandle, multiplyTransform, type BoxHandle } from '../../../../src/renderer/src/design-patent/correction/klecks-box-handles';
import { klecksTransformPixelBounds } from '../../../../src/renderer/src/design-patent/correction/klecks-transform';
import { isKlecksToolCommand, type KlecksSelectionOptions } from '../../../../src/renderer/src/design-patent/correction/klecks-tool-port';
import type { ClipboardImage } from '../../../../src/shared/ipc/contract';
import type { KlecksClipboardAction } from '../../../../src/renderer/src/design-patent/correction/klecks-native-clipboard';
import { bindKlecksBrushAdjustment } from '../../../../src/renderer/src/design-patent/correction/klecks-brush-adjustment';
import { magicWandSelection, type MagicWandOptions } from '../../../../src/renderer/src/design-patent/correction/klecks-magic-wand';
import { ColorRangeSession } from './color-range-session';
import type { ColorRangeOptions } from '../../../../src/shared/settings/design-color-range';
import {DEFAULT_FILL,FillOptionsSchema,type FillOptions,BucketOptionsSchema,type BucketOptions} from '../../../../src/shared/settings/design-fill';
import {resolveFillColor} from '../../../../src/renderer/src/design-patent/correction/klecks-fill';
import{WhitespaceSession}from'./whitespace-session';
import{ToneSession}from'./tone-session';
import type{ToneOptions}from'../../../../src/shared/settings/design-tone';
import type{WhitespaceOptions}from'../../../../src/shared/settings/design-whitespace';
import {DEFAULT_WHITESPACE} from '../../../../src/shared/settings/design-whitespace';
import {scanTrimEdges} from '../../../../src/renderer/src/design-patent/correction/klecks-auto-trim';
import {planWhitespace} from '../../../../src/renderer/src/design-patent/correction/klecks-whitespace';

type Tool = ReturnType<KlecksPointerDriver['getTool']>;
type Callbacks = { changed(): void; error(error: unknown): void };
type PaintPoint = readonly [number, number, number];
type PaintEndpoint = { imageId: string; point: PaintPoint; layerId: string; contentId: string };

/** UI-independent assembly; the case owner must retain it across workflow-step changes. */
export class HostEditorRuntime {
    private readonly sessionStore = typeof indexedDB === 'undefined' ? null : createKlecksSessionStore();
    private readonly workspace = new HostWorkspace(this.sessionStore ? new KlecksSessionCache(this.sessionStore) : undefined);
    private readonly saves = new KlecksDocumentSessions<null>();
    private readonly initialized = new Set<string>();
    private readonly applied = new Map<string, { contentId: string | null; revision: number }>();
    private readonly checkpoints = new Map<string, { identity: string; revision: number }>();
    private readonly savedSelections = new Map<string, string>();
    private readonly selectionSaveTokens = new WeakMap<KlecksSessionToken, string>();
    private readonly display: HostCanvasSurface;
    private readonly cursor: ReturnType<typeof bindKlecksToolCursor>;
    private readonly releases: (() => void)[] = [];
    private readonly listeners = new Set<() => void>();
    private readonly saveListeners=new Set<()=>void>();
    private readonly clipboardListeners=new Set<(action:KlecksClipboardAction)=>void>();
    private externalClipboard=false;
    onClipboardRequested(listener:(action:KlecksClipboardAction)=>void):()=>void{this.clipboardListeners.add(listener);return()=>{this.clipboardListeners.delete(listener);};}
    setExternalClipboard(enabled:boolean):void{this.assertOpen();this.externalClipboard=enabled;}
    onSaveRequested(listener:()=>void):()=>void{this.assertOpen();this.saveListeners.add(listener);return()=>{this.saveListeners.delete(listener);};}
    private readonly resources: KlecksResourceBudget;
    private gestureRelease: (() => void) | null = null;
    private readonly paintEndpoints = new Map<string, PaintEndpoint>();
    private painting: { key: string; imageId: string; point: PaintPoint; layerId: string } | null = null;
    private pending = false;
    private readonly inputLocks = new Map<string, string>();
    private scope(id: string): string { return id.includes(':') ? id.split(':')[0] : ''; }
    private get inputLock(): string | null { return this.inputLocks.get(this.scope(this.workspace.activeId ?? '')) ?? null; }
    private inputPending = false;
    private navigationActive = false;
    private polygonNavigable=false;
    private polygonClose=false;
    private pointerInput?:ReturnType<typeof bindKlecksPointerInput>;
    private boxCursor:string|null=null;
    private adjustingBrush=false;
    private cursorPreferences={tip:'normal' as 'normal'|'full'|'precise',crosshair:false};
    private cropDraft: { id: string; rect: { left: number; top: number; width: number; height: number } } | null = null;
    private transformDraft: { id: string; target:'pixels'|'selection'; layerId: string; identity: string; bounds: KlecksTransformBounds; matrix: KlecksTransformMatrix; past: KlecksTransformMatrix[]; future: KlecksTransformMatrix[]; release: () => void } | null = null;
    private deleteCroppedPixels = false;
    private closed = false;
    private loadingIntent = 0;
    private zoomWithWheel = DEFAULT_DESIGN_EDITOR_PREFERENCES.navigation.wheel;
    private navigation = { mode: 'marquee' as 'marquee' | 'scrubby', center: false };
    private displayPreferences={pixelGrid:true,selectionEdges:true};
    private selectionOptions:KlecksSelectionOptions={mode:'replace',style:'normal',width:1,height:1,feather:0,antiAlias:true};
    private sampleSource: 'current' | 'merged' = 'merged';
    private autoSelect=true;
    private pointerSelectionMode:KlecksSelectionOptions['mode']|null=null;
    private transformLinked=true;
    private activePointerTool:Tool|null=null;
    private tool: Tool = 'hand';
    private marquee: Tool = 'rectangle';
    private lasso: Tool = 'lasso';
    private stroke: TStrokeOptions = { tool: 'brush', size: 8, opacity: 1, color: { r: 0, g: 0, b: 0 }, backgroundColor: { r: 255, g: 255, b: 255 } };
    private toolMemory=structuredClone(DEFAULT_DESIGN_EDITOR_PREFERENCES);
    private wandOptions:MagicWandOptions={tolerance:32,contiguous:true,antiAlias:true,sampleSize:1,sampleAllLayers:false};
    private wandAbort:AbortController|null=null;
    private colorRange:ColorRangeSession|null=null;
    private colorRangeSpace=false;
    private fillState:{dialog:boolean;busy:boolean;error:string}|null=null;
    private fillAbort:AbortController|null=null;
    private whitespace:WhitespaceSession|null=null;
    private tone:ToneSession|null=null;
    private cloneSources=new Map<string,{x:number;y:number;offset?:{x:number;y:number};width:number;height:number}>();
    private cloneCurrentOffset:{x:number;y:number}|null=null;
    setRetouchOptions(o:{aligned:boolean;merged:boolean;strength:number}):void{this.assertEditable();if(!isKlecksToolCommand({action:'retouchOptions',aligned:o.aligned,merged:o.merged,strength:o.strength}))throw new KlecksOperationRejected('修图参数无效。');if(this.toolMemory.retouch.aligned!==o.aligned)for(const source of this.cloneSources.values())delete source.offset;this.toolMemory.retouch={aligned:o.aligned,merged:o.merged,strength:o.strength};this.emit();}
    beginTone(mode:'levels'|'threshold'):void{
        this.assertEditable();const image=this.requireDocument(),release=this.reserveImageWork(6);
        try{this.tone=new ToneSession(image,{...this.toolMemory.tone,mode},{changed:()=>this.emit(),remember:o=>{this.toolMemory.tone={...o};},release,finished:()=>{const draft=this.tone;this.tone=null;draft?.close();this.pending=this.inputPending||!!this.whitespace||!!this.fillState||!!this.cropDraft||!!this.transformDraft||!!this.wandAbort||!!this.colorRange;if(!this.closed){this.display.redraw();this.emit();}}});this.pending=true;this.tone.start();this.emit();}catch(e){release();this.tone=null;throw e;}
    }
    updateTone(options:ToneOptions):void{if(!this.tone||this.inputLock)throw new KlecksOperationRejected('请先打开色阶或阈值面板。');this.tone.update(options);}
    applyTone():void{if(!this.tone||this.inputLock)throw new KlecksOperationRejected('请先打开色阶或阈值面板。');this.tone.apply();}
    cancelTone():void{this.tone?.cancel();}
    async autoTrim(options:import('../../../../src/shared/settings/design-auto-trim').AutoTrimOptions):Promise<void>{
        this.assertEditable();const image=this.requireDocument(),view=this.workspace.viewport;
        const release=this.resources.reserve(image.canvas.getWidth()*image.canvas.getHeight()*8);
        this.pending=true;this.emit();
        try{
            const composite=image.getDisplayComposite();
            const bounds=await scanTrimEdges({width:composite.width,height:composite.height,data:composite.getContext('2d')!.getImageData(0,0,composite.width,composite.height).data},options);
            if(!bounds)throw new KlecksOperationRejected('没有识别到需要保留的图像内容，图片未改变。');
            const plan=planWhitespace(composite.width,composite.height,bounds,{...DEFAULT_WHITESPACE,trim:true,pad:false});
            if(!plan.changed)return;
            const budget=this.reserveImageWork(6,plan.rect.width,plan.rect.height);
            try{await image.adjustWhitespace(plan,'transparent');}finally{budget();}
            if(view){const origin=imageToScreen(view,{x:bounds.left,y:bounds.top});this.workspace.setViewport({...view,...origin});}
        }finally{release();this.pending=false;this.display.redraw();this.emit();}
    }
    beginWhitespace(mode:'trim'|'pad'):void{
        this.assertEditable();if(!['trim','pad'].includes(mode))throw new Error('Invalid whitespace mode');const image=this.requireDocument(),release=this.resources.reserve(image.canvas.getWidth()*image.canvas.getHeight()*8+2000000);
        try{
            this.whitespace=new WhitespaceSession(image,{...this.toolMemory.whitespace,trim:mode==='trim',pad:mode==='pad'},{changed:()=>this.emit(),remember:options=>{this.toolMemory.whitespace={...options};},release,
                apply:async(plan,color,signal)=>{const budget=this.reserveImageWork(6,plan.rect.width,plan.rect.height);try{await image.adjustWhitespace(plan,color,signal);}finally{budget();}},
                finished:()=>{const draft=this.whitespace;if(!draft)return;this.whitespace=null;draft.close();this.pending=this.inputPending||!!this.fillState||!!this.cropDraft||!!this.transformDraft||!!this.wandAbort||!!this.colorRange;if(!this.closed){if(!draft.state.options.trim&&draft.state.plan?.changed)this.fit();this.display.redraw();this.emit();}},
            });this.pending=true;this.whitespace.start();this.emit();
        }catch(error){release();this.whitespace=null;throw error;}
    }
    updateWhitespace(options:WhitespaceOptions):void{this.requireWhitespace().update(options);}
    applyWhitespace():void{this.requireWhitespace().apply();}
    cancelWhitespace():void{this.whitespace?.cancel();}
    private requireWhitespace():WhitespaceSession{this.assertOpen();if(!this.whitespace||this.inputLock)throw new KlecksOperationRejected('请先打开白边与留白设置。');return this.whitespace;}
    beginFill():void{this.setTool('bucket');}
    private invalidBucketInputs=new Set<string>();
    setBucketInputValidity(field:string,valid:boolean):void{if(valid)this.invalidBucketInputs.delete(field);else this.invalidBucketInputs.add(field);}
    setBucketOptions(options:Partial<BucketOptions>):void{this.assertEditable();this.toolMemory.bucket=BucketOptionsSchema.parse({...this.toolMemory.bucket,...options});this.emit();}
    bucketAt(point:PaintPoint):void{
        try{
            this.assertEditable();const image=this.requireDocument(),[x,y]=point;
            if(['opacity','color',...(!image.canvas.getSelection()?['tolerance']:[])].some(field=>this.invalidBucketInputs.has(field)))throw new KlecksOperationRejected('请先修正油漆桶工具栏中标红的参数或颜色。');
            if(x<0||y<0||x>=image.canvas.getWidth()||y>=image.canvas.getHeight())throw new KlecksOperationRejected('请在图片范围内点击油漆桶。');
            if(image.canvas.getSelection()&&!image.selectionContains(x,y))throw new KlecksOperationRejected('点击位置在选区外，请点击选区内部进行填充。');
            const layers=image.layerState().layers,selected=image.selectedLayerIds(),active=layers.find(layer=>layer.id===selected[0]);
            if(selected.length!==1||!active)throw new KlecksOperationRejected('请先选择一个图层，再使用油漆桶。');
            if(!active.visible||active.locks.all||active.locks.pixels)throw new KlecksOperationRejected('当前图层已隐藏或像素已锁定，请显示并解锁后再填充。');
            const options=this.toolMemory.bucket;this.applyFill({...DEFAULT_FILL,opacity:options.opacity,blend:options.blend,preserveTransparency:options.preserveTransparency},point);
        }catch(error){this.callbacks.error(error);}
    }
    cancelFill():void{
        if(this.fillAbort){this.fillAbort.abort();return;}
        if(!this.fillState)return;this.fillState=null;this.pending=this.inputPending||!!this.cropDraft||!!this.transformDraft||!!this.wandAbort||!!this.colorRange;this.emit();
    }
    applyFill(options:FillOptions,point?:PaintPoint):void{
        this.assertOpen();if(this.fillAbort||this.inputLock)throw new KlecksOperationRejected('请等待当前填充完成或取消后再操作。');
        if(!this.fillState)this.assertEditable();
        if(!FillOptionsSchema.safeParse(options).success)throw new KlecksOperationRejected('填充参数无效。');
        const image=this.requireDocument(),bucket={...this.toolMemory.bucket},release=this.reserveImageWork(point?12:6),controller=new AbortController(),dialog=false;
        this.fillState={dialog,busy:true,error:''};this.fillAbort=controller;this.pending=true;this.emit();
        const color=resolveFillColor(options,this.stroke.color,this.stroke.backgroundColor??{r:255,g:255,b:255});
        const sourceIdentity=image.contentIdentity(),sourceSelection=JSON.stringify(image.history.getComposed().selection),sourceId=this.workspace.activeId;
        void (async()=>{
            let coverage:import('../../../../src/shared/patent/design-selection-coverage').DesignSelectionCoverage|undefined;
            if(point&&!image.canvas.getSelection()){
                await new Promise<void>(resolve=>setTimeout(resolve,0));if(controller.signal.aborted)throw new DOMException('已取消','AbortError');
                const width=image.canvas.getWidth(),height=image.canvas.getHeight();
                const pixels=image.readToolPixels(bucket.sampleAllLayers);
                const value=await magicWandSelection(pixels,point[0],point[1],{...bucket,sampleSize:1},{signal:controller.signal});
                if(controller.signal.aborted)throw new DOMException('已取消','AbortError');
                if(this.closed||this.workspace.document!==image||this.workspace.activeId!==sourceId||image.contentIdentity()!==sourceIdentity||JSON.stringify(image.history.getComposed().selection)!==sourceSelection)throw new KlecksOperationRejected('图片或选区已改变，本次油漆桶填充未提交，请重试。');
                if(!value.length)throw new KlecksOperationRejected('此处没有可填充区域，请调整容差后重试。');
                coverage={kind:'shape',value,antiAlias:bucket.antiAlias,feather:0};
            }
            await image.fillPixels(color,options,controller.signal,coverage);
        })().then(()=>{
            if(this.closed)return;if(dialog)this.toolMemory.fill=structuredClone(options);this.fillState=null;
        }).catch(error=>{
            if(this.closed)return;
            if(controller.signal.aborted)this.fillState=null;
            else if(dialog)this.fillState={dialog:true,busy:false,error:error instanceof KlecksOperationRejected?error.message:'填充未完成，原图片与编辑内容已保留，请重试。'};
            else{this.fillState=null;this.callbacks.error(error);}
        }).finally(()=>{
            release();if(this.closed)return;this.fillAbort=null;this.pending=!!this.fillState||this.inputPending||!!this.cropDraft||!!this.transformDraft||!!this.wandAbort||!!this.colorRange;if(controller.signal.aborted&&!this.pending)this.setTool('hand');this.display.redraw();this.emit();
        });
    }
    private rememberTool():void {
        if(this.tool==='magicWand')this.toolMemory.magicWand={...this.wandOptions,antiAlias:this.selectionOptions.antiAlias,mode:this.selectionOptions.mode};
        if(this.tool==='brush'||this.tool==='eraser'||this.tool==='clone'||this.tool==='blur')this.toolMemory[this.tool]={size:this.stroke.size,opacity:this.stroke.opacity,flow:this.stroke.flow??1,hardness:this.stroke.hardness??1};
        if(['rectangle','ellipse','lasso','polygon'].includes(this.tool))this.toolMemory.selections[this.tool as keyof DesignEditorPreferences['selections']]={...this.selectionOptions};
    }
    private restoreTool():void {
        if(this.tool==='magicWand'){
            const {mode,...options}=this.toolMemory.magicWand;this.wandOptions={...options};
            this.selectionOptions={mode,antiAlias:options.antiAlias,feather:0,style:'normal',width:1,height:1};
        }
        if(this.tool==='brush'||this.tool==='eraser'||this.tool==='clone'||this.tool==='blur')this.stroke={...this.stroke,...this.toolMemory[this.tool]};
        if(['rectangle','ellipse','lasso','polygon'].includes(this.tool))this.selectionOptions={...this.toolMemory.selections[this.tool as keyof DesignEditorPreferences['selections']]};
    }
    get preferences():DesignEditorPreferences {
        this.rememberTool();return structuredClone({...this.toolMemory,foreground:this.stroke.color,background:this.stroke.backgroundColor??{r:255,g:255,b:255},autoSelect:this.autoSelect,sampleSource:this.sampleSource,transformLinked:this.transformLinked,deletePixels:this.deleteCroppedPixels,cursor:this.cursorPreferences,navigation:{...this.navigation,wheel:this.zoomWithWheel,...this.displayPreferences}});
    }
    applyPreferences(value:DesignEditorPreferences):void {
        this.assertEditable();const settings=DesignEditorPreferencesSchema.parse(value);this.toolMemory=structuredClone(settings);
        this.stroke={...this.stroke,color:settings.foreground,backgroundColor:settings.background};this.autoSelect=settings.autoSelect;this.sampleSource=settings.sampleSource;this.transformLinked=settings.transformLinked;this.deleteCroppedPixels=settings.deletePixels;this.cursorPreferences={...settings.cursor};
        this.navigation={mode:settings.navigation.mode,center:settings.navigation.center};this.zoomWithWheel=settings.navigation.wheel;this.displayPreferences={pixelGrid:settings.navigation.pixelGrid,selectionEdges:settings.navigation.selectionEdges};
        this.restoreTool();this.display.setPixelGrid(settings.navigation.pixelGrid);this.display.setSelectionEdges(settings.navigation.selectionEdges);this.emit();
    }

    constructor(container: HTMLElement, platform: 'windows' | 'mac' | 'harmony', private readonly callbacks: Callbacks, resourcePolicy?: KlecksResourcePolicy) {
        this.resources = new KlecksResourceBudget(() => this.workspace.resourceUsage().minimumKnownPixelBytes, resourcePolicy);
        this.display = new HostCanvasSurface(container, this.workspace);
        const canvas = this.display.canvas;
        this.cursor = bindKlecksToolCursor(canvas, () => ({ tool: this.colorRange&&!this.inputPending?(this.colorRangeSpace?'hand':'eyedropper'):this.activePointerTool??this.tool, size: this.stroke.size, viewport: this.workspace.viewport,
            drawingSelection: this.inputPending && ['rectangle', 'ellipse'].includes(this.tool),
            override: !this.inputLock ? this.boxCursor : null,
            adjusting:this.adjustingBrush,
            ...this.cursorPreferences,hardness:this.stroke.hardness??1,
            platform,gestureActive:this.inputPending,polygonDraft:this.polygonNavigable,polygonClose:this.polygonClose,selectionMode:this.selectionOptions.mode,gestureSelectionMode:this.pointerSelectionMode,
            cloneSource:this.tool==='clone'?(()=>{const s=this.cloneSources.get(this.workspace.activeId!);return s?{x:s.x,y:s.y,offset:this.cloneCurrentOffset??(this.toolMemory.retouch.aligned?s.offset:undefined)}:null;})():null,
            enabled: !this.closed && !!this.workspace.document && !this.inputLock && !this.transformDraft }));
        this.releases.push(() => this.cursor.destroy());
        this.releases.push(bindKlecksBrushAdjustment(canvas,{platform,enabled:()=>!this.closed&&!this.pending&&!this.inputLock&&!!this.workspace.document&&['brush','eraser','clone','blur'].includes(this.tool),
            current:()=>({size:this.stroke.size,hardness:this.stroke.hardness??1}),changed:(brush,event)=>{this.stroke={...this.stroke,...brush};this.adjustingBrush=true;this.pending=true;if(event)this.cursor.syncPointer(event);this.emit();},
            finished:()=>{this.adjustingBrush=false;this.pending=this.inputPending||!!this.cropDraft||!!this.transformDraft;this.emit();}}));
        this.releases.push(this.bindBoxInput());
        const rejectEmpty = (event: PointerEvent) => {
            if(this.colorRange&&(event.button===1||this.colorRangeSpace))return;
            if(this.colorRange){event.preventDefault();event.stopImmediatePropagation();if(event.button===0){this.canvas.focus({preventScroll:true});const rect=this.canvas.getBoundingClientRect(),view=this.workspace.viewport;if(view){const p=screenToImage(view,{x:event.clientX-rect.left,y:event.clientY-rect.top});this.colorRange.sample(p.x,p.y,event.altKey?'subtract':event.shiftKey?'add':this.colorRange.state.sampling);}}return;}
            if (!this.workspace.document || this.inputLock || this.transformDraft || this.adjustingBrush || this.wandAbort) { event.preventDefault(); event.stopImmediatePropagation(); }
        };
        canvas.addEventListener('pointerdown', rejectEmpty, true);
        const lockedKey = (event: KeyboardEvent) => { if (this.inputLock) { event.preventDefault(); event.stopImmediatePropagation(); } };
        container.addEventListener('keydown', lockedKey, true);
        this.releases.push(() => container.removeEventListener('keydown', lockedKey, true));
        this.releases.push(() => canvas.removeEventListener('pointerdown', rejectEmpty, true));
        const rangeSpace=(event:KeyboardEvent)=>{if(this.colorRange&&event.code==='Space'&&!event.isComposing){this.colorRangeSpace=event.type==='keydown';this.cursor.refresh();}};
        const rangeBlur=()=>{this.colorRangeSpace=false;};
        canvas.addEventListener('keydown',rangeSpace,true);canvas.addEventListener('keyup',rangeSpace,true);canvas.addEventListener('blur',rangeBlur);window.addEventListener('blur',rangeBlur);
        this.releases.push(()=>{canvas.removeEventListener('keydown',rangeSpace,true);canvas.removeEventListener('keyup',rangeSpace,true);canvas.removeEventListener('blur',rangeBlur);window.removeEventListener('blur',rangeBlur);});
        this.pointerInput=bindKlecksPointerInput(canvas, {
            platform,
            getImageSize:()=>this.state.size,
            onActiveTool:tool=>{this.activePointerTool=tool;this.cursor.refresh();},
            onSelectionMode:mode=>{this.pointerSelectionMode=mode;this.cursor.refresh();},
            onPolygonDraftChange:active=>{this.polygonNavigable=active;this.cursor.refresh();},
            onPolygonCloseHint:close=>{this.polygonClose=close;this.cursor.refresh();},
            previewPolygon:(points,mode)=>this.display.previewPolygon(points,mode),
            prepareMove:(point,toggle)=>{const image=this.requireDocument();if(this.autoSelect!==toggle&&!image.canvas.getSelection()){const id=image.pickLayer(point[0],point[1]);if(id&&!image.selectedLayerIds().includes(id))image.setActiveLayer(id);this.emit();}},
            getNavigation: () => this.navigation,
            getSelectionOptions:()=>this.selectionOptions,
            magicWand:(point,mode)=>{void this.selectWithWand(point,mode).catch(error=>this.callbacks.error(error));},
            bucket:point=>this.bucketAt(point),
            hasSelection:()=>!!this.workspace.document?.canvas.getSelection(),
            deselect:()=>{this.requireDocument().deselect();this.emit();},
            previewZoom: rect => this.display.previewZoom(rect),
            getViewport: () => this.workspace.viewport ?? { zoom: 1, pixelRatio: window.devicePixelRatio || 1, x: 0, y: 0 },
            setViewport: view => { this.workspace.setViewport(view); this.emit(); }, getTool: () => this.tool,
            onPendingChange: pending => {
                if (!pending) this.navigationActive = false;
                else if (!this.inputPending) this.navigationActive = !this.pending &&
                    (this.activePointerTool === 'hand' || this.activePointerTool === 'zoom');
                this.inputPending = pending; this.pending = pending || !!this.tone || !!this.whitespace || !!this.fillState || !!this.cropDraft || !!this.transformDraft || !!this.wandAbort || !!this.colorRange; this.emit();
            },
            previewSelection: region => this.display.previewSelection(region),
            selectionContains: point => this.requireDocument().selectionContains(point[0], point[1]),
            moveSelection: (dx, dy, phase) => {
                const image = this.requireDocument();
                if (phase === 'preview') {
                    const region = image.canvas.getSelection();
                    this.display.previewSelection(region ? translateMultiPolygon(region, dx, dy) : null);
                } else {
                    try { if (phase === 'commit' && (dx !== 0 || dy !== 0)) image.moveSelection(dx, dy); }
                    finally { this.display.previewSelection(null); }
                    this.emit();
                }
            },
            crop: (region, phase) => {
                if (this.closed) return;
                if (phase === 'cancel' || !region.length) { this.cancelCrop(); return; }
                const points = region.flat(2);
                const left = Math.floor(Math.min(...points.map(point => point[0]))), top = Math.floor(Math.min(...points.map(point => point[1])));
                const right = Math.ceil(Math.max(...points.map(point => point[0]))), bottom = Math.ceil(Math.max(...points.map(point => point[1])));
                this.previewCrop({ left, top, width: right - left, height: bottom - top });
            },
            sampleColor: point => {
                const image = this.requireDocument();
                if (this.sampleSource === 'current' && !image.selectedLayerIds().length) throw new KlecksOperationRejected('请先选择需要取色的图层，或将取样范围改为“所有可见图层”。');
                const color = image.sampleColor(point[0], point[1], this.sampleSource);
                if (!color) throw new KlecksOperationRejected(point[0] < 0 || point[1] < 0 || point[0] >= image.canvas.getWidth() || point[1] >= image.canvas.getHeight()
                    ? '取色位置在图幅外，请在图片范围内取色。'
                    : this.sampleSource === 'current' ? '当前图层此处为透明像素，无法取色。请选择有颜色的位置，或将取样范围改为“所有可见图层”。' : '所有可见图层在此处均为透明，无法取色。请选择有颜色的位置。');
                this.stroke = { ...this.stroke, color }; this.emit();
            },
            movePixels: (dx, dy, phase,copy) => {
                if (phase === 'preview') {
                    this.requireDocument().assertMoveAllowed(copy);
                    this.gestureRelease ??= this.reserveImageWork(8);
                    const preview = this.requireDocument().previewPixelMove(dx, dy,copy);
                    this.display.previewComposite(preview.canvas,false); this.display.previewSelection(preview.selection ?? null);
                } else {
                    try { if (phase === 'commit') this.requireDocument().movePixels(dx, dy,copy); }
                    finally { this.display.previewComposite(null,false); this.display.previewSelection(null); this.releaseGesture(); }
                    this.emit();
                }
            },
            select: (region, mode) => {
                this.requireDocument().select(region, mode,this.selectionOptions); this.emit();
            },
            cloneSample:point=>{const image=this.requireDocument();if(point[0]<0||point[1]<0||point[0]>=image.canvas.getWidth()||point[1]>=image.canvas.getHeight())throw new KlecksOperationRejected('请在图片内按 Alt／Option 单击设置取样点。');this.cloneSources.set(this.workspace.activeId!,{x:Math.floor(point[0]),y:Math.floor(point[1]),width:image.canvas.getWidth(),height:image.canvas.getHeight()});this.emit();},
            beginStroke: (point, connectPrevious) => {
                this.gestureRelease = this.reserveImageWork(this.requireDocument().editingMask?4:8);
                try {
                    const image = this.requireDocument(), imageId = this.workspace.activeId!;
                    if(this.tool==='clone'||this.tool==='blur'){
                        const source=this.cloneSources.get(imageId),settings=this.toolMemory.retouch;
                        if(this.tool==='clone'&&(!source||source.width!==image.canvas.getWidth()||source.height!==image.canvas.getHeight()))throw new KlecksOperationRejected('请先按 Alt（Mac 为 Option）单击图片设置仿制取样点；图片尺寸改变后需重新取样。');
                        const offset=source?(settings.aligned&&source.offset?source.offset:{x:source.x-Math.floor(point[0]),y:source.y-Math.floor(point[1])}):{x:0,y:0};
                        image.beginRetouch(point,{tool:this.tool,size:this.stroke.size,hardness:this.stroke.hardness??1,opacity:this.stroke.opacity,flow:this.stroke.flow??1,strength:settings.strength,offset,merged:this.tool==='clone'&&settings.merged});this.cloneCurrentOffset=offset;return;
                    }
                    const key = JSON.stringify([imageId, this.saves.token(imageId).generation, this.tool]);
                    const layerId = image.layerState().activeLayerId;
                    const previous = this.paintEndpoints.get(key);
                    const connect = connectPrevious && previous?.layerId === layerId && previous.contentId === image.contentIdentity();
                    image.beginStroke(connect ? previous.point : point, { ...this.stroke, tool: this.tool === 'eraser' ? 'eraser' : 'brush' });
                    this.painting = { key, imageId, layerId, point: [...point] };
                    if (connect) image.moveStroke(point);
                }
                catch (error) { this.releaseGesture(); throw error; }
            },
            moveStroke: point => {if(this.tool==='clone'||this.tool==='blur')this.requireDocument().moveRetouch(point);else this.requireDocument().moveStroke(point); if (this.painting) this.painting.point = [...point]; },
            endStroke: () => {
                try {
                    const image = this.requireDocument();if(this.tool==='clone'||this.tool==='blur'){image.endRetouch();const source=this.cloneSources.get(this.workspace.activeId!);if(this.tool==='clone'&&source&&this.toolMemory.retouch.aligned&&this.cloneCurrentOffset)source.offset=this.cloneCurrentOffset;}else image.endStroke();
                    const painting = this.painting;
                    if (painting) this.paintEndpoints.set(painting.key, { imageId: painting.imageId, layerId: painting.layerId, point: painting.point, contentId: image.contentIdentity() });
                } finally { this.cloneCurrentOffset=null;this.painting = null; this.releaseGesture(); }
                this.emit();
            },
            cancelStroke: () => { try { this.workspace.document?.cancelRetouch();this.workspace.document?.cancelStroke(); } finally { this.cloneCurrentOffset=null;this.painting = null; this.releaseGesture(); } this.emit(); },
            redraw: () => this.display.redraw(), onError: error => this.callbacks.error(error),
        });
        this.releases.push(this.pointerInput);
        this.releases.push(this.bindCanvasContextMenu());
        this.releases.push(bindKlecksKeyboard(container, () => ({ platform, enabled: !this.closed && !!this.workspace.document && !this.inputLock, pending: this.pending,
            navigationWhilePending:this.polygonNavigable||!!this.colorRange,
            transformHistoryWhilePending:!!this.transformDraft && !this.inputPending,
            activeTool: this.tool,
            maskTarget:!!this.workspace.document?.editingMask,
            paintingTool: this.tool === 'brush' || this.tool === 'eraser'||this.tool==='clone'||this.tool==='blur' ? this.tool : null,
            strokeScope: `${this.workspace.activeId}:${this.workspace.activeId ? this.saves.token(this.workspace.activeId).generation : 0}:${this.tool}`,
        }), command => this.dispatch(command)));
        this.releases.push(bindKlecksToolExit(container,
            () => !this.closed && !!this.workspace.document && !this.inputLock && !this.fillState,
            () => {
                try {
                    // Reuse each input owner's rollback and capture-release path.
                    this.cancelWand();
                    this.cancelColorRange();
                    canvas.dispatchEvent(new Event('blur'));
                    if (this.transformDraft) this.cancelTransform();
                    if (this.cropDraft) this.cancelCrop();
                    this.workspace.document?.cancelFloatingMove();
                    this.activePointerTool = null;
                    this.setTool('hand');
                } catch (error) { this.callbacks.error(error); }
            }));
        const cropKey = (event: KeyboardEvent) => {
            if (event.isComposing || (!this.cropDraft && !this.transformDraft) || this.inputPending || !['Enter', 'Escape'].includes(event.key)) return;
            event.preventDefault(); event.stopImmediatePropagation();
            try {
                if (this.transformDraft) { if (event.key === 'Enter') this.applyTransform(); else this.cancelTransform(); }
                else if (event.key === 'Enter') this.applyCrop(); else this.cancelCrop();
            }
            catch (error) { this.callbacks.error(error); }
        };
        canvas.addEventListener('keydown', cropKey, true);
        const rangeKey=(event:KeyboardEvent)=>{if(this.fillState&&event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopImmediatePropagation();this.cancelFill();return;}if(this.colorRange&&!event.isComposing&&['Enter','Escape'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();try{if(event.key==='Enter')this.applyColorRange();else{this.cancelColorRange();this.setTool('hand');}}catch(error){this.callbacks.error(error);}}};
        canvas.addEventListener('keydown',rangeKey,true);this.releases.push(()=>canvas.removeEventListener('keydown',rangeKey,true));
        this.releases.push(() => canvas.removeEventListener('keydown', cropKey, true));
        this.releases.push(bindKlecksWheelInput(canvas, { viewport: () => this.workspace.viewport,
            enabled: () => !this.closed && (!this.pending||this.polygonNavigable||!!this.colorRange) && !this.inputLock, zoomWithWheel: () => this.zoomWithWheel,
            changed: view => { this.workspace.setViewport(view); this.pointerInput?.refreshViewport();this.display.redraw(); this.emit(); },
            error: error => this.callbacks.error(error) }));
    }

    get canvas(): HTMLCanvasElement { return this.display.canvas; }
    get state() { const image = this.workspace.document, id = this.workspace.activeId; return { selectionDirty: !!id && !!image && this.savedSelections.get(id) !== JSON.stringify(image.history.getComposed().selection), canUndo:this.transformDraft?this.transformDraft.past.length>0:!!image?.canUndo(),canRedo:this.transformDraft?this.transformDraft.future.length>0:!!image?.canRedo(),tone:this.tone?structuredClone(this.tone.state):null,whitespace:this.whitespace?structuredClone(this.whitespace.state):null,fill:this.fillState?{...this.fillState}:null,colorRange:this.colorRange?structuredClone(this.colorRange.state):null,preferences:this.preferences, activeId: id, ids: this.workspace.ids, dirty: id ? this.saves.get(id)?.dirty ?? false : false,
        controls:{bucket:{...this.toolMemory.bucket},magicWand:{...this.wandOptions,antiAlias:this.selectionOptions.antiAlias},colors:{foreground:{...this.stroke.color},background:{...(this.stroke.backgroundColor??{r:255,g:255,b:255})}},sampleSource:this.sampleSource,autoSelect:this.autoSelect,transformLinked:this.transformLinked,cursor:{...this.cursorPreferences},navigation:{...this.navigation,wheel:this.zoomWithWheel,...this.displayPreferences},selection:{...this.selectionOptions},crop:this.cropDraft?{...this.cropDraft.rect}:null,
            transform:this.transformDraft?{bounds:{...this.transformDraft.bounds},matrix:{...this.transformDraft.matrix},target:this.transformDraft.target}:null,deletePixels:this.deleteCroppedPixels},
        unapplied: id && image ? this.applied.get(id)?.contentId !== this.saves.token(id).contentId : false,
        wandBusy:!!this.wandAbort,pending: this.pending, hasSelection: !!image?.canvas.getSelection(), navigationActive: this.navigationActive && this.inputPending, locked: !!this.inputLock, checkpointRevision: id ? this.checkpoints.get(id)?.revision ?? 0 : 0, tool: this.tool, viewport: this.workspace.viewport, foreground: { ...this.stroke.color },
        brush: { size: this.stroke.size, opacity: this.stroke.opacity, flow: this.stroke.flow ?? 1, hardness: this.stroke.hardness ?? 1, color: { ...this.stroke.color } },
        ...(image?.layerState(!this.pending || this.navigationActive) ?? { activeLayerId: null, selectedLayerIds:[], layers: [] }),
        size: image ? { width: image.canvas.getWidth(), height: image.canvas.getHeight() } : null }; }

    layer(command: KlecksLayerCommand): void {
        this.assertEditable(); const image = this.requireDocument();
        const release = ['new', 'duplicate', 'mergeDown', 'duplicateMany', 'mergeMany', 'stampMany'].includes(command.operation)||command.operation==='mask'&&['add','addHide','apply','invert','selection'].includes(command.maskOperation) ? this.reserveImageWork(6) : () => {};
        try {
        switch (command.operation) {
            case 'mask': image.layerMask(command.id,command.maskOperation);break;
            case 'selectMany': image.setSelectedLayers(command.ids,command.id); break;
            case 'duplicateMany': image.duplicateLayers(command.ids); break;
            case 'deleteMany': image.deleteLayers(command.ids); break;
            case 'mergeMany': image.mergeLayers(command.ids); break;
            case 'stampMany': image.stampLayers(command.ids); break;
            case 'solo': image.soloLayer(command.id); break;
            case 'new': image.newLayer(command.name); break;
            case 'select': image.setActiveLayer(command.id); break;
            case 'delete': image.deleteLayer(command.id); break;
            case 'duplicate': image.duplicateLayer(command.id); break;
            case 'mergeDown': image.mergeDown(command.id); break;
            case 'rename': image.renameLayer(command.id, command.name); break;
            case 'backgroundToLayer': image.backgroundToLayer(command.id, command.name); break;
            case 'opacity': if(command.ids)image.setLayersOpacity(command.ids,command.opacity);else image.setLayerOpacity(command.id, command.opacity); break;
            case 'visibility': image.setLayerVisibility(command.id, command.visible); break;
            case 'move': if(command.ids)image.reorderLayers(command.ids,command.index);else image.moveLayer(command.id, command.index); break;
            case 'locks': if(command.ids)image.setLayersLocks(command.ids,command.locks);else image.setLayerLocks(command.id, command.locks); break;
        }
        } finally { release(); }
        this.display.redraw(); this.emit();
    }

    subscribe(listener: () => void): () => void { this.assertOpen(); this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

    interactionLock(token: string, locked: boolean): void {
        this.assertOpen();
        const scope = this.scope(token), existing = this.inputLocks.get(scope);
        if (scope === this.scope(this.workspace.activeId ?? '')) this.assertIdle();
        if (!token || token.length > 200 || (existing && existing !== token)) throw new Error('Checkpoint interaction lock belongs to another operation');
        if (locked) this.inputLocks.set(scope, token); else this.inputLocks.delete(scope);
        this.emit();
    }

    sync(ids: readonly string[], lockToken?: string): void {
        this.assertOpen();
        if (lockToken !== undefined && ![...this.inputLocks.values()].includes(lockToken)) throw new Error('Reset input lock does not belong to this operation');
        for (const [scope, token] of this.inputLocks) {
            const before = this.workspace.ids.filter(id => this.scope(id) === scope), after = ids.filter(id => this.scope(id) === scope);
            if (lockToken !== token && JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Image collection is locked for checkpoint');
        }
        if (this.pending && this.workspace.activeId && !ids.includes(this.workspace.activeId)) throw new Error('Finish or cancel the current gesture before removing this image');
        const previous = this.workspace.activeId;
        this.workspace.sync(ids);
        for(const key of this.cloneSources.keys())if(!ids.includes(key))this.cloneSources.delete(key);
        this.saves.sync(ids);
        for (const id of this.initialized) if (!ids.includes(id)) { this.initialized.delete(id); this.applied.delete(id); this.checkpoints.delete(id); this.savedSelections.delete(id); }
        for (const [key, endpoint] of this.paintEndpoints) if (!ids.includes(endpoint.imageId)) this.paintEndpoints.delete(key);
        if (previous !== this.workspace.activeId) this.display.previewSelection(null);
        this.display.redraw(); this.emit();
    }

    async openRaster(id: string, name: string, read: () => Promise<THostRasterSource>): Promise<boolean> {
        this.assertIdle();
        const intent = ++this.loadingIntent;
        await this.workspace.parkSuspended();
        const cachedRelease = this.resources.reserve(this.workspace.cachedBytes(id) * 4);
        try {
        await this.workspace.hydrate(id);
        if (this.closed || intent !== this.loadingIntent) return false;
        this.assertIdle();
        const image = await this.workspace.openAsync(id, async () => {
            const source = await read();
            const release = this.resources.reserve(source.widthPx * source.heightPx * 4 * 12 + source.bytes.byteLength * 2);
            let decoded: HostDocument;
            try { decoded = await HostDocument.fromPng(id, name, source); }
            finally { release(); }
            if (this.closed || this.pending) { decoded.destroy(); throw new Error('Image switch cancelled by pending gesture'); }
            return decoded;
        });
        if (!image || this.closed || intent !== this.loadingIntent) return false;
        this.establishSavepoint(id);
        this.display.previewSelection(null); this.display.redraw(); this.emit();
        await this.workspace.parkSuspended(); return true;
        } finally { cachedRelease(); }
    }

    captureActive(): THostDocumentSnapshot | null { this.assertIdle(); return this.workspace.document?.capture() ?? null; }
    activate(id: string): boolean {
        this.assertIdle();
        this.workspace.open(id, () => { throw new Error('Image must be loaded before activation'); });
        this.display.previewSelection(null); this.display.redraw(); this.emit(); return true;
    }
    async activateCached(id: string): Promise<boolean> {
        this.assertIdle();
        const intent = ++this.loadingIntent;
        await this.workspace.parkSuspended();
        const release = this.resources.reserve(this.workspace.cachedBytes(id) * 4);
        try {
        await this.workspace.hydrate(id);
        if (this.closed || intent !== this.loadingIntent) return false;
        const accepted = this.activate(id);
        await this.workspace.parkSuspended();
        return accepted;
        } finally { release(); }
    }
    async exportActiveProject(): Promise<{ imageId: string; project: THostProject; saveToken: KlecksSessionToken }> {
        this.assertIdle();
        const image = this.requireDocument(), imageId = this.workspace.activeId!;
        this.updateContent(); const saveToken = this.saves.token(imageId);
        this.selectionSaveTokens.set(saveToken, JSON.stringify(image.history.getComposed().selection));
        const view = this.workspace.viewport;
        const release = this.reserveEncoding(image);
        let project: THostProject;
        try { project = await image.exportProject(); }
        finally { release(); }
        if (view) project.metadata.hostViewport = view;
        return { imageId, project, saveToken };
    }

    /** Host calls only after this exact snapshot's case reference commit succeeds. */
    markSaved(token: KlecksSessionToken): boolean {
        if (this.closed) return false;
        const accepted = this.saves.saved(token);
        if (accepted && this.selectionSaveTokens.has(token)) this.savedSelections.set(token.id, this.selectionSaveTokens.get(token)!);
        this.emit(); return accepted;
    }

    /** Acknowledgement only after project, composite, thumbnail and case references commit together. */
    markApplied(token: KlecksSessionToken): boolean {
        if (this.closed || token.revision < (this.applied.get(token.id)?.revision ?? 0) || !this.saves.saved(token)) return false;
        if (this.selectionSaveTokens.has(token)) this.savedSelections.set(token.id, this.selectionSaveTokens.get(token)!);
        this.applied.set(token.id, { contentId: token.contentId, revision: token.revision }); this.emit(); return true;
    }

    async openProject(id: string, read: () => Promise<THostProject>, status: { isApplied: boolean; isSaved?: boolean } = { isApplied: false }): Promise<boolean> {
        this.assertIdle();
        const intent = ++this.loadingIntent;
        await this.workspace.parkSuspended();
        const cachedRelease = this.resources.reserve(this.workspace.cachedBytes(id) * 4);
        try {
        await this.workspace.hydrate(id);
        if (this.closed || intent !== this.loadingIntent) return false;
        this.assertIdle();
        let restoredView: KlecksViewport | null = null;
        const image = await this.workspace.openAsync(id, async () => {
            const project = await read();
            if (project.metadata.hostViewport) {
                restoredView = { ...project.metadata.hostViewport };
                imageToScreen(restoredView, { x: 0, y: 0 });
            }
            const pixels = project.metadata.size.width * project.metadata.size.height * project.metadata.layers.length + project.metadata.layers.reduce((sum, layer) => sum + (layer.backing ? layer.backing.width * layer.backing.height : 0), 0);
            const release = this.resources.reserve(pixels * 4 * 12 + project.psd.size * 2 + project.backings.reduce((sum, asset) => sum + asset.blob.size * 2, 0));
            let decoded: HostDocument;
            try { decoded = await HostDocument.openProject(project); }
            finally { release(); }
            if (this.closed || this.pending) { decoded.destroy(); throw new Error('Project switch cancelled by pending gesture'); }
            return decoded;
        });
        if (!image || this.closed || intent !== this.loadingIntent) return false;
        this.establishSavepoint(id, status.isApplied, status.isSaved ?? true);
        if (restoredView) this.workspace.setViewport(restoredView);
        this.display.previewSelection(null); this.display.redraw(); this.emit();
        await this.workspace.parkSuspended(); return true;
        } finally { cachedRelease(); }
    }
    previewCrop(rect: { left: number; top: number; width: number; height: number }): void {
        this.assertOpen(); this.requireDocument();
        if (this.transformDraft) throw new Error('Finish or cancel the transform first');
        if (this.inputLock) throw new Error('Editor input is locked for checkpoint');
        if (Object.values(rect).some(value => !Number.isSafeInteger(value)) || rect.width < 1 || rect.height < 1 || rect.width > 10000 || rect.height > 10000 || rect.width * rect.height > 40000000 || Math.abs(rect.left) > 10000 || Math.abs(rect.top) > 10000) throw new Error('Invalid crop preview');
        this.cropDraft = { id: this.workspace.activeId!, rect: { ...rect } }; this.pending = true;
        this.display.previewControlBox(this.activeControlBox(),false);
        const { left: x, top: y, width: w, height: h } = rect;
        this.display.previewSelection([[[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]]]); this.emit();
    }
    cancelCrop(): void { this.assertOpen(); this.cropDraft = null; this.boxCursor=null; this.pending = this.inputPending || !!this.transformDraft; this.display.previewControlBox(this.activeControlBox(),false); this.display.previewSelection(null); this.emit(); }
    applyCrop(): void {
        this.assertOpen();
        if (this.inputLock) throw new Error('Editor input is locked for checkpoint');
        if (this.inputPending || !this.cropDraft || this.cropDraft.id !== this.workspace.activeId) throw new Error('Crop is not ready to apply');
        const release = this.reserveImageWork(6, this.cropDraft.rect.width, this.cropDraft.rect.height);
        try { this.requireDocument().crop(this.cropDraft.rect, this.deleteCroppedPixels, this.stroke.backgroundColor); }
        finally { release(); }
        this.cancelCrop(); this.display.redraw();
    }
    setDeleteCroppedPixels(value: boolean): void { this.assertOpen(); this.deleteCroppedPixels = value; }
    async exportImageRevision(id: string) {
        this.assertOpen();
        if (id === this.workspace.activeId) return this.exportActiveRevision();
        const cachedRelease = this.resources.reserve(this.workspace.cachedBytes(id) * 4);
        try {
        const {state, viewport, selectedLayerIds} = await this.workspace.readSuspendedState(id), saveToken = this.saves.token(id);
        const pixelDirty = this.saves.get(id)?.dirty ?? false;
        this.selectionSaveTokens.set(saveToken, JSON.stringify(state.selection));
        const layerBytes = state.size.width * state.size.height * 4 * Object.keys(state.layerMap).length;
        const backingBytes = Object.values(state.layerMap).reduce((total, layer) => total + (layer.hostBacking ? layer.hostBacking.width * layer.hostBacking.height * 4 : 0), 0);
        const release = this.resources.reserve((this.workspace.resourceUsage().historyPixelBytes + layerBytes + backingBytes) * 4);
        let image: HostDocument | undefined;
        try {
            image = HostDocument.fromComposed(state,selectedLayerIds);
            const revision = await image.exportRevision();
            if (viewport) revision.project.metadata.hostViewport = viewport;
            return {...revision, imageId:id, saveToken, pixelDirty, unapplied: this.applied.get(id)?.contentId !== saveToken.contentId};
        } finally { image?.destroy(); release(); }
        } finally { cachedRelease(); }
    }
    async exportActiveRevision() {
        this.assertIdle(); this.updateContent(); const view = this.workspace.viewport, imageId = this.workspace.activeId!;
        const saveToken = this.saves.token(imageId);
        const pixelDirty = this.saves.get(imageId)?.dirty ?? false;
        this.selectionSaveTokens.set(saveToken, JSON.stringify(this.requireDocument().history.getComposed().selection));
        const image = this.requireDocument(), release = this.reserveEncoding(image);
        let revision: Awaited<ReturnType<HostDocument['exportRevision']>>;
        try { revision = await image.exportRevision(); }
        finally { release(); }
        if (view) revision.project.metadata.hostViewport = view;
        return { ...revision, imageId, saveToken, pixelDirty, unapplied: this.applied.get(imageId)?.contentId !== saveToken.contentId };
    }
    beginColorRange():void{
        this.assertEditable();const image=this.requireDocument(),release=this.resources.reserve(image.canvas.getWidth()*image.canvas.getHeight()*40+image.resourceUsage().selectionMaskWorkBytes+8000000);
        try{this.colorRange=new ColorRangeSession(image,this.toolMemory.colorRange,{
            read:all=>{const layers=image.layerState().layers,ids=image.selectedLayerIds();if(!all&&(ids.length!==1||!layers.find(l=>l.id===ids[0])?.visible))throw new KlecksOperationRejected('请选择一个可见图层，或使用所有可见图层取样。');
                return image.readToolPixels(all);},
            preview:canvas=>this.display.previewComposite(canvas),changed:()=>{this.pending=!!this.colorRange||this.inputPending||!!this.cropDraft||!!this.transformDraft||!!this.wandAbort;this.emit();},remember:options=>{this.toolMemory.colorRange={...options};},release,
        });this.pending=true;this.display.setSelectionEdges(false);this.colorRange.start();this.emit();}catch(error){release();this.colorRange=null;throw error;}
    }
    setColorRangeOptions(options:ColorRangeOptions):void{this.requireColorRange().update(options);}
    patchColorRangeOptions(change:Partial<ColorRangeOptions>):void{const draft=this.requireColorRange();draft.update({...draft.state.options,...change});}
    setColorRangeInputValidity(field:'fuzziness'|'range',valid:boolean):void{this.requireColorRange().inputValidity(field,valid);}
    setRangeSampling(mode:'replace'|'add'|'subtract'):void{this.requireColorRange().sampling(mode);}
    sampleColorRange(x:number,y:number,mode:'replace'|'add'|'subtract'):void{this.requireColorRange().sample(x,y,mode);}
    resetColorRange():void{this.requireColorRange().reset();}
    applyColorRange():void{this.requireColorRange().apply();this.cancelColorRange();}
    cancelColorRange():void{const draft=this.colorRange;if(!draft)return;this.colorRange=null;draft.close();this.display.setSelectionEdges(this.displayPreferences.selectionEdges);this.pending=this.inputPending||!!this.cropDraft||!!this.transformDraft||!!this.wandAbort;this.emit();}
    private requireColorRange():ColorRangeSession{this.assertOpen();if(this.inputLock||!this.colorRange)throw new KlecksOperationRejected('请先打开色彩范围。');return this.colorRange;}
    setWandOptions(options:MagicWandOptions):void {
        this.assertEditable();if(!isKlecksToolCommand({action:'wandOptions',...options}))throw new Error('Invalid magic wand options');
        this.wandOptions={tolerance:options.tolerance,contiguous:options.contiguous,antiAlias:options.antiAlias,sampleSize:options.sampleSize,sampleAllLayers:options.sampleAllLayers};if(this.tool==='magicWand')this.selectionOptions.antiAlias=options.antiAlias;this.emit();
    }
    cancelWand():void {
        if(!this.wandAbort)return;this.wandAbort.abort();this.wandAbort=null;
        this.pending=this.inputPending||!!this.cropDraft||!!this.transformDraft;
        this.rememberTool();this.tool='hand';this.restoreTool();if(!this.closed)this.emit();
    }
    async selectWithWand(point:PaintPoint,mode:KlecksSelectionOptions['mode']):Promise<void> {
        this.assertEditable();const image=this.requireDocument(),id=this.workspace.activeId;
        const width=image.canvas.getWidth(),height=image.canvas.getHeight(),x=point[0],y=point[1];
        if(x<0||y<0||x>=width||y>=height)throw new KlecksOperationRejected('请在图片范围内点击魔棒取样点。');
        if((mode==='subtract'||mode==='intersect')&&!image.canvas.getSelection())throw new KlecksOperationRejected('当前没有选区，请先新建选区，再减去或交叉选择。');
        const options={...this.wandOptions,antiAlias:this.selectionOptions.antiAlias};
        const layers=image.layerState().layers,selected=image.selectedLayerIds();
        if(!options.sampleAllLayers&&(selected.length!==1||!layers.find(layer=>layer.id===selected[0])?.visible))throw new KlecksOperationRejected('请选中一个可见图层，或勾选“取样所有图层”。');
        const release=this.resources.reserve(width*height*28+image.resourceUsage().selectionMaskWorkBytes+8000000),controller=new AbortController();
        const identity=image.contentIdentity();this.wandAbort=controller;this.pending=true;this.emit();
        try {
            await new Promise<void>(resolve=>setTimeout(resolve,0));
            if(controller.signal.aborted)return;
            const {data}=image.readToolPixels(options.sampleAllLayers);
            const region=await magicWandSelection({width,height,data},x,y,options,{signal:controller.signal});
            if(controller.signal.aborted||this.closed||this.workspace.activeId!==id||this.workspace.document!==image||image.contentIdentity()!==identity)return;
            if(!region.length)throw new KlecksOperationRejected('当前取样条件未选中像素，请调整容差或取样大小后重试。');
            image.select(region,mode,{antiAlias:options.antiAlias,feather:0,coverage:{kind:'shape',value:region,antiAlias:options.antiAlias,feather:0}});
            this.display.redraw();
        }catch(error){
            if(!controller.signal.aborted)throw new KlecksOperationRejected(error instanceof Error?error.message:'魔棒选区未完成，请重试。');
        }finally{
            release();if(this.wandAbort===controller){this.wandAbort=null;this.pending=this.inputPending||!!this.cropDraft||!!this.transformDraft;if(!this.closed)this.emit();}
        }
    }
    setTool(tool: Tool): void {
        this.assertEditable(); this.rememberTool(); this.tool = tool; this.restoreTool();
        if (tool === 'rectangle' || tool === 'ellipse') this.marquee = tool;
        if (tool === 'lasso' || tool === 'polygon') this.lasso = tool;
        this.emit();
    }
    setStroke(options: TStrokeOptions): void { this.assertEditable(); this.stroke = structuredClone({ ...options, backgroundColor: options.backgroundColor ?? this.stroke.backgroundColor ?? { r: 255, g: 255, b: 255 } }); this.emit(); }
    fit(): void { this.assertNavigable(); this.display.fit();this.pointerInput?.refreshViewport(); this.emit(); }
    rotateCanvas(degrees: number): void { this.mutateImage(() => this.requireDocument().rotateCanvas(degrees)); }
    flip(axis: 'horizontal' | 'vertical', target: 'canvas' | 'pixels'): void {
        this.assertOpen();
        if(!['horizontal','vertical'].includes(axis)||!['canvas','pixels'].includes(target))throw new Error('Invalid mirror operation');
        if(target==='canvas'){this.mutateImage(()=>this.requireDocument().flipCanvas(axis));return;}
        const reflection=(bounds:KlecksTransformBounds):KlecksTransformMatrix=>axis==='horizontal'
            ?{a:-1,b:0,c:0,d:1,e:bounds.left*2+bounds.width,f:0}
            :{a:1,b:0,c:0,d:-1,e:0,f:bounds.top*2+bounds.height};
        if(this.transformDraft){
            const draft=this.requireTransform();
            const bounds=draft.target==='selection'?draft.bounds:this.requireDocument().transformBounds(true);
            this.previewTransform(multiplyTransform(draft.matrix,reflection(bounds)));
            return;
        }
        this.mutateImage(()=>{
            const image=this.requireDocument();
            const bounds=image.transformBounds(true);
            this.withTransformBudget(admit=>image.transformPixels(reflection(bounds),admit));
        });
    }
    movePixels(dx: number, dy: number): void { this.mutateImage(() => this.requireDocument().movePixels(dx, dy)); }
    resizeCanvas(width: number, height: number, anchor: THostCanvasAnchor): void { this.mutateImage(() => this.requireDocument().resizeCanvas(width, height, anchor, this.stroke.backgroundColor), width, height); }
    resizeImage(width: number, height: number, options: Parameters<HostDocument['resizeImage']>[2]): void { this.mutateImage(() => this.requireDocument().resizeImage(width, height, options), width, height); }
    setWheelZoom(enabled: boolean): void { this.assertOpen(); this.zoomWithWheel = enabled; }
    setCursorPreferences(options:{tip:'normal'|'full'|'precise';crosshair:boolean}):void{
        this.assertEditable();const {tip,crosshair}=options;if(!isKlecksToolCommand({action:'cursor',tip,crosshair}))throw new Error('Invalid cursor preferences');this.cursorPreferences={tip,crosshair};this.emit();
    }
    setSelectionOptions(options:KlecksSelectionOptions):void {
        this.assertEditable();const {mode,style,width,height,feather,antiAlias}=options;
        if(!isKlecksToolCommand({action:'selectionOptions',mode,style,width,height,feather,antiAlias}))throw new Error('Invalid selection options');
        this.selectionOptions={mode,style,width,height,feather,antiAlias};this.emit();
    }
    setNavigation(options: { mode: 'marquee' | 'scrubby'; center: boolean; wheel: boolean; pixelGrid: boolean; selectionEdges: boolean }): void {
        this.assertEditable();
        if (!['marquee', 'scrubby'].includes(options.mode) || [options.center, options.wheel, options.pixelGrid, options.selectionEdges].some(value => typeof value !== 'boolean')) throw new Error('Invalid navigation preferences');
        this.navigation = { mode: options.mode, center: options.center }; this.zoomWithWheel = options.wheel;
        this.displayPreferences={pixelGrid:options.pixelGrid,selectionEdges:options.selectionEdges};
        this.display.setPixelGrid(options.pixelGrid); this.display.setSelectionEdges(options.selectionEdges); this.emit();
    }
    setSampleSource(source: 'current' | 'merged'): void { this.assertEditable(); if (!['current', 'merged'].includes(source)) throw new Error('Invalid sample source'); this.sampleSource = source;this.emit(); }
    setAutoSelect(enabled:boolean):void{this.assertEditable();if(typeof enabled!=='boolean')throw new Error('Invalid automatic layer selection');this.autoSelect=enabled;this.emit();}
    focusCanvas():void{if(!this.closed&&!this.inputLock)this.display.canvas.focus({preventScroll:true});}
    forwardToolKey(key: string, shiftKey: boolean): void {
        this.assertEditable();
        if (!isKlecksToolCommand({ action: 'toolKey', key, shiftKey })) throw new Error('Invalid tool key');
        this.focusCanvas();
        this.canvas.dispatchEvent(new KeyboardEvent('keydown', {
            key, code: `Key${key.toUpperCase()}`, shiftKey, bubbles: true, cancelable: true,
        }));
    }
    setTransformLinked(enabled:boolean):void{if(this.closed||this.inputLock||this.inputPending||this.cropDraft)throw new Error('Transform preferences unavailable');if(typeof enabled!=='boolean')throw new Error('Invalid transform link');this.transformLinked=enabled;this.emit();}
    setColors(foreground:TStrokeOptions['color'],background:TStrokeOptions['color']):void{this.assertEditable();if(!isKlecksToolCommand({action:'colors',foreground,background}))throw new Error('Invalid colors');this.stroke={...this.stroke,color:{...foreground},backgroundColor:{...background}};this.emit();}
    zoomTo(zoom: number): void {
        this.assertNavigable();
        const view = this.workspace.viewport;
        if (!view) return;
        const box = this.canvas.getBoundingClientRect();
        this.workspace.setViewport(zoomViewport(view, zoom, { x: box.width / 2, y: box.height / 2 }));
        this.pointerInput?.refreshViewport();
        this.display.redraw(); this.emit();
    }

    dispatch(command: KlecksKeyboardCommand): boolean {
        this.assertOpen();
        if (this.inputLock) return false;
        if (this.transformDraft && (command.action === 'undo' || command.action === 'redo')) {
            try { this.stepTransformHistory(command.action === 'redo'); } catch(error) { this.callbacks.error(error); }
            return true;
        }
        if(this.pending&&(this.polygonNavigable||this.colorRange)&&['fitCanvas','actualPixels','zoomIn','zoomOut'].includes(command.action)){
            try{if(command.action==='fitCanvas')this.fit();else if(command.action==='actualPixels')this.zoomTo(1);else this.stepZoom(command.action==='zoomOut');}
            catch(error){this.callbacks.error(error);}return true;
        }
        if(!this.pending&&this.workspace.document&&this.externalClipboard&&['copy','copyMerged','cut','paste','pasteInPlace'].includes(command.action)){
            for(const listener of this.clipboardListeners)listener(command.action as KlecksClipboardAction);return true;
        }
        let release = () => {};
        if (!this.pending && this.workspace.document && ['copy', 'copyMerged', 'cut', 'paste', 'pasteInPlace','invertSelection','reselect','nudge'].includes(command.action)) {
            try { release = this.reserveImageWork(6); }
            catch (error) { this.callbacks.error(error); return true; }
        }
        try {
        return routeKlecksCommand(command, { workspace: {document:this.workspace.document,copy:(cut,merged)=>this.workspace.copy(cut,merged,this.stroke.backgroundColor),paste:inPlace=>this.workspace.paste(inPlace)}, pending: () => this.pending,
            changed: () => { this.display.redraw(); this.emit(); }, error: error => this.callbacks.error(error), host: command => {
                if(command.action==='fillDialog'){this.beginFill();return true;}
                if(['fillForeground','fillBackground','fillForegroundPreserve','fillBackgroundPreserve'].includes(command.action)){
                    this.applyFill({...DEFAULT_FILL,source:command.action.startsWith('fillForeground')?'foreground':'background',preserveTransparency:command.action.endsWith('Preserve')});return true;
                }
                if (command.action === 'transform') { this.beginTransform(); return true; }
                if(command.action==='fitCanvas'){this.fit();return true;}
                if(command.action==='actualPixels'){this.zoomTo(1);return true;}
                if(command.action==='zoomIn'||command.action==='zoomOut'){this.stepZoom(command.action==='zoomOut');return true;}
                if(command.action==='layerViaCopy'){this.mutateImage(()=>{const image=this.requireDocument();if(image.selectedLayerIds().length>1)image.duplicateLayers(image.selectedLayerIds());else if(image.canvas.getSelection())image.pastePixels(image.copyPixels(),true);else image.duplicateLayer(this.state.activeLayerId!);});return true;}
                if(['mergeLayers','mergeVisible','stampLayers','stampVisible'].includes(command.action)){
                    this.mutateImage(()=>{const image=this.requireDocument(),visible=command.action.endsWith('Visible'),ids=visible?image.layerState().layers.filter(layer=>layer.visible).map(layer=>layer.id):image.selectedLayerIds();
                        if(command.action.startsWith('stamp'))image.stampLayers(ids);
                        else if(!visible&&ids.length===1)image.mergeDown(ids[0]);else image.mergeLayers(ids);
                    });return true;
                }
                if(command.action==='selectAllLayers'){const image=this.requireDocument(),ids=image.layerState().layers.filter(layer=>!layer.background).map(layer=>layer.id);if(ids.length)image.setSelectedLayers(ids,ids[ids.length-1]);return true;}
                if (['selectLayerAbove','selectLayerBelow','extendLayerAbove','extendLayerBelow'].includes(command.action)) {
                    const image=this.requireDocument(),layers=image.layerState().layers,index=layers.findIndex(layer=>layer.id===this.state.activeLayerId);
                    const next=layers[index+(command.action.endsWith('Above')?1:-1)];
                    if(next){const ids=command.action.startsWith('extend')?layers.filter(layer=>image.selectedLayerIds().includes(layer.id)||layer.id===next.id).map(layer=>layer.id):[next.id];image.setSelectedLayers(ids,next.id);}
                    return true;
                }
                if(command.action==='deleteLayers'){const image=this.requireDocument();if(image.canvas.getSelection()&&image.selectedLayerIds().length===1)this.mutateImage(()=>image.clearPixels(this.stroke.backgroundColor));else image.deleteLayers(image.selectedLayerIds());return true;}
                if(['layerForward','layerBackward','layerToFront','layerToBack'].includes(command.action)){
                    const image=this.requireDocument(),ids=image.selectedLayerIds(),layers=image.layerState().layers,min=Math.min(...ids.map(id=>layers.findIndex(layer=>layer.id===id))),max=Math.max(...ids.map(id=>layers.findIndex(layer=>layer.id===id)));
                    const floor=layers[0].background?1:0;
                    const index=command.action==='layerToFront'?layers.length-ids.length:command.action==='layerToBack'?floor:command.action==='layerForward'?Math.min(layers.length-ids.length,min+1):Math.max(floor,min-1);
                    if(!ids.some(id=>layers.find(layer=>layer.id===id)?.background))image.reorderLayers(ids,index);return true;
                }
                if(command.action==='saveProject'){if(!this.saveListeners.size)throw new Error('Case save coordinator is not connected');for(const listener of this.saveListeners)listener();return true;}
                if(command.action==='clear'){this.mutateImage(()=>this.requireDocument().clearPixels(this.stroke.backgroundColor));return true;}
                if (['smallerBrush', 'largerBrush', 'softerBrush', 'harderBrush'].includes(command.action)) {
                    if (!['brush', 'eraser','clone','blur'].includes(this.tool)) return false;
                    if (command.action === 'softerBrush' || command.action === 'harderBrush') {
                        this.stroke = { ...this.stroke, hardness: Math.max(0, Math.min(1, (this.stroke.hardness ?? 1) + (command.action === 'softerBrush' ? -0.25 : 0.25))) };
                    } else {
                        const sizes = [1,2,3,4,5,6,7,8,9,10, ...Array.from({ length: 8 }, (_, i) => 15 + i * 5),
                            ...Array.from({ length: 5 }, (_, i) => 60 + i * 10), ...Array.from({ length: 8 }, (_, i) => 125 + i * 25),
                            ...Array.from({ length: 14 }, (_, i) => 350 + i * 50), ...Array.from({ length: 40 }, (_, i) => 1100 + i * 100)];
                        const size = command.action === 'smallerBrush' ? sizes.findLast(size => size < this.stroke.size) ?? 1 : sizes.find(size => size > this.stroke.size) ?? 5000;
                        this.stroke = { ...this.stroke, size };
                    }
                    return true;
                }
                if (command.action === 'nudge') {
                    if (!Number.isInteger(command.dx) || !Number.isInteger(command.dy) || Math.abs(command.dx) > 10 || Math.abs(command.dy) > 10 || (command.dx !== 0 && command.dy !== 0)) return false;
                    if (command.target === 'pixels' && this.tool === 'move') this.movePixels(command.dx, command.dy);
                    else if (command.target === 'selection' && ['rectangle', 'ellipse', 'lasso', 'polygon', 'magicWand'].includes(this.tool)) this.requireDocument().moveSelection(command.dx, command.dy);
                    else return false;
                    return true;
                }
                if (command.action === 'strokeValue') {
                    if (!['brush', 'eraser','clone','blur'].includes(this.tool) || !['opacity', 'flow'].includes(command.field) || !Number.isFinite(command.value) || command.value < 0 || command.value > 1) return false;
                    if(this.tool==='blur'){if(command.field==='opacity')this.toolMemory.retouch.strength=command.value;return command.field==='opacity';}
                    this.stroke = { ...this.stroke, [command.field]: command.value };
                    return true;
                }
                if (command.action === 'defaultColors') {
                    this.stroke = { ...this.stroke, color: this.workspace.document?.editingMask?{r:255,g:255,b:255}:{ r: 0, g: 0, b: 0 }, backgroundColor: this.workspace.document?.editingMask?{r:0,g:0,b:0}:{ r: 255, g: 255, b: 255 } };
                    return true;
                }
                if(['invertMask','targetMask','targetImage','viewMask'].includes(command.action)){
                    const image=this.requireDocument(),id=image.layerState().activeLayerId;
                    if(command.action==='invertMask'&&!image.editingMask)return false;
                    image.layerMask(id,command.action==='invertMask'?'invert':command.action==='targetMask'?'target':command.action==='targetImage'?'image':'view');return true;
                }
                if (command.action === 'swapColors') {
                    this.stroke = { ...this.stroke, color: { ...(this.stroke.backgroundColor ?? { r: 255, g: 255, b: 255 }) }, backgroundColor: { ...this.stroke.color } };
                    return true;
                }
                if (command.action !== 'tool') return false;
                if (command.group === 'marquee') this.setTool(command.cycle ? this.marquee === 'rectangle' ? 'ellipse' : 'rectangle' : this.marquee);
                else if (command.group === 'lasso') this.setTool(command.cycle ? this.lasso === 'lasso' ? 'polygon' : 'lasso' : this.lasso);
                else if (['brush', 'eraser','clone','blur', 'hand', 'zoom', 'eyedropper', 'move', 'crop', 'magicWand','bucket'].includes(command.group)) this.setTool(command.group as Tool);
                else return false;
                return true;
            } });
        } finally { release(); }
    }

    beginTransform(target:'pixels'|'selection'='pixels'): void {
        this.assertEditable();
        if(!['pixels','selection'].includes(target)||target==='selection'&&!this.requireDocument().canvas.getSelection())throw new Error('No selection to transform');
        const image = this.requireDocument(), release = this.reserveImageWork(8);
        const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        try {
            if(target==='pixels')this.withTransformBudget(admit => this.display.previewComposite(image.previewPixelTransform(matrix, admit),false));
            this.transformDraft = { id: this.workspace.activeId!, layerId: image.layerState().activeLayerId,
                target,identity: image.contentIdentity(), bounds: image.transformBounds(), matrix, past:[], future:[], release };
            this.display.previewControlBox(this.activeControlBox());
            this.pending = true; this.emit();
        } catch (error) { release(); throw error; }
    }

    previewTransform(matrix: KlecksTransformMatrix, record = true): void {
        const draft = this.requireTransform(), image = this.requireDocument();
        if(draft.target==='pixels')this.withTransformBudget(admit => this.display.previewComposite(image.previewPixelTransform(matrix, admit),false));
        this.display.previewSelection(image.previewTransformedSelection(matrix)??null,false);
        if (record) this.recordTransformStep(draft.matrix, matrix);
        draft.matrix = { ...matrix }; this.display.previewControlBox(this.activeControlBox()); this.emit();
    }

    private recordTransformStep(previous: KlecksTransformMatrix, next: KlecksTransformMatrix): void {
        const draft = this.transformDraft;
        if (!draft || (['a','b','c','d','e','f'] as const).every(key => previous[key] === next[key])) return;
        draft.past.push({...previous});
        if (draft.past.length > 100) draft.past.shift();
        draft.future = [];
    }

    private stepTransformHistory(redo: boolean): void {
        const draft = this.requireTransform(), source = redo ? draft.future : draft.past;
        const matrix = source.at(-1);
        if (!matrix) throw new KlecksOperationRejected(redo ? '当前自由变换没有可重做的步骤。' : '当前自由变换已回到初始状态，没有可回退的步骤。');
        const previous = {...draft.matrix};
        this.previewTransform(matrix, false);
        source.pop(); (redo ? draft.past : draft.future).push(previous);
    }

    applyTransform(): void {
        const draft = this.requireTransform();
        if(draft.target==='pixels')this.withTransformBudget(admit => this.requireDocument().transformPixels(draft.matrix, admit));
        else this.requireDocument().transformSelection(draft.matrix);
        this.cancelTransform();
    }

    cancelTransform(): void {
        this.assertOpen();
        const draft = this.transformDraft; this.transformDraft = null;
        this.boxCursor=null;
        this.display.previewControlBox(this.activeControlBox(),false);
        this.display.previewComposite(null,false); draft?.release();
        this.display.previewSelection(null,false);
        this.pending = this.inputPending || !!this.cropDraft; this.display.redraw(); this.emit();
    }

    private activeControlBox() {
        if (this.transformDraft) return { kind: 'transform' as const, bounds: this.transformDraft.bounds, matrix: this.transformDraft.matrix };
        if (this.cropDraft) return { kind: 'crop' as const, bounds: this.cropDraft.rect, matrix: {a:1,b:0,c:0,d:1,e:0,f:0} };
        return null;
    }

    private bindBoxInput(): () => void {
        const controller=new AbortController(),options={signal:controller.signal,capture:true},canvas=this.canvas;
        let drag: { id:number; handle:BoxHandle; box:NonNullable<ReturnType<HostEditorRuntime['activeControlBox']>>; start:{x:number;y:number} } | null=null;
        const point=(event:PointerEvent)=> { const box=canvas.getBoundingClientRect();return screenToImage(this.workspace.viewport!,{x:event.clientX-box.left,y:event.clientY-box.top}); };
        const setCursor=(handle:BoxHandle|null)=>{this.boxCursor=handle==='move'?klecksToolShape('move'):handle==='rotate'?klecksToolShape('rotate'):handle?`${handle}-resize`:this.transformDraft?'default':null;this.cursor.refresh();};
        const finish=()=>{ const previous=drag;drag=null;if(previous&&canvas.hasPointerCapture(previous.id))canvas.releasePointerCapture(previous.id);this.inputPending=false;this.pending=!!this.transformDraft||!!this.cropDraft;this.emit(); };
        const update=(event:PointerEvent)=>{
            if(!drag)return;
            try {
                const matrix=dragTransformHandle(drag.box.bounds,drag.box.matrix,drag.handle,drag.start,point(event),{shift:event.shiftKey,alt:event.altKey,linked:drag.box.kind==='transform'&&this.transformLinked});
                if(drag.box.kind==='transform')this.previewTransformFromHandle(matrix);
                else this.previewCrop(klecksTransformPixelBounds(drag.box.bounds,matrix));
            }catch(error){this.callbacks.error(error);}
        };
        canvas.addEventListener('pointerdown',event=>{
            const box=this.activeControlBox(),view=this.workspace.viewport;if(!box||!view||this.inputLock||event.button!==0)return;
            const start=point(event),handle=hitTransformHandle(box.bounds,box.matrix,start,7*view.pixelRatio/view.zoom);
            if(!handle||(box.kind==='crop'&&handle==='rotate'))return;
            drag={id:event.pointerId,handle,box:structuredClone(box),start};canvas.focus({preventScroll:true});canvas.setPointerCapture(event.pointerId);this.inputPending=true;this.pending=true;
            setCursor(handle);
            event.preventDefault();event.stopImmediatePropagation();this.emit();
        },options);
        canvas.addEventListener('pointermove',event=>{if(!drag){const box=this.activeControlBox(),view=this.workspace.viewport;setCursor(box&&view?hitTransformHandle(box.bounds,box.matrix,point(event),7*view.pixelRatio/view.zoom):null);return;}if(drag.id!==event.pointerId)return;event.preventDefault();event.stopImmediatePropagation();update(event);},options);
        canvas.addEventListener('pointerup',event=>{if(!drag||drag.id!==event.pointerId)return;event.preventDefault();event.stopImmediatePropagation();const initial=drag.box;update(event);if(initial.kind==='transform'&&this.transformDraft)this.recordTransformStep(initial.matrix,this.transformDraft.matrix);finish();},options);
        const cancel=()=>{if(!drag)return;const initial=drag.box;finish();if(initial.kind==='transform')this.previewTransform(initial.matrix,false);else this.previewCrop(initial.bounds);};
        canvas.addEventListener('dblclick',event=>{const box=this.activeControlBox(),view=this.workspace.viewport;if(box?.kind!=='transform'||!view||this.inputPending||this.inputLock)return;if(hitTransformHandle(box.bounds,box.matrix,point(event),7*view.pixelRatio/view.zoom)!=='move')return;event.preventDefault();event.stopImmediatePropagation();try{this.applyTransform();}catch(error){this.callbacks.error(error);}},options);
        canvas.addEventListener('pointercancel',event=>{if(drag?.id===event.pointerId){event.stopImmediatePropagation();cancel();}},options);
        canvas.addEventListener('lostpointercapture',event=>{if(drag?.id===event.pointerId)cancel();},options);
        canvas.addEventListener('blur',()=>{if(drag)cancel();},options);
        canvas.addEventListener('keydown',event=>{if(event.key!=='Escape'||!drag)return;finish();event.preventDefault();event.stopImmediatePropagation();if(this.transformDraft)this.cancelTransform();else this.cancelCrop();},options);
        return()=>controller.abort();
    }

    private previewTransformFromHandle(matrix:KlecksTransformMatrix):void {
        const wasPending=this.inputPending;this.inputPending=false;
        try{this.previewTransform(matrix,false);}finally{this.inputPending=wasPending;}
    }

    private requireTransform() {
        this.assertOpen(); const draft = this.transformDraft, image = this.requireDocument();
        if (this.inputLock || !draft || this.inputPending || draft.id !== this.workspace.activeId ||
            draft.layerId !== image.layerState().activeLayerId || draft.identity !== image.contentIdentity()) throw new Error('Transform is not ready to apply');
        return draft;
    }

    private withTransformBudget<T>(operation: (admit: (bounds: KlecksTransformBounds) => void) => T): T {
        const releases: (() => void)[] = [];
        try { return operation(bounds => { releases.push(this.resources.reserve(bounds.width * bounds.height * 4 * 8)); }); }
        finally { for(const release of releases)release(); }
    }

    cancelLoading(): void { this.assertOpen(); this.loadingIntent++; this.workspace.cancelPendingOpen(); }
    async copyForSystem(cut:boolean,merged:boolean):Promise<ClipboardImage|null>{
        this.assertEditable();const release=this.reserveImageWork(8);
        try{this.workspace.copy(cut,merged,this.stroke.backgroundColor);this.display.redraw();this.emit();const image=await this.workspace.exportClipboardPng();return image?{...image,bytes:Uint8Array.from(image.bytes)}:null;}
        finally{release();}
    }
    async pasteForSystem(image:ClipboardImage|null,inPlace:boolean,revision:number,signal:AbortSignal):Promise<boolean>{
        this.assertEditable();if(signal.aborted||revision!==this.state.checkpointRevision)return false;
        const release=this.reserveImageWork(8,image?.width,image?.height);
        try{
            if(!image){this.workspace.paste(inPlace);this.display.redraw();this.emit();return true;}
            const accepted=await this.workspace.pasteExternalPng(image,this.workspace.captureTarget(),()=>!this.closed&&!signal.aborted&&!this.pending&&!this.inputLock&&this.state.checkpointRevision===revision);
            if(accepted){this.display.redraw();this.emit();}return accepted;
        }finally{release();}
    }

    destroy(): void {
        this.tone?.close();this.tone=null;
        this.whitespace?.close();this.whitespace=null;
        this.fillAbort?.abort();this.fillAbort=null;this.fillState=null;
        this.colorRange?.close();this.colorRange=null;
        this.wandAbort?.abort();this.wandAbort=null;
        if (this.closed) return;
        this.closed = true;
        this.transformDraft?.release(); this.transformDraft = null;
        this.releaseGesture();
        for (const release of this.releases.reverse()) release();
        this.display.destroy(); this.workspace.destroy();
        this.saves.sync([]); this.initialized.clear(); this.applied.clear();
        this.checkpoints.clear();
        this.sessionStore?.close();
        this.inputLocks.clear();
        this.paintEndpoints.clear(); this.painting = null;
        this.listeners.clear();
        this.saveListeners.clear();
        this.clipboardListeners.clear();
    }

    private requireDocument(): HostDocument { this.assertOpen(); const image = this.workspace.document; if (!image) throw new Error('No active image'); return image; }
    private bindCanvasContextMenu(): () => void {
        let close=()=>{};
        let anchor:{id:string|null;tool:Tool}|null=null;
        const unsubscribe=this.subscribe(()=>{if(anchor&&(anchor.id!==this.workspace.activeId||anchor.tool!==this.tool||this.inputLock)){close();anchor=null;}});
        const receive=(event:MouseEvent)=>{
            event.preventDefault();event.stopPropagation();close();
            const image=this.workspace.document,id=this.workspace.activeId,currentTool=this.tool;
            if(!image||this.inputLock||(this.inputPending&&!this.polygonNavigable)||this.adjustingBrush||event.altKey&&(currentTool==='brush'||currentTool==='eraser'))return;
            // Focusing a popup blurs the canvas. Never destroy an unfinished lasso to open a menu.
            if(this.pending&&!this.transformDraft&&!this.cropDraft)return;
            const run=(operation:()=>void)=>()=>{if(this.workspace.activeId!==id||this.tool!==currentTool||this.inputLock)return;try{operation();}catch(error){this.callbacks.error(error);}};
            const command=(label:string,action:KlecksKeyboardCommand['action'],disabled=false):KlecksMenuItem=>({label,disabled,run:run(()=>{this.dispatch({action} as KlecksKeyboardCommand);})});
            const items:KlecksMenuItem[]=[];
            if(this.transformDraft){items.push(command('撤销变换调整','undo'),command('重做变换调整','redo'),{label:'确认变换',run:run(()=>this.applyTransform())},{label:'取消变换',run:run(()=>this.cancelTransform())});}
            else if(this.cropDraft){items.push({label:'应用裁剪',run:run(()=>this.applyCrop())},{label:'取消裁剪',run:run(()=>this.cancelCrop())});}
            else if(this.pending){items.push({label:'取消当前操作',run:run(()=>this.canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})))});}
            else if(currentTool==='brush'||currentTool==='eraser'){
                items.push({label:'大小 px',number:{value:this.stroke.size,min:1,max:5000,change:value=>run(()=>{this.stroke={...this.stroke,size:value};this.emit();})()}},{label:'硬度 %',number:{value:(this.stroke.hardness??1)*100,min:0,max:100,change:value=>run(()=>{this.stroke={...this.stroke,hardness:value/100};this.emit();})()}});
            } else if(['rectangle','ellipse','lasso','polygon','magicWand'].includes(currentTool)){
                const selected=!!image.canvas.getSelection()?.length;
                items.push(command('取消选区','deselect',!selected),command('反选','invertSelection',!selected),command('油漆桶','fillDialog'),command('复制','copy',!selected),command('合并复制','copyMerged',!selected),command('剪切','cut',!selected),command('粘贴','paste'),command('通过拷贝的图层','layerViaCopy',!selected),command('自由变换','transform',!selected),{label:'变换选区',disabled:!selected,run:run(()=>this.beginTransform('selection'))});
            } else if(currentTool==='move'){
                const rect=this.canvas.getBoundingClientRect(),view=this.workspace.viewport;
                if(view){const point=screenToImage(view,{x:event.clientX-rect.left,y:event.clientY-rect.top}),x=Math.floor(point.x),y=Math.floor(point.y);
                    for(const layerId of image.pickLayers(x,y)){const layer=image.canvas.getLayers().find(layer=>layer.id===layerId)!;items.push({label:layer.name,run:run(()=>{image.setActiveLayer(layer.id);this.emit();})});}}
                if(!items.length)items.push({label:'此处没有可选择的可见图层',disabled:true});
                items.push({...command('自由变换','transform',!image.selectedLayerIds().length),separator:true});
            } else {items.push(command('适合窗口','fitCanvas'),command('实际像素（100%）','actualPixels'),command('放大','zoomIn'),command('缩小','zoomOut'));}
            if(this.transformDraft||['rectangle','ellipse','lasso','polygon','magicWand','move'].includes(currentTool)) {
                const ids=image.selectedLayerIds();
                const disabled=!this.transformDraft&&(!ids.length||ids.some(id=>{const locks=image.getLayerLocks(id);return locks.all||locks.pixels||locks.position;}));
                items.push(
                    {label:'水平翻转',separator:true,disabled,run:run(()=>this.flip('horizontal','pixels'))},
                    {label:'垂直翻转',disabled,run:run(()=>this.flip('vertical','pixels'))},
                );
            }
            anchor={id,tool:currentTool};
            close=showKlecksContextMenu(this.canvas.ownerDocument,{x:event.clientX,y:event.clientY},items);
        };
        this.canvas.addEventListener('contextmenu',receive);
        return()=>{close();unsubscribe();this.canvas.removeEventListener('contextmenu',receive);};
    }
    private releaseGesture(): void { this.gestureRelease?.(); this.gestureRelease = null; }
    private reserveImageWork(buffers: number, width?: number, height?: number): () => void {
        const image = this.requireDocument(), usage = image.resourceUsage();
        const target = (width ?? image.canvas.getWidth()) * (height ?? image.canvas.getHeight()) * 4 * image.canvas.getLayerCount();
        return this.resources.reserve(Math.max(usage.workCanvasBytes, target) * buffers + usage.historyPixelBytes * 2 + usage.selectionMaskWorkBytes);
    }
    private mutateImage(operation: () => void, width?: number, height?: number): void {
        this.assertEditable(); const release = this.reserveImageWork(6, width, height);
        try { operation(); } finally { release(); }
        this.display.redraw(); this.emit();
    }
    private reserveEncoding(image: HostDocument): () => void {
        const usage = image.resourceUsage();
        return this.resources.reserve((usage.historyPixelBytes + usage.workCanvasBytes) * 4);
    }
    private assertOpen(): void { if (this.closed) throw new Error('Editor runtime has been destroyed'); }
    private assertIdle(): void { this.assertOpen(); if (this.pending) throw new Error('Finish or cancel the current gesture first'); }
    private assertEditable(): void { this.assertIdle(); if (this.inputLock) throw new Error('Editor input is locked for checkpoint'); }
    private assertNavigable():void{this.assertOpen();if(this.inputLock||this.pending&&!this.polygonNavigable&&!this.colorRange)throw new Error('Finish or cancel the current gesture first');}
    private stepZoom(out:boolean):void{this.assertNavigable();const view=this.workspace.viewport;if(!view)return;const rect=this.canvas.getBoundingClientRect();this.workspace.setViewport(clickZoom(view,{x:rect.width/2,y:rect.height/2},{width:rect.width,height:rect.height},out,false));this.pointerInput?.refreshViewport();this.display.redraw();this.emit();}
    private establishSavepoint(id: string, isApplied = true, isSaved = true): void {
        if (this.initialized.has(id)) return;
        this.saves.update(id, null, this.requireDocument().contentIdentity());
        if (isSaved) this.saves.saved(this.saves.token(id));
        this.initialized.add(id);
        this.savedSelections.set(id, JSON.stringify(this.requireDocument().history.getComposed().selection));
        this.applied.set(id, { contentId: isApplied ? this.saves.token(id).contentId : null, revision: 0 });
    }
    private updateContent(): void {
        const id = this.workspace.activeId, image = this.workspace.document;
        if (!id || !image || !this.initialized.has(id)) return;
        const identity = image.contentIdentity();
        if (this.saves.token(id).contentId !== identity) this.saves.update(id, null, identity);
        const checkpoint = JSON.stringify([this.saves.token(id).contentId, image.checkpointOptionsIdentity(), this.workspace.viewport]);
        const previous = this.checkpoints.get(id);
        if (previous?.identity !== checkpoint) this.checkpoints.set(id, { identity: checkpoint, revision: (previous?.revision ?? 0) + 1 });
    }
    private paletteMask=false;
    private imagePalette={foreground:{r:0,g:0,b:0},background:{r:255,g:255,b:255}};
    private maskPalette={foreground:{r:255,g:255,b:255},background:{r:0,g:0,b:0}};
    private syncMaskPalette():void {
        const mask=!!this.workspace.document?.editingMask;
        if(mask!==this.paletteMask){const current={foreground:{...this.stroke.color},background:{...(this.stroke.backgroundColor??{r:255,g:255,b:255})}};if(this.paletteMask)this.maskPalette=current;else this.imagePalette=current;const next=mask?this.maskPalette:this.imagePalette;this.stroke={...this.stroke,color:{...next.foreground},backgroundColor:{...next.background}};this.paletteMask=mask;}
        if(mask){const gray=(color:TStrokeOptions['color'])=>{const n=Math.round(.299*color.r+.587*color.g+.114*color.b);return{r:n,g:n,b:n};};this.stroke={...this.stroke,color:gray(this.stroke.color),backgroundColor:gray(this.stroke.backgroundColor??{r:0,g:0,b:0})};}
    }
    private emit(): void { if (!this.closed) { this.syncMaskPalette();this.cursor.refresh(); this.updateContent(); this.callbacks.changed(); for (const listener of this.listeners) listener(); } }
}
