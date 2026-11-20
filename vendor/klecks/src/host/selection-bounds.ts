import { intersection, type MultiPolygon } from 'polygon-clipping';

/** Clip geometry, not individual vertices: curved/diagonal edges must meet the canvas accurately. */
export function selectionWithinCanvas(region: MultiPolygon, width: number, height: number): MultiPolygon {
    if (region.every(poly => poly.every(ring => ring.every(([x, y]) => x >= 0 && y >= 0 && x <= width && y <= height)))) return region;
    return intersection(region, [[[[0, 0], [width, 0], [width, height], [0, height], [0, 0]]]]);
}
