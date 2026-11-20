import { HostDocument } from './host-document';
import { HostEditorRuntime } from './editor-runtime';
import { grantedKlecksResourcePolicy } from '../../../../src/renderer/src/design-patent/correction/klecks-resource-budget';
import { klecksTransformMatrix } from '../../../../src/renderer/src/design-patent/correction/klecks-transform';
import { selectionMask } from './selection-mask';
import { DesignEditorMetadataSchema } from '../../../../src/shared/patent/design-editor-project';
import { getNextLayerId } from '../app/script/klecks/history/get-next-layer-id';

// Development-only integration assertions; never imported by production entry points.
export async function verifyPixelTransformDocuments(): Promise<void> {
    const source = document.createElement('canvas'); source.width = 20; source.height = 16;
    const context = source.getContext('2d')!;
    context.fillStyle = 'red'; context.fillRect(2, 3, 4, 2); context.fillStyle = 'blue'; context.fillRect(10, 4, 2, 3);
    const image = new HostDocument({ projectId: 'transform-document', width: 20, height: 16,
        layers: [{ name: 'Source', opacity: 1, isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: source }] });
    const pixel = (document: HostDocument, x: number, y: number) => Array.from(document.canvas.getLayer(0).context.getImageData(x, y, 1, 1).data);
    try {
        const original = image.capture(), identity = image.contentIdentity();
        for(const duplicate of[false,true]){
            const snapshot=structuredClone(original),oldest=snapshot.history.entries[0].data,collision=String(Number(getNextLayerId())+1),properties=Object.values(oldest.layerMap!)[0];
            oldest.layerMap={[collision]:properties};oldest.activeLayerId=collision;
            const reopened=HostDocument.restore(snapshot);
            try{if(duplicate)reopened.duplicateLayer(collision);else reopened.newLayer('New after reopen');const metadata=(await reopened.exportProject()).metadata;DesignEditorMetadataSchema.parse(metadata);if(reopened.canvas.getLayerCount()!==2||new Set(metadata.layers.map(layer=>layer.id)).size!==2||pixel(reopened,2,3)[0]!==255)throw new Error('New layer collided with a persisted identifier after reopening');}
            finally{reopened.destroy();}
        }
        const background=HostDocument.restore(original);
        try{
            background.makeBackground(background.layerState().activeLayerId,{r:255,g:255,b:255});
            background.select([[[[2,3],[6,3],[6,5],[2,5],[2,3]]]],'replace');
            background.clearPixels({r:0,g:255,b:0});
            if(pixel(background,2,3)[1]!==255||pixel(background,2,3)[3]!==255||pixel(background,10,4)[2]!==255)throw new Error('Background clear did not fill the current background color');
            background.undo();if(pixel(background,2,3)[0]!==255)throw new Error('Background clear undo lost source');
        }finally{background.destroy();}
        const copied=HostDocument.restore(original);
        try{
            copied.select([[[[2,3],[6,3],[6,5],[2,5],[2,3]]]],'replace');
            const actions=copied.capture().history.totalActions;
            copied.movePixels(0,6,true);
            if(pixel(copied,2,3)[0]!==255||pixel(copied,2,9)[0]!==255||copied.canvas.getLayerCount()!==1||copied.capture().history.totalActions!==actions+1)throw new Error('Alt Move did not copy selected pixels in one history step');
            copied.undo();if(pixel(copied,2,9)[3]!==0)throw new Error('Alt Move undo left duplicate pixels');
            copied.deselect();copied.movePixels(2,0,true);
            if(copied.canvas.getLayerCount()!==2||pixel(copied,2,3)[0]!==255||copied.canvas.getLayer(1).context.getImageData(4,3,1,1).data[0]!==255)throw new Error('Alt Move did not duplicate an unselected layer without altering the source');
            copied.undo();if(copied.canvas.getLayerCount()!==1||pixel(copied,2,3)[0]!==255)throw new Error('Alt Move layer duplication was not one undo step');
        }finally{copied.destroy();}
        const container = document.createElement('div'); document.body.append(container);
        const errors: unknown[] = [];
        const runtime = new HostEditorRuntime(container, 'windows', { changed() {}, error(error) { errors.push(error); } }, grantedKlecksResourcePolicy(512 * 1024 * 1024));
        try {
            runtime.sync(['runtime-transform']);
            await runtime.openProject('runtime-transform', () => image.exportProject());
            const history = runtime.captureActive()!.history.totalActions;
            if (runtime.state.tool !== 'hand') throw new Error('Default tool must be the hand');
            // Match the toolbar: choose the tool before changing its remembered parameters.
            runtime.setTool('brush');
            runtime.setStroke({ tool: 'brush', size: 8, hardness: 1, opacity: 0.6, flow: 0.4, color: { r: 0, g: 0, b: 0 } });
            const checkpoint = runtime.state.checkpointRevision;
            const key = (key: string, shiftKey = false) => runtime.canvas.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
            key(']'); if (runtime.state.brush.size !== 9) throw new Error('Brush size shortcut is unhandled');
            key('['); key('{', true);
            if (Number(runtime.state.brush.size) !== 8 || runtime.state.brush.hardness !== 0.75 || runtime.state.brush.opacity !== 0.6 || runtime.state.brush.flow !== 0.4 || runtime.state.dirty || runtime.state.checkpointRevision !== checkpoint) throw new Error('Brush shortcuts changed pixels or unrelated parameters');
            key('}', true); if (Number(runtime.state.brush.hardness) !== 1) throw new Error('Brush hardness increase failed');
            runtime.setTool('eraser'); key('{', true);
            if (runtime.state.brush.hardness !== 0.75) throw new Error('Eraser hardness shortcut is unhandled');
            runtime.canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 20, clientY: 20 }));
            if (runtime.canvas.style.cursor !== 'none' || !container.querySelector('[data-klecks-brush-cursor]')) throw new Error('Painting tool cursor is missing');
            runtime.setTool('move');
            if (!String(runtime.canvas.style.cursor).includes('data:image/svg+xml')) throw new Error('Move cursor did not follow active tool');
            runtime.beginTransform();
            if (!runtime.state.pending || runtime.state.dirty) throw new Error('Transform start modified saved document');
            runtime.previewTransform({ a: 1, b: 0, c: 0, d: 1, e: 1, f: 0 });
            let rejected = false;
            try { runtime.previewTransform({ a: 400, b: 0, c: 0, d: 400, e: 0, f: 0 }); } catch { rejected = true; }
            if (!rejected || !runtime.state.pending || runtime.state.dirty) throw new Error('Oversized preview lost draft or changed source');
            runtime.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            if (runtime.state.pending || !runtime.state.dirty || runtime.captureActive()!.history.totalActions !== history + 1) throw new Error('Transform Enter did not commit last valid preview once');
            runtime.dispatch({ action: 'undo' });
            if (runtime.state.dirty) throw new Error('Transform undo did not restore saved state');
            runtime.dispatch({ action: 'transform' });
            runtime.previewTransform({ a: 1, b: 0, c: 0, d: 1, e: 2, f: 0 });
            runtime.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await Promise.resolve();
            if (String(runtime.state.tool) !== 'hand' || String(runtime.canvas.style.cursor) !== 'grab') throw new Error('Transform Escape did not release to hand');
            if (runtime.state.pending || runtime.state.dirty || runtime.captureActive()!.history.totalActions !== history + 1 || errors.length) throw new Error('Transform Escape changed history or failed to release draft');
        } finally { runtime.destroy(); container.remove(); }
        const bounds = { left: 2, top: 3, width: 10, height: 4 };
        const rotation = klecksTransformMatrix(bounds, { dx: 0, dy: 0, scaleX: 1, scaleY: 1, angle: 90 });
        const preview = image.previewPixelTransform(rotation);
        try {
            if (preview.width !== 20 || preview.height !== 16 || preview.getContext('2d')!.getImageData(8, 0, 1, 1).data[0] !== 255 ||
                image.contentIdentity() !== identity || image.capture().history.totalActions !== original.history.totalActions) throw new Error('Document transform preview changed history or source');
        } finally { preview.width = 0; preview.height = 0; }
        image.transformPixels(rotation);
        if (pixel(image, 8, 0)[0] !== 255 || pixel(image, 7, 8)[2] !== 255 || pixel(image, 2, 3)[3] !== 0 ||
            image.capture().history.totalActions !== original.history.totalActions + 1) throw new Error('Document affine transform did not commit one history entry');
        image.undo();
        if (image.contentIdentity() !== identity || pixel(image, 2, 3)[0] !== 255) throw new Error('Document transform undo lost original pixels');
        image.redo();
        if (pixel(image, 8, 0)[0] !== 255) throw new Error('Document transform redo lost rotated pixels');
        const unchangedHistory = image.capture().history.totalActions;
        image.transformPixels({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        if (image.capture().history.totalActions !== unchangedHistory) throw new Error('Identity transform created a dirty history entry');
        const locked = HostDocument.restore(original);
        try {
            locked.setLayerLocks(locked.canvas.getLayer(0).id, { position: true });
            const lockedState = locked.contentIdentity(), lockedHistory = locked.capture().history.totalActions;
            let lockRejected = false;
            try { locked.transformPixels(rotation); } catch { lockRejected = true; }
            if (!lockRejected || locked.contentIdentity() !== lockedState || locked.capture().history.totalActions !== lockedHistory)
                throw new Error('Affine transform bypassed the layer position lock');
        } finally { locked.destroy(); }
        const outside = HostDocument.restore(original);
        try {
            outside.transformPixels(klecksTransformMatrix(bounds, { dx: -10, dy: 0, scaleX: 1, scaleY: 1, angle: 0 }));
            const restored = await HostDocument.openProject(await outside.exportProject());
            try {
                restored.resizeCanvas(40, 16, { horizontal: 'right', vertical: 'top' });
                if (pixel(restored, 12, 3)[0] !== 255 || pixel(restored, 20, 4)[2] !== 255) throw new Error('Saved affine transform lost off-canvas pixels');
            } finally { restored.destroy(); }
        } finally { outside.destroy(); }
        const selected=HostDocument.restore(original);
        try {
            selected.select([[[[2,3],[6,3],[6,5],[2,5],[2,3]]]],'replace');
            selected.transformPixels({a:1,b:0,c:0,d:1,e:0,f:6});
            if(pixel(selected,2,9)[0]!==255||pixel(selected,2,3)[3]!==0||pixel(selected,10,4)[2]!==255)throw new Error('Selected transform moved unrelated layer pixels');
            selected.undo();selected.select([[[[2,3],[6,3],[6,5],[2,5],[2,3]]]],'replace',{feather:1});
            const beforeProject=await selected.exportProject(),mask=selectionMask(20,16,beforeProject.metadata.selection)!;
            selected.transformPixels({a:2,b:0,c:0,d:1,e:0,f:0});
            const project=await selected.exportProject();DesignEditorMetadataSchema.parse(project.metadata);
            const expected=document.createElement('canvas');expected.width=20;expected.height=16;expected.getContext('2d')!.scale(2,1);expected.getContext('2d')!.drawImage(mask,0,0);
            const actual=selectionMask(20,16,project.metadata.selection)!;
            const a=actual.getContext('2d')!.getImageData(0,0,20,16).data,b=expected.getContext('2d')!.getImageData(0,0,20,16).data;
            for(let i=3;i<a.length;i+=4)if(Math.abs(a[i]-b[i])>1)throw new Error('Nonuniform transform approximated feather with a scalar');
            const reopened=await HostDocument.openProject(project);
            try {
                reopened.invertSelection();const inverse=selectionMask(20,16,(await reopened.exportProject()).metadata.selection)!;
                const values=inverse.getContext('2d')!.getImageData(0,0,20,16).data;
                for(let i=3;i<a.length;i+=4)if(Math.abs(a[i]+values[i]-255)>1)throw new Error('Inverse selection lost partial mask coverage');
                inverse.width=0;inverse.height=0;
            } finally{reopened.destroy();mask.width=actual.width=expected.width=0;}
        } finally{selected.destroy();}
    } finally { image.destroy(); source.width = 0; source.height = 0; }
}
