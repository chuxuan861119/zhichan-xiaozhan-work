import { isLayerFill } from '../app/script/klecks/kl-types';
import { HISTORY_TILE_SIZE } from '../app/script/klecks/history/kl-history';
import type { THistoryEntryLayer } from '../app/script/klecks/history/history.types';

export function backingToCanvas(backing: NonNullable<THistoryEntryLayer['hostBacking']>) {
    const canvas = document.createElement('canvas');
    canvas.width = backing.width; canvas.height = backing.height;
    const context = canvas.getContext('2d')!;
    const columns = Math.ceil(backing.width / HISTORY_TILE_SIZE);
    for (const [index, tile] of backing.tiles.entries()) {
        const left = (index % columns) * HISTORY_TILE_SIZE;
        const top = Math.floor(index / columns) * HISTORY_TILE_SIZE;
        if (isLayerFill(tile)) {
            context.fillStyle = tile.fill;
            context.fillRect(left, top, Math.min(HISTORY_TILE_SIZE, backing.width - left), Math.min(HISTORY_TILE_SIZE, backing.height - top));
        } else context.putImageData(tile.data, left, top);
    }
    return canvas;
}

export function mergeLayerBacking(current: HTMLCanvasElement, previous: THistoryEntryLayer['hostBacking']) {
    const x = Math.min(0, previous?.x ?? 0), y = Math.min(0, previous?.y ?? 0);
    const width = Math.max(current.width, previous ? previous.x + previous.width : 0) - x;
    const height = Math.max(current.height, previous ? previous.y + previous.height : 0) - y;
    if (width > 10000 || height > 10000 || width * height > 40000000) throw new Error('Preserved layer exceeds safe dimensions');
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d')!;
    if (previous) {
        const restored = backingToCanvas(previous);
        try { context.drawImage(restored, previous.x - x, previous.y - y); }
        finally { restored.width = 0; restored.height = 0; }
    }
    context.clearRect(-x, -y, current.width, current.height);
    context.drawImage(current, -x, -y);
    return { canvas, x, y };
}
