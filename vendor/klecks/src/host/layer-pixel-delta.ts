import type { THistoryEntryLayerTile } from '../app/script/klecks/history/history.types';
import { createImageDataTile, getTileSize } from '../app/script/klecks/history/image-data-tile';
import { HISTORY_TILE_SIZE } from '../app/script/klecks/history/kl-history';

type TileRect = { x: number; y: number; width: number; height: number };

function mapTiles<T>(
    canvas: HTMLCanvasElement,
    read: (rect: TileRect) => T,
): T[] {
    const tiles: T[] = [];
    for (let row = 0; row < Math.ceil(canvas.height / HISTORY_TILE_SIZE); row++) {
        for (let col = 0; col < Math.ceil(canvas.width / HISTORY_TILE_SIZE); col++) {
            tiles.push(read({
                x: col * HISTORY_TILE_SIZE,
                y: row * HISTORY_TILE_SIZE,
                ...getTileSize(col, row, canvas),
            }));
        }
    }
    return tiles;
}

const readTile = (ctx: CanvasRenderingContext2D, {x, y, width, height}: TileRect) =>
    ctx.getImageData(x, y, width, height);

function encodeTile(pixels: ImageData): THistoryEntryLayerTile {
    return pixels.data.some((value) => value !== 0) ? createImageDataTile(pixels) : { fill: 'transparent' };
}

function changedTile(before: ImageData, after: ImageData): THistoryEntryLayerTile | undefined {
    const words = ({ data }: ImageData) => new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    const old = words(before);
    const next = words(after);
    for (let i = 0; i < next.length; i++) {
        if (next[i] !== old[i]) return encodeTile(after);
    }
}

function hasCoverage({data}: ImageData): boolean {
    for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
    return false;
}

/** A tile array with undefined entries reuses pixels from the previous history state. */
export function layerPixelDelta(before: HTMLCanvasElement, after: HTMLCanvasElement) {
    const previous = before.getContext('2d')!;
    const next = after.getContext('2d')!;
    return mapTiles(before, (rect) => changedTile(readTile(previous, rect), readTile(next, rect)));
}

/** Clear only the covered pixels, preparing the delta before updating the live layer. */
export function clearedLayerTiles(
    source: HTMLCanvasElement,
    mask: HTMLCanvasElement | null,
    background: string | null,
) {
    const previous = source.getContext('2d')!;
    const maskContext = mask?.getContext('2d');
    const scratch = document.createElement('canvas');
    const fill = document.createElement('canvas');
    try {
        return mapTiles(source, (rect) => {
            const { x, y, width, height } = rect;
            // An empty mask tile cannot change pixels, even with feathering,
            // raster selections or combinations of several selection shapes.
            const coverage = maskContext && readTile(maskContext, rect);
            if (coverage && !hasCoverage(coverage)) return undefined;
            const before = readTile(previous, rect);
            scratch.width = width;
            scratch.height = height;
            const target = scratch.getContext('2d')!;
            target.putImageData(before, 0, 0);
            if (background) {
                if (mask) {
                    fill.width = width;
                    fill.height = height;
                    const overlay = fill.getContext('2d')!;
                    overlay.fillStyle = background;
                    overlay.fillRect(0, 0, width, height);
                    overlay.globalCompositeOperation = 'destination-in';
                    overlay.drawImage(mask, x, y, width, height, 0, 0, width, height);
                    target.drawImage(fill, 0, 0);
                } else {
                    target.fillStyle = background;
                    target.fillRect(0, 0, width, height);
                }
            } else if (mask) {
                target.globalCompositeOperation = 'destination-out';
                target.drawImage(mask, x, y, width, height, 0, 0, width, height);
            } else {
                target.clearRect(0, 0, width, height);
            }
            return changedTile(before, target.getImageData(0, 0, width, height));
        });
    } finally {
        scratch.width = scratch.height = fill.width = fill.height = 0;
    }
}

/** Backing is only authoritative outside the document; don't duplicate the visible plane. */
export function offCanvasBackingTiles(canvas: HTMLCanvasElement, visible: TileRect): THistoryEntryLayerTile[] {
    const ctx = canvas.getContext('2d')!;
    ctx.save();
    ctx.resetTransform();
    ctx.clearRect(visible.x, visible.y, visible.width, visible.height);
    ctx.restore();
    return mapTiles(canvas, (rect) =>
        rect.x >= visible.x && rect.y >= visible.y &&
        rect.x + rect.width <= visible.x + visible.width && rect.y + rect.height <= visible.y + visible.height
            ? { fill: 'transparent' }
            : encodeTile(readTile(ctx, rect)),
    );
}
