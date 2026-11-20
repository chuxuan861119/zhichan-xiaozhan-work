import { HISTORY_TILE_SIZE } from '../app/script/klecks/history/kl-history';

/** Integer tile clips preserve the original full-image sampling/compositing coordinates. */
export function strokeTileRegion(changed: readonly boolean[], width: number, height: number) {
    const path = new Path2D(), columns = Math.ceil(width / HISTORY_TILE_SIZE);
    let left = width, top = height, right = 0, bottom = 0;
    for (let i = 0; i < changed.length; i++) if (changed[i]) {
        const x = i % columns * HISTORY_TILE_SIZE, y = Math.floor(i / columns) * HISTORY_TILE_SIZE;
        path.rect(x, y, HISTORY_TILE_SIZE, HISTORY_TILE_SIZE);
        left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, Math.min(width, x + HISTORY_TILE_SIZE)); bottom = Math.max(bottom, Math.min(height, y + HISTORY_TILE_SIZE));
    }
    return { path, left, top, right, bottom };
}

export function drawStrokeRegion(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement,
    region: { left: number; top: number; right: number; bottom: number }): void {
    const { left, top, right, bottom } = region, width = right - left, height = bottom - top;
    if (width > 0 && height > 0) context.drawImage(canvas, left, top, width, height, left, top, width, height);
}
