import { HostDocument } from './host-document';
import { RetouchStroke } from './retouch-stroke';
import { encodeSelectionRaster } from '../../../../src/shared/patent/design-selection-raster';

export async function verifyStrokeRegions() {
    const image = document.createElement('canvas'); image.width = 530; image.height = 330;
    const ctx = image.getContext('2d')!;
    for (let x = 0; x < image.width; x += 9) { ctx.fillStyle = `rgba(${x % 256},40,170,0.7)`; ctx.fillRect(x, 0, 7, 300); }
    const make = () => new HostDocument({ projectId: 'region', width: image.width, height: image.height,
        layers: [{ name: 'Pixels', opacity: 1, isVisible: true, hasClipping: false, mixModeStr: 'source-over', image }] });
    const raw = (d: HostDocument) => (d.editingMask ? d.getEditorDisplay().getContext('2d')! : d.canvas.getLayer(0).context).getImageData(0, 0, image.width, image.height).data;
    const equal = (a: ArrayLike<number>, b: ArrayLike<number>, label: string) => {
        if (a.length !== b.length || Array.from(a).some((v, i) => v !== b[i])) throw Error(`Pixel mismatch: ${label}`);
    };
    let clips = 0;
    const originalClip = CanvasRenderingContext2D.prototype.clip;
    CanvasRenderingContext2D.prototype.clip = function (...args: any[]) { clips++; return (originalClip as any).apply(this, args); };
    try {
        for (const tool of ['brush', 'eraser', 'clone', 'blur'] as const) for (const locked of [false, true]) for (const mode of ['plain', 'feather', 'mask']) {
            if (mode === 'mask' && (locked || tool === 'clone' || tool === 'blur')) continue;
            const actual = make(), reference = make();
            try {
                // Freeze the previous full-frame preview algorithm as a pixel oracle.
                (reference as any).refreshStroke = function () {
                    const s = this.strokeComposite; if (!s) return;
                    const m = s.masked.getContext('2d'); m.globalCompositeOperation = 'copy'; m.drawImage(s.paint, 0, 0);
                    if (s.mask) { m.globalCompositeOperation = 'destination-in'; m.drawImage(s.mask, 0, 0); }
                    const c = this.masks.paint?.canvas.getContext('2d') ?? this.canvas.getLayer(this.layerIndex(s.layerId)).context;
                    c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'copy'; c.drawImage(s.base, 0, 0);
                    c.globalCompositeOperation = this.masks.paint ? 'destination-out' : s.erasing ? 'destination-out' : s.alphaLocked ? 'source-atop' : 'source-over';
                    c.globalAlpha = s.opacity; c.drawImage(s.masked, 0, 0);
                    if (this.masks.paint) { c.globalCompositeOperation = 'lighter'; c.globalAlpha = s.opacity * this.masks.gray; c.drawImage(s.masked, 0, 0); } c.restore();
                    this.pixelPreviewRevision = (this.pixelPreviewRevision ?? 0) + 1;
                };
                for (const doc of [actual, reference]) {
                    doc.setLayerLocks(doc.canvas.getLayer(0).id, { alpha: locked });
                    if (mode === 'mask') {
                        doc.layerMask(doc.canvas.getLayer(0).id, 'add');
                        doc.layerMask(doc.canvas.getLayer(0).id, 'target');
                    }
                    const coverage = mode === 'feather' ? encodeSelectionRaster(image.width, image.height,
                        Uint8Array.from({ length: image.width * image.height }, (_, i) => i % image.width < 300 ? 128 : 0)) : undefined;
                    doc.select([[[[0, 0], [300, 0], [300, 315], [0, 315], [0, 0]]]], 'replace', coverage ? { coverage } : undefined);
                }
                const points = [[1.3, 2.8, 1], [250.5, 130.5, 1], [270, 140, 1], [252, 131, 1], [535, 325, 1]] as const;
                const brush = { tool: tool === 'eraser' ? 'eraser' as const : 'brush' as const, size: 25, opacity: .63, flow: .42, hardness: .4, color: { r: 5, g: 190, b: 40 } };
                const retouch = { tool: tool === 'blur' ? 'blur' as const : 'clone' as const, size: 25, opacity: .63, flow: .42, hardness: .4, strength: .55, offset: { x: -17, y: 5 }, merged: false };
                const isBrush = tool === 'brush' || tool === 'eraser';
                const originalClone = (RetouchStroke.prototype as any).refreshClone;
                for (let i = 0; i < points.length; i++) {
                    for (const doc of [actual, reference]) {
                        if (doc === reference) (RetouchStroke.prototype as any).refreshClone = function () {
                            const m = this.masked; if (m.width !== this.paint.width || m.height !== this.paint.height) { m.width = this.paint.width; m.height = this.paint.height; }
                            const c = m.getContext('2d'); c.globalCompositeOperation = 'copy'; c.drawImage(this.paint, 0, 0);
                            if (this.mask) { c.globalCompositeOperation = 'destination-in'; c.drawImage(this.mask, 0, 0); }
                            const t = this.target.getContext('2d'); t.save(); t.globalAlpha = 1; t.globalCompositeOperation = 'copy'; t.drawImage(this.base, 0, 0);
                            t.globalCompositeOperation = this.alphaLocked ? 'source-atop' : 'source-over'; t.globalAlpha = this.options.opacity; t.drawImage(m, 0, 0); t.restore();
                        };
                        try { if (isBrush) i ? doc.moveStroke(points[i]) : doc.beginStroke(points[i], brush); else i ? doc.moveRetouch(points[i]) : doc.beginRetouch(points[i], retouch); }
                        finally { (RetouchStroke.prototype as any).refreshClone = originalClone; }
                    }
                    equal(raw(actual), raw(reference), `${tool} ${mode} lock=${locked} move=${i}`);
                }
                for (const doc of [actual, reference]) isBrush ? doc.endStroke() : doc.endRetouch();
                equal(raw(actual), raw(reference), `${tool} end`);
                const after = raw(actual).slice(); actual.undo(); actual.redo(); equal(raw(actual), after, `${tool} redo`);
                for (const doc of [actual, reference]) {
                    isBrush ? doc.beginStroke(points[0], brush) : doc.beginRetouch(points[0], retouch);
                    isBrush ? doc.cancelStroke() : doc.cancelRetouch();
                }
                equal(raw(actual), raw(reference), `${tool} cancel`);
            } finally { actual.destroy(); reference.destroy(); }
        }
        if (!clips) throw Error('Stroke previews never clip dirty regions');
    } finally { CanvasRenderingContext2D.prototype.clip = originalClip; image.width = image.height = 0; }
    return { clips };
}

