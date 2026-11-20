import { clearSelectionMaskCache, selectionMask, selectionMaskWorkBytes } from './selection-mask';
import type { DesignSelectionCoverage, SelectionOutline } from '../../../../src/shared/patent/design-selection-coverage';

const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const rectangle = (width: number, height: number): SelectionOutline => [[[[0, 0], [width, 0], [width, height], [0, height], [0, 0]]]];
const alpha = (canvas: HTMLCanvasElement): number[] => Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data).filter((_, i) => i % 4 === 3);
const release = (canvas: HTMLCanvasElement | null) => { if (canvas) canvas.width = canvas.height = 0; };

export function verifySelectionMaskCache() {
    const original = CanvasRenderingContext2D.prototype.getImageData;
    let reads = 0;
    CanvasRenderingContext2D.prototype.getImageData = function (...args: Parameters<typeof original>) { reads++; return original.apply(this, args); };
    try {
        const raster: DesignSelectionCoverage = { kind: 'raster', width: 4, height: 1, runs: [1, 64, 1, 128, 1, 200, 1, 255] };
        const shape: DesignSelectionCoverage = { kind: 'shape', value: rectangle(2, 1), feather: 0, antiAlias: false };
        const coverage: DesignSelectionCoverage = { kind: 'add', left: raster, right: shape };
        const selection = { value: rectangle(4, 1), coverage };
        const first = selectionMask(4, 1, selection)!;
        check(alpha(first).join() === '255,255,200,255', 'Initial max coverage changed');
        release(first);
        reads = 0;
        const second = selectionMask(4, 1, structuredClone(selection))!;
        check(reads === 0, 'Warm equivalent coverage rebuilt pixel operands');
        check(alpha(second).join() === '255,255,200,255', 'Caller disposal corrupted cached mask');
        second.getContext('2d')!.clearRect(0, 0, 4, 1); release(second);
        const third = selectionMask(4, 1, selection)!;
        check(alpha(third).join() === '255,255,200,255', 'Caller painting corrupted cached mask'); release(third);
        check(selectionMaskWorkBytes(4, 1, selection) === 4 * 4 * (3 * 3 + 1), 'Cache bytes missing or multiple history masks retained');
        reads = 0;
        const extended = selectionMask(4, 1, { value: [], coverage: { kind: 'add', left: coverage, right: { ...shape, antiAlias: true } } })!;
        check(reads === 2, 'Incremental selection recomputed the previously cached branch');
        check(alpha(extended).join() === '255,255,200,255', 'Incremental branch reuse changed coverage'); release(extended);
        raster.runs[1] = 32;
        shape.value = rectangle(1, 1);
        const changed = selectionMask(4, 1, selection)!;
        check(alpha(changed).join() === '255,128,200,255', 'In-place value mutation reused stale cache'); release(changed);
        const narrow = selectionMask(2, 1, selection)!;
        check(alpha(narrow).join() === '255,128', 'Different document dimensions reused stale cache'); release(narrow);
        check(selectionMaskWorkBytes(2, 1, selection) === 2 * 4 * (3 * 3 + 1), 'Replaced canvas remained accounted/retained');
        clearSelectionMaskCache();
        check(selectionMaskWorkBytes(2, 1, selection) === 2 * 4 * 3 * 3, 'Document teardown did not release cache');
        const restored = selectionMask(4, 1, { value: rectangle(4, 1), coverage: { kind: 'subtract', left: coverage, right: { kind: 'raster', width: 4, height: 1, runs: [4, 100] } } })!;
        check(alpha(restored).join() === '155,28,100,155', 'Incremental subtraction changed soft alpha'); release(restored);
        const intersect = selectionMask(4, 1, { value: [], coverage: { kind: 'intersect', left: coverage, right: { kind: 'raster', width: 4, height: 1, runs: [4, 150] } } })!;
        check(alpha(intersect).join() === '150,128,150,150', 'Intersection changed soft alpha'); release(intersect);
        const inverse = selectionMask(4, 1, { value: [], coverage: { kind: 'invert', source: coverage } })!;
        check(alpha(inverse).join() === '0,127,55,0', 'Inversion changed soft alpha'); release(inverse);
        const transformed = selectionMask(5, 1, { value: [], coverage: { kind: 'transform', source: coverage, width: 4, height: 1, matrix: { a: 1, b: 0, c: 0, d: 1, e: 1, f: 0 } } })!;
        check(alpha(transformed).join() === '0,255,128,200,255', 'Transform source size or translation changed'); release(transformed);
        const smooth: DesignSelectionCoverage = { kind: 'shape', value: rectangle(2, 1), feather: 1, antiAlias: true };
        const soft = selectionMask(4, 3, { value: [], coverage: smooth })!;
        const before = alpha(soft).join(); release(soft);
        smooth.feather = 0; smooth.antiAlias = false;
        const hard = selectionMask(4, 3, { value: [], coverage: smooth })!;
        check(alpha(hard).join() !== before, 'Feather/AA change reused stale cache'); release(hard);
        smooth.value = rectangle(1.5, 1); smooth.antiAlias = true;
        const antialiased = selectionMask(4, 3, { value: [], coverage: smooth })!;
        const fractional = alpha(antialiased).join(); release(antialiased);
        smooth.antiAlias = false;
        const thresholded = selectionMask(4, 3, { value: [], coverage: smooth })!;
        check(alpha(thresholded).join() !== fractional, 'AA-only change reused stale cache'); release(thresholded);
        release(selectionMask(4, 3, { value: undefined }));
        check(selectionMaskWorkBytes(4, 3, { value: undefined }) === 0, 'Deselection retained cache canvas');
        let rejected = false;
        try { selectionMask(4, 1, { value: [], coverage: { ...raster, runs: [5, 255] } }); } catch { rejected = true; }
        check(rejected, 'Invalid coverage bypassed limits');
        const oversized = { value: [], coverage: { kind: 'raster' as const, width: 4097, height: 4096, runs: [4097 * 4096, 100] } };
        release(selectionMask(4097, 4096, oversized));
        check(selectionMaskWorkBytes(1, 1, { value: undefined }) === 0, 'Mask above 64MiB stayed cached');
    } finally { CanvasRenderingContext2D.prototype.getImageData = original; clearSelectionMaskCache(); }
}

