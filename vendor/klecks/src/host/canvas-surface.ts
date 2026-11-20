import { HostWorkspace } from './host-workspace';
import { fitViewport, changePixelRatio } from '../../../../src/renderer/src/design-patent/correction/klecks-viewport';
import type { MultiPolygon } from 'polygon-clipping';
import { getSelectionPath2d } from '../app/script/bb/multi-polygon/get-selection-path-2d';
import { applyKlecksTransform, type KlecksTransformBounds, type KlecksTransformMatrix } from '../../../../src/renderer/src/design-patent/correction/klecks-transform';
import { BOX_HANDLES, boxHandlePoint } from '../../../../src/renderer/src/design-patent/correction/klecks-box-handles';
import { selectionWithinCanvas } from './selection-bounds';

/** Display-only surface: neither workspace gray nor transparency tiles enter document pixels. */
export class HostCanvasSurface {
    readonly canvas = document.createElement('canvas');
    private readonly resize: ResizeObserver;
    private disposed = false;
    private preview: { id: string; region: MultiPolygon } | null = null;
    private polygonPreview: {id:string;points:readonly (readonly [number,number])[];mode:string}|null=null;
    private compositePreview: { id: string; canvas: HTMLCanvasElement } | null = null;
    private zoomRect: { left: number; top: number; width: number; height: number } | null = null;
    private showPixelGrid = true;
    private showEdges = true;
    private controlBox: { kind: 'crop' | 'transform'; bounds: KlecksTransformBounds; matrix: KlecksTransformMatrix } | null = null;
    previewControlBox(box: typeof this.controlBox, redraw = true): void { this.controlBox = box; if(redraw)this.redraw(); }

    setPixelGrid(show: boolean): void { this.showPixelGrid = show; this.redraw(); }
    setSelectionEdges(show: boolean): void { this.showEdges = show; this.redraw(); }
    previewZoom(rect: typeof this.zoomRect): void { this.zoomRect = rect; this.redraw(); }

    constructor(private readonly container: HTMLElement, private readonly workspace: HostWorkspace) {
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute('aria-label', '图片编辑画布');
        this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline-offset:-2px';
        container.append(this.canvas);
        this.resize = new ResizeObserver(() => this.redraw());
        this.resize.observe(container);
        this.redraw();
    }

    fit(): void {
        const image = this.workspace.document;
        const box = this.container.getBoundingClientRect();
        if (!image || box.width <= 0 || box.height <= 0) return;
        this.workspace.setViewport(fitViewport({ width: image.canvas.getWidth(), height: image.canvas.getHeight() },
            { width: box.width, height: box.height }, window.devicePixelRatio || 1));
        this.redraw();
    }

    previewSelection(region: MultiPolygon | null, redraw = true): void {
        if (this.disposed) return;
        const id = this.workspace.activeId;
        this.preview = region?.length && id ? { id, region: structuredClone(region) } : null;
        if(redraw)this.redraw();
    }

    /** An open tool path, never a committed/closed selection or document raster. */
    previewPolygon(points:readonly (readonly [number,number])[]|null,mode='replace'):void {
        if(this.disposed)return;
        const id=this.workspace.activeId;
        this.polygonPreview=points?.length&&id?{id,points:points.map(p=>[p[0],p[1]] as const),mode}:null;
        this.redraw();
    }

    /** Takes ownership of the preview canvas; previous previews are released immediately. */
    previewComposite(canvas: HTMLCanvasElement | null, redraw = true): void {
        if (this.compositePreview) { this.compositePreview.canvas.width = 1; this.compositePreview.canvas.height = 1; }
        const id = this.workspace.activeId;
        this.compositePreview = canvas && id ? { id, canvas } : null;
        if(redraw)this.redraw();
    }

