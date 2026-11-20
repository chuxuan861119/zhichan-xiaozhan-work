import { initializeCanvas, readPsd, writePsdUint8Array } from 'ag-psd';

// Internal projects contain only 8-bit layers/masks. No DOM or OffscreenCanvas
// dependency: this also works in embedded browsers without worker canvas support.
initializeCanvas(() => { throw new Error('PSD worker cannot create DOM canvases'); },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData);

self.onmessage = ({ data }) => {
    try {
        if (data.operation === 'encode') {
            const bytes = writePsdUint8Array(data.payload);
            self.postMessage({ value: bytes }, { transfer: [bytes.buffer] });
        } else if (data.operation === 'decode') {
            const psd = readPsd(data.payload, { skipThumbnail: true, skipCompositeImageData: true, useImageData: true });
            const transfers: ArrayBuffer[] = [];
            const visit = (node: any): void => {
                if (node.imageData) transfers.push(node.imageData.data.buffer);
                if (node.mask) visit(node.mask);
                node.children?.forEach(visit);
            };
            visit(psd);
            self.postMessage({ value: psd }, { transfer: transfers });
        } else throw new Error('Unknown PSD worker operation');
    } catch (error) {
        self.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
};
