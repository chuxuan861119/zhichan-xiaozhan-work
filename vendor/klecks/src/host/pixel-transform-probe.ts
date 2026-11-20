import { klecksTransformMatrix } from '../../../../src/renderer/src/design-patent/correction/klecks-transform';
import { transformPixelCanvas } from './pixel-transform';

// Development-only pixel assertions; never import from production entry points.
export function verifyPixelTransforms(): void {
    const affineSource = document.createElement('canvas'); affineSource.width = 4; affineSource.height = 2;
    const affineContext = affineSource.getContext('2d')!;
    affineContext.fillStyle = 'red'; affineContext.fillRect(0, 0, 1, 1);
    affineContext.fillStyle = 'blue'; affineContext.fillRect(3, 1, 1, 1);
    affineContext.fillStyle = 'rgba(0,255,0,0.5)'; affineContext.fillRect(1, 0, 1, 1);
    const affineOriginal = Array.from(affineContext.getImageData(0, 0, 4, 2).data);
    const affineBounds = { left: 0, top: 0, width: 4, height: 2 };
    const turned = transformPixelCanvas(affineSource, { x: 0, y: 0 }, klecksTransformMatrix(affineBounds, { dx: 0, dy: 0, scaleX: 1, scaleY: 1, angle: 90 }));
    if (!turned || turned.x !== 1 || turned.y !== -1 || turned.canvas.width !== 2 || turned.canvas.height !== 4 ||
        turned.canvas.getContext('2d')!.getImageData(1, 0, 1, 1).data[0] !== 255 || turned.canvas.getContext('2d')!.getImageData(0, 3, 1, 1).data[2] !== 255 ||
        turned.canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data[3] !== 0 || turned.canvas.getContext('2d')!.getImageData(1, 1, 1, 1).data[3] !== affineOriginal[7]) throw new Error('Affine pixel rotation changed size, color or transparency');
    turned.canvas.width = 0; turned.canvas.height = 0;
    const outside = transformPixelCanvas(affineSource, { x: -5, y: -2 }, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    if (!outside || outside.x !== -5 || outside.y !== -2 || JSON.stringify(Array.from(outside.canvas.getContext('2d')!.getImageData(0, 0, 4, 2).data)) !== JSON.stringify(affineOriginal))
        throw new Error('Affine transform clipped preserved off-canvas pixels');
    outside.canvas.width = 0; outside.canvas.height = 0;
    const flipped = transformPixelCanvas(affineSource, { x: 0, y: 0 }, klecksTransformMatrix(affineBounds, { dx: 0, dy: 0, scaleX: -1, scaleY: 1, angle: 0 }));
    if (!flipped || flipped.canvas.getContext('2d')!.getImageData(3, 0, 1, 1).data[0] !== 255 || flipped.canvas.getContext('2d')!.getImageData(0, 1, 1, 1).data[2] !== 255)
        throw new Error('Affine reflection lost source pixels');
    flipped.canvas.width = 0; flipped.canvas.height = 0;
    if (JSON.stringify(Array.from(affineContext.getImageData(0, 0, 4, 2).data)) !== JSON.stringify(affineOriginal)) throw new Error('Transform preview mutated source pixels');
    const affineEmpty = document.createElement('canvas'); affineEmpty.width = 4; affineEmpty.height = 2;
    if (transformPixelCanvas(affineEmpty, { x: 0, y: 0 }, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) !== null) throw new Error('Empty transform created content');
    const bandSource = document.createElement('canvas'); bandSource.width = 1; bandSource.height = 257;
    bandSource.getContext('2d')!.fillStyle = 'red'; bandSource.getContext('2d')!.fillRect(0, 256, 1, 1);
    const bandOutput = transformPixelCanvas(bandSource, { x: 0, y: 0 }, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    if (!bandOutput || bandOutput.y !== 254 || bandOutput.canvas.height !== 3 || bandOutput.canvas.getContext('2d')!.getImageData(0, 2, 1, 1).data[3] !== 255)
        throw new Error('Banded alpha scanning lost pixels after the first band');
    bandOutput.canvas.width = 0; bandOutput.canvas.height = 0; bandSource.width = 0; bandSource.height = 0;
    let oversizedRejected = false;
    try { transformPixelCanvas(affineSource, { x: 0, y: 0 }, { a: 3000, b: 0, c: 0, d: 3000, e: 0, f: 0 }); } catch { oversizedRejected = true; }
    if (!oversizedRejected || JSON.stringify(Array.from(affineContext.getImageData(0, 0, 4, 2).data)) !== JSON.stringify(affineOriginal))
        throw new Error('Oversized transform changed the source or was admitted');
    affineSource.width = 0; affineSource.height = 0; affineEmpty.width = 0; affineEmpty.height = 0;
}
