import { nonWhiteBounds } from "../../../shared/drawing-markup/trim-white";

type PixelBounds = ReturnType<typeof nonWhiteBounds>;

/** One worker per export and an identical cooperative fallback. */
export class DrawingPixelScanner {
  #worker: Worker | null = null;
  #fallback = false;

  async scan(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): Promise<PixelBounds> {
    if (!this.#worker && !this.#fallback) {
      try {
        this.#worker = new Worker(new URL("./drawing-pixels.worker.ts", import.meta.url), {
          type: "module",
        });
      } catch {
        this.#fallback = true;
      }
    }
    // Keep the original read before further painting: removing it can change
    // Chromium's canvas backend and the antialiasing of subsequently drawn labels.
    const data = context.getImageData(0, 0, width, height).data;
    if (this.#worker) {
      try {
        return await this.#scanWorker(data, width, height);
      } catch {
        this.dispose();
        this.#fallback = true;
      }
    }
    let result: PixelBounds = null;
    const rows = Math.max(1, Math.min(128, Math.floor(262144 / width)));
    for (let y = 0; y < height; y += rows) {
      const count = Math.min(rows, height - y);
      const part = nonWhiteBounds(
        data.subarray(y * width * 4, (y + count) * width * 4),
        width,
        count,
      );
      if (part) {
        const left = Math.min(result?.x ?? width, part.x);
        const top = Math.min(result?.y ?? height, y + part.y);
        const right = Math.max(result ? result.x + result.width : 0, part.x + part.width);
        const bottom = Math.max(result ? result.y + result.height : 0, y + part.y + part.height);
        result = { x: left, y: top, width: right - left, height: bottom - top };
      }
      if (y + count < height) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return result;
  }

  #scanWorker(data: Uint8ClampedArray, width: number, height: number): Promise<PixelBounds> {
    const worker = this.#worker!;
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timeout);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
      };
      const timeout = setTimeout(() => {
        finish();
        reject(new Error("图像扫描超时。"));
      }, 5000);
      worker.onmessage = (event: MessageEvent<{ bounds: PixelBounds; error?: boolean }>) => {
        finish();
        if (event.data.error) reject(new Error("图像扫描不可用。"));
        else resolve(event.data.bounds);
      };
      worker.onerror = worker.onmessageerror = () => {
        finish();
        reject(new Error("图像扫描不可用。"));
      };
      try {
        // Retain the original pixels for failure recovery. Only the worker copy is scanned.
        worker.postMessage({ data, width, height });
      } catch (error) {
        finish();
        reject(error);
      }
    });
  }

  dispose() {
    this.#worker?.terminate();
    this.#worker = null;
  }
}