    redraw(): void {
        if (this.disposed) return;
        const box = this.container.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return;
        const ratio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(box.width * ratio)), height = Math.max(1, Math.round(box.height * ratio));
        if (this.canvas.width !== width) this.canvas.width = width;
        if (this.canvas.height !== height) this.canvas.height = height;
        const context = this.canvas.getContext('2d')!;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, box.width, box.height);
        context.fillStyle = '#e5e7eb'; context.fillRect(0, 0, box.width, box.height);
        const image = this.workspace.document;
        if (!image) return;
        let view = this.workspace.viewport;
        if (!view) {
            view = fitViewport({ width: image.canvas.getWidth(), height: image.canvas.getHeight() }, { width: box.width, height: box.height }, ratio);
            this.workspace.setViewport(view);
        } else if (view.pixelRatio !== ratio) {
            view = changePixelRatio(view, ratio, { x: box.width / 2, y: box.height / 2 });
            this.workspace.setViewport(view);
        }
        const scale = view.zoom / ratio;
        const documentWidth = image.canvas.getWidth() * scale, documentHeight = image.canvas.getHeight() * scale;
        context.save();
        context.beginPath(); context.rect(view.x, view.y, documentWidth, documentHeight); context.clip();
        context.fillStyle = '#fff'; context.fillRect(view.x, view.y, documentWidth, documentHeight);
        // Screen-aligned tiles are a display aid, independent of document resolution.
        context.fillStyle = '#d1d5db';
        for (let y = Math.max(0, Math.floor(view.y / 8) * 8); y < Math.min(box.height, view.y + documentHeight); y += 8) {
            for (let x = Math.max(0, Math.floor(view.x / 8) * 8); x < Math.min(box.width, view.x + documentWidth); x += 8) {
                if ((Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0) context.fillRect(x, y, 8, 8);
            }
        }
        context.imageSmoothingEnabled = scale < 1;
        if (this.compositePreview && this.compositePreview.id !== this.workspace.activeId) {
            this.compositePreview.canvas.width = 1; this.compositePreview.canvas.height = 1; this.compositePreview = null;
        }
        context.drawImage(this.compositePreview?.canvas ?? image.getEditorDisplay(), view.x, view.y, documentWidth, documentHeight);
        if (this.showPixelGrid && view.zoom > 5) {
            context.beginPath();
            const firstX = Math.max(0, Math.ceil(-view.x / scale)), lastX = Math.min(image.canvas.getWidth(), Math.floor((box.width - view.x) / scale));
            const firstY = Math.max(0, Math.ceil(-view.y / scale)), lastY = Math.min(image.canvas.getHeight(), Math.floor((box.height - view.y) / scale));
            for (let x = firstX; x <= lastX; x++) { context.moveTo(view.x + x * scale, view.y); context.lineTo(view.x + x * scale, view.y + documentHeight); }
            for (let y = firstY; y <= lastY; y++) { context.moveTo(view.x, view.y + y * scale); context.lineTo(view.x + documentWidth, view.y + y * scale); }
            context.strokeStyle = 'rgba(128,128,128,0.5)'; context.lineWidth = 1 / ratio; context.stroke();
        }
        if (this.preview && this.preview.id !== this.workspace.activeId) this.preview = null;
        if(this.polygonPreview&&this.polygonPreview.id!==this.workspace.activeId)this.polygonPreview=null;
        const candidate = this.polygonPreview?.mode==='replace'?undefined:this.preview?.region ?? image.canvas.getSelection();
        const selection = candidate ? selectionWithinCanvas(candidate, image.canvas.getWidth(), image.canvas.getHeight()) : undefined;
        if (this.showEdges && selection?.length) {
            context.translate(view.x, view.y); context.scale(scale, scale);
            const path = getSelectionPath2d(selection);
            context.lineWidth = 1 / scale;
            context.strokeStyle = '#fff'; context.stroke(path);
            context.setLineDash([4 / scale, 4 / scale]);
            context.strokeStyle = '#111'; context.stroke(path);
        }
        context.restore();
        if(this.polygonPreview){
            context.save();context.beginPath();
            this.polygonPreview.points.forEach(([x,y],index)=>index===0?context.moveTo(view!.x+x*scale,view!.y+y*scale):context.lineTo(view!.x+x*scale,view!.y+y*scale));
            context.lineWidth=2.5;context.strokeStyle='#fff';context.stroke();
            context.lineWidth=1;context.strokeStyle='#111';context.stroke();context.restore();
            const points = this.polygonPreview.points;
            if (points.length >= 3) {
                // A display-only return edge: never close or commit the actual draft path here.
                const first = points[0]!, last = points[points.length - 1]!;
                context.save(); context.beginPath();
                context.moveTo(view.x + last[0] * scale, view.y + last[1] * scale);
                context.lineTo(view.x + first[0] * scale, view.y + first[1] * scale);
                context.setLineDash([5, 4]);
                context.lineWidth = 3.5; context.strokeStyle = '#fff'; context.stroke();
                context.lineWidth = 1.5; context.strokeStyle = '#1683d8'; context.stroke();
                context.restore();
            }
        }
        if (this.controlBox) {
            const {bounds,matrix,kind} = this.controlBox;
            const screen = (x:number,y:number) => { const p = applyKlecksTransform(matrix,{x,y}); return {x:view!.x+p.x*scale,y:view!.y+p.y*scale}; };
            const points = ['nw','ne','se','sw'].map(handle => { const p = boxHandlePoint(bounds,handle as 'nw'); return screen(p.x,p.y); });
            if (kind === 'crop') {
                const [a,,c] = points;
                context.fillStyle='rgba(0,0,0,0.5)'; context.beginPath(); context.rect(0,0,box.width,box.height); context.rect(a.x,a.y,c.x-a.x,c.y-a.y); context.fill('evenodd');
                context.strokeStyle='rgba(255,255,255,0.65)';context.lineWidth=1;
                for(let i=1;i<3;i++) { context.beginPath();context.moveTo(a.x+(c.x-a.x)*i/3,a.y);context.lineTo(a.x+(c.x-a.x)*i/3,c.y);context.moveTo(a.x,a.y+(c.y-a.y)*i/3);context.lineTo(c.x,a.y+(c.y-a.y)*i/3);context.stroke(); }
            }
            context.beginPath();points.forEach((p,i)=>i===0?context.moveTo(p.x,p.y):context.lineTo(p.x,p.y));context.closePath();
            context.strokeStyle='#111';context.lineWidth=2;context.stroke();context.strokeStyle='#fff';context.lineWidth=1;context.stroke();
            for(const handle of BOX_HANDLES) { const p=boxHandlePoint(bounds,handle),s=screen(p.x,p.y); context.fillStyle='#fff';context.fillRect(s.x-3,s.y-3,6,6);context.strokeStyle='#111';context.strokeRect(s.x-3,s.y-3,6,6); }
        }
        if (this.zoomRect) {
            const rect = this.zoomRect;
            context.setLineDash([4, 4]); context.strokeStyle = '#111'; context.lineWidth = 1;
            context.strokeRect(rect.left, rect.top, rect.width, rect.height); context.setLineDash([]);
        }
    }

    destroy(): void {
        if (this.disposed) return;
        this.disposed = true; this.resize.disconnect(); this.canvas.remove();
        this.preview = null;
        this.polygonPreview=null;
        if (this.compositePreview) { this.compositePreview.canvas.width = 1; this.compositePreview.canvas.height = 1; this.compositePreview = null; }
        this.canvas.width = 1; this.canvas.height = 1;
    }
}
