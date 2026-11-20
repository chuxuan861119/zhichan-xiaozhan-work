import { HostWorkspace } from './host-workspace';
import { HostDocument } from './host-document';

/** Development-only measurement, not an application limit or platform acceptance. */
export async function probeWorkspaceResources(): Promise<object> {
    const workspace = new HostWorkspace();
    const ids = Array.from({ length: 9 }, (_, index) => `resource-${index}`);
    const width = 1600, height = 1200;
    const timings: number[] = [];
    const started = performance.now();
    workspace.sync(ids);
    try {
        for (const [index, id] of ids.entries()) {
            const start = performance.now();
            const image = workspace.open(id, () => new HostDocument({ projectId: id, width, height,
                layers: Array.from({ length: 3 }, (_, layer) => ({
                    name: `layer-${layer}`, opacity: layer ? 0.5 : 1, isVisible: true,
                    hasClipping: false, mixModeStr: 'source-over' as const,
                    image: (() => {
                        const canvas = document.createElement('canvas');
                        canvas.width = width; canvas.height = height;
                        const context = canvas.getContext('2d')!;
                        // Dense nonuniform pixels prevent a uniform fill-only history shortcut.
                        const pixels = context.createImageData(width, height);
                        for (let offset = 0; offset < pixels.data.length; offset += 4) {
                            pixels.data[offset] = (offset / 4 + index * 17 + layer * 31) % 251;
                            pixels.data[offset + 1] = (offset / 64) % 253;
                            pixels.data[offset + 2] = layer * 70;
                            pixels.data[offset + 3] = 255;
                        }
                        context.putImageData(pixels, 0, 0);
                        return canvas;
                    })(),
                })) }));
            for (let step = 0; step < 20; step++) image.renameLayer(image.canvas.getLayer(2).id, `history-${step}`);
            for (let step = 0; step < 8; step++) image.paint([[80 + step * 160, 80 + step * 100, 1]], {
                tool: 'brush', size: 24, opacity: 0.6, color: { r: 250, g: 0, b: 0 },
            });
            image.undo();
            timings.push(performance.now() - start);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        const reopen: number[] = [];
        for (const id of ids) {
            const start = performance.now();
            const image = workspace.open(id, () => { throw new Error('Suspended image was lost'); });
            const before = image.canvas.getLayer(2).context.getImageData(1200, 780, 1, 1).data[0];
            image.redo();
            const after = image.canvas.getLayer(2).context.getImageData(1200, 780, 1, 1).data[0];
            if (before === after || image.canvas.getLayer(2).name !== 'history-19') throw new Error('Suspended pixel redo was lost');
            reopen.push(performance.now() - start);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        const saved = await workspace.document!.exportProject();
        if (workspace.resourceUsage().historyPixelBytes > ids.length * width * height * 4 * 3 * 2) throw new Error('Small strokes retained full-layer history copies');
        const reopened = await HostDocument.openProject(saved);
        try {
            if (reopened.canvas.getLayerCount() !== 3 || reopened.canvas.getWidth() !== width) throw new Error('Resource project restore failed');
        } finally { reopened.destroy(); }
        return { passed: true, documents: ids.length, width, height, layers: 3, metadataHistorySteps: 20,
            pixelHistorySteps: 8, initialMs: timings.map(Math.round), reopenMs: reopen.map(Math.round), elapsedMs: Math.round(performance.now() - started),
            psdBytes: saved.psd.size, minimumLayerPixelBytes: ids.length * width * height * 4 * 3, knownResources: workspace.resourceUsage(),
            scope: 'Windows headless Chrome; not boundary-size or peak-memory acceptance' };
    } finally { workspace.destroy(); }
}
