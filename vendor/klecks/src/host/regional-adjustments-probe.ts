import { HostDocument } from './host-document';
import { DEFAULT_FILL } from '../../../../src/shared/settings/design-fill';
import { DEFAULT_TONE } from '../../../../src/shared/settings/design-tone';

export async function verifyRegionalAdjustments() {
    await verifyRegionalReferencePixels();
    await verifyHistogramCache();
    const source = document.createElement('canvas');
    source.width = 4096; source.height = 3072;
    const context = source.getContext('2d')!;
    const gradient = context.createLinearGradient(0, 0, source.width, source.height);
    gradient.addColorStop(0, '#123456'); gradient.addColorStop(1, '#bcd2f0');
    context.fillStyle = gradient; context.fillRect(0, 0, source.width, source.height);
    const image = new HostDocument({ projectId:'regional',width:source.width,height:source.height,
        layers:[0,1].map(i=>({name:'layer'+i,opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over' as const,image:source})) });
    const selection = [[[[100,100],[300,100],[300,300],[100,300],[100,100]]]];
    const reports: Record<string,number> = {};
    try {
        image.select(selection, 'replace');
        const before = image.contentIdentity(),pixels=()=>image.canvas.getLayer(1).context.getImageData(150,150,1,1).data.join(',');
        const oldPixel=pixels();
        const capture=image.capture;
        image.capture=()=>{throw new Error('Pixel adjustment must not deep-copy history for a scalar counter');};
        let clock=performance.now();
        const result=await image.tonePixels({...DEFAULT_TONE,gamma:1.5},undefined,false);
        reports.smallToneMs=Math.round(performance.now()-clock);
        if(!result.changed||image.contentIdentity()!==before)throw new Error('Tone preview changed the live document');
        const outside=result.canvas.getContext('2d')!.getImageData(1,1,1,1).data;
        if(outside.join(',')!==source.getContext('2d')!.getImageData(1,1,1,1).data.join(','))throw new Error('Preview changed unselected pixels');
        result.canvas.width=result.canvas.height=0;
        clock=performance.now();
        await image.fillPixels({r:1,g:2,b:3},DEFAULT_FILL);
        reports.smallFillMs=Math.round(performance.now()-clock);
        const after=image.contentIdentity();
        if(after===before||pixels()===oldPixel)throw new Error('Small fill was not applied');
        image.undo();if(image.contentIdentity()!==before||pixels()!==oldPixel)throw new Error('Fill undo lost original pixels');
        image.redo();if(image.contentIdentity()!==after)throw new Error('Fill redo changed the prepared revision');
        image.capture=capture;
        const base=image.history.getRetainedPixelBytes();
        if(base>110*1024**2)throw new Error('Small fill duplicated a full-resolution layer in history');
        reports.retainedHistoryBytes=base;
        const aborted=new AbortController();aborted.abort();
        try{await image.fillPixels({r:9,g:8,b:7},DEFAULT_FILL,aborted.signal);throw new Error('Cancellation was ignored');}
        catch(e){if(!(e instanceof DOMException&&e.name==='AbortError'))throw e;}
        if(image.contentIdentity()!==after)throw new Error('Cancelled fill changed the image');
        const cancelIdentity=image.contentIdentity();
        image.setHistoryPolicy({maxUndoSteps:100,maxEstimatedBytes:1});
        let rejected=false;
        try{await image.fillPixels({r:19,g:18,b:17},DEFAULT_FILL);}catch{rejected=true;}
        if(!rejected||image.contentIdentity()!==cancelIdentity)throw new Error('Failed history admission changed pixels');
        return reports;
    } finally {image.destroy();source.width=source.height=0;}
}

/** Keep the old full-strip canvas roundtrip as a byte-level oracle, including low alpha. */
export async function verifyRegionalReferencePixels() {
    const { selectionMask } = await import('./selection-mask');
    const { tonePixel } = await import('../../../../src/shared/settings/design-tone');
    const { fillPixel } = await import('../../../../src/renderer/src/design-patent/correction/klecks-fill');
    const { getPushableLayerChange } = await import('../app/script/klecks/history/push-helpers/get-pushable-layer-change');
    const width = 541, height = 333, source = document.createElement('canvas');
    source.width = width; source.height = height;
    const data = source.getContext('2d')!.createImageData(width, height);
    let seed = 17;
    for (let i = 0; i < data.data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0; data.data[i] = seed >>> 24;
    }
    source.getContext('2d')!.putImageData(data, 0, 0);
    const make = () => new HostDocument({ projectId: 'region-reference', width, height,
        layers: [{ name: 'RGBA', opacity: 1, isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: source }] });
    const equal = (a: ArrayLike<number>, b: ArrayLike<number>, label: string) => {
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw Error(`${label} byte/bin ${i}: ${a[i]} vs ${b[i]}`);
    };
    try {
        for (const mode of ['AA', 'hard', 'feather', 'coverage']) for (const operation of ['fill', 'tone']) {
            const actual = make(), reference = make(), output = document.createElement('canvas');
            output.width = width; output.height = height;
            let mask: HTMLCanvasElement | null = null;
            try {
                const selection = [[[[243.3, 237.7], [291.4, 249.3], [270.8, 315.2], [243.3, 237.7]]]];
                const options = mode === 'coverage' ? { coverage: { kind: 'raster' as const, width, height, runs: [width * height, 128] } }
                    : mode === 'feather' ? { feather: 3 } : { antiAlias: mode !== 'hard' };
                for (const doc of [actual, reference]) doc.select(selection, 'replace', options);
                mask = selectionMask(width, height, reference.history.getComposed().selection);
                const histogram = Array<number>(256).fill(0), context = output.getContext('2d')!;
                const tone = { ...DEFAULT_TONE, gamma: 1.7, channel: 'g' as const }, color = { r: 17, g: 195, b: 43 };
                const fill = { ...DEFAULT_FILL, opacity: 37 };
                const strip = operation === 'tone' ? 16 : 32;
                const renderReference = () => {
                histogram.fill(0);
                for (let y = 0; y < height; y += strip) {
                    const rows = Math.min(strip, height - y), pixels = reference.canvas.getLayer(0).context.getImageData(0, y, width, rows);
                    const coverage = mask?.getContext('2d')!.getImageData(0, y, width, rows).data;
                    for (let p = 0; p < pixels.data.length; p += 4) {
                        const amount = coverage ? coverage[p + 3]! / 255 : 1;
                        if (!amount) continue;
                        const old = Array.from(pixels.data.subarray(p, p + 4));
                        if (operation === 'fill') pixels.data.set(fillPixel(old, color, amount * fill.opacity / 100, fill.blend, false), p);
                        else if (old[3]) {
                            histogram[old[1]!]! += amount * old[3]! / 255;
                            const next = tonePixel(old, tone);
                            for (let k = 0; k < 3; k++) pixels.data[p + k] = Math.round(old[k]! + (next[k]! - old[k]!) * amount);
                        }
                    }
                    context.putImageData(pixels, 0, y);
                }
                };
                renderReference();
                if (operation === 'fill') await actual.fillPixels(color, fill);
                else {
                    const preview = await actual.tonePixels(tone, undefined, false);
                    try {
                        equal(preview.histogram, histogram, `${mode} histogram`);
                        equal(preview.canvas.getContext('2d')!.getImageData(0, 0, width, height).data, context.getImageData(0, 0, width, height).data, `${mode} preview`);
                    } finally { preview.canvas.width = preview.canvas.height = 0; }
                    // Match preview then apply: the first read can migrate a GPU canvas to CPU.
                    renderReference();
                    const committed = await actual.tonePixels(tone); committed.canvas.width = committed.canvas.height = 0;
                }
                // Match the old output -> full history tiles -> live layer canonicalization.
                const before = reference.history.getComposed();
                reference.history.push(getPushableLayerChange(before, output));
                reference.canvas.updateViaComposed(before, reference.history.getComposed());
                const read = (doc: HostDocument) => doc.canvas.getLayer(0).context.getImageData(0, 0, width, height).data;
                equal(read(actual), read(reference), `${mode} ${operation} committed`);
                actual.undo(); reference.undo(); equal(read(actual), read(reference), `${mode} ${operation} undo`);
                actual.redo(); reference.redo(); equal(read(actual), read(reference), `${mode} ${operation} redo`);
            } finally { actual.destroy(); reference.destroy(); output.width = output.height = 0; if (mask) mask.width = mask.height = 0; }
        }
    } finally { source.width = source.height = 0; }
}

async function verifyHistogramCache(){
    const source=document.createElement('canvas');source.width=source.height=8;
    const context=source.getContext('2d')!;context.fillStyle='#202020';context.fillRect(0,0,8,8);
    const image=new HostDocument({projectId:'histogram-cache',width:8,height:8,layers:[{name:'dark',opacity:1,isVisible:true,hasClipping:false,mixModeStr:'source-over',image:source}]});
    try{
        const first=await image.tonePixels({...DEFAULT_TONE,gamma:1.5},undefined,false);
        first.histogram.fill(0);first.canvas.width=first.canvas.height=0;
        const second=await image.tonePixels({...DEFAULT_TONE,gamma:2},undefined,false);
        if(second.histogram[32]!==64)throw Error('Caller mutated cached histogram');
        second.canvas.width=second.canvas.height=0;
        const before=image.contentIdentity(),committed=await image.tonePixels({...DEFAULT_TONE,gamma:1.5});
        committed.canvas.width=committed.canvas.height=0;
        if(before===image.contentIdentity())throw Error('Tone did not commit');
        image.undo();if(before!==image.contentIdentity())throw Error('Tone undo changed original revision');
        const restored=await image.tonePixels({...DEFAULT_TONE,gamma:2},undefined,false);
        if(restored.histogram[32]!==64)throw Error('Undo reused stale histogram');
        restored.canvas.width=restored.canvas.height=0;
    }finally{image.destroy();source.width=source.height=0;}
}
