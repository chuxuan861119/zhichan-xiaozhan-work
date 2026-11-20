import { KlHistory, TKlHistorySnapshot, HISTORY_TILE_SIZE } from '../app/script/klecks/history/kl-history';
import{RetouchStroke,type RetouchOptions}from'./retouch-stroke';
import {ToneOptionsSchema,tonePixel,type ToneOptions} from '../../../../src/shared/settings/design-tone';
import { getNextLayerId } from '../app/script/klecks/history/get-next-layer-id';
import { KlCanvas } from '../app/script/klecks/canvas/kl-canvas';
import { projectToComposed } from '../app/script/klecks/history/push-helpers/project-to-composed';
import { TKlProject } from '../app/script/klecks/kl-types';
import { klCanvasToPsdBlob } from '../app/script/klecks/storage/kl-canvas-to-psd-blob';
import { PenBrush } from '../app/script/klecks/brushes/pen-brush';
import { MultiPolygon, union, difference, intersection } from 'polygon-clipping';
import { selectionWithinCanvas } from './selection-bounds';
import { createLayerMap } from '../app/script/klecks/history/push-helpers/create-layer-map';
import { selectionMask, coverageForSelection, selectionMaskWorkBytes, clearSelectionMaskCache } from './selection-mask';
import { strokeTileRegion, drawStrokeRegion } from './stroke-region';
import { combineSelectionCoverage, isSelectionCoverage, type DesignSelectionCoverage } from '../../../../src/shared/patent/design-selection-coverage';
import { traceSelectedPixelsSync } from '../../../../src/renderer/src/design-patent/correction/klecks-magic-wand';
import { multiplyTransform } from '../../../../src/renderer/src/design-patent/correction/klecks-box-handles';
import { transformPixelCanvas, opaquePixelBounds, type TransformedPixels } from './pixel-transform';
import { compositeTransformedSelection } from './selection-transform-composite';
import { invertKlecksTransform, type KlecksTransformMatrix } from '../../../../src/renderer/src/design-patent/correction/klecks-transform';
import { getSelectionPath2d } from '../app/script/bb/multi-polygon/get-selection-path-2d';
import { getMultiPolyBounds } from '../app/script/bb/multi-polygon/get-multi-polygon-bounds';
import type { THostLayerLocks } from '../app/script/klecks/history/history.types';
import type { THistoryEntryDataComposed, THistoryEntryLayerComposed } from '../app/script/klecks/history/history.types';
import { decodePsdInWorker } from '../app/script/klecks/storage/psd-codec-client';
import { canvasToLayerTiles, canvasAndChangedTilesToLayerTiles } from '../app/script/klecks/history/push-helpers/canvas-to-layer-tiles';
import { getPushableLayerChange } from '../app/script/klecks/history/push-helpers/get-pushable-layer-change';
import { mergeLayerBacking, backingToCanvas } from './layer-backing';
import { clearedLayerTiles, layerPixelDelta, offCanvasBackingTiles } from './layer-pixel-delta';
import { translateMultiPolygon } from '../app/script/bb/multi-polygon/translate-multi-polygon';
import { LayerCompositor } from '../app/script/klecks/canvas/layer-compositor';
import { validateEditorBinaryHeader } from '../../../../src/shared/patent/design-editor-binary';
import { validateEditorPsdLayout } from '../../../../src/shared/patent/design-editor-psd';
import type { KlecksViewport } from '../../../../src/renderer/src/design-patent/correction/klecks-viewport';
import { DEFAULT_HOST_HISTORY_POLICY, THostHistoryPolicy } from '../app/script/klecks/history/host-history-policy';
import { KlecksOperationRejected } from '../../../../src/renderer/src/design-patent/correction/klecks-operation-error';
import {FillOptionsSchema,type FillOptions,type FillColor} from '../../../../src/shared/settings/design-fill';
import {regionalFill,changedAdjustmentTiles} from './regional-pixels';
import {WhitespacePlanSchema,type WhitespacePlan} from '../../../../src/shared/settings/design-whitespace';
import {HostLayerMasks,type MaskOperation,type MaskFocus} from './layer-mask-operations';
import {maskCoverage,maskGray,grayMask,transformMask,maskAlphaAt} from './layer-mask';

export type THostDocumentSnapshot = {
    version: 1;
    history: TKlHistorySnapshot;
    selectedLayerIds?: string[];
    maskFocus?:MaskFocus;
    floatingMove?: { source: THostDocumentSnapshot; dx: number; dy: number; copy: boolean; expected: string; positions: [string, {dx:number;dy:number}][] };
};
export type TStrokePoint = readonly [number, number, number];
export type TStrokeOptions = {
    tool: 'brush' | 'eraser'; size: number; opacity: number;
    color: { r: number; g: number; b: number };
    backgroundColor?: { r: number; g: number; b: number };
    flow?: number;
    hardness?: number;
};
export type THostClipboard = { image: ImageData; x: number; y: number };
export type THostRasterSource = { bytes: Uint8Array; widthPx: number; heightPx: number; initialLayerKind?: 'regular' | 'background' };
export type THostCanvasAnchor = { horizontal: 'left' | 'center' | 'right'; vertical: 'top' | 'center' | 'bottom' };
export type THostRasterOutput = { blob: Blob; width: number; height: number; mediaType: 'image/png' };
export type THostRevisionBundle = { project: THostProject; composite: THostRasterOutput; thumbnail: THostRasterOutput };
export type THostProject = {
    version: 1;
    psd: Blob;
    backings: { id: string; blob: Blob }[];
    metadata: Omit<THistoryEntryDataComposed, 'layerMap'> & {
        hostViewport?: KlecksViewport;
        maskFocus?:MaskFocus;
        selectedLayerIds?: string[];
        layers: { id: string; properties: Omit<THistoryEntryLayerComposed, 'tiles' | 'hostBacking' | 'hostMask'>;mask?:Omit<import('../app/script/klecks/history/history.types').THostLayerMask,'tiles'>;
            backing?: { x: number; y: number; width: number; height: number } }[];
    };
};

/** A UI-independent engine document; the host owns navigation and persistence. */
export class HostDocument {
    private explicitHistoryPolicy=false;
    private admitMaskHistory(changes:Partial<THistoryEntryLayerComposed>):void {
        const policy=this.history.getHostPolicy();
        if(changes.hostMask&&!this.explicitHistoryPolicy&&policy?.maxEstimatedBytes===DEFAULT_HOST_HISTORY_POLICY.maxEstimatedBytes)this.history.setHostPolicy({...policy,maxEstimatedBytes:DEFAULT_HOST_HISTORY_POLICY.maxEstimatedBytes*2});
    }
    private layerMasks?:HostLayerMasks;
    private get masks():HostLayerMasks {
        return this.layerMasks??=new HostLayerMasks({canvas:()=>this.canvas,state:()=>this.history.getComposed(),idle:()=>{this.assertAlive();this.assertIdle();},focus:id=>this.history.setActiveLayer(id),
            commit:(id,changes)=>{this.admitMaskHistory(changes);this.commitLayers(this.history.getComposed(),Object.fromEntries(this.canvas.getLayers().map(layer=>[layer.id,layer.id===id?changes:{}])),id);},
            select:(region,coverage)=>this.select(region,'replace',{coverage,antiAlias:true})});
    }
    get editingMask():boolean{return this.masks.editing;}
    layerMask(id:string,operation:MaskOperation):void{this.masks.operate(id,operation);}
    getEditorDisplay():HTMLCanvasElement{return this.masks.editorDisplay()??this.getDisplayComposite();}
    readToolPixels(merged:boolean):{width:number;height:number;data:Uint8ClampedArray} {
        if(!this.editingMask||merged){const source=merged?this.getDisplayComposite():this.canvas.getLayer(this.layerIndex(this.history.getComposed().activeLayerId)).canvas;return{width:source.width,height:source.height,data:source.getContext('2d')!.getImageData(0,0,source.width,source.height).data};}
        const state=this.history.getComposed(),coverage=maskCoverage(state.layerMap[state.activeLayerId].hostMask!,state.size.width,state.size.height),c=coverage.getContext('2d')!;
        try{const pixels=c.getImageData(0,0,coverage.width,coverage.height);for(let p=0;p<pixels.data.length;p+=4){const a=pixels.data[p+3];pixels.data[p]=pixels.data[p+1]=pixels.data[p+2]=a;pixels.data[p+3]=255;}return{width:coverage.width,height:coverage.height,data:pixels.data};}finally{coverage.width=coverage.height=0;}
    }
    private maskProxy(operation:(image:HostDocument)=>void,preview=false,readOnly=false,moving=false,origin:HostDocument=this):HTMLCanvasElement|undefined {
        const before=this.history.getComposed(),source=origin.history.getComposed(),id=before.activeLayerId,mask=source.layerMap[id].hostMask!;
        if(!readOnly&&(this.getLayerLocks(id).all||moving&&this.getLayerLocks(id).position))throw new KlecksOperationRejected('请先解除图层的位置或全部锁定，再变换蒙版。');
        const coverage=maskCoverage(mask,before.size.width,before.size.height),gray=document.createElement('canvas');gray.width=coverage.width;gray.height=coverage.height;
        const c=gray.getContext('2d')!;c.fillStyle='black';c.fillRect(0,0,gray.width,gray.height);c.drawImage(coverage,0,0);coverage.width=coverage.height=0;
        const full=maskGray(mask),state=structuredClone(source);
        try{state.layerMap={[id]:{...source.layerMap[id],index:0,hostBackground:false,hostLocks:{all:false,alpha:false,pixels:false,position:false},hostMask:null,tiles:canvasToLayerTiles(gray),hostBacking:{x:mask.x,y:mask.y,width:mask.width,height:mask.height,tiles:canvasToLayerTiles(full)}}};
            const proxy=HostDocument.fromComposed(state,[id]);
            try{operation(proxy);if(readOnly)return;const after=proxy.history.getComposed(),pixels=mergeLayerBacking(proxy.canvas.getLayer(0).canvas,after.layerMap[id].hostBacking);
                try{const next=grayMask(pixels.canvas,{...mask,x:pixels.x,y:pixels.y,width:pixels.canvas.width,height:pixels.canvas.height});
                    if(preview){const snapshot=structuredClone(before);snapshot.layerMap[id].hostMask=next;const temp=HostDocument.fromComposed(snapshot,this.selectedLayerIds());
                        try{if(!this.masks.viewing)return temp.canvas.getCanvas();
                            temp.masks.focus={id,view:true};const display=temp.getEditorDisplay(),output=document.createElement('canvas');output.width=display.width;output.height=display.height;output.getContext('2d')!.drawImage(display,0,0);return output;
                        }finally{temp.destroy();}}
                    this.history.push({selection:after.selection,layerMap:Object.fromEntries(this.canvas.getLayers().map(layer=>[layer.id,layer.id===id?{hostMask:next}:{}]))});this.canvas.updateViaComposed(before,this.history.getComposed());
                }finally{pixels.canvas.width=pixels.canvas.height=0;}
            }finally{proxy.destroy();}
        }finally{gray.width=gray.height=full.width=full.height=0;}
    }
    private maskOnlyTransform():boolean{return this.editingMask&&(!this.history.getComposed().layerMap[this.history.getComposed().activeLayerId].hostMask!.linked||!!this.canvas.getSelection());}
    private documentCanvas: KlCanvas;
    private history: KlHistory;
    private destroyed = false;
    private floatingMove?: { source: HostDocument; dx: number; dy: number; copy: boolean; expected: string; positions: Map<string,{dx:number;dy:number}> };
    private moveIdentity(): string { return this.contentIdentity() + this.checkpointOptionsIdentity(); }
    private releaseFloatingMove(): void { this.floatingMove?.source.destroy(); this.floatingMove = undefined; }
    private syncFloatingMove(): void {
        const floating=this.floatingMove;
        if(!floating)return;
        const identity=this.moveIdentity();
        if(identity===floating.expected)return;
        const position=floating.positions.get(identity);
        if(position){floating.dx=position.dx;floating.dy=position.dy;floating.expected=identity;}
        else this.releaseFloatingMove();
    }
    cancelFloatingMove(): void {
        this.syncFloatingMove();
        const floating=this.floatingMove;
        if(!floating)return;
        if(floating.expected===this.moveIdentity()) {
            // Escape aborts the whole floating operation, not a new pixel edit. A
            // new full-layer entry could exhaust the budget and reject cancellation.
            const history=KlHistory.fromSnapshot(floating.source.history.exportSnapshot());
            const canvas=new KlCanvas(history),previous=this.documentCanvas;
            this.history=history;this.documentCanvas=canvas;this.protectImmediateUndo();
            this.pixelPreviewRevision=(this.pixelPreviewRevision??0)+1;previous.destroy();
        }
        this.releaseFloatingMove();
    }
    private solo?: { id: string; expected: string; visibility: Record<string, boolean> };
    private thumbnails?:{identity:string;urls:Record<string,string>;masks:Record<string,string>};
    private displayComposite?: { canvas: HTMLCanvasElement; compositor: LayerCompositor; owner: KlCanvas; historyRevision: number; pixelRevision: number };
    private pixelPreviewRevision = 0;
    private stroke: PenBrush | null = null;
    private strokeComposite: { base: HTMLCanvasElement; paint: HTMLCanvasElement; mask: HTMLCanvasElement | null; masked: HTMLCanvasElement; layerId: string; opacity: number; alphaLocked: boolean; erasing: boolean } | null = null;

    get canvas(): KlCanvas { return this.documentCanvas; }
    /** Borrowed read-only display raster. Viewport, cursor and overlay redraws reuse it; exports own their copies. */
    getDisplayComposite(): HTMLCanvasElement {
        this.assertAlive();
        const historyRevision = this.history.getChangeCount(), pixelRevision = this.pixelPreviewRevision ?? 0;
        const cached = this.displayComposite ??= {canvas: document.createElement('canvas'), compositor: new LayerCompositor(), owner: this.canvas, historyRevision: -1, pixelRevision: -1};
        if (cached.owner === this.canvas && cached.historyRevision === historyRevision && cached.pixelRevision === pixelRevision) return cached.canvas;
        const width = this.canvas.getWidth(), height = this.canvas.getHeight();
        if (cached.canvas.width !== width) cached.canvas.width = width;
        if (cached.canvas.height !== height) cached.canvas.height = height;
        const context = cached.canvas.getContext('2d')!;
        context.clearRect(0, 0, width, height);
        cached.compositor.draw(context, this.canvas.getLayers(), width, height, (target, layer) => target.drawImage(layer.canvas, 0, 0));
        cached.owner = this.canvas; cached.historyRevision = historyRevision; cached.pixelRevision = pixelRevision;
        return cached.canvas;
    }
    /** Stable across undo/redo; view, selection and active-layer focus are not pixel-document dirtiness. */
    contentIdentity(): string {
        this.assertAlive();
        const state = this.history.getComposed();
        const tiles = (values: THistoryEntryLayerComposed['tiles']) => values.map(tile => 'id' in tile ? tile.id : { fill: tile.fill });
        return JSON.stringify({ size: state.size, layers: this.canvas.getLayers().map(layer => {
            const properties = state.layerMap[layer.id], backing = properties.hostBacking;
            return { id: layer.id, name: properties.name, opacity: properties.opacity, visible: properties.isVisible,
                mix: properties.mixModeStr, clipping: properties.hasClipping, background: properties.hostBackground ?? false,
                mask: properties.hostMask?{...properties.hostMask,tiles:tiles(properties.hostMask.tiles)}:null,
                locks: { all: false, pixels: false, position: false, alpha: false, ...properties.hostLocks }, tiles: tiles(properties.tiles),
                backing: backing ? { x: backing.x, y: backing.y, width: backing.width, height: backing.height, tiles: tiles(backing.tiles) } : null };
        }) });
    }
    checkpointOptionsIdentity(): string {
        this.assertAlive(); const state = this.history.getComposed();
        return JSON.stringify({ selection: state.selection, activeLayerId: state.activeLayerId, selectedLayerIds:this.selectedLayerIds(),maskFocus:this.editingMask?this.masks.focus:undefined });
    }
    resourceUsage(): {historyPixelBytes:number;layerCanvasBytes:number;workCanvasBytes:number;scratchCanvasBytes:number;selectionMaskWorkBytes:number} {
        this.assertAlive();
        const retained = this.floatingMove?.source.resourceUsage();
        const maskCount=Object.values(this.history.getComposed().layerMap).filter(layer=>layer.hostMask).length;
        const layerCanvasBytes = this.canvas.getWidth() * this.canvas.getHeight() * 4 * (this.canvas.getLayerCount()+maskCount*2+(this.masks.paint?1:0)) + this.masks.displayBytes + (retained?.layerCanvasBytes ?? 0);
        const scratchCanvasBytes = (this.strokeComposite ? this.strokeComposite.base.width * this.strokeComposite.base.height * 4 * (this.strokeComposite.mask ? 4 : 3) : 0)
            + (this.displayComposite ? this.displayComposite.canvas.width * this.displayComposite.canvas.height * 8 : 0);
        // Admission work scales with editable image/mask planes, not resident
        // compositor caches or an older floating-move source already counted above.
        const workCanvasBytes=this.canvas.getWidth()*this.canvas.getHeight()*4*(this.canvas.getLayerCount()+maskCount);
        return { historyPixelBytes: this.history.getRetainedPixelBytes() + (retained?.historyPixelBytes ?? 0), layerCanvasBytes, workCanvasBytes,scratchCanvasBytes,
            selectionMaskWorkBytes:selectionMaskWorkBytes(this.canvas.getWidth(),this.canvas.getHeight(),this.history.getComposed().selection) };
    }

