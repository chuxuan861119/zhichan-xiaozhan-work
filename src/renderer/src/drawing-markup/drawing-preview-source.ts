/** Immutable source ownership at the React boundary. Keeping binary payloads
 * private avoids copying/enumerating millions of byte properties on UI updates.
 * Consumers borrow the original view for decoding; never mutate/transfer it. */
export class DrawingPreviewSource {
  #bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }
  read() {
    return this.#bytes;
  }
}

const sources = new WeakMap<Uint8Array, DrawingPreviewSource>();
export function drawingPreviewSource(bytes: Uint8Array): DrawingPreviewSource {
  let source = sources.get(bytes);
  if (!source) {
    source = new DrawingPreviewSource(bytes);
    sources.set(bytes, source);
  }
  return source;
}
