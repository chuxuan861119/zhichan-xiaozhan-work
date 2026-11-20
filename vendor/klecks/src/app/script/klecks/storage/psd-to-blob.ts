import type { Psd } from 'ag-psd/dist/psd';
import { encodePsdInWorker } from './psd-codec-client';

export async function psdToBlob(psd: Psd): Promise<Blob> {
    const buffer = await encodePsdInWorker(psd);
    return new Blob([new Uint8Array(buffer).buffer], { type: 'image/vnd.adobe.photoshop' });
}
