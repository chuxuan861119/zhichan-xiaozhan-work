export type CachedDrawingConversion = (
  | { svg: Buffer; tiles?: undefined }
  | { svg?: undefined; tiles: Buffer }
) & {
  preview: Buffer;
  width: number;
  height: number;
  warnings: string[];
};

export class DrawingConversionCache {
  readonly #entries = new Map<string, CachedDrawingConversion>();
  #bytes = 0;
  constructor(
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxEntries = 8,
  ) {}
  get(key: string): CachedDrawingConversion | undefined {
    const result = this.#entries.get(key);
    if (!result) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, result);
    return copy(result);
  }
  set(key: string, result: CachedDrawingConversion): void {
    const size = byteLength(result);
    if (size > this.maxBytes) return;
    const previous = this.#entries.get(key);
    if (previous) {
      this.#bytes -= byteLength(previous);
      this.#entries.delete(key);
    }
    for (const [oldest, entry] of this.#entries) {
      if (this.#entries.size < this.maxEntries && this.#bytes + size <= this.maxBytes) break;
      this.#bytes -= byteLength(entry);
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, copy(result));
    this.#bytes += size;
  }
}

function byteLength(result: CachedDrawingConversion) {
  return (
    (result.svg?.byteLength ?? 0) + (result.tiles?.byteLength ?? 0) + result.preview.byteLength
  );
}

function copy(result: CachedDrawingConversion): CachedDrawingConversion {
  const shared = {
    width: result.width,
    height: result.height,
    preview: Buffer.from(result.preview),
    warnings: [...result.warnings],
  };
  return result.tiles
    ? { ...shared, tiles: Buffer.from(result.tiles) }
    : { ...shared, svg: Buffer.from(result.svg) };
}
