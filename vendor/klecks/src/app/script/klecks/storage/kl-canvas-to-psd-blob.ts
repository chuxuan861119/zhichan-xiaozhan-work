import { KlCanvas } from '../canvas/kl-canvas';
import type { Psd } from 'ag-psd/dist/psd';
import { blendKlToPsd } from './psd';
import { psdToBlob } from './psd-to-blob';
import { attempt, AttemptError } from '../../bb/base/base';
import {maskGray} from '../../../../host/layer-mask';

export async function klCanvasToPsdBlob(
    klCanvas: KlCanvas,
    isPreviewIncluded: boolean = true,
): Promise<Blob> {
    const layerArr = klCanvas.getLayers();
    const owned:HTMLCanvasElement[]=[];

    let canvas: HTMLCanvasElement | undefined;
    if (isPreviewIncluded) {
        // makes saving less likely to fail
        const c = attempt(() => klCanvas.getCanvas());
        if (!(c instanceof AttemptError)) {
            canvas = c;
        }
    }

    const psdConfig: Psd = {
        width: klCanvas.getWidth(),
        height: klCanvas.getHeight(),
        canvas,
        children: layerArr.map((item) => {
            // todo - can be optimized if layer mostly empty
            const mask=item.hostMask,maskCanvas=mask?maskGray(mask):undefined;if(maskCanvas)owned.push(maskCanvas);
            return {
                ...(mask&&maskCanvas?{mask:{canvas:maskCanvas,left:mask.x,top:mask.y,defaultColor:mask.outside,disabled:!mask.enabled,positionRelativeToLayer:mask.linked}}:{}),
                name: item.name,
                hidden: !item.isVisible,
                opacity: item.opacity,
                canvas: item.canvas,
                blendMode: blendKlToPsd(item.mixModeStr),
                clipping: item.hasClipping,
                left: 0,
                top: 0,
            };
        }),
    };

    try { return await psdToBlob(psdConfig); }
    finally { if (canvas) { canvas.width = 1; canvas.height = 1; }for(const c of owned)c.width=c.height=0; }
}