    constructor(project: TKlProject, initialBackground = false) {
        const oldest = projectToComposed(project);
        if (initialBackground) {
            if (project.layers.length !== 1) throw new Error('Initial background requires one layer');
            for (const layer of Object.values(oldest.layerMap)) { layer.hostBackground = true; layer.name = '背景'; }
        }
        this.history = new KlHistory({ oldest, hostPolicy: DEFAULT_HOST_HISTORY_POLICY });
        this.documentCanvas = new KlCanvas(this.history);
        this.protectImmediateUndo();
    }

    static async fromPng(projectId: string, name: string, source: THostRasterSource): Promise<HostDocument> {
        if (!projectId.trim() || projectId.length > 200 || !name.trim() || name.length > 200 ||
            !(source.bytes instanceof Uint8Array) || source.bytes.byteLength > 256 * 1024 * 1024) throw new Error('Invalid initial raster');
        const width = source.widthPx, height = source.heightPx;
        const initialLayerKind = source.initialLayerKind;
        if (initialLayerKind !== undefined && !['regular', 'background'].includes(initialLayerKind)) throw new Error('Invalid initial layer kind');
        validateEditorBinaryHeader(source.bytes, 'png', { width, height });
        const blob = new Blob([new Uint8Array(source.bytes)], { type: 'image/png' });
        const bitmap = await createImageBitmap(blob);
        try {
            if (bitmap.width !== width || bitmap.height !== height) throw new Error('Initial raster decoded dimensions mismatch');
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
            canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
            const background = initialLayerKind === 'background';
            if (background) {
                const pixels = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
                for (let index = 3; index < pixels.length; index += 4) if (pixels[index] !== 255) throw new Error('Transparent source cannot initialize an opaque background');
            }
            return new HostDocument({ projectId, width, height, layers: [{ name, opacity: 1,
                isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: canvas }] }, background);
        } finally { bitmap.close(); }
    }

    static restore(snapshot: THostDocumentSnapshot): HostDocument {
        if (snapshot.version !== 1) throw new Error('Unsupported host snapshot');
        const history = KlHistory.fromSnapshot(snapshot.history);
        if (!snapshot.history.hostPolicy) history.setHostPolicy(DEFAULT_HOST_HISTORY_POLICY);
        const document = Object.create(HostDocument.prototype) as HostDocument;
        Object.assign(document, { history, documentCanvas: new KlCanvas(history), destroyed: false, stroke: null, strokeComposite: null });
        if(snapshot.selectedLayerIds)history.setActiveLayer(history.getComposed().activeLayerId,snapshot.selectedLayerIds);
        if(snapshot.maskFocus)document.masks.focus={...snapshot.maskFocus};
        try {
            if (snapshot.floatingMove) {
                const floating = snapshot.floatingMove;
                document.floatingMove = { source: HostDocument.restore(floating.source), dx: floating.dx, dy: floating.dy, copy: floating.copy, expected: floating.expected,
                    positions: new Map(floating.positions.map(([id, position]) => [id, {...position}])) };
            }
            document.protectImmediateUndo();return document;
        } catch (error) { document.destroy(); throw error; }
    }

    /** Private export owner with only the current state; live undo history is untouched. */
    static fromComposed(state: THistoryEntryDataComposed, selectedLayerIds?: string[]): HostDocument {
        const history = new KlHistory({ oldest: structuredClone(state), hostPolicy: DEFAULT_HOST_HISTORY_POLICY });
        const document = Object.create(HostDocument.prototype) as HostDocument;
        Object.assign(document, { history, documentCanvas: new KlCanvas(history), destroyed: false, stroke: null, strokeComposite: null });
        if(selectedLayerIds)history.setActiveLayer(state.activeLayerId,selectedLayerIds);
        document.protectImmediateUndo();return document;
    }

    capture(): THostDocumentSnapshot {
        this.assertAlive();
        this.assertIdle();
        const snapshot: THostDocumentSnapshot = { version: 1, history: this.history.exportSnapshot() };
        if(this.masks.focus)snapshot.maskFocus={...this.masks.focus};
        if (this.floatingMove) {
            const floating = this.floatingMove;
            snapshot.floatingMove = { source: floating.source.capture(), dx: floating.dx, dy: floating.dy, copy: floating.copy, expected: floating.expected,
                positions: [...floating.positions].map(([id, position]) => [id, {...position}]) };
        }
        return snapshot;
    }

    setHistoryPolicy(policy: THostHistoryPolicy): void {
        this.explicitHistoryPolicy=true;
        this.assertAlive(); this.assertIdle(); this.history.setHostPolicy(policy);
    }

    canUndo():boolean{return this.history.canUndo();}
    canRedo():boolean{return this.history.canRedo();}
    undo(): void {
        this.assertAlive();
        this.assertIdle();
        const before = this.history.getComposed();
        this.history.decreaseIndex();
        this.canvas.updateViaComposed(before, this.history.getComposed());
    }

    redo(): void {
        this.assertAlive();
        this.assertIdle();
        const before = this.history.getComposed();
        this.history.increaseIndex();
        this.canvas.updateViaComposed(before, this.history.getComposed());
    }

    crop(rect: { left: number; top: number; width: number; height: number }, deletePixels: boolean, backgroundColor = { r: 255, g: 255, b: 255 }): void {
        this.assertAlive(); this.assertIdle();
        if (Object.values(backgroundColor).some(value => !Number.isFinite(value) || value < 0 || value > 255)) throw new Error('Invalid canvas background color');
        if (Object.values(rect).some(value => !Number.isSafeInteger(value)) || rect.width < 1 || rect.height < 1 ||
            rect.width > 10000 || rect.height > 10000 || rect.width * rect.height > 40000000 ||
            Math.abs(rect.left) > 10000 || Math.abs(rect.top) > 10000) throw new Error('Invalid crop dimensions');
        const before = this.history.getComposed();
        const layerMap: THistoryEntryDataComposed['layerMap'] = {}, owned: HTMLCanvasElement[] = [];
        try {
        for (const layer of this.canvas.getLayers()) {
            const properties = before.layerMap[layer.id];
            const full = mergeLayerBacking(layer.canvas, deletePixels ? null : properties.hostBacking);
            owned.push(full.canvas);
            const cropped = document.createElement('canvas'); owned.push(cropped);
            cropped.width = rect.width; cropped.height = rect.height;
            if (properties.hostBackground) {
                const context = cropped.getContext('2d')!; context.fillStyle = `rgb(${backgroundColor.r},${backgroundColor.g},${backgroundColor.b})`;
                context.fillRect(0, 0, rect.width, rect.height);
            }
            cropped.getContext('2d')!.drawImage(full.canvas, full.x - rect.left, full.y - rect.top);
            layerMap[layer.id] = { ...properties, tiles: canvasToLayerTiles(cropped), ...(properties.hostMask?{hostMask:{...properties.hostMask,x:properties.hostMask.x-rect.left,y:properties.hostMask.y-rect.top}}:{}),
                hostBacking: deletePixels ? null : { x: full.x - rect.left, y: full.y - rect.top,
                    width: full.canvas.width, height: full.canvas.height, tiles: canvasToLayerTiles(full.canvas) } };
        }
        this.history.push({ size: { width: rect.width, height: rect.height }, layerMap,
            selection: this.affineSelectionWithPrevious(before.selection,{a:1,b:0,c:0,d:1,e:-rect.left,f:-rect.top}) });
        this.canvas.updateViaComposed(before, this.history.getComposed());
        } finally { for (const canvas of owned) canvas.width = canvas.height = 0; }
    }

    async adjustWhitespace(raw:WhitespacePlan,color:'white'|'transparent',signal?:AbortSignal):Promise<void>{
        this.assertAlive();this.assertIdle();const plan=WhitespacePlanSchema.parse(raw),before=this.history.getComposed();
        if(!['white','transparent'].includes(color)||plan.original.width!==before.size.width||plan.original.height!==before.size.height)throw new KlecksOperationRejected('图片尺寸已改变，请重新预览。');
        if(!plan.changed)throw new KlecksOperationRejected('当前设置不会改变图片尺寸。');
        const layers=this.canvas.getLayers(),padding=Object.values(plan.padding).some(v=>v>0);
        const whiteBase=color==='white'&&layers.some(l=>before.layerMap[l.id].hostBackground&&l.isVisible&&l.opacity===1&&l.mixModeStr==='source-over'&&!l.hasClipping);
        const border=padding&&color==='white'&&!whiteBase;
        if(border&&layers.length>=16)throw new KlecksOperationRejected('白色留白需要新增一个图层，当前已达 16 层上限；请选择透明留白，或先手动合并图层。');
        const identity=this.contentIdentity(),selection=JSON.stringify(before.selection),actions=this.history.getTotalIndex(),owned:HTMLCanvasElement[]=[];
        const check=()=>{if(signal?.aborted)throw new DOMException('已取消','AbortError');this.assertAlive();};
        try{
            const map:THistoryEntryDataComposed['layerMap']={};
            for(const layer of layers){
                await new Promise<void>(r=>setTimeout(r,0));check();const properties=before.layerMap[layer.id];
                const output=document.createElement('canvas');owned.push(output);output.width=plan.rect.width;output.height=plan.rect.height;const c=output.getContext('2d')!;c.imageSmoothingEnabled=false;
                const transparent=padding&&color==='transparent';
                if(properties.hostBackground&&!transparent){c.fillStyle='white';c.fillRect(0,0,output.width,output.height);}
                c.drawImage(layer.canvas,plan.crop.left,plan.crop.top,plan.crop.width,plan.crop.height,plan.padding.left,plan.padding.top,plan.crop.width,plan.crop.height);
                const full=mergeLayerBacking(layer.canvas,properties.hostBacking);owned.push(full.canvas);
                map[layer.id]={...properties,...(properties.hostMask?{hostMask:{...properties.hostMask,x:properties.hostMask.x-plan.rect.left,y:properties.hostMask.y-plan.rect.top}}:{}),hostBackground:transparent?false:!!properties.hostBackground,tiles:canvasToLayerTiles(output),hostBacking:{x:full.x-plan.rect.left,y:full.y-plan.rect.top,width:full.canvas.width,height:full.canvas.height,tiles:canvasToLayerTiles(full.canvas)}};
            }
            if(border){let id:string;do{id=getNextLayerId();}while(map[id]);const canvas=document.createElement('canvas');owned.push(canvas);canvas.width=plan.rect.width;canvas.height=plan.rect.height;const c=canvas.getContext('2d')!;c.fillStyle='white';c.fillRect(0,0,canvas.width,canvas.height);c.clearRect(plan.padding.left,plan.padding.top,plan.crop.width,plan.crop.height);
                map[id]={name:'留白（白色）',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',hostBackground:false,hostLocks:{all:false,pixels:false,position:false,alpha:false},hostBacking:null,index:layers.length,tiles:canvasToLayerTiles(canvas)};
            }
            check();this.assertIdle();if(this.contentIdentity()!==identity||JSON.stringify(this.history.getComposed().selection)!==selection||this.history.getTotalIndex()!==actions)throw new KlecksOperationRejected('图片或选区已改变，本次操作未提交。');
            const transformed=this.affineSelectionWithPrevious(before.selection,{a:1,b:0,c:0,d:1,e:-plan.rect.left,f:-plan.rect.top});
            this.history.push({size:{width:plan.rect.width,height:plan.rect.height},layerMap:map,selection:transformed,activeLayerId:before.activeLayerId});this.canvas.updateViaComposed(before,this.history.getComposed());
        }finally{for(const c of owned)c.width=c.height=0;}
    }

    /** Boundary-only change for ordinary raster layers; no resampling or implicit white background. */
    resizeCanvas(width: number, height: number, anchor: THostCanvasAnchor, backgroundColor = { r: 255, g: 255, b: 255 }): void {
        this.assertAlive(); this.assertIdle();
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
            width > 10000 || height > 10000 || width * height > 40000000 ||
            !['left', 'center', 'right'].includes(anchor.horizontal) || !['top', 'center', 'bottom'].includes(anchor.vertical)) throw new Error('Invalid canvas dimensions or anchor');
        const oldWidth = this.canvas.getWidth(), oldHeight = this.canvas.getHeight();
        if (width === oldWidth && height === oldHeight) return;
        const x = anchor.horizontal === 'left' ? 0 : anchor.horizontal === 'right' ? 1 : 0.5;
        const y = anchor.vertical === 'top' ? 0 : anchor.vertical === 'bottom' ? 1 : 0.5;
        this.crop({ left: Math.trunc((oldWidth - width) * x), top: Math.trunc((oldHeight - height) * y), width, height }, false, backgroundColor);
    }

    resizeImage(width: number, height: number, options: { interpolation: 'nearest' | 'smooth'; allowDistortion?: boolean }): void {
        this.assertAlive(); this.assertIdle();
        const safe = (w: number, h: number) => Number.isSafeInteger(w) && Number.isSafeInteger(h) && w > 0 && h > 0 && w <= 10000 && h <= 10000 && w * h <= 40000000;
        if (!safe(width, height) || !['nearest', 'smooth'].includes(options.interpolation)) throw new Error('Invalid image dimensions or interpolation');
        const before = this.history.getComposed();
        const sx = width / before.size.width, sy = height / before.size.height;
        // Integer pixel dimensions necessarily round one linked side; this is not an intentional stretch.
        const distorted = Math.abs(sx - sy) > 1e-9 && height !== Math.round(before.size.height * sx) && width !== Math.round(before.size.width * sy);
        if (distorted && !options.allowDistortion) throw new Error('Non-proportional image resize requires explicit permission');
        if (width === before.size.width && height === before.size.height) return;
        const selection = this.affineSelectionWithPrevious(before.selection,{a:sx,b:0,c:0,d:sy,e:0,f:0});
        const owned: HTMLCanvasElement[] = [];
        const resample = (source: HTMLCanvasElement, w: number, h: number, x = 0, y = 0, drawWidth = w, drawHeight = h) => {
            if (!safe(w, h)) throw new Error('Resampled layer backing exceeds safe dimensions');
            const canvas = document.createElement('canvas'); owned.push(canvas); canvas.width = w; canvas.height = h;
            const context = canvas.getContext('2d')!; context.imageSmoothingEnabled = options.interpolation === 'smooth'; context.imageSmoothingQuality = 'high';
            context.drawImage(source, x, y, drawWidth, drawHeight); return canvas;
        };
        const layerMap: THistoryEntryDataComposed['layerMap'] = {};
        try {
        for (const layer of this.canvas.getLayers()) {
            const properties = before.layerMap[layer.id];
            let backing: THistoryEntryLayerComposed['hostBacking'] = null;
            if (properties.hostBacking) {
                const full = mergeLayerBacking(layer.canvas, properties.hostBacking);
                owned.push(full.canvas);
                const x = Math.floor(full.x * sx), y = Math.floor(full.y * sy);
                const w = Math.ceil((full.x + full.canvas.width) * sx) - x, h = Math.ceil((full.y + full.canvas.height) * sy) - y;
                const canvas = resample(full.canvas, w, h, full.x * sx - x, full.y * sy - y, full.canvas.width * sx, full.canvas.height * sy);
                backing = { x, y, width: w, height: h, tiles: canvasToLayerTiles(canvas) };
            }
            layerMap[layer.id] = { ...properties, tiles: canvasToLayerTiles(resample(layer.canvas, width, height)), hostBacking: backing,...(properties.hostMask?{hostMask:transformMask(properties.hostMask,{a:sx,b:0,c:0,d:sy,e:0,f:0})}:{}) };
        }
        this.history.push({ size: { width, height }, selection, layerMap });
        this.canvas.updateViaComposed(before, this.history.getComposed());
        } finally { for (const canvas of owned) canvas.width = canvas.height = 0; }
    }

