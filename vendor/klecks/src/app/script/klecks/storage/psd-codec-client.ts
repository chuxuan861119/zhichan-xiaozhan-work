import type { Psd } from 'ag-psd';
import { psdWorkerSource } from './psd-codec-worker-source';

// Bound concurrency and lifetime: never retain a worker (or its codec heaps) after
// an operation, and never send a caller-owned/live pixel buffer as a transferable.
let queue: Promise<unknown> = Promise.resolve();
function runCodec<T>(operation: 'encode' | 'decode', payload: unknown, transfers: ArrayBuffer[]): Promise<T> {
    const result = queue.then(() => new Promise<T>((resolve, reject) => {
        let worker: Worker | undefined, url: string | undefined;
        const timer = setTimeout(() => finish(new Error('PSD 后台处理超时，请重试。')), 120000);
        const finish = (error?: Error, value?: T): void => {
            clearTimeout(timer); worker?.terminate(); if (url) URL.revokeObjectURL(url);
            if (error) reject(error); else resolve(value!);
        };
        try {
            url = URL.createObjectURL(new Blob([psdWorkerSource], { type: 'text/javascript' }));
            worker = new Worker(url);
            worker.onmessage = ({ data }) => data.error ? finish(new Error(data.error)) : finish(undefined, data.value);
            worker.onerror = event => { event.preventDefault(); finish(new Error('PSD 后台处理失败，请重试。')); };
            worker.onmessageerror = () => finish(new Error('PSD 后台数据传输失败，请重试。'));
            worker.postMessage({ operation, payload }, transfers);
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    }));
    queue = result.then(() => undefined, () => undefined);
    return result;
}

export function encodePsdInWorker(psd: Psd): Promise<Uint8Array> {
    const transfers: ArrayBuffer[] = [];
    const copy = (node: any): any => {
        const { canvas, children, mask, ...properties } = node;
        if (canvas) {
            properties.imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
            transfers.push(properties.imageData.data.buffer);
        } else if (properties.imageData) {
            properties.imageData = { width: properties.imageData.width, height: properties.imageData.height, data: properties.imageData.data.slice() };
            transfers.push(properties.imageData.data.buffer);
        }
        if (children) properties.children = children.map(copy);
        if (mask) properties.mask = copy(mask);
        return properties;
    };
    return runCodec('encode', copy(psd), transfers);
}

export function decodePsdInWorker(bytes: Uint8Array): Promise<Psd> {
    const owned = bytes.slice();
    return runCodec('decode', owned, [owned.buffer]);
}
