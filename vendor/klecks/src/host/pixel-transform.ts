import { invertKlecksTransform, klecksTransformPixelBounds, type KlecksTransformMatrix, type KlecksTransformBounds } from '../../../../src/renderer/src/design-patent/correction/klecks-transform';

export type TransformedPixels = { canvas: HTMLCanvasElement; x: number; y: number };
export function opaquePixelBounds(source: HTMLCanvasElement): KlecksTransformBounds | null {
    const width = source.width, height = source.height;
    if (width < 1 || height < 1 || width > 10000 || height > 10000 || width * height > 40000000) throw new Error('Invalid pixel bounds dimensions');
    const input = source.getContext('2d')!;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let top = 0; top < height; top += 128) {
        const rows = Math.min(128, height-top), pixels = input.getImageData(0,top,width,rows).data;
        for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) {
            if (!pixels[(y*width+x)*4+3]) continue;
            minX=Math.min(minX,x);minY=Math.min(minY,top+y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,top+y);
        }
    }
    return maxX<minX ? null : {left:minX,top:minY,width:maxX-minX+1,height:maxY-minY+1};
}
/** New owned raster only; caller retains the original and must admit its memory reservation first. */
export function transformPixelCanvas(source: HTMLCanvasElement, origin: { x: number; y: number }, matrix: KlecksTransformMatrix, admitBounds?: (bounds: KlecksTransformBounds) => void): TransformedPixels | null {
    const width = source.width, height = source.height;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 10000 || height > 10000 || width * height > 40000000 ||
        !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) throw new Error('Invalid transform source dimensions or origin');
    invertKlecksTransform(matrix); // Fail before reading pixels when the transform cannot be hit-tested.
    const input = source.getContext('2d');
    if (!input) throw new Error('Transform source context unavailable');
    let minX = width, minY = height, maxX = -1, maxY = -1;
    // Bound temporary alpha scanning to a small band rather than copying a full 40MP ImageData.
    for (let top = 0; top < height; top += 128) {
        const rows = Math.min(128, height - top), pixels = input.getImageData(0, top, width, rows).data;
        for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) {
            if (pixels[(y * width + x) * 4 + 3] === 0) continue;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, top + y); maxY = Math.max(maxY, top + y);
        }
    }
    if (maxX < minX || maxY < minY) return null;
    // Retain transparent neighboring samples for resampling at non-opaque edges.
    minX = Math.max(0, minX - 2); minY = Math.max(0, minY - 2);
    maxX = Math.min(width - 1, maxX + 2); maxY = Math.min(height - 1, maxY + 2);
    const bounds = klecksTransformPixelBounds({ left: origin.x + minX, top: origin.y + minY, width: maxX - minX + 1, height: maxY - minY + 1 }, matrix);
    admitBounds?.(bounds);
    const output = document.createElement('canvas'); output.width = bounds.width; output.height = bounds.height;
    try {
        const context = output.getContext('2d');
        if (!context) throw new Error('Transform output context unavailable');
        // Signed unit-axis permutations map pixel centers exactly: mirrors, quarter
        // turns and integer translations need no resampling. Keep smooth sampling
        // for genuine scaling, rotation or subpixel positioning.
        const pixelAligned = [matrix.a,matrix.b,matrix.c,matrix.d].every(value=>value===-1||value===0||value===1) &&
            Math.abs(matrix.a)+Math.abs(matrix.c)===1 && Math.abs(matrix.b)+Math.abs(matrix.d)===1 &&
            Math.abs(matrix.a)+Math.abs(matrix.b)===1 && Math.abs(matrix.c)+Math.abs(matrix.d)===1 &&
            [matrix.e,matrix.f,origin.x,origin.y].every(Number.isInteger);
        context.imageSmoothingEnabled = !pixelAligned; context.imageSmoothingQuality = 'high';
        context.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - bounds.left, matrix.f - bounds.top);
        context.drawImage(source, origin.x, origin.y);
        return { canvas: output, x: bounds.left, y: bounds.top };
    } catch (error) {
        output.width = 0; output.height = 0; throw error;
    }
}