    select(region: MultiPolygon | undefined, mode: 'replace' | 'add' | 'subtract' | 'intersect', options: { feather?: number; antiAlias?: boolean; coverage?: DesignSelectionCoverage } = {}): void {
        this.releaseFloatingMove();
        this.assertAlive();
        this.assertIdle();
        if (!['replace', 'add', 'subtract', 'intersect'].includes(mode)) throw new Error('Invalid selection mode');
        if (options.feather !== undefined && (!Number.isFinite(options.feather) || options.feather < 0 || options.feather > 1000) ||
            options.antiAlias !== undefined && typeof options.antiAlias !== 'boolean') throw new Error('Invalid selection edge options');
        const current = this.canvas.getSelection();
        const combined = !region || mode === 'replace' ? region :
            mode === 'add' ? union(current ?? [], region) :
            mode === 'subtract' ? difference(current ?? [], region) : intersection(current ?? [], region);
        const clipped = combined ? selectionWithinCanvas(combined, this.canvas.getWidth(), this.canvas.getHeight()) : undefined;
        let result = clipped?.length ? clipped : undefined;
        const before = this.history.getComposed();
        let coverage:DesignSelectionCoverage|undefined = !region ? undefined : mode==='replace' ? options.coverage :
            before.selection.coverage || options.coverage ? combineSelectionCoverage(mode,coverageForSelection(before.selection),coverageForSelection({value:region,...options})) : undefined;
        if(coverage&&!isSelectionCoverage(coverage))throw new Error('Selection mask exceeds complexity budget');
        if(coverage){
            const stack=[coverage];let raster=false;
            while(stack.length){const node=stack.pop()!;if(node.kind==='raster'){raster=true;break;}if(node.kind==='invert'||node.kind==='transform')stack.push(node.source);else if(node.kind!=='shape')stack.push(node.left,node.right);}
            if(raster){
                // Partial weights can survive even when polygon subtraction has no interior.
                const width=this.canvas.getWidth(),height=this.canvas.getHeight(),full:MultiPolygon=[[[[0,0],[width,0],[width,height],[0,height],[0,0]]]];
                const mask=selectionMask(width,height,{value:full,coverage})!;
                try{const c=mask.getContext('2d')!,flags=new Uint8Array(width*height);
                    for(let y=0;y<height;y+=64){const rows=Math.min(64,height-y),data=c.getImageData(0,y,width,rows).data;for(let i=0;i<width*rows;i++)if(data[i*4+3])flags[y*width+i]=2;}
                    const support=traceSelectedPixelsSync(flags,width,height);result=support.length?support:undefined;
                }finally{mask.width=mask.height=0;}
            }
        }
        if(!result)coverage=undefined;
        const previous=!result&&before.selection.value?{value:before.selection.value,feather:before.selection.feather,antiAlias:before.selection.antiAlias,coverage:before.selection.coverage}:before.selection.previous;
        const points=(value:MultiPolygon|undefined)=>value?.reduce((n,p)=>n+p.reduce((m,r)=>m+r.length,0),0)??0;
        if(points(result)+points(previous?.value)>50000)throw new KlecksOperationRejected('选区与历史选区轮廓总量超限，未改变原选区。请简化选区后重试。');
        this.history.push({ selection: { value: result ? structuredClone(result) : undefined,
            coverage:coverage?structuredClone(coverage):undefined,
            previous: !result && before.selection.value ? { value: structuredClone(before.selection.value),
                feather: before.selection.feather, antiAlias: before.selection.antiAlias,coverage:before.selection.coverage } : before.selection.previous,
            feather: options.feather ?? 0, antiAlias: options.antiAlias ?? true } });
        this.canvas.updateViaComposed(before, this.history.getComposed());
    }

    selectAll(): void {
        const width = this.canvas.getWidth(), height = this.canvas.getHeight();
        this.select([[[[0, 0], [width, 0], [width, height], [0, height], [0, 0]]]], 'replace');
    }

    invertSelection():void {
        this.assertAlive();this.assertIdle();const state=this.history.getComposed(),width=state.size.width,height=state.size.height;
        const full:MultiPolygon=[[[[0,0],[width,0],[width,height],[0,height],[0,0]]]];
        if(!state.selection.value){this.selectAll();return;}
        const original=coverageForSelection(state.selection),coverage:DesignSelectionCoverage=original.kind==='invert'?original.source:{kind:'invert',source:original};
        this.select(difference(full,state.selection.value),'replace',{coverage});
    }