export function measureSelectionMaskCache() {
    const width = 4096, height = 3072;
    const coverage: DesignSelectionCoverage = { kind: 'add', left: { kind: 'raster', width, height, runs: [width * height, 100] }, right: { kind: 'shape', value: rectangle(2000, 1500), feather: 0, antiAlias: true } };
    const selection = { value: rectangle(width, height), coverage };
    // A read forces canvas rendering before timing ends (rather than timing only queued drawImage).
    const consume = (canvas: HTMLCanvasElement | null) => { canvas?.getContext('2d')!.getImageData(0, 0, 1, 1); release(canvas); };
    const run = () => { const start = performance.now(); consume(selectionMask(width, height, selection)); return performance.now() - start; };
    const cold = run(), warm = [run(), run(), run()];
    const incremental = performance.now();
    consume(selectionMask(width, height, { value: [], coverage: { kind: 'subtract', left: coverage, right: { kind: 'shape', value: rectangle(100, 100), feather: 0, antiAlias: true } } }));
    const incrementMs = performance.now() - incremental;
    release(selectionMask(width, height, { value: undefined }));
    const rectangleMs = runSimpleMask();
    return { width, height, coldMs: cold, warmMs: warm, incrementMs, rectangleMs };
}

function runSimpleMask() {
    const start = performance.now();
    release(selectionMask(4096, 3072, { value: rectangle(2000, 1500) }));
    return performance.now() - start;
}
