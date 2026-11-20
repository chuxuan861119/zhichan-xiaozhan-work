import { bindKlecksProjectPort } from '../../../../src/renderer/src/design-patent/correction/klecks-project-port';
import type { KlecksPortIdentity } from '../../../../src/renderer/src/design-patent/correction/klecks-command-port';
import { HostEditorRuntime } from './editor-runtime';

/** Attach only to the nonce/origin-authenticated parent port; never exposes history tokens. */
export function bindRuntimeProjectPort(port: MessagePort, runtime: HostEditorRuntime, isCurrent: (target: KlecksPortIdentity) => boolean): () => void {
    return bindKlecksProjectPort(port, { isCurrent, ...runtimeProjectCommands(runtime) });
}

export function runtimeProjectCommands(runtime: HostEditorRuntime) {
    return {
        freeze: async (target: KlecksPortIdentity) => {
            const revision = await runtime.exportImageRevision(target.viewId);
            if (revision.imageId !== target.viewId) throw new Error('Save snapshot target changed');
            const project = revision.project;
            if (project.psd.size + project.backings.reduce((size, asset) => size + asset.blob.size, 0) > 50 * 1024 * 1024 || revision.thumbnail.blob.size > 4 * 1024 * 1024 || revision.composite.blob.size>50*1024*1024) throw new Error('Project exceeds transport budget');
            return {
                project: { metadata: project.metadata, psd: new Uint8Array(await project.psd.arrayBuffer()),
                    backings: await Promise.all(project.backings.map(async item => ({ id: item.id, bytes: new Uint8Array(await item.blob.arrayBuffer()) }))) },
                thumbnail: new Uint8Array(await revision.thumbnail.blob.arrayBuffer()), token: revision.saveToken,
                unapplied: revision.unapplied,
                pixelDirty: revision.pixelDirty,
                composite:new Uint8Array(await revision.composite.blob.arrayBuffer()),
            };
        },
        confirmSaved: (token: Parameters<HostEditorRuntime['markSaved']>[0]) => runtime.markSaved(token),
        confirmApplied:(token:Parameters<HostEditorRuntime['markApplied']>[0])=>runtime.markApplied(token),
    };
}