    previewTransformedSelection(matrix:KlecksTransformMatrix):MultiPolygon|undefined {
        this.assertAlive();this.assertIdle();return this.affineSelection(this.history.getComposed().selection,matrix).value;
    }
    transformSelection(matrix:KlecksTransformMatrix):void {
        this.assertAlive();this.assertIdle();invertKlecksTransform(matrix);
        const before=this.history.getComposed();if(!before.selection.value)throw new KlecksOperationRejected('当前没有选区，请先创建选区，再变换选区。');
        const selection=this.affineSelection(before.selection,matrix);this.select(selection.value,'replace',selection);
    }
    private affineSelection(selection:THistoryEntryDataComposed['selection'],matrix:KlecksTransformMatrix,width=this.canvas.getWidth(),height=this.canvas.getHeight()) {
        if(!selection.value)return selection;
        const value=selection.value.map(poly=>poly.map(ring=>ring.map(([x,y])=>{const p={x:matrix.a*x+matrix.c*y+matrix.e,y:matrix.b*x+matrix.d*y+matrix.f};if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>100000||Math.abs(p.y)>100000)throw new Error('Selection transform exceeds coordinate limits');return [p.x,p.y] as [number,number];})));
        const current=coverageForSelection(selection);
        const coverage:DesignSelectionCoverage=current.kind==='transform'?{...current,matrix:multiplyTransform(matrix,current.matrix)}:{kind:'transform',source:current,width,height,matrix:{...matrix}};
        if(!isSelectionCoverage(coverage))throw new Error('Selection mask exceeds complexity budget');
        const sx=Math.hypot(matrix.a,matrix.b),sy=Math.hypot(matrix.c,matrix.d),similarity=Math.abs(sx-sy)<1e-9&&Math.abs(matrix.a*matrix.c+matrix.b*matrix.d)<1e-9;
        return {...selection,value,feather:similarity?Math.min(1000,(selection.feather??0)*sx):0,coverage};
    }
    private affineSelectionWithPrevious(selection:THistoryEntryDataComposed['selection'],matrix:KlecksTransformMatrix) {
        return {...this.affineSelection(selection,matrix),previous:selection.previous?this.affineSelection(selection.previous,matrix) as NonNullable<THistoryEntryDataComposed['selection']['previous']>:undefined};
    }

    /** Quarter-turn document rotation, including preserved off-canvas layer pixels. */
    rotateCanvas(degrees: number): void {
        this.assertAlive(); this.assertIdle();
        if (![90, 180, 270].includes(degrees)) throw new Error('Unsupported canvas rotation');
        const before = this.history.getComposed();
        const width = before.size.width, height = before.size.height;
        const owned: HTMLCanvasElement[] = [];
        const turn = (canvas: HTMLCanvasElement) => {
            const result = document.createElement('canvas'); owned.push(result);
            result.width = degrees === 180 ? canvas.width : canvas.height;
            result.height = degrees === 180 ? canvas.height : canvas.width;
            const context = result.getContext('2d')!;
            if (degrees === 90) context.setTransform(0, 1, -1, 0, canvas.height, 0);
            else if (degrees === 180) context.setTransform(-1, 0, 0, -1, canvas.width, canvas.height);
            else context.setTransform(0, -1, 1, 0, 0, canvas.width);
            context.drawImage(canvas, 0, 0); return result;
        };
        const layerMap: THistoryEntryDataComposed['layerMap'] = {};
        try {
        for (const layer of this.canvas.getLayers()) {
            const properties = before.layerMap[layer.id];
            let backing: THistoryEntryLayerComposed['hostBacking'] = null;
            if (properties.hostBacking) {
                const full = mergeLayerBacking(layer.canvas, properties.hostBacking);
                owned.push(full.canvas);
                const rotated = turn(full.canvas);
                const x = degrees === 90 ? height - full.y - full.canvas.height : degrees === 180 ? width - full.x - full.canvas.width : full.y;
                const y = degrees === 90 ? full.x : degrees === 180 ? height - full.y - full.canvas.height : width - full.x - full.canvas.width;
                backing = { x, y, width: rotated.width, height: rotated.height, tiles: canvasToLayerTiles(rotated) };
            }
            layerMap[layer.id] = { ...properties, tiles: canvasToLayerTiles(turn(layer.canvas)), hostBacking: backing,...(properties.hostMask?{hostMask:transformMask(properties.hostMask,degrees===90?{a:0,b:1,c:-1,d:0,e:height,f:0}:degrees===180?{a:-1,b:0,c:0,d:-1,e:width,f:height}:{a:0,b:-1,c:1,d:0,e:0,f:width})}:{}) };
        }
        this.history.push({ size: { width: degrees === 180 ? width : height, height: degrees === 180 ? height : width }, layerMap,
            selection: this.affineSelectionWithPrevious(before.selection,degrees===90?{a:0,b:1,c:-1,d:0,e:height,f:0}:degrees===180?{a:-1,b:0,c:0,d:-1,e:width,f:height}:{a:0,b:-1,c:1,d:0,e:0,f:width}) });
        this.canvas.updateViaComposed(before, this.history.getComposed());
        } finally { for (const canvas of owned) canvas.width = canvas.height = 0; }
    }

    /** Document reflection preserves all layers, locks and pixels outside the canvas. */
    flipCanvas(axis: 'horizontal' | 'vertical'): void {
        this.assertAlive(); this.assertIdle();
        if (axis !== 'horizontal' && axis !== 'vertical') throw new Error('Invalid mirror axis');
        const before = this.history.getComposed(), {width,height} = before.size;
        const turn = (source: HTMLCanvasElement) => {
            const result = document.createElement('canvas'); result.width=source.width; result.height=source.height;
            const context=result.getContext('2d')!;
            context.imageSmoothingEnabled=false;
            context.setTransform(axis==='horizontal'?-1:1,0,0,axis==='vertical'?-1:1,axis==='horizontal'?source.width:0,axis==='vertical'?source.height:0);
            context.drawImage(source,0,0); return result;
        };
        const layerMap: THistoryEntryDataComposed['layerMap'] = {};
        for(const layer of this.canvas.getLayers()) {
            const properties=before.layerMap[layer.id];
            let hostBacking:THistoryEntryLayerComposed['hostBacking']=null;
            if(properties.hostBacking) {
                const full=mergeLayerBacking(layer.canvas,properties.hostBacking);
                const flipped=turn(full.canvas);
                try { hostBacking={x:axis==='horizontal'?width-full.x-full.canvas.width:full.x,y:axis==='vertical'?height-full.y-full.canvas.height:full.y,width:flipped.width,height:flipped.height,tiles:canvasToLayerTiles(flipped)}; }
                finally {full.canvas.width=full.canvas.height=flipped.width=flipped.height=0;}
            }
            const flipped=turn(layer.canvas);
            try { layerMap[layer.id]={...properties,tiles:canvasToLayerTiles(flipped),hostBacking,...(properties.hostMask?{hostMask:transformMask(properties.hostMask,axis==='horizontal'?{a:-1,b:0,c:0,d:1,e:width,f:0}:{a:1,b:0,c:0,d:-1,e:0,f:height})}:{})}; }
            finally {flipped.width=flipped.height=0;}
        }
        const matrix=axis==='horizontal'?{a:-1,b:0,c:0,d:1,e:width,f:0}:{a:1,b:0,c:0,d:-1,e:0,f:height};
        this.history.push({layerMap,selection:this.affineSelectionWithPrevious(before.selection,matrix)});
        this.canvas.updateViaComposed(before,this.history.getComposed());
    }

    deselect(): void { this.select(undefined, 'replace'); }

    reselect(): void {
        this.assertAlive(); this.assertIdle();
        const previous = this.history.getComposed().selection.previous;
        if (!previous) throw new Error('No previous selection');
        this.select(previous.value, 'replace', previous);
    }

    /** Vector-interior hit testing without allocating a document-sized mask. */
    selectionContains(x: number, y: number): boolean {
        this.assertAlive();
        const region = this.canvas.getSelection();
        if (!region?.length || !Number.isFinite(x) || !Number.isFinite(y)) return false;
        const surface = document.createElement('canvas'); surface.width = 1; surface.height = 1;
        try { return surface.getContext('2d')!.isPointInPath(getSelectionPath2d(region), x, y); }
        finally { surface.width = 0; surface.height = 0; }
    }

    /** Changes only the boundary; unlike pixel movement no layer pixels are touched. */
    moveSelection(x: number, y: number): void {
        this.assertAlive(); this.assertIdle();
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100000 || Math.abs(y) > 100000) throw new Error('Invalid selection translation');
        const selection = this.history.getComposed().selection;
        if (!selection.value?.length) throw new KlecksOperationRejected('当前没有可移动的选区，请先创建选区。');
        const moved=this.affineSelection(selection,{a:1,b:0,c:0,d:1,e:x,f:y});
        this.select(moved.value, 'replace', moved);
    }

    copyPixels(merged = false): THostClipboard {
        if(this.editingMask&&!merged){let clipboard:THostClipboard|undefined;this.maskProxy(image=>{clipboard=image.copyPixels();},false,true);return clipboard!;}
        this.assertAlive();
        this.assertIdle();
        if (!merged && !this.selectedLayerIds().length) throw new KlecksOperationRejected('请先选择需要复制的图层。');
        if (!merged && this.selectedLayerIds().length>1) throw new KlecksOperationRejected('多图层保留结构的剪贴板尚未支持。请使用“复制图层”保留所选图层，或使用“合并复制”复制可见图像；不会仅复制或剪切其中一层。');
        const selection = this.canvas.getSelection();
        if (selection && !selection.length && !this.history.getComposed().selection.coverage) throw new KlecksOperationRejected('当前选区为空，请重新框选有内容的区域，或先取消选区。');
        const bounds = selection && !this.history.getComposed().selection.coverage ? getMultiPolyBounds(selection, 'coordinate') : {
            x1: 0, y1: 0, x2: this.canvas.getWidth(), y2: this.canvas.getHeight(),
        };
        const padding = selection ? Math.ceil((this.history.getComposed().selection.feather ?? 0) * 3) : 0;
        const x = Math.max(0, Math.floor(bounds.x1) - padding);
        const y = Math.max(0, Math.floor(bounds.y1) - padding);
        const right = Math.min(this.canvas.getWidth(), Math.ceil(bounds.x2) + padding);
        const bottom = Math.min(this.canvas.getHeight(), Math.ceil(bounds.y2) + padding);
        if (right <= x || bottom <= y) throw new KlecksOperationRejected('选区没有覆盖图幅内的像素，请重新选择图片内的区域。');
        const source = merged ? this.canvas.getCanvas() : this.canvas.getLayers().find(
            layer => layer.id === this.history.getComposed().activeLayerId,
        )?.canvas;
        if (!source) throw new Error('No active copy layer');
        const cropped = document.createElement('canvas');
        cropped.width = right - x;
        cropped.height = bottom - y;
        const context = cropped.getContext('2d')!;
        context.translate(-x, -y);
        context.drawImage(source, 0, 0);
        const mask = selectionMask(this.canvas.getWidth(), this.canvas.getHeight(), this.history.getComposed().selection);
        if (mask) { context.globalCompositeOperation = 'destination-in'; context.drawImage(mask, 0, 0); }
        try{
            const image=context.getImageData(0,0,cropped.width,cropped.height);
            let left=image.width,top=image.height,right=0,bottom=0;
            for(let row=0;row<image.height;row++){
                const offset=row*image.width*4;let first=0,last=image.width-1;
                while(first<image.width&&!image.data[offset+first*4+3])first++;
                if(first===image.width)continue;
                while(last>first&&!image.data[offset+last*4+3])last--;
                left=Math.min(left,first);top=Math.min(top,row);right=Math.max(right,last+1);bottom=row+1;
            }
            if(right<=left||bottom<=top)throw new KlecksOperationRejected('所选区域没有可复制的像素，请选择有内容的图层或使用“合并复制”。');
            // Keep every nonzero edge alpha while removing padding before centering a paste.
            return {x:x+left,y:y+top,image:left===0&&top===0&&right===image.width&&bottom===image.height?image:context.getImageData(left,top,right-left,bottom-top)};
        }finally{cropped.width=0;cropped.height=0;if(mask){mask.width=0;mask.height=0;}}
    }

    sampleColor(x: number, y: number, source: 'current' | 'merged'): { r: number; g: number; b: number } | null {
        this.assertAlive(); this.assertIdle();
        if (!Number.isFinite(x) || !Number.isFinite(y) || !['current', 'merged'].includes(source)) throw new Error('Invalid color sample');
        const px = Math.floor(x), py = Math.floor(y);
        if (px < 0 || py < 0 || px >= this.canvas.getWidth() || py >= this.canvas.getHeight()) return null;
        if(this.editingMask&&source==='current'){const n=maskAlphaAt(this.history.getComposed().layerMap[this.history.getComposed().activeLayerId].hostMask!,px,py);return{r:n,g:n,b:n};}
        const canvas = source === 'merged' ? this.getDisplayComposite() : this.canvas.getLayer(this.layerIndex(this.history.getComposed().activeLayerId)).canvas;
        const value = canvas.getContext('2d')!.getImageData(px, py, 1, 1).data;
        return value[3] === 0 ? null : { r: value[0], g: value[1], b: value[2] };
    }
    pickLayers(x:number,y:number):string[]{
        this.assertAlive();this.assertIdle();if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=this.canvas.getWidth()||y>=this.canvas.getHeight())return [];
        return [...this.canvas.getLayers()].reverse().filter(layer=>layer.isVisible&&layer.opacity>0&&
            (!layer.hostMask?.enabled||maskAlphaAt(layer.hostMask,x,y)>0)&&layer.context.getImageData(Math.floor(x),Math.floor(y),1,1).data[3]>0).map(layer=>layer.id);
    }
    pickLayer(x:number,y:number):string|null{return this.pickLayers(x,y)[0]??null;}

    assertMoveAllowed(copy = false): void {
        this.assertAlive(); this.assertIdle();
        if (!this.selectedLayerIds().length) throw new KlecksOperationRejected('请先选择需要移动的图层。');
        if (this.selectedLayerIds().length > 1) {
            if (copy && this.canvas.getLayerCount() + this.selectedLayerIds().length > 16) throw new KlecksOperationRejected('复制选中图层将超过 16 个图层的上限。');
            if (!copy && this.selectedLayerIds().some(id => { const locks=this.getLayerLocks(id); return locks.all || locks.position; })) throw new KlecksOperationRejected('选中的图层包含位置锁定或全部锁定的图层，请先解锁。');
            return;
        }
        const before = this.history.getComposed(), id = before.activeLayerId;
        if (copy && !before.selection.value) {
            if (this.canvas.getLayerCount() >= 16) throw new KlecksOperationRejected('已达到图层数量上限，无法继续复制图层。');
            return;
        }
        if (this.getLayerLocks(id).all || before.selection.value) this.assertPixelsEditable(id);
        if (this.getLayerLocks(id).position) throw new KlecksOperationRejected(before.layerMap[id].hostBackground
            ? '背景图层的位置已锁定，请先在图层面板中转换为普通图层，再使用移动工具。'
            : '当前图层的位置已锁定，请先取消图层面板中的位置锁定，再移动。');
    }

    private renderPixelMove(dx: number, dy: number, copy = false): ReturnType<HostDocument['renderPixelMoveSource']> {
        this.syncFloatingMove();
        if(this.floatingMove && this.floatingMove.copy!==copy)this.releaseFloatingMove();
        const floating=this.floatingMove;
        if(!floating)return this.renderPixelMoveSource(dx,dy,copy);
        const result=floating.source.renderPixelMoveSource(floating.dx+dx,floating.dy+dy,copy);
        return {...result,before:this.history.getComposed()};
    }
    private renderPixelMoveSource(dx: number, dy: number, copy = false) {
        this.assertAlive(); this.assertIdle();
        if (!Number.isSafeInteger(dx) || !Number.isSafeInteger(dy) || Math.abs(dx) > 10000 || Math.abs(dy) > 10000) throw new Error('Invalid pixel translation');
        const before = this.history.getComposed(), id = before.activeLayerId;
        const selection = before.selection.value,copyLayer=copy&&!selection;
        this.assertMoveAllowed(copy);
        const layer = this.canvas.getLayer(this.layerIndex(id));
        const full = mergeLayerBacking(layer.canvas, before.layerMap[id].hostBacking);
        let source = full.canvas, sourceX = full.x, sourceY = full.y;
        if (selection) {
            const copied = this.copyPixels();
            source = document.createElement('canvas'); source.width = copied.image.width; source.height = copied.image.height;
            source.getContext('2d')!.putImageData(copied.image, 0, 0); sourceX = copied.x; sourceY = copied.y;
        }
        const x = Math.min(0, sourceX + dx, selection ? full.x : 0), y = Math.min(0, sourceY + dy, selection ? full.y : 0);
        const width = Math.max(this.canvas.getWidth(), sourceX + dx + source.width, selection ? full.x + full.canvas.width : 0) - x;
        const height = Math.max(this.canvas.getHeight(), sourceY + dy + source.height, selection ? full.y + full.canvas.height : 0) - y;
        if (width > 10000 || height > 10000 || width * height > 40000000) throw new Error('Moved pixels exceed preserved layer budget');
        const output = document.createElement('canvas'); output.width = width; output.height = height;
        const context = output.getContext('2d')!; context.translate(-x, -y);
        if (selection) {
            context.drawImage(full.canvas, full.x, full.y);
            if(!copy){const mask = selectionMask(this.canvas.getWidth(), this.canvas.getHeight(), before.selection)!;
                context.globalCompositeOperation = 'destination-out'; context.drawImage(mask, 0, 0);mask.width=0;mask.height=0;
                context.globalCompositeOperation = 'source-over';}
        }
        context.drawImage(source, sourceX + dx, sourceY + dy);
        const visible = document.createElement('canvas'); visible.width = this.canvas.getWidth(); visible.height = this.canvas.getHeight();
        visible.getContext('2d')!.drawImage(output, x, y);
        if(source!==full.canvas){source.width=0;source.height=0;}full.canvas.width=0;full.canvas.height=0;
        return { before, id, visible, output, x, y, width, height, copyLayer, hostMask:before.layerMap[id].hostMask?.linked&&!selection?transformMask(before.layerMap[id].hostMask!,{a:1,b:0,c:0,d:1,e:dx,f:dy}):before.layerMap[id].hostMask,selection: selection ? translateMultiPolygon(selection, dx, dy) : undefined };
    }

    previewPixelMove(dx: number, dy: number,copy=false): { canvas: HTMLCanvasElement; selection: MultiPolygon | undefined } {
        if(this.maskOnlyTransform()){
            this.syncFloatingMove();const floating=this.floatingMove?.copy===copy?this.floatingMove:undefined;
            return{canvas:this.maskProxy(image=>image.movePixels((floating?.dx??0)+dx,(floating?.dy??0)+dy,copy),true,false,true,floating?.source)!,selection:this.canvas.getSelection()?translateMultiPolygon(this.canvas.getSelection()!,dx,dy):undefined};
        }
        if (this.selectedLayerIds().length > 1) {
            this.assertMoveAllowed(copy);
            return {canvas:this.previewSelectedTransform({a:1,b:0,c:0,d:1,e:dx,f:dy},undefined,copy),selection:undefined};
        }
        const result = this.renderPixelMove(dx, dy,copy);
        const canvas = document.createElement('canvas'); canvas.width = this.canvas.getWidth(); canvas.height = this.canvas.getHeight();
        const compositor = new LayerCompositor();
        try {
            const layers=this.canvas.getLayers().flatMap(layer=>layer.id!==result.id?[layer]:result.copyLayer?[layer,{...layer,id:'copy-preview',canvas:result.visible,hostMask:result.hostMask}]:[{...layer,canvas:result.visible,hostMask:result.hostMask}]);
            compositor.draw(canvas.getContext('2d')!, layers,
                canvas.width, canvas.height, (context, layer) => context.drawImage(layer.canvas, 0, 0));
        } finally { compositor.destroy();result.visible.width=0;result.visible.height=0;result.output.width=0;result.output.height=0; }
        return { canvas, selection: result.selection };
    }

    movePixels(dx: number, dy: number,copy=false): void {
        this.assertAlive(); this.assertIdle();
        if (!dx && !dy) return;
        if(this.maskOnlyTransform()){
            this.assertMoveAllowed(copy);this.prepareFloatingMove(copy);const floating=this.floatingMove;
            this.maskProxy(image=>image.movePixels((floating?.dx??0)+dx,(floating?.dy??0)+dy,copy),false,false,true,floating?.source);
            this.advanceFloatingMove(dx,dy);return;
        }
        if (this.selectedLayerIds().length > 1) {
            this.assertMoveAllowed(copy);
            this.transformSelectedLayers({a:1,b:0,c:0,d:1,e:dx,f:dy},undefined,copy); return;
        }
        this.prepareFloatingMove(copy);
        const { before, id, visible, output, x, y, width, height, copyLayer } = this.renderPixelMove(dx, dy,copy);
        try{
        const backing = x === 0 && y === 0 && width === visible.width && height === visible.height ? null : {
            x, y, width, height, tiles: offCanvasBackingTiles(output, { x: -x, y: -y, width: visible.width, height: visible.height }),
        };
        const layerMap:Record<string,Partial<THistoryEntryLayerComposed>> = Object.fromEntries(this.canvas.getLayers().map(item => [item.id, item.id === id&&!copyLayer ? {
            tiles: layerPixelDelta(item.canvas, visible), hostBacking: backing,...(!before.selection.value&&before.layerMap[id].hostMask?.linked?{hostMask:transformMask(before.layerMap[id].hostMask!,{a:1,b:0,c:0,d:1,e:dx,f:dy})}:{}),
        } : copyLayer?{index:item.index+(item.index>before.layerMap[id].index?1:0)}:{}]));
        let activeLayerId=id;
        if(copyLayer){do{activeLayerId=getNextLayerId();}while(before.layerMap[activeLayerId]);}
        if(copyLayer)layerMap[activeLayerId]={...structuredClone(before.layerMap[id]),tiles:canvasToLayerTiles(visible),hostBacking:backing,hostMask:before.layerMap[id].hostMask?.linked?transformMask(before.layerMap[id].hostMask!,{a:1,b:0,c:0,d:1,e:dx,f:dy}):before.layerMap[id].hostMask,hostBackground:false,index:before.layerMap[id].index+1,name:(before.layerMap[id].name+' 拷贝').slice(0,200)};
        this.history.push({ activeLayerId,layerMap, selection: this.affineSelection(before.selection,{a:1,b:0,c:0,d:1,e:dx,f:dy}) });
        this.canvas.updateViaComposed(before, this.history.getComposed());
        this.advanceFloatingMove(dx,dy);
        }finally{visible.width=0;visible.height=0;output.width=0;output.height=0;}
    }

    private prepareFloatingMove(copy:boolean):void {
        this.syncFloatingMove();
        if(this.floatingMove&&this.floatingMove.copy!==copy)this.releaseFloatingMove();
        if(!this.floatingMove&&this.canvas.getSelection()?.length){const expected=this.moveIdentity();
            this.floatingMove={source:HostDocument.restore(this.capture()),dx:0,dy:0,copy,expected,positions:new Map([[expected,{dx:0,dy:0}]])};}
    }
    private advanceFloatingMove(dx:number,dy:number):void {
        if(!this.floatingMove)return;
        const floating=this.floatingMove;floating.dx+=dx;floating.dy+=dy;floating.expected=this.moveIdentity();
        floating.positions.set(floating.expected,{dx:floating.dx,dy:floating.dy});
        if(floating.positions.size>100)floating.positions.delete(floating.positions.keys().next().value!);
    }

    transformBounds(pixelAlignedSelection = false) {
        this.assertAlive(); this.assertIdle();
        if (!this.selectedLayerIds().length) throw new KlecksOperationRejected('请先选择需要变换的图层。');
        const state = this.history.getComposed(), selection = state.selection.value;
        if(this.maskOnlyTransform()&&!selection){const mask=state.layerMap[state.activeLayerId].hostMask!;return{left:mask.x,top:mask.y,width:mask.width,height:mask.height};}
        if (this.selectedLayerIds().length > 1) {
            const bounds = this.selectedLayerIds().flatMap(id => {
                const full=mergeLayerBacking(this.canvas.getLayer(this.layerIndex(id)).canvas,state.layerMap[id].hostBacking);
                try { const box=opaquePixelBounds(full.canvas); return box ? [{left:box.left+full.x,top:box.top+full.y,width:box.width,height:box.height}] : []; }
                finally {full.canvas.width=0;full.canvas.height=0;}
            });
            if (!bounds.length) throw new KlecksOperationRejected('选中的图层没有可变换的像素。');
            const left=Math.min(...bounds.map(b=>b.left)),top=Math.min(...bounds.map(b=>b.top));
            return {left,top,width:Math.max(...bounds.map(b=>b.left+b.width))-left,height:Math.max(...bounds.map(b=>b.top+b.height))-top};
        }
        if (selection?.length) {
            if(pixelAlignedSelection) {
                const mask=selectionMask(this.canvas.getWidth(),this.canvas.getHeight(),state.selection)!;
                try {
                    const bounds=opaquePixelBounds(mask);
                    if(!bounds)throw new KlecksOperationRejected('当前选区没有可镜像的像素，请重新选择区域。');
                    return bounds;
                } finally {mask.width=mask.height=0;}
            }
            const box = getMultiPolyBounds(selection,'coordinate'); return { left:box.x1,top:box.y1,width:box.x2-box.x1,height:box.y2-box.y1 };
        }
        const full = mergeLayerBacking(this.canvas.getLayer(this.layerIndex(state.activeLayerId)).canvas,state.layerMap[state.activeLayerId].hostBacking);
        try { const bounds = opaquePixelBounds(full.canvas); if (!bounds) throw new KlecksOperationRejected('当前图层没有可变换的像素，请选择包含图片内容的图层。'); return {...bounds,left:bounds.left+full.x,top:bounds.top+full.y}; }
        finally { full.canvas.width=0;full.canvas.height=0; }
    }

    private renderPixelTransform(matrix: KlecksTransformMatrix, admitBounds?: Parameters<typeof transformPixelCanvas>[3], layerId?: string, copy=false) {
        this.assertAlive(); this.assertIdle(); invertKlecksTransform(matrix);
        if (!this.selectedLayerIds().length) throw new KlecksOperationRejected('请先选择需要变换的图层。');
        const current = this.history.getComposed(), before = layerId ? {...current,selection:{}} : current, id = layerId ?? before.activeLayerId;
        if (!copy) {
            if (this.getLayerLocks(id).all || before.selection.value || matrix.a!==1 || matrix.b!==0 || matrix.c!==0 || matrix.d!==1) this.assertPixelsEditable(id);
            if (this.getLayerLocks(id).position) throw new KlecksOperationRejected('当前图层的位置已锁定，请先解锁。');
        }
        const full = mergeLayerBacking(this.canvas.getLayer(this.layerIndex(id)).canvas, before.layerMap[id].hostBacking);
        let output: TransformedPixels | null = null, visible: HTMLCanvasElement | null = null;
        let selected:HTMLCanvasElement|null=null,mask:HTMLCanvasElement|null=null;
        try {
            const selection=this.affineSelection(before.selection,matrix);
            if(before.selection.value){
                mask=selectionMask(this.canvas.getWidth(),this.canvas.getHeight(),before.selection)!;
                selected=document.createElement('canvas');selected.width=this.canvas.getWidth();selected.height=this.canvas.getHeight();
                const context=selected.getContext('2d')!;context.drawImage(full.canvas,full.x,full.y);context.globalCompositeOperation='destination-in';context.drawImage(mask,0,0);
            }
            output = transformPixelCanvas(selected??full.canvas, selected?{x:0,y:0}:{ x: full.x, y: full.y }, matrix, bounds => {
                const left = Math.min(0, bounds.left,selected?full.x:0), top = Math.min(0, bounds.top,selected?full.y:0);
                const width = Math.max(this.canvas.getWidth(), bounds.left + bounds.width,selected?full.x+full.canvas.width:0) - left;
                const height = Math.max(this.canvas.getHeight(), bounds.top + bounds.height,selected?full.y+full.canvas.height:0) - top;
                if (width > 10000 || height > 10000 || width * height > 40000000) throw new Error('Transformed backing exceeds preserved layer budget');
                admitBounds?.({left,top,width,height});
            });
            if (!output && layerId) { const empty=document.createElement('canvas');empty.width=this.canvas.getWidth();empty.height=this.canvas.getHeight();output={canvas:empty,x:0,y:0}; }
            if (!output) throw new Error('No pixels available for transform');
            if(selected&&mask){
                const x=Math.min(0,output.x,full.x),y=Math.min(0,output.y,full.y);
                const combined=document.createElement('canvas');combined.width=Math.max(this.canvas.getWidth(),output.x+output.canvas.width,full.x+full.canvas.width)-x;
                combined.height=Math.max(this.canvas.getHeight(),output.y+output.canvas.height,full.y+full.canvas.height)-y;
                try {compositeTransformedSelection(combined,{x,y},full.canvas,{x:full.x,y:full.y},mask,output,matrix);}
                catch(error){combined.width=combined.height=0;throw error;}
                output.canvas.width=0;output.canvas.height=0;output={canvas:combined,x,y};
            }
            visible = document.createElement('canvas'); visible.width = this.canvas.getWidth(); visible.height = this.canvas.getHeight();
            visible.getContext('2d')!.drawImage(output.canvas, output.x, output.y);
            return { before, id, visible, output, selection,hostMask:before.layerMap[id].hostMask?.linked&&!before.selection.value?transformMask(before.layerMap[id].hostMask!,matrix):before.layerMap[id].hostMask };
        } catch (error) {
            if (visible) { visible.width = 0; visible.height = 0; }
            if (output) { output.canvas.width = 0; output.canvas.height = 0; }
            throw error;
        } finally { full.canvas.width = 0; full.canvas.height = 0;if(selected){selected.width=0;selected.height=0;}if(mask){mask.width=0;mask.height=0;} }
    }

    /** Owned composite preview; document pixels/history remain unchanged. Caller admits memory first. */
    previewPixelTransform(matrix: KlecksTransformMatrix, admitBounds?: Parameters<typeof transformPixelCanvas>[3]): HTMLCanvasElement {
        if(this.maskOnlyTransform())return this.maskProxy(image=>image.transformPixels(matrix,admitBounds),true,false,true)!;
        if (this.selectedLayerIds().length > 1) return this.previewSelectedTransform(matrix,admitBounds);
        const result = this.renderPixelTransform(matrix, admitBounds);
        const canvas = document.createElement('canvas'); canvas.width = this.canvas.getWidth(); canvas.height = this.canvas.getHeight();
        const compositor = new LayerCompositor();
        try {
            compositor.draw(canvas.getContext('2d')!, this.canvas.getLayers().map(layer => layer.id === result.id ? { ...layer, canvas: result.visible, hostMask: result.hostMask } : layer),
                canvas.width, canvas.height, (context, layer) => context.drawImage(layer.canvas, 0, 0));
            return canvas;
        } catch (error) { canvas.width = 0; canvas.height = 0; throw error; }
        finally { compositor.destroy(); result.visible.width = 0; result.visible.height = 0; result.output.canvas.width = 0; result.output.canvas.height = 0; }
    }

    /** Whole-layer affine commit. Selected-pixel mask semantics are connected separately. */
    transformPixels(matrix: KlecksTransformMatrix, admitBounds?: Parameters<typeof transformPixelCanvas>[3]): void {
        if(this.maskOnlyTransform()){this.maskProxy(image=>image.transformPixels(matrix,admitBounds),false,false,true);return;}
        this.assertAlive(); this.assertIdle();
        if (matrix.a === 1 && matrix.b === 0 && matrix.c === 0 && matrix.d === 1 && matrix.e === 0 && matrix.f === 0) return;
        if (this.selectedLayerIds().length > 1) {this.transformSelectedLayers(matrix,admitBounds);return;}
        const result = this.renderPixelTransform(matrix, admitBounds);
        try {
            const { before, id, visible, output } = result;
            const outside = output.x < 0 || output.y < 0 || output.x + output.canvas.width > visible.width || output.y + output.canvas.height > visible.height;
            const hostBacking = outside ? { x: output.x, y: output.y, width: output.canvas.width, height: output.canvas.height, tiles: canvasToLayerTiles(output.canvas) } : null;
            const layerMap = Object.fromEntries(this.canvas.getLayers().map(layer => [layer.id, layer.id === id ? { tiles: canvasToLayerTiles(visible), hostBacking,hostMask:result.hostMask } : {}]));
            this.history.push({ layerMap,selection:result.selection }); this.canvas.updateViaComposed(before, this.history.getComposed());
        } finally { result.visible.width = 0; result.visible.height = 0; result.output.canvas.width = 0; result.output.canvas.height = 0; }
    }

    private renderSelectedTransforms(matrix: KlecksTransformMatrix, admitBounds?: Parameters<typeof transformPixelCanvas>[3], copy=false) {
        const rendered: ReturnType<HostDocument['renderPixelTransform']>[]=[];
        try { for (const id of this.selectedLayerIds()) rendered.push(this.renderPixelTransform(matrix,admitBounds,id,copy)); return rendered; }
        catch (error) { for (const result of rendered) {result.visible.width=result.visible.height=0;result.output.canvas.width=result.output.canvas.height=0;} throw error; }
    }

    private previewSelectedTransform(matrix: KlecksTransformMatrix, admitBounds?: Parameters<typeof transformPixelCanvas>[3], copy=false): HTMLCanvasElement {
        const rendered=this.renderSelectedTransforms(matrix,admitBounds,copy),canvas=document.createElement('canvas'),compositor=new LayerCompositor();
        canvas.width=this.canvas.getWidth();canvas.height=this.canvas.getHeight();
        try {
            const layers=this.canvas.getLayers().map(layer=>{const result=rendered.find(r=>r.id===layer.id);return result&&!copy?{...layer,canvas:result.visible,hostMask:result.hostMask}:layer;});
            if(copy){const insertion=Math.max(...rendered.map(r=>this.layerIndex(r.id)))+1;layers.splice(insertion,0,...rendered.map(r=>({...this.canvas.getLayer(this.layerIndex(r.id)),canvas:r.visible,hostMask:r.hostMask})));}
            compositor.draw(canvas.getContext('2d')!,layers,canvas.width,canvas.height,(ctx,layer)=>ctx.drawImage(layer.canvas,0,0));return canvas;
        } catch(error){canvas.width=canvas.height=0;throw error;}
        finally{compositor.destroy();for(const result of rendered){result.visible.width=result.visible.height=0;result.output.canvas.width=result.output.canvas.height=0;}}
    }

    private transformSelectedLayers(matrix: KlecksTransformMatrix, admitBounds?: Parameters<typeof transformPixelCanvas>[3], copy=false): void {
        const before=this.history.getComposed(),rendered=this.renderSelectedTransforms(matrix,admitBounds,copy);
        try {
            const order=this.canvas.getLayers().map(layer=>layer.id),copies: string[]=[];
            const map:Record<string,Partial<THistoryEntryLayerComposed>>=Object.fromEntries(order.map(id=>[id,{}]));
            for(const result of rendered){
                let id=result.id;
                if(copy){do{id=getNextLayerId();}while(before.layerMap[id]||copies.includes(id));copies.push(id);}
                const {output,visible}=result,outside=output.x<0||output.y<0||output.x+output.canvas.width>visible.width||output.y+output.canvas.height>visible.height;
                map[id]={...(copy?{...before.layerMap[result.id],hostBackground:false,name:(before.layerMap[result.id].name+' 拷贝').slice(0,200)}:{}),tiles:canvasToLayerTiles(visible),hostMask:result.hostMask,hostBacking:outside?{x:output.x,y:output.y,width:output.canvas.width,height:output.canvas.height,tiles:canvasToLayerTiles(output.canvas)}:null};
            }
            if(copy)order.splice(Math.max(...rendered.map(r=>this.layerIndex(r.id)))+1,0,...copies);
            order.forEach((id,index)=>map[id].index=index);
            this.commitLayers(before,map,copy?copies[copies.length-1]:before.activeLayerId);
            if(copy)this.history.setActiveLayer(copies[copies.length-1],copies);
        } finally {for(const result of rendered){result.visible.width=result.visible.height=0;result.output.canvas.width=result.output.canvas.height=0;}}
    }

    pastePixels(clipboard: THostClipboard, inPlace = false): void {
        if(this.masks.viewing){this.maskProxy(image=>{image.pastePixels(clipboard,inPlace);image.mergeDown(image.layerState().activeLayerId);});return;}
        this.assertAlive();
        this.assertIdle();
        const { image, x, y } = clipboard;
        if (this.canvas.getLayerCount() >= 16) throw new KlecksOperationRejected('最多支持 16 个图层，请先合并或删除不需要的图层，再粘贴。');
        if (!(image instanceof ImageData) || image.width > 10000 || image.height > 10000 || image.width * image.height > 40000000 || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
            throw new Error('Invalid internal clipboard');
        }
        const pasted = document.createElement('canvas');
        pasted.width = image.width;
        pasted.height = image.height;
        pasted.getContext('2d')!.putImageData(image, 0, 0);
        const before = this.history.getComposed();
        const active = this.canvas.getLayers().find(layer => layer.id === before.activeLayerId);
        const left = inPlace ? x : Math.floor((this.canvas.getWidth() - image.width) / 2);
        const top = inPlace ? y : Math.floor((this.canvas.getHeight() - image.height) / 2);
        const visible = document.createElement('canvas'); visible.width = this.canvas.getWidth(); visible.height = this.canvas.getHeight();
        try {
            visible.getContext('2d')!.drawImage(pasted, left, top);
            let layerId: string; do { layerId = getNextLayerId(); } while (before.layerMap[layerId]);
            const order = this.canvas.getLayers().map(layer => layer.id);
            order.splice(active ? active.index + 1 : order.length, 0, layerId);
            const layerMap: Record<string, Partial<THistoryEntryLayerComposed>> = Object.fromEntries(order.map((id, index) => [id, {index}]));
            const outside = left < 0 || top < 0 || left + image.width > visible.width || top + image.height > visible.height;
            layerMap[layerId] = { ...layerMap[layerId], name: `图层 ${this.canvas.getLayerCount()}`, opacity: 1, isVisible: true, hasClipping: false,
                mixModeStr: 'source-over', tiles: canvasToLayerTiles(visible), hostBackground: false,
                hostBacking: outside ? {x:left,y:top,width:image.width,height:image.height,tiles:canvasToLayerTiles(pasted)} : null };
            const previous = before.selection;
            // Commit topology once. Mutating KlCanvas before applying this history delta
            // would resolve old layer indices against the newly inserted layer array.
            this.history.push({ activeLayerId: layerId,
                layerMap,
                selection: { value: undefined, feather: 0, antiAlias: true,
                    previous: previous.value !== undefined ? { value: previous.value, feather: previous.feather, antiAlias: previous.antiAlias, coverage: previous.coverage } : previous.previous },
            });
            this.history.setActiveLayer(layerId);
            this.canvas.updateViaComposed(before, this.history.getComposed());
        } finally { pasted.width = pasted.height = visible.width = visible.height = 0; }
    }

    private toneHistogram?:{identity:string;id:string;selection:string;channel:string;histogram:number[]};
    async tonePixels(raw:ToneOptions,signal?:AbortSignal,commit=true):Promise<{canvas:HTMLCanvasElement;changed:boolean;histogram:number[]}>{
        if(this.editingMask)throw new KlecksOperationRejected('请先点击图像缩略图，再调整图像色阶；蒙版反相可用 Ctrl/Cmd+I。');
        this.assertAlive();this.assertIdle();const options=ToneOptionsSchema.parse(raw);
        if(this.selectedLayerIds().length!==1)throw new KlecksOperationRejected('请先选择一个图层，再调整色阶或阈值。');
        const before=this.history.getComposed(),id=before.activeLayerId,layer=this.canvas.getLayer(this.layerIndex(id));this.assertPixelsEditable(id);
        if(!layer.isVisible)throw new KlecksOperationRejected('当前图层已隐藏，请先显示图层。');
        const width=this.canvas.getWidth(),height=this.canvas.getHeight(),mask=selectionMask(width,height,before.selection),output=document.createElement('canvas');output.width=width;output.height=height;
        const identity=this.contentIdentity(),selection=JSON.stringify(before.selection),total=this.history.getTotalIndex(),channel=options.mode==='threshold'?'rgb':options.channel;
        const cached=this.toneHistogram,hasHistogram=cached?.identity===identity&&cached.id===id&&cached.selection===selection&&cached.channel===channel;
        const histogram=hasHistogram?cached.histogram.slice():Array<number>(256).fill(0),changedTiles:boolean[]=[],columns=Math.ceil(width/HISTORY_TILE_SIZE);
        const check=()=>{if(signal?.aborted)throw new DOMException('已取消','AbortError');this.assertAlive();};
        try{
            let changed=false,clock=performance.now();const c=output.getContext('2d')!,m=mask?.getContext('2d');
            const lut=Array.from({length:256},(_,n)=>tonePixel([n,n,n,255],options));
            await new Promise<void>(r=>setTimeout(r,0));check();
            // Keep full-width readback: GPU-backed fractional alpha can round differently
            // for narrow reads. Optimize history/histograms without changing preview pixels.
            for(let y=0;y<height;y+=16){check();const rows=Math.min(16,height-y),image=layer.context.getImageData(0,y,width,rows),a=m?.getImageData(0,y,width,rows).data;
                for(let p=0;p<image.data.length;p+=4){const amount=a?a[p+3]!/255:1;if(!amount||!image.data[p+3])continue;
                    const tone=channel==='rgb'?Math.round(image.data[p]!*0.299+image.data[p+1]!*0.587+image.data[p+2]!*0.114):image.data[p+['r','g','b'].indexOf(channel)]!;
                    if(!hasHistogram)histogram[tone]!+=amount*image.data[p+3]!/255;
                    for(let k=0;k<3;k++){const old=image.data[p+k]!,next=options.mode==='threshold'?(tone>=options.threshold?255:0):lut[old]![k]!;const n=Math.round(old+(next-old)*amount);if(n!==old){changed=true;changedTiles[Math.floor((y+Math.floor(p/4/width))/HISTORY_TILE_SIZE)*columns+Math.floor(((p/4)%width)/HISTORY_TILE_SIZE)]=true;}image.data[p+k]=n;}
                }c.putImageData(image,0,y);if(performance.now()-clock>=8){await new Promise<void>(r=>setTimeout(r,0));clock=performance.now();}
            }
            check();this.assertIdle();if(identity!==this.contentIdentity()||this.history.getComposed().activeLayerId!==id||JSON.stringify(this.history.getComposed().selection)!==selection||this.history.getTotalIndex()!==total)throw new KlecksOperationRejected('图片或选区已改变，请重新打开调整面板。');
            this.toneHistogram={identity,id,selection,channel,histogram:histogram.slice()};
            if(commit){if(!changed)throw new KlecksOperationRejected('本次调整没有改变像素，可能参数未改变、选区为空或区域透明。');this.history.push(getPushableLayerChange(before,changedAdjustmentTiles(output,changedTiles)));this.canvas.updateViaComposed(before,this.history.getComposed());}
            return{canvas:output,changed,histogram};
        }catch(error){output.width=output.height=0;throw error;}finally{if(mask)mask.width=mask.height=0;}
    }

    async fillPixels(color:FillColor,options:FillOptions,signal?:AbortSignal,coverage?:DesignSelectionCoverage):Promise<void>{
        this.assertAlive();this.assertIdle();
        if(!FillOptionsSchema.safeParse(options).success||!FillOptionsSchema.shape.color.safeParse(color).success)throw new KlecksOperationRejected('填充参数无效，请检查颜色和不透明度。');
        if(this.selectedLayerIds().length!==1)throw new KlecksOperationRejected('请先选择一个图层，再进行填充。');
        if(options.opacity===0)throw new KlecksOperationRejected('不透明度为 0%，不会改变图片，请提高不透明度。');
        if(this.editingMask){this.assertPixelsEditable(this.history.getComposed().activeLayerId);if(options.blend!=='normal')throw new KlecksOperationRejected('蒙版填充请使用正常混合模式。');if(signal?.aborted)throw new DOMException('已取消','AbortError');this.masks.fill(color,options.opacity/100,coverage);return;}
        const before=this.history.getComposed(),id=before.activeLayerId,index=this.layerIndex(id),layer=this.canvas.getLayer(index);
        this.assertPixelsEditable(id);
        if(!layer.isVisible)throw new KlecksOperationRejected('当前图层已隐藏，请先显示图层再填充。');
        const width=this.canvas.getWidth(),height=this.canvas.getHeight(),targetSelection=coverage?{...before.selection,value:[],coverage}:before.selection,mask=selectionMask(width,height,targetSelection);
        const identity=this.contentIdentity(),selection=JSON.stringify(before.selection),total=this.history.getTotalIndex(),preserve=options.preserveTransparency||this.getLayerLocks(id).alpha;
        const check=()=>{if(signal?.aborted)throw new DOMException('已取消','AbortError');this.assertAlive();};
        try{
            await new Promise<void>(resolve=>setTimeout(resolve,0));check();
            const tiles=await regionalFill(layer.canvas,mask,color,options,preserve,check);
            check();this.assertIdle();
            if(identity!==this.contentIdentity()||this.history.getComposed().activeLayerId!==id||JSON.stringify(this.history.getComposed().selection)!==selection||this.history.getTotalIndex()!==total)throw new KlecksOperationRejected('图片或选区已改变，本次填充未提交，请重试。');
            if(!tiles.some(Boolean))throw new KlecksOperationRejected('本次填充未改变像素：可能颜色相同、选区为空，或保留透明度时区域内没有不透明像素。');
            // Admit the prepared revision before touching the live layer canvas.
            this.history.push(getPushableLayerChange(before,tiles));
            this.canvas.updateViaComposed(before,this.history.getComposed());
        }finally{if(mask)mask.width=mask.height=0;}
    }

    clearPixels(backgroundColor={r:255,g:255,b:255}): void {
        if(this.editingMask){this.assertPixelsEditable(this.history.getComposed().activeLayerId);this.masks.fill(backgroundColor);return;}
        this.assertAlive();
        this.assertIdle();
        if (this.selectedLayerIds().length > 1) throw new KlecksOperationRejected('请先选择一个图层，再清除像素；如需删除多个图层，请使用“删除图层”。');
        if (this.canvas.getSelection()?.length === 0 && !this.history.getComposed().selection.coverage) throw new KlecksOperationRejected('当前选区为空，请重新选择需要清除的区域，或先取消选区。');
        const index = this.layerIndex(this.history.getComposed().activeLayerId);
        this.assertPixelsEditable(this.canvas.getLayer(index).id);
        const background=!!this.history.getComposed().layerMap[this.canvas.getLayer(index).id].hostBackground;
        if (this.getLayerLocks(this.canvas.getLayer(index).id).alpha&&!background) throw new KlecksOperationRejected('当前图层已锁定透明像素，请先取消透明像素锁定，再清除内容。');
        if(Object.values(backgroundColor).some(value=>!Number.isFinite(value)||value<0||value>255))throw new Error('Invalid background color');
        const before = this.history.getComposed();
        const mask = selectionMask(this.canvas.getWidth(), this.canvas.getHeight(), before.selection);
        try {
            const color = background ? `rgb(${backgroundColor.r},${backgroundColor.g},${backgroundColor.b})` : null;
            const tiles = clearedLayerTiles(this.canvas.getLayer(index).canvas, mask, color);
            if (!tiles.some(Boolean))
                throw new KlecksOperationRejected('当前区域没有可清除的像素，或已是背景色；图片和撤销记录未改变。');
            this.history.push(getPushableLayerChange(before, tiles));
            this.canvas.updateViaComposed(before, this.history.getComposed());
        } finally {
            if (mask) mask.width = mask.height = 0;
        }
    }

    cutPixels(backgroundColor={r:255,g:255,b:255}): THostClipboard {
        // Copy must succeed before a destructive change is allowed.
        const clipboard = this.copyPixels();
        this.clearPixels(backgroundColor);
        return clipboard;
    }

    setActiveLayer(id: string): void {
        this.masks.focus=undefined;
        this.assertAlive();
        this.assertIdle();
        this.layerIndex(id);
        this.history.setActiveLayer(id);
    }

    selectedLayerIds(): string[] {
        return this.history.getSelectedLayers();
    }

    setSelectedLayers(ids: readonly string[], active: string): void {
        this.assertAlive(); this.assertIdle();
        if (!ids.length && this.canvas.getLayerCount() === 1) {
            this.layerIndex(active);
            return;
        }
        this.masks.focus=undefined;
        if(!ids.length){this.layerIndex(active);this.history.setActiveLayer(active,[]);return;}
        const ordered = this.validateLayerIds(ids);
        if (!ordered.includes(active)) throw new Error('Active layer must be selected');
        this.history.setActiveLayer(active,ordered);
    }

    private validateLayerIds(ids: readonly string[]): string[] {
        if (!ids.length) throw new KlecksOperationRejected('请先选择需要操作的图层。');
        if (ids.length > 16 || new Set(ids).size !== ids.length) throw new Error('Invalid selected layers');
        ids.forEach(id => this.layerIndex(id));
        return this.canvas.getLayers().filter(layer => ids.includes(layer.id)).map(layer => layer.id);
    }

    private commitLayers(before: THistoryEntryDataComposed, layerMap: Record<string, Partial<THistoryEntryLayerComposed>>, activeLayerId = before.activeLayerId): void {
        this.history.push({ layerMap, activeLayerId });
        this.canvas.updateViaComposed(before, this.history.getComposed());
    }

    duplicateLayers(ids: readonly string[]): string[] {
        this.assertAlive(); this.assertIdle();
        const ordered = this.validateLayerIds(ids), before = this.history.getComposed();
        if (this.canvas.getLayerCount() + ordered.length > 16) throw new KlecksOperationRejected('最多支持 16 个图层，请先合并或删除不需要的图层。');
        const copies = ordered.map(id => { let copy: string; do { copy = getNextLayerId(); } while (before.layerMap[copy]); return { id, copy }; });
        const insertion = Math.max(...ordered.map(id => this.layerIndex(id))) + 1;
        const order = this.canvas.getLayers().map(layer => layer.id);
        order.splice(insertion, 0, ...copies.map(item => item.copy));
        const layerMap = Object.fromEntries(order.map((id, index) => {
            const copy = copies.find(item => item.copy === id);
            return [id, copy ? { ...before.layerMap[copy.id], hostBackground: false, index, name: (before.layerMap[copy.id].name + ' 拷贝').slice(0, 200) } : { index }];
        }));
        this.commitLayers(before, layerMap, copies[copies.length - 1].copy);
        const selected=copies.map(item=>item.copy);
        this.history.setActiveLayer(selected[selected.length-1],selected);
        return selected;
    }

    deleteLayers(ids: readonly string[]): void {
        this.assertAlive(); this.assertIdle();
        const ordered = this.validateLayerIds(ids), before = this.history.getComposed();
        if (ordered.length >= this.canvas.getLayerCount()) throw new KlecksOperationRejected('至少需要保留一个图层。');
        if (ordered.some(id => this.getLayerLocks(id).all)) throw new KlecksOperationRejected('选中的图层包含已全部锁定的图层，请先解锁。');
        const remaining = this.canvas.getLayers().filter(layer => !ordered.includes(layer.id));
        const active = remaining[Math.min(this.layerIndex(before.activeLayerId), remaining.length - 1)].id;
        this.commitLayers(before, Object.fromEntries(remaining.map((layer,index) => [layer.id, {index}])), active);
        this.history.setActiveLayer(active);
    }

    setLayersOpacity(ids: readonly string[], opacity: number): void {
        this.assertAlive(); this.assertIdle();
        const ordered = this.validateLayerIds(ids), before = this.history.getComposed();
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Invalid opacity');
        if (ordered.some(id => this.getLayerLocks(id).all || before.layerMap[id].hostBackground)) throw new KlecksOperationRejected('请先解锁背景层或全部锁定的图层，再调整不透明度。');
        if (ordered.every(id => before.layerMap[id].opacity === opacity)) return;
        this.commitLayers(before, Object.fromEntries(this.canvas.getLayers().map(layer => [layer.id, ordered.includes(layer.id) ? {opacity} : {}])));
    }

    setLayersLocks(ids: readonly string[], changes: Partial<THostLayerLocks>): void {
        this.assertAlive(); this.assertIdle();
        const ordered = this.validateLayerIds(ids), before = this.history.getComposed();
        if (Object.entries(changes).some(([key,value]) => !['all','pixels','position','alpha'].includes(key) || typeof value !== 'boolean')) throw new Error('Invalid layer locks');
        this.commitLayers(before, Object.fromEntries(this.canvas.getLayers().map(layer => [layer.id, ordered.includes(layer.id) ? {hostLocks:{...this.getLayerLocks(layer.id),...changes}} : {}])));
    }

    reorderLayers(ids: readonly string[], index: number): void {
        this.assertAlive(); this.assertIdle();
        const ordered = this.validateLayerIds(ids), before = this.history.getComposed();
        if (!Number.isInteger(index) || index < 0 || index >= this.canvas.getLayerCount()) throw new Error('Invalid layer position');
        if (ordered.some(id => before.layerMap[id].hostBackground) || index === 0 && this.canvas.getLayers().some(layer => before.layerMap[layer.id].hostBackground)) throw new KlecksOperationRejected('背景图层固定在最底部，请先转换为普通图层。');
        const order = this.canvas.getLayers().map(layer => layer.id).filter(id => !ordered.includes(id));
        order.splice(Math.min(index,order.length), 0, ...ordered);
        if (order.every((id,i) => before.layerMap[id].index === i)) return;
        this.commitLayers(before, Object.fromEntries(order.map((id,index) => [id,{index}])));
    }

    soloLayer(id: string): void {
        this.idleLayerIndex(id);
        const before = this.history.getComposed(), signature = () => JSON.stringify(this.canvas.getLayers().map(layer => [layer.id,layer.isVisible]));
        const previous = this.solo, restore = previous?.id === id && previous.expected === signature();
        const visibility = restore ? previous.visibility : Object.fromEntries(this.canvas.getLayers().map(layer => [layer.id,layer.isVisible]));
        this.commitLayers(before, Object.fromEntries(this.canvas.getLayers().map(layer => [layer.id,{isVisible:restore ? visibility[layer.id] : layer.id === id}])));
        this.solo = restore ? undefined : {id,visibility,expected:signature()};
    }

    layerState(withThumbnails=false) {
        this.assertAlive();
        const state = this.history.getComposed();
        if(withThumbnails&&!this.stroke){
            const identity=this.contentIdentity();
            if(this.thumbnails?.identity!==identity){
                const thumb=document.createElement('canvas');thumb.width=48;thumb.height=48;const context=thumb.getContext('2d')!,urls:Record<string,string>={},masks:Record<string,string>={};
                try{for(const layer of this.canvas.getLayers()){context.clearRect(0,0,48,48);const scale=Math.min(48/layer.canvas.width,48/layer.canvas.height),width=layer.canvas.width*scale,height=layer.canvas.height*scale;context.drawImage(layer.canvas,(48-width)/2,(48-height)/2,width,height);urls[layer.id]=thumb.toDataURL('image/png');const mask=state.layerMap[layer.id].hostMask;if(mask){const raster=maskCoverage(mask,layer.canvas.width,layer.canvas.height);try{context.fillStyle='black';context.fillRect(0,0,48,48);context.drawImage(raster,(48-width)/2,(48-height)/2,width,height);masks[layer.id]=thumb.toDataURL('image/png');}finally{raster.width=raster.height=0;}}}this.thumbnails={identity,urls,masks};}
                finally{thumb.width=0;thumb.height=0;}
            }
        }
        return { activeLayerId: state.activeLayerId, selectedLayerIds: this.selectedLayerIds(), layers: this.canvas.getLayers().map(layer => ({
            id: layer.id, name: layer.name, opacity: layer.opacity, visible: layer.isVisible,
            background: !!state.layerMap[layer.id].hostBackground, locks: this.getLayerLocks(layer.id),
            ...(state.layerMap[layer.id].hostMask?{mask:{enabled:state.layerMap[layer.id].hostMask!.enabled,linked:state.layerMap[layer.id].hostMask!.linked,active:this.editingMask&&this.masks.focus?.id===layer.id,view:this.masks.viewing&&this.masks.focus?.id===layer.id,...(this.thumbnails?.masks[layer.id]?{thumbnail:this.thumbnails.masks[layer.id]}:{})}}:{}),
            ...(this.thumbnails?.urls[layer.id]?{thumbnail:this.thumbnails.urls[layer.id]}:{}),
        })) };
    }

    newLayer(name: string): string {
        this.assertAlive();
        this.assertIdle();
        if (!name.trim() || name.length > 200) throw new Error('Invalid layer name');
        const image = document.createElement('canvas');
        image.width = 1;
        image.height = 1;
        const activeIndex = this.layerIndex(this.history.getComposed().activeLayerId);
        const index = this.canvas.addLayer(activeIndex, {
            name, isVisible: true, opacity: 1, mixModeStr: 'source-over', hasClipping: false, image,
        });
        if (index === false) throw new KlecksOperationRejected('最多支持 16 个图层，请先合并或删除不需要的图层。');
        this.history.setActiveLayer(this.canvas.getLayer(index).id);
        return this.canvas.getLayer(index).id;
    }

    deleteLayer(id: string): void {
        this.assertAlive();
        this.assertIdle();
        const index = this.layerIndex(id);
        if (this.getLayerLocks(id).all) throw new Error('Layer is locked');
        if (this.canvas.getLayerCount() <= 1) throw new Error('Cannot delete the last layer');
        if (this.canvas.removeLayer(index) === false) throw new Error('Layer deletion failed');
    }

    private layerIndex(id: string): number {
        const layer = this.canvas.getLayers().find(layer => layer.id === id);
        if (!layer) throw new Error('Layer no longer exists');
        return layer.index;
    }

    renameLayer(id: string, name: string): void {
        const index = this.idleLayerIndex(id);
        if (this.getLayerLocks(id).all) throw new KlecksOperationRejected('当前图层已全部锁定，请先解锁再重命名。');
        if (!name.trim() || name.length > 200) throw new Error('Invalid layer name');
        if (!this.canvas.renameLayer(index, name)) throw new Error('Layer rename failed');
    }

    setLayerOpacity(id: string, opacity: number): void {
        const index = this.idleLayerIndex(id);
        if (this.getLayerLocks(id).all) throw new KlecksOperationRejected('当前图层已全部锁定，请先解锁再调整不透明度。');
        if (this.history.getComposed().layerMap[id].hostBackground && opacity !== 1) throw new Error('Background opacity is fixed');
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Invalid opacity');
        this.canvas.setOpacity(index, opacity);
    }

    setLayerVisibility(id: string, visible: boolean): void {
        const index = this.idleLayerIndex(id);
        if (typeof visible !== 'boolean') throw new Error('Invalid visibility');
        this.canvas.setLayerIsVisible(index, visible);
    }

    moveLayer(id: string, targetIndex: number): void {
        const index = this.idleLayerIndex(id);
        // Pixel/position locks protect the image, not a normal layer's stacking order.
        if (this.history.getComposed().layerMap[id].hostBackground && index !== targetIndex) throw new KlecksOperationRejected('背景图层固定在最底部，请先解锁并转换为普通图层。');
        if (targetIndex === 0 && Object.entries(this.history.getComposed().layerMap).some(([other, properties]) => other !== id && properties.hostBackground)) throw new Error('Cannot place a layer below the background');
        if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= this.canvas.getLayerCount()) {
            throw new Error('Invalid layer position');
        }
        this.canvas.moveLayer(index, targetIndex - index);
    }

    duplicateLayer(id: string): string {
        const index = this.idleLayerIndex(id);
        const before = this.history.getComposed();
        let added: number | false;
        this.history.pause(true);
        try {
            added = this.canvas.duplicateLayer(index);
            if (added !== false) {
                const duplicate = this.canvas.getLayer(added);
                if (duplicate.name.length > 200) this.canvas.renameLayer(added, duplicate.name.slice(0, 200));
            }
        }
        finally { this.history.pause(false); }
        if (added === false) throw new KlecksOperationRejected('最多支持 16 个图层，请先合并或删除不需要的图层，再复制图层。');
        const duplicateId = this.canvas.getLayer(added).id;
        this.canvas.getLayersReference()[added].hostMask=before.layerMap[id].hostMask;
        const layerMap = Object.fromEntries(this.canvas.getLayers().map(layer => [layer.id,
            layer.id === duplicateId
                ? { ...structuredClone(before.layerMap[id]), hostBackground: false, index: layer.index, name: layer.name }
                : { index: layer.index }]));
        this.history.push({ activeLayerId: duplicateId, layerMap });
        this.history.setActiveLayer(duplicateId);
        return duplicateId;
    }

    mergeDown(id: string): void {
        const index = this.idleLayerIndex(id);
        if (index === 0) throw new KlecksOperationRejected('当前图层下方没有图层，无法向下合并。请先选择上方图层。');
        this.assertPixelsEditable(id,false);
        this.assertPixelsEditable(this.canvas.getLayer(index - 1).id,false);
        const before = this.history.getComposed();
        const bottom = this.canvas.getLayer(index - 1), top = this.canvas.getLayer(index);
        if (!bottom.isVisible || !top.isVisible) throw new KlecksOperationRejected('向下合并需要相邻的两个图层均可见，请先显示图层。');
        if (bottom.mixModeStr === 'source-over' && top.mixModeStr === 'source-over' && !bottom.hasClipping) {
            this.mergeNormalLayers(before, bottom.id, top.id);
            return;
        }
        if(before.layerMap[bottom.id].hostMask||before.layerMap[top.id].hostMask)throw new KlecksOperationRejected('当前混合或剪贴关系与蒙版组合不能安全向下合并，原图层未改变。请先应用图层蒙版，或保留图层继续编辑。');
        let backing: THistoryEntryLayerComposed['hostBacking'];
        if (before.layerMap[top.id].hostBacking || before.layerMap[bottom.id].hostBacking) {
            const parts = [bottom, top].map(layer => ({ layer,
                ...mergeLayerBacking(layer.canvas, before.layerMap[layer.id].hostBacking) }));
            const x = Math.min(...parts.map(part => part.x)), y = Math.min(...parts.map(part => part.y));
            const width = Math.max(...parts.map(part => part.x + part.canvas.width)) - x;
            const height = Math.max(...parts.map(part => part.y + part.canvas.height)) - y;
            if (width > 10000 || height > 10000 || width * height > 40000000) throw new Error('Merged backing exceeds safe dimensions');
            const fullLayers = parts.map(part => {
                const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
                const context = canvas.getContext('2d')!;
                context.drawImage(part.canvas, part.x - x, part.y - y);
                return { ...part.layer, canvas, context };
            });
            const compositor = new LayerCompositor();
            try { compositor.merge(fullLayers[0].context, fullLayers[0], fullLayers[1], (context, layer) => context.drawImage(layer.canvas, 0, 0)); }
            finally { compositor.destroy(); }
            backing = { x, y, width, height, tiles: canvasToLayerTiles(fullLayers[0].canvas) };
        }
        this.history.pause(true);
        try { if (this.canvas.mergeLayer(index) === undefined) throw new Error('Layer merge failed'); }
        finally { this.history.pause(false); }
        const layerMap = Object.fromEntries(this.canvas.getLayers().map(layer => [layer.id,
            layer.id === bottom.id ? { index: layer.index, tiles: canvasToLayerTiles(layer.canvas), hostBacking: backing ?? null } : { index: layer.index }]));
        this.history.push({ activeLayerId: bottom.id, layerMap });
    }

    /** Bake each layer's opacity into one raster before replacing either source. One undoable commit. */
    private mergeNormalLayers(before: THistoryEntryDataComposed, bottomId: string, topId: string): void {
        this.bakeLayers(before, [bottomId, topId], false);
    }

    mergeLayers(ids: readonly string[]): void {
        this.assertAlive(); this.assertIdle();
        const ordered = this.validateLayerIds(ids);
        if (ordered.length < 2) throw new KlecksOperationRejected('请至少选择两个图层进行合并。');
        ordered.forEach(id => this.assertPixelsEditable(id,false));
        if (ordered.some(id => !this.canvas.getLayer(this.layerIndex(id)).isVisible)) throw new KlecksOperationRejected('请先显示需要合并的图层。');
        this.bakeLayers(this.history.getComposed(), ordered, false);
        this.history.setActiveLayer(ordered[0]);
    }

    stampLayers(ids: readonly string[]): void {
        this.assertAlive(); this.assertIdle();
        const ordered = this.validateLayerIds(ids);
        if (this.canvas.getLayerCount() >= 16) throw new KlecksOperationRejected('最多支持 16 个图层，请先合并或删除不需要的图层。');
        if (ordered.some(id => !this.canvas.getLayer(this.layerIndex(id)).isVisible)) throw new KlecksOperationRejected('请先显示需要盖印的图层。');
        this.bakeLayers(this.history.getComposed(), ordered, true);
    }

    private bakeLayers(before: THistoryEntryDataComposed, ids: string[], stamp: boolean): void {
        const bottomId = ids[0];
        const layers = ids.map(id=>this.canvas.getLayer(this.layerIndex(id)));
        if (layers.some(layer => layer.mixModeStr !== 'source-over') || layers[0].hasClipping) throw new KlecksOperationRejected('当前混合或剪贴关系不能安全合并，请保留图层继续编辑。');
        const preserved = layers.some(layer=>before.layerMap[layer.id].hostBacking);
        const owned: HTMLCanvasElement[] = [], compositor = new LayerCompositor();
        try {
            const parts = layers.map(layer=>{
                if (!preserved) return {layer,canvas:layer.canvas,x:0,y:0};
                const full = mergeLayerBacking(layer.canvas,before.layerMap[layer.id].hostBacking);
                owned.push(full.canvas);return {layer,...full};
            });
            const x = Math.min(...parts.map(part=>part.x)), y = Math.min(...parts.map(part=>part.y));
            const width = Math.max(...parts.map(part=>part.x+part.canvas.width))-x;
            const height = Math.max(...parts.map(part=>part.y+part.canvas.height))-y;
            if (width>10000||height>10000||width*height>40000000) throw new Error('Merged backing exceeds safe dimensions');
            const output=document.createElement('canvas');owned.push(output);output.width=width;output.height=height;
            const positioned=layers.map(layer=>({...layer,hostMask:layer.hostMask?{...layer.hostMask,x:layer.hostMask.x-x,y:layer.hostMask.y-y}:layer.hostMask}));
            compositor.draw(output.getContext('2d')!,positioned,width,height,(context,layer)=>{
                const part=parts.find(value=>value.layer.id===layer.id)!;
                context.drawImage(part.canvas,part.x-x,part.y-y);
            });
            const visible=document.createElement('canvas');owned.push(visible);visible.width=before.size.width;visible.height=before.size.height;
            visible.getContext('2d')!.drawImage(output,x,y);
            const backing = preserved ? {x,y,width,height,tiles:canvasToLayerTiles(output)} : null;
            let target = bottomId;
            const remaining=this.canvas.getLayers().map(layer=>layer.id).filter(id=>stamp || !ids.includes(id) || id===bottomId);
            if (stamp) { do { target = getNextLayerId(); } while (before.layerMap[target]); remaining.splice(this.layerIndex(ids[ids.length-1])+1,0,target); }
            const layerMap=Object.fromEntries(remaining.map((id,index)=>[id,id===target?
                {...(stamp?{...before.layerMap[bottomId],name:'盖印图层',hostBackground:false,hostLocks:{all:false,pixels:false,position:false,alpha:false}}:{}),hostMask:null,index,opacity:1,hasClipping:false,tiles:canvasToLayerTiles(visible),hostBacking:backing}:{index}]));
            this.commitLayers(before,layerMap,target);
            this.history.setActiveLayer(target);
        } finally { compositor.destroy();for(const canvas of owned){canvas.width=0;canvas.height=0;} }
    }

    private idleLayerIndex(id: string): number {
        this.assertAlive();
        this.assertIdle();
        return this.layerIndex(id);
    }

    getLayerLocks(id: string): THostLayerLocks {
        this.assertAlive();
        this.layerIndex(id);
        const properties = this.history.getComposed().layerMap[id];
        return { all: false, pixels: false, position: false, alpha: false,
            ...properties.hostLocks, ...(properties.hostBackground ? { position: true, alpha: true } : {}) };
    }

    makeBackground(id: string, color: { r: number; g: number; b: number }): void {
        this.idleLayerIndex(id);
        if (Object.values(color).some(value => !Number.isFinite(value) || value < 0 || value > 255)) throw new Error('Invalid background color');
        const before = this.history.getComposed();
        if (Object.entries(before.layerMap).some(([other, properties]) => other !== id && properties.hostBackground)) throw new Error('A background layer already exists');
        const source = this.canvas.getLayer(this.layerIndex(id));
        const flatten = (canvas: HTMLCanvasElement) => {
            const output = document.createElement('canvas'); output.width = canvas.width; output.height = canvas.height;
            const context = output.getContext('2d')!; context.fillStyle = `rgb(${color.r},${color.g},${color.b})`;
            context.fillRect(0, 0, output.width, output.height); context.drawImage(canvas, 0, 0); return output;
        };
        let backing: THistoryEntryLayerComposed['hostBacking'] = null;
        if (before.layerMap[id].hostBacking) {
            const full = mergeLayerBacking(source.canvas, before.layerMap[id].hostBacking);
            backing = { x: full.x, y: full.y, width: full.canvas.width, height: full.canvas.height, tiles: canvasToLayerTiles(flatten(full.canvas)) };
        }
        const order = [id, ...this.canvas.getLayers().map(layer => layer.id).filter(other => other !== id)];
        const layerMap = Object.fromEntries(order.map((other, index) => [other, other === id ? {
            ...before.layerMap[id], index, name: '背景', opacity: 1, isVisible: true, mixModeStr: 'source-over' as const,
            hasClipping: false, hostBackground: true, hostLocks: { all: false, pixels: false, position: false, alpha: false },
            tiles: canvasToLayerTiles(flatten(source.canvas)), hostBacking: backing,
        } : { index }]));
        this.history.push({ layerMap, activeLayerId: id });
        this.canvas.updateViaComposed(before, this.history.getComposed());
    }

    backgroundToLayer(id: string, name: string): void {
        this.idleLayerIndex(id);
        if (!name.trim() || name.length > 200) throw new Error('Invalid layer name');
        const before = this.history.getComposed();
        if (!before.layerMap[id].hostBackground) throw new Error('Not a background layer');
        const layerMap = Object.fromEntries(this.canvas.getLayers().map(layer => [layer.id, layer.id === id ? {
            hostBackground: false, name, hostLocks: { all: false, pixels: false, position: false, alpha: false },
        } : {}]));
        this.history.push({ layerMap }); this.canvas.updateViaComposed(before, this.history.getComposed());
    }

    setLayerLocks(id: string, changes: Partial<THostLayerLocks>): void {
        this.idleLayerIndex(id);
        if (Object.entries(changes).some(([key, value]) =>
            !['all', 'pixels', 'position', 'alpha'].includes(key) || typeof value !== 'boolean')) {
            throw new Error('Invalid layer locks');
        }
        const hostLocks = { ...this.getLayerLocks(id), ...changes };
        const layerMap = Object.fromEntries(this.canvas.getLayers().map(layer =>
            [layer.id, layer.id === id ? { hostLocks } : {}]));
        this.history.push({ layerMap });
    }

    private assertPixelsEditable(id: string,maskTarget=this.editingMask): void {
        if (!this.selectedLayerIds().length) throw new KlecksOperationRejected('请先在图层面板选择需要编辑的图层。');
        const locks = this.getLayerLocks(id);
        if (locks.all || locks.pixels&&!maskTarget) throw new KlecksOperationRejected('当前图层的像素已锁定，请先在图层面板取消相应锁定，再进行编辑。');
    }

    /** Convenience for replaying an already completed pointer sequence. */
    paint(points: readonly TStrokePoint[], options: TStrokeOptions): void {
        if (!points.length) return;
        points.forEach(point => this.validatePoint(point));
        this.beginStroke(points[0], options);
        try {
            for (const point of points.slice(1)) this.moveStroke(point);
            this.endStroke();
        } catch (error) {
            this.cancelStroke();
            throw error;
        }
    }

    private retouch:RetouchStroke|null=null;
    beginRetouch(point:TStrokePoint,options:RetouchOptions):void{
        if(this.editingMask)throw new KlecksOperationRejected('仿制图章和模糊暂不编辑蒙版，请点击图像缩略图后使用；蒙版可使用画笔、橡皮擦和填充。');
        this.assertAlive();this.assertIdle();this.validatePoint(point);
        if(this.selectedLayerIds().length!==1)throw new KlecksOperationRejected('请先选择一个图层，再使用仿制图章或模糊。');
        const id=this.history.getComposed().activeLayerId;this.assertPixelsEditable(id);const layer=this.canvas.getLayer(this.layerIndex(id));if(!layer.isVisible)throw new KlecksOperationRejected('当前图层已隐藏，请先显示图层。');
        if(!['clone','blur'].includes(options.tool)||!Number.isFinite(options.size)||options.size<1||options.size>5000||[options.hardness,options.opacity,options.strength].some(v=>!Number.isFinite(v)||v<0||v>1)||!Number.isFinite(options.offset.x)||!Number.isFinite(options.offset.y))throw new KlecksOperationRejected('修图笔刷参数无效。');
        if(options.flow!==undefined&&(!Number.isFinite(options.flow)||options.flow<0||options.flow>1))throw new KlecksOperationRejected('流量参数无效。');
        if(options.tool==='clone'&&(!options.opacity||options.flow===0)||options.tool==='blur'&&!options.strength)throw new KlecksOperationRejected('当前不透明度、流量或强度为 0%，不会修改图片。');
        this.retouch=new RetouchStroke(layer.canvas,options.merged?this.getDisplayComposite():layer.canvas,selectionMask(this.canvas.getWidth(),this.canvas.getHeight(),this.history.getComposed().selection),this.getLayerLocks(id).alpha,options);
        try{this.moveRetouch(point);}catch(e){this.cancelRetouch();throw e;}
    }
    moveRetouch(point:TStrokePoint):void{this.validatePoint(point);if(!this.retouch)throw new Error('No retouch stroke');this.retouch.move(point);this.pixelPreviewRevision=(this.pixelPreviewRevision??0)+1;}
    endRetouch():void{const stroke=this.retouch;if(!stroke)return;try{if(!stroke.changed())throw new KlecksOperationRejected('本次操作未改变像素：请检查取样点、选区、透明区域或强度。');const canvas=this.canvas.getLayer(this.layerIndex(this.history.getComposed().activeLayerId)).canvas,entry=getPushableLayerChange(this.history.getComposed(),canvasAndChangedTilesToLayerTiles(canvas,stroke.changedTiles()));if(!this.history.canRetainUndo(entry))throw new KlecksOperationRejected('本次笔画过大，无法保留撤销记录，已恢复原图。请缩小笔刷或分成多笔处理。');this.history.push(entry);}catch(e){stroke.rollback();throw e;}finally{stroke.destroy();this.retouch=null;this.pixelPreviewRevision=(this.pixelPreviewRevision??0)+1;}}
    cancelRetouch():void{if(!this.retouch)return;this.retouch.rollback();this.retouch.destroy();this.retouch=null;this.pixelPreviewRevision=(this.pixelPreviewRevision??0)+1;}
    beginStroke(point: TStrokePoint, options: TStrokeOptions): void {
        this.assertAlive();
        this.assertIdle();
        if (this.selectedLayerIds().length > 1) throw new KlecksOperationRejected('请先选择一个图层，再使用画笔或橡皮擦。');
        this.validatePoint(point);
        if (this.canvas.getSelection()?.length === 0 && !this.history.getComposed().selection.coverage) throw new KlecksOperationRejected('当前选区为空，无法绘制或擦除。请重新选择区域，或先取消选区。');
        if (!Number.isFinite(options.size) || options.size <= 0 || options.size > 5000 ||
            !Number.isFinite(options.opacity) || options.opacity < 0 || options.opacity > 1 ||
            (options.flow !== undefined && (!Number.isFinite(options.flow) || options.flow < 0 || options.flow > 1)) ||
            (options.hardness !== undefined && (!Number.isFinite(options.hardness) || options.hardness < 0 || options.hardness > 1)) ||
            !['brush', 'eraser'].includes(options.tool) ||
            Object.values(options.color).some(v => !Number.isFinite(v) || v < 0 || v > 255)) {
            throw new Error('Invalid stroke parameters');
        }
        const activeId = this.history.getComposed().activeLayerId;
        this.assertPixelsEditable(activeId);
        const alphaLocked = !this.editingMask&&this.getLayerLocks(activeId).alpha;
        const layer = this.canvas.getLayers().find(layer => layer.id === activeId);
        if (!layer) throw new Error('No active painting layer');
        if (!layer.isVisible) throw new KlecksOperationRejected('当前图层已隐藏，请先显示图层再绘制。');
        const maskPaint=this.masks.begin(options.tool==='eraser'?options.backgroundColor??{r:255,g:255,b:255}:options.color);
        const brush = new PenBrush();
            const base = document.createElement('canvas');
            base.width = this.canvas.getWidth(); base.height = this.canvas.getHeight();
            base.getContext('2d')!.drawImage(maskPaint??layer.canvas, 0, 0);
            const paint = document.createElement('canvas');
            paint.width = base.width; paint.height = base.height;
            const masked = document.createElement('canvas');
            masked.width = base.width; masked.height = base.height;
            this.strokeComposite = { base, paint, masked,
                mask: selectionMask(base.width, base.height, this.history.getComposed().selection), layerId: layer.id, opacity: options.opacity, alphaLocked,
                erasing: options.tool === 'eraser' && !alphaLocked };
            brush.setContext(paint.getContext('2d')!);
            brush.setColor(maskPaint?{r:255,g:255,b:255}:options.tool === 'eraser' ? options.backgroundColor ?? { r: 255, g: 255, b: 255 } : options.color);
            brush.setAlpha(0);
            brush.setLockAlpha(false);
            brush.setSpacing(0.5);
            brush.setHardness(options.hardness ?? 1);
        brush.setHistory(this.history);
        brush.useHostSelectionMask();
        brush.setSize(options.size / 2);
        brush.setOpacity(options.flow ?? 1);
        brush.sizePressure(false);
        brush.opacityPressure(false);
        this.stroke = brush;
        try { brush.startLine(...point); this.refreshStroke(); } catch (error) { this.cancelStroke(); throw error; }
    }

    moveStroke(point: TStrokePoint): void {
        this.assertAlive();
        this.validatePoint(point);
        if (!this.stroke) throw new Error('No active stroke');
        this.stroke.goLine(...point);
        this.refreshStroke();
    }

    endStroke(): void {
        this.assertAlive();
        if (!this.stroke) return;
        if (this.strokeComposite) {
            this.history.pause(true);
            try { this.stroke.endLine(); } finally { this.history.pause(false); }
            this.refreshStroke();
            const changedTiles = this.stroke.getHostChangedTiles();
            if (changedTiles.some(Boolean)) {
                if(this.masks.paint)this.masks.commitPaint();
                else this.history.push(getPushableLayerChange(this.history.getComposed(),canvasAndChangedTilesToLayerTiles(this.canvas.getLayer(this.layerIndex(this.strokeComposite.layerId)).canvas, changedTiles)));
            }
        } else this.stroke.endLine();
        this.stroke = null;
        this.releaseStrokeComposite();
    }

    cancelStroke(): void {
        this.assertAlive();
        if (!this.stroke) return;
        // Brush changes enter history only at endLine; rebuild from the untouched history.
        const rebuilt = new KlCanvas(this.history);
        this.documentCanvas.destroy();
        this.documentCanvas = rebuilt;
        this.stroke = null;
        this.releaseStrokeComposite();
    }

    private releaseStrokeComposite(): void {
        this.masks.cancelPaint();
        const scratch = this.strokeComposite;
        this.strokeComposite = null;
        if (scratch) for (const canvas of [scratch.base, scratch.paint, scratch.masked, scratch.mask])
            if (canvas) { canvas.width = 0; canvas.height = 0; }
    }

    private refreshStroke(): void {
        const composite = this.strokeComposite;
        if (!composite) return;
        const dirty = strokeTileRegion(this.stroke!.getHostChangedTiles(), composite.paint.width, composite.paint.height);
        const maskedContext = composite.masked.getContext('2d')!;
        maskedContext.save();
        maskedContext.clip(dirty.path);
        maskedContext.globalCompositeOperation = 'copy';
        drawStrokeRegion(maskedContext, composite.paint, dirty);
        if (composite.mask) {
            maskedContext.globalCompositeOperation = 'destination-in';
            drawStrokeRegion(maskedContext, composite.mask, dirty);
        }
        maskedContext.restore();
        const context = this.masks.paint?.canvas.getContext('2d')??this.canvas.getLayer(this.layerIndex(composite.layerId)).context;
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clip(dirty.path);
        context.globalAlpha = 1;
        context.globalCompositeOperation = 'copy';
        drawStrokeRegion(context, composite.base, dirty);
        context.globalCompositeOperation = this.masks.paint?'destination-out':composite.erasing ? 'destination-out' : composite.alphaLocked ? 'source-atop' : 'source-over';
        context.globalAlpha = composite.opacity;
        drawStrokeRegion(context, composite.masked, dirty);
        if(this.masks.paint){context.globalCompositeOperation='lighter';context.globalAlpha=composite.opacity*this.masks.gray;drawStrokeRegion(context,composite.masked,dirty);}
        context.restore();
        this.pixelPreviewRevision = (this.pixelPreviewRevision ?? 0) + 1;
    }

    private validatePoint(point: TStrokePoint): void {
        if (point.some(v => !Number.isFinite(v)) || point[2] < 0 || point[2] > 1) {
            throw new Error('Invalid stroke point');
        }
    }

    private protectImmediateUndo():void{
        this.history.setUndoAdmissionFailure(()=>{const previous=this.documentCanvas;this.documentCanvas=new KlCanvas(this.history);previous.destroy();this.pixelPreviewRevision=(this.pixelPreviewRevision??0)+1;throw new KlecksOperationRejected('本次操作无法保留撤销记录，已恢复原图。请缩小处理范围或使用较小尺寸的图片副本。');});
    }
    private assertIdle(): void {
        if (this.stroke||this.retouch) throw new Error('Finish or cancel the current stroke first');
    }

    async exportPSD(): Promise<Blob> {
        // Freeze before the asynchronous encoder, so subsequent edits cannot enter the save.
        const frozen = this.freezeCurrent();
        try {
            return await klCanvasToPsdBlob(frozen.canvas);
        } finally {
            frozen.destroy();
        }
    }

    /** One frozen revision for the later atomic host commit; this does not mark anything saved/applied. */
    async exportRevision(thumbnailEdge = 512): Promise<THostRevisionBundle> {
        if (!Number.isSafeInteger(thumbnailEdge) || thumbnailEdge < 1 || thumbnailEdge > 2048) throw new Error('Invalid thumbnail edge');
        const frozen = this.freezeCurrent();
        let composite: HTMLCanvasElement | undefined, thumbnail: HTMLCanvasElement | undefined;
        const encode = async (canvas: HTMLCanvasElement): Promise<THostRasterOutput> => {
            const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value =>
                value ? resolve(value) : reject(new Error('Revision PNG encoding failed')), 'image/png'));
            return { blob, width: canvas.width, height: canvas.height, mediaType: 'image/png' };
        };
        try {
            const project = await frozen.encodeFrozenProject();
            composite = frozen.canvas.getCanvas();
            const scale = Math.min(1, thumbnailEdge / composite.width, thumbnailEdge / composite.height);
            thumbnail = document.createElement('canvas');
            thumbnail.width = Math.max(1, Math.round(composite.width * scale));
            thumbnail.height = Math.max(1, Math.round(composite.height * scale));
            const context = thumbnail.getContext('2d')!;
            context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
            context.drawImage(composite, 0, 0, thumbnail.width, thumbnail.height);
            return { project, composite: await encode(composite), thumbnail: await encode(thumbnail) };
        } finally {
            if (composite) { composite.width = 1; composite.height = 1; }
            if (thumbnail) { thumbnail.width = 1; thumbnail.height = 1; }
            frozen.destroy();
        }
    }

    /** Trusted internal bundle; persistence/IPC must validate its envelope before decoding. */
    async exportProject(): Promise<THostProject> {
        const frozen = this.freezeCurrent();
        try { return await frozen.encodeFrozenProject(); }
        finally { frozen.destroy(); }
    }

    /** Frozen, private owner: encode without recursively cloning history or current pixels. */
    private async encodeFrozenProject(): Promise<THostProject> {
            const composed = this.history.getComposed();
            const { layerMap, ...metadata } = composed;
            const layers: THostProject['metadata']['layers'] = [];
            const backings: THostProject['backings'] = [];
            for (const layer of this.canvas.getLayers()) {
                const { tiles, hostBacking, hostMask, ...properties } = layerMap[layer.id];
                const mask=hostMask?{x:hostMask.x,y:hostMask.y,width:hostMask.width,height:hostMask.height,outside:hostMask.outside,enabled:hostMask.enabled,linked:hostMask.linked}:undefined;
                if (hostBacking) {
                    const canvas = backingToCanvas(hostBacking);
                    let blob: Blob;
                    try { blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
                        value => value ? resolve(value) : reject(new Error('Backing PNG encoding failed')), 'image/png')); }
                    finally { canvas.width = 1; canvas.height = 1; }
                    backings.push({ id: layer.id, blob });
                    layers.push({ id: layer.id, properties,...(mask?{mask}:{}), backing: {
                        x: hostBacking.x, y: hostBacking.y, width: hostBacking.width, height: hostBacking.height,
                    } });
                } else layers.push({ id: layer.id, properties,...(mask?{mask}:{}) });
            }
            return {
                version: 1,
                metadata: structuredClone({ ...metadata, selectedLayerIds: this.selectedLayerIds(),...(this.editingMask?{maskFocus:this.masks.focus}:{}), layers }),
                backings,
                psd: await klCanvasToPsdBlob(this.canvas),
            };
    }

    private freezeCurrent(): HostDocument {
        this.assertAlive(); this.assertIdle();
        const history = new KlHistory({ oldest: structuredClone(this.history.getComposed()), hostPolicy: DEFAULT_HOST_HISTORY_POLICY });
        const frozen = Object.create(HostDocument.prototype) as HostDocument;
        Object.assign(frozen, { history, documentCanvas: new KlCanvas(history), destroyed: false, stroke: null, strokeComposite: null });
        history.setActiveLayer(history.getComposed().activeLayerId,this.selectedLayerIds());
        if(this.editingMask&&this.masks.focus)frozen.masks.focus={...this.masks.focus};
        return frozen;
    }

    static async openProject(bundle: THostProject): Promise<HostDocument> {
        if (bundle.version !== 1 || !(bundle.psd instanceof Blob) || bundle.psd.size > 256 * 1024 * 1024) {
            throw new Error('Unsupported internal project');
        }
        // Freeze caller-owned metadata before the decoder's asynchronous boundary.
        const metadata = structuredClone(bundle.metadata);
        const backings = new Map(bundle.backings.map(item => [item.id, item.blob]));
        if (backings.size !== bundle.backings.length || backings.size !== metadata.layers.filter(layer => layer.backing).length) {
            throw new Error('Invalid backing asset references');
        }
        const { width, height } = metadata.size;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
            width > 10000 || height > 10000 || width * height > 40000000 ||
            metadata.layers.length < 1 || metadata.layers.length > 16 ||
            new Set(metadata.layers.map(layer => layer.id)).size !== metadata.layers.length) {
            throw new Error('Invalid internal project dimensions or layers');
        }
        const psdBytes = new Uint8Array(await bundle.psd.arrayBuffer());
        validateEditorPsdLayout(psdBytes, { width, height }, metadata.layers.length,metadata.layers.map(layer=>layer.mask));
        const decoded = await decodePsdInWorker(psdBytes);
        if (decoded.width !== width || decoded.height !== height || decoded.children?.length !== metadata.layers.length) {
            throw new Error('PSD and metadata do not match');
        }
        const layerMap: THistoryEntryDataComposed['layerMap'] = {};
        for (const [index, saved] of metadata.layers.entries()) {
            const layer = decoded.children[index];
            if (!layer.imageData || layer.children || saved.properties.index !== index) throw new Error('Unsupported project layer');
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const pixels = layer.imageData;
            canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), layer.left ?? 0, layer.top ?? 0);
            layerMap[saved.id] = { ...saved.properties, tiles: canvasToLayerTiles(canvas) };
            canvas.width=canvas.height=0;
            if(saved.mask){const pixels=layer.mask?.imageData;if(!pixels||pixels.width!==saved.mask.width||pixels.height!==saved.mask.height)throw new Error('蒙版通道与清单尺寸不一致。');const maskCanvas=document.createElement('canvas');maskCanvas.width=pixels.width;maskCanvas.height=pixels.height;try{maskCanvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels.data),pixels.width,pixels.height),0,0);layerMap[saved.id].hostMask=grayMask(maskCanvas,saved.mask);}finally{maskCanvas.width=maskCanvas.height=0;}}
            if (saved.backing) {
                const backing = saved.backing;
                if (Object.values(backing).some(value => !Number.isSafeInteger(value)) || backing.width < 1 || backing.height < 1 ||
                    backing.width > 10000 || backing.height > 10000 || backing.width * backing.height > 40000000) throw new Error('Invalid backing dimensions');
                const blob = backings.get(saved.id);
                if (!blob || blob.size > 256 * 1024 * 1024) throw new Error('Missing or oversized backing asset');
                validateEditorBinaryHeader(new Uint8Array(await blob.slice(0, 33).arrayBuffer()), 'png', backing);
                const bitmap = await createImageBitmap(blob);
                try {
                    if (bitmap.width !== backing.width || bitmap.height !== backing.height) throw new Error('Backing PNG dimensions mismatch');
                    const backingCanvas = document.createElement('canvas');
                    backingCanvas.width = bitmap.width; backingCanvas.height = bitmap.height;
                    try {
                        backingCanvas.getContext('2d')!.drawImage(bitmap, 0, 0);
                        layerMap[saved.id].hostBacking = {
                            ...backing,
                            tiles: offCanvasBackingTiles(backingCanvas, { x: -backing.x, y: -backing.y, width, height }),
                        };
                    } finally { backingCanvas.width = backingCanvas.height = 0; }
                } finally { bitmap.close(); }
            }
        }
        if (!layerMap[metadata.activeLayerId]) throw new Error('Missing active layer');
        const { layers, hostViewport, selectedLayerIds, maskFocus, ...state } = metadata;
        if (selectedLayerIds && (new Set(selectedLayerIds).size !== selectedLayerIds.length || selectedLayerIds.length>16 || selectedLayerIds.length>0&&!selectedLayerIds.includes(metadata.activeLayerId) || selectedLayerIds.some(id => !layerMap[id]))) throw new Error('Invalid selected layers');
        const history = new KlHistory({ oldest: { ...state, layerMap }, hostPolicy: DEFAULT_HOST_HISTORY_POLICY });
        return HostDocument.restore({ version: 1, history: history.exportSnapshot(), selectedLayerIds,maskFocus });
    }

    destroy(): void {
        this.cancelRetouch();
        this.releaseFloatingMove();
        if (this.destroyed) return;
        this.destroyed = true;
        clearSelectionMaskCache();
        this.toneHistogram=undefined;
        this.stroke = null;
        this.releaseStrokeComposite();
        this.layerMasks?.destroy();
        if (this.displayComposite) {
            this.displayComposite.compositor.destroy();
            this.displayComposite.canvas.width = 0; this.displayComposite.canvas.height = 0;
            this.displayComposite = undefined;
        }
        this.canvas.destroy();
    }

    private assertAlive(): void {
        if (this.destroyed) throw new Error('Editor document has been destroyed');
    }
}