/** Same Canvas algorithm, with its dirty clip disabled to reproduce the old full-frame work. */
export async function measureStrokeRegions() {
    const results: Record<string, unknown>[] = [];
    const originalClip = CanvasRenderingContext2D.prototype.clip;
    const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
    for (const tool of ['brush', 'eraser', 'clone', 'blur'] as const) for (const fullFrame of [true, false]) {
        const image = document.createElement('canvas'); image.width = 4000; image.height = 3000;
        const c = image.getContext('2d')!; c.fillStyle = 'white'; c.fillRect(0, 0, 4000, 3000);
        c.fillStyle = 'black'; c.fillRect(1400, 1400, 125, 300);
        const doc = new HostDocument({ projectId: 'perf', width: 4000, height: 3000,
            layers: [{ name: '12MP', opacity: 1, isVisible: true, hasClipping: false, mixModeStr: 'source-over', image }] });
        const samples: { begin: number; moves: number; end: number }[] = [];
        if (fullFrame) {
            CanvasRenderingContext2D.prototype.clip = function () {};
            CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
                const source = args[0];
                if (args.length === 9 && source.width === 4000 && source.height === 3000 && args[1] === args[5] && args[2] === args[6])
                    return originalDraw.call(this, source, 0, 0);
                return (originalDraw as any).apply(this, args);
            };
        }
        try {
            for (let run = 0; run < 4; run++) {
                const isBrush = tool === 'brush' || tool === 'eraser';
                const options = { tool, size: 24, opacity: .7, flow: .5, hardness: .5, color: { r: 10, g: 100, b: 40 }, strength: .5, offset: { x: -100, y: 0 }, merged: false };
                const a = performance.now();
                if (isBrush) doc.beginStroke([1520, 1500, 1], { ...options, tool }); else doc.beginRetouch([1520, 1500, 1], { ...options, tool });
                const b = performance.now();
                for (let i = 1; i <= 4; i++) if (isBrush) doc.moveStroke([1520 + i * 5, 1500 + i * 3, 1]); else doc.moveRetouch([1520 + i * 5, 1500 + i * 3, 1]);
                const d = performance.now();
                if (isBrush) doc.endStroke(); else doc.endRetouch();
                const e = performance.now();
                if (run) samples.push({ begin: b - a, moves: d - b, end: e - d });
                doc.undo();
            }
            const median = (key: keyof typeof samples[number]) => samples.map(v => v[key]).sort((a, b) => a - b)[1];
            results.push({ tool, fullFrame, begin: median('begin'), moves: median('moves'), end: median('end') });
        } finally { CanvasRenderingContext2D.prototype.clip = originalClip; CanvasRenderingContext2D.prototype.drawImage = originalDraw; doc.destroy(); image.width = image.height = 0; }
    }
    return results;
}
