import { afterEach, expect, test, vi } from "vitest";
import { CadSvgPreviewClient } from "./cad-svg-preview-client";
import type { PreviewGeometry } from "./fixed-line-preview";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("CAD SVG preparation and viewport generation run through a worker", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/svg+xml" });
  const posted: Array<{ id: number; kind: string; bytes?: Uint8Array }> = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    postMessage(message: { id: number; kind: string }) {
      posted.push(message);
      queueMicrotask(() =>
        this.onmessage?.({
          data:
            message.kind === "prepare"
              ? { id: message.id, supportsScreenStrokes: true }
              : { id: message.id, blob },
        } as MessageEvent),
      );
    }
    terminate() {}
  }
  vi.stubGlobal("Worker", FakeWorker);
  const parser = vi.spyOn(DOMParser.prototype, "parseFromString");
  const client = new CadSvgPreviewClient();
  const source = new TextEncoder().encode('<svg viewBox="0 0 1 1"/>');
  const project = { width: 100, height: 80 };
  expect(await client.prepare(source, project)).toEqual({ supportsScreenStrokes: true });
  expect(await client.prepare(source, project)).toEqual({ supportsScreenStrokes: true });
  const geometry: PreviewGeometry = {
    zoom: 1,
    scale: 1,
    width: 100,
    height: 80,
    offsetX: 0,
    offsetY: 0,
    visible: { x: 0, y: 0, width: 100, height: 80 },
  };
  expect(await client.render(source, project, geometry, true, 1, 1)).toBe(blob);
  expect(posted.map((item) => item.kind)).toEqual(["prepare", "render"]);
  expect(posted.filter((item) => item.bytes)).toHaveLength(1);
  expect(parser).not.toHaveBeenCalled();
  client.dispose();
});

test("cancelled queued viewports never copy or render stale drawing data", async () => {
  const posted: Array<{ id: number; kind: string }> = [];
  let reply: (id: number) => void = () => {};
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      constructor() {
        reply = (id) =>
          this.onmessage?.({ data: { id, bytes: new Uint8Array([7]) } } as MessageEvent);
      }
      postMessage(message: { id: number; kind: string }) {
        posted.push(message);
      }
      terminate() {}
    },
  );
  const client = new CadSvgPreviewClient();
  const bytes = new Uint8Array([1]);
  const size = { width: 100, height: 80 };
  const geometry = {
    zoom: 1,
    scale: 1,
    ...size,
    offsetX: 0,
    offsetY: 0,
    visible: { x: 0, y: 0, ...size },
  };
  const active = client.render(bytes, size, geometry, true, 1);
  await Promise.resolve();
  const controller = new AbortController();
  const stale = client.render(bytes, size, geometry, true, 1, undefined, controller.signal);
  const rejected = expect(stale).rejects.toMatchObject({ name: "AbortError" });
  const latest = client.render(bytes, size, geometry, true, 1);
  controller.abort();
  expect(posted).toHaveLength(1);
  reply(posted[0]!.id);
  await active;
  await rejected;
  await vi.waitFor(() => expect(posted).toHaveLength(2));
  reply(posted[1]!.id);
  expect(await latest).toEqual(new Uint8Array([7]));
  client.dispose();
});

test("CAD preview remains readable when a worker cannot start", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("worker unavailable");
      }
    },
  );
  const client = new CadSvgPreviewClient();
  const source = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><path d="M0 0L100 80" stroke="black"/></svg>',
  );
  const project = { width: 100, height: 80 };
  expect(await client.prepare(source, project)).toEqual({ supportsScreenStrokes: true });
  const geometry: PreviewGeometry = {
    zoom: 1,
    scale: 1,
    width: 100,
    height: 80,
    offsetX: 0,
    offsetY: 0,
    visible: { x: 0, y: 0, width: 100, height: 80 },
  };
  const rendered = await client.render(source, project, geometry, true, 1);
  expect(ArrayBuffer.isView(rendered)).toBe(true);
  const result = new TextDecoder().decode(rendered as Uint8Array);
  expect(result).toContain('viewBox="0 0 100 80"');
  client.dispose();
});

test("an evicted worker source is restored once without detaching document bytes", async () => {
  const posted: Array<{ id: number; bytes?: Uint8Array }> = [];
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      postMessage(message: { id: number; bytes?: Uint8Array }) {
        posted.push(message);
        queueMicrotask(() =>
          this.onmessage?.({
            data: message.bytes
              ? { id: message.id, bytes: new Uint8Array([9]) }
              : { id: message.id, needsSource: true },
          } as MessageEvent),
        );
      }
      terminate() {}
    },
  );
  const client = new CadSvgPreviewClient();
  const bytes = new Uint8Array([1, 2, 3]);
  const size = { width: 100, height: 80 };
  const geometry = {
    zoom: 1,
    scale: 1,
    ...size,
    offsetX: 0,
    offsetY: 0,
    visible: { x: 0, y: 0, ...size },
  };
  expect(await client.render(bytes, size, geometry, true, 1)).toEqual(new Uint8Array([9]));
  expect(posted).toHaveLength(2);
  expect(posted[0]!.bytes).toBeUndefined();
  expect(posted[1]!.bytes).toBe(bytes);
  expect(bytes.byteLength).toBe(3);
  client.dispose();
});
