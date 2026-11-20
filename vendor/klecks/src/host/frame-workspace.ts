import { bindKlecksDocumentPort, KlecksDocumentIdentity } from '../../../../src/renderer/src/design-patent/correction/klecks-document-port';
import { bindKlecksProjectPort } from '../../../../src/renderer/src/design-patent/correction/klecks-project-port';
import type { KlecksPortIdentity } from '../../../../src/renderer/src/design-patent/correction/klecks-command-port';
import type { THostProject } from './host-document';
import { HostEditorRuntime } from './editor-runtime';
import { runtimeProjectCommands } from './runtime-project-port';
import { bindKlecksToolPort } from '../../../../src/renderer/src/design-patent/correction/klecks-tool-port';
import { isKlecksEditorState } from '../../../../src/renderer/src/design-patent/correction/klecks-state-port';
import { bindKlecksClipboardPort } from '../../../../src/renderer/src/design-patent/correction/klecks-clipboard-port';
import { bindKlecksFileDrop } from '../../../../src/renderer/src/design-patent/correction/klecks-file-drop-port';

/** One case per frame. Collection generations are distinct from content revisions. */
export class HostFrameWorkspace {
    private documents = new Map<string, number>();
    private readonly seen = new Map<string, number>();
    private readonly releases = new Set<() => void>();
    private readonly publishers = new Set<() => void>();
    private closed = false;
    constructor(readonly sessionId: string, readonly runtime: HostEditorRuntime, initial: readonly KlecksDocumentIdentity[] = []) {
        if (!sessionId || sessionId.length > 200) throw new Error('Invalid frame case session');
        this.sync(initial);
    }
    get activeIdentity(): KlecksPortIdentity | null {
        const viewId = this.runtime.state.activeId, generation = viewId ? this.documents.get(viewId) : undefined;
        return viewId && generation ? { sessionId: this.sessionId, viewId, generation } : null;
    }
    isCurrent = (target: KlecksPortIdentity): boolean => !this.closed && target.sessionId === this.sessionId && this.documents.get(target.viewId) === target.generation;
    sync(next: readonly KlecksDocumentIdentity[], lockToken?: string): void {
        if (this.closed || new Set(next.map(doc => doc.viewId)).size !== next.length || next.some(doc => !doc.viewId || doc.viewId.length > 200 || !Number.isSafeInteger(doc.generation) || doc.generation < 1)) throw new Error('Invalid frame image collection');
        for (const doc of next) {
            if (this.documents.get(doc.viewId) !== doc.generation && doc.generation <= (this.seen.get(doc.viewId) ?? 0)) throw new Error('Retired image generation cannot be reopened');
        }
        const generations = new Map(next.map(doc => [doc.viewId, doc.generation]));
        const reset = new Set([...this.documents].filter(([id, generation]) => generations.has(id) && generations.get(id) !== generation).map(([id]) => id));
        // Removing first invalidates the engine's decoder/history/save token for replaced identities.
        if (reset.size) this.runtime.sync(this.runtime.state.ids.filter(id => !reset.has(id)), lockToken);
        this.runtime.sync(next.map(doc => doc.viewId), lockToken);
        this.documents = generations;
        for (const doc of next) this.seen.set(doc.viewId, doc.generation);
        for (const publish of this.publishers) publish();
    }
    bind(port: MessagePort): () => void {
        if (this.closed) throw new Error('Frame workspace is closed');
        const fileDrop = bindKlecksFileDrop(port, document);
        const projects = bindKlecksProjectPort(port, { isCurrent: this.isCurrent, ...runtimeProjectCommands(this.runtime) });
        const clipboard=bindKlecksClipboardPort(port,{current:()=>{const identity=this.activeIdentity;return identity?{identity,revision:this.runtime.state.checkpointRevision}:null;},
            copy:(cut,merged)=>this.runtime.copyForSystem(cut,merged),paste:(image,inPlace,revision,signal)=>this.runtime.pasteForSystem(image,inPlace,revision,signal)});
        const clipboardMode=(event:MessageEvent<unknown>)=>{const data=event.data as Record<string,unknown>|null;if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==4||data.type!=='klecks:clipboard:mode'||data.version!==1||data.sessionId!==this.sessionId||typeof data.enabled!=='boolean')return;this.runtime.setExternalClipboard(data.enabled);};
        port.addEventListener('message',clipboardMode);let clipboardSequence=0;
        const clipboardRequests=this.runtime.onClipboardRequested(action=>{const identity=this.activeIdentity;if(identity)port.postMessage({type:'klecks:clipboard-request',version:1,sequence:++clipboardSequence,identity,action});});
        const documents = bindKlecksDocumentPort(port, {
            activate: target => this.runtime.activateCached(target.viewId),
            cancelOpen: () => this.runtime.cancelLoading(),
            sessionId: this.sessionId, isCurrent: this.isCurrent, sync: (docs, lockToken) => this.sync(docs, lockToken),
            interactionLock: (token, locked) => this.runtime.interactionLock(token, locked),
            openRaster: (target, name, source) => this.runtime.openRaster(target.viewId, name, async () => source),
            openProject: (target, project, isApplied, isSaved) => this.runtime.openProject(target.viewId, async () => ({
                version: 1, metadata: project.metadata as THostProject['metadata'],
                psd: new Blob([Uint8Array.from(project.psd).buffer]),
                backings: project.backings.map(item => ({ id: item.id, blob: new Blob([Uint8Array.from(item.bytes).buffer]) })),
            }), { isApplied, isSaved }),
        });
        const tools = bindKlecksToolPort(port, () => this.activeIdentity, command => {
            if(command.action==='autoTrim')return this.runtime.autoTrim(command.options);
            if(command.action==='retouchOptions'){this.runtime.setRetouchOptions(command);return;}
            if(command.action==='tone'){
                if(command.operation==='begin')this.runtime.beginTone(command.mode);else if(command.operation==='options')this.runtime.updateTone(command.options);else if(command.operation==='apply')this.runtime.applyTone();else this.runtime.cancelTone();return;
            }
            if(command.action==='whitespace'){
                if(command.operation==='begin')this.runtime.beginWhitespace(command.mode);else if(command.operation==='options')this.runtime.updateWhitespace(command.options);else if(command.operation==='apply')this.runtime.applyWhitespace();else this.runtime.cancelWhitespace();
            }
            else if(command.action==='bucketInputValidity')this.runtime.setBucketInputValidity(command.field,command.valid);
            else if(command.action==='bucketOptions')this.runtime.setBucketOptions(command.options);
            else if(command.action==='fill'){
                if(command.operation==='begin')this.runtime.beginFill();else if(command.operation==='cancel')this.runtime.cancelFill();else this.runtime.applyFill(command.options);
            }
            else if(command.action==='colorRange'){
                if(command.operation==='begin')this.runtime.beginColorRange();
                else if(command.operation==='cancel')this.runtime.cancelColorRange();
                else if(command.operation==='apply')this.runtime.applyColorRange();
                else if(command.operation==='reset')this.runtime.resetColorRange();
                else if(command.operation==='options')this.runtime.setColorRangeOptions(command.value);
                else if(command.operation==='patch')this.runtime.patchColorRangeOptions(command.change);
                else if(command.operation==='inputValidity')this.runtime.setColorRangeInputValidity(command.field,command.valid);
                else this.runtime.setRangeSampling(command.mode);
            }
            else if(command.action==='preferences')this.runtime.applyPreferences(command.value);
            else if(command.action==='wandOptions')this.runtime.setWandOptions(command);
            else if(command.action==='cancelWand')this.runtime.cancelWand();
            else if(command.action==='focus')this.runtime.focusCanvas();
            else if(command.action==='toolKey')this.runtime.forwardToolKey(command.key, command.shiftKey);
            else if(command.action==='rotateCanvas')this.runtime.rotateCanvas(command.degrees);
            else if(command.action==='flip')this.runtime.flip(command.axis, command.target);
            else if(command.action==='resizeCanvas')this.runtime.resizeCanvas(command.width,command.height,command.anchor);
            else if(command.action==='resizeImage')this.runtime.resizeImage(command.width,command.height,{interpolation:command.interpolation,allowDistortion:command.allowDistortion});
            else if (command.action === 'layer') this.runtime.layer(command);
            else if(command.action==='sampleSource')this.runtime.setSampleSource(command.source);
            else if(command.action==='autoSelect')this.runtime.setAutoSelect(command.enabled);
              else if(command.action==='transformLinked')this.runtime.setTransformLinked(command.enabled);
            else if(command.action==='colors')this.runtime.setColors(command.foreground,command.background);
            else if(command.action==='cursor')this.runtime.setCursorPreferences(command);
            else if(command.action==='navigation')this.runtime.setNavigation(command);
            else if(command.action==='selectionOptions')this.runtime.setSelectionOptions(command);
            else if(command.action==='crop'){
                if(command.operation==='preview'){this.runtime.setDeleteCroppedPixels(command.deletePixels);this.runtime.previewCrop(command.rect);}
                else if(command.operation==='apply')this.runtime.applyCrop();else this.runtime.cancelCrop();
            }
            else if (command.action === 'transform') {
                if (command.operation === 'begin') this.runtime.beginTransform(command.target);
                else if (command.operation === 'preview') this.runtime.previewTransform(command.matrix);
                else if (command.operation === 'apply') this.runtime.applyTransform();
                else this.runtime.cancelTransform();
            }
            else if (command.action === 'tool') this.runtime.setTool(command.tool);
            else if (command.action === 'fit') this.runtime.fit();
            else if (command.action === 'zoom') this.runtime.zoomTo(command.zoom);
            else {
                const { action, ...stroke } = command;
                this.runtime.setStroke({ ...stroke, tool: this.runtime.state.tool === 'eraser' ? 'eraser' : 'brush' });
            }
        });
        let sequence = 0;
        let saveSequence=0;
        const saves=this.runtime.onSaveRequested(()=>{const identity=this.activeIdentity;if(identity)port.postMessage({type:'klecks:save-request',version:1,sequence:++saveSequence,identity});});
        const publish = () => {
            const current = this.runtime.state;
            const history={canUndo:current.canUndo,canRedo:current.canRedo};
            const state = { ...history,tone:current.tone,whitespace:current.whitespace,fill:current.fill,colorRange:current.colorRange,wandBusy:current.wandBusy,identity: this.activeIdentity, activeId: current.activeId, ids: [...current.ids], dirty: current.dirty,
                controls:current.controls, preferences:current.preferences, selectionDirty:current.selectionDirty,
                unapplied: !!current.unapplied, pending: current.pending, hasSelection: current.hasSelection, navigationActive: current.navigationActive, locked: current.locked, tool: current.tool, zoom: current.viewport?.zoom ?? null,
                checkpointRevision: current.checkpointRevision, size: current.size, brush: current.brush, activeLayerId: current.activeLayerId, selectedLayerIds:current.selectedLayerIds, layers: current.layers };
            if (isKlecksEditorState(state)) port.postMessage({ type: 'klecks:state', version: 1, sequence: ++sequence, state });
        };
        this.publishers.add(publish);
        const unsubscribe = this.runtime.subscribe(publish);
        publish();
        const release = () => { fileDrop();this.runtime.setExternalClipboard(false);port.removeEventListener('message',clipboardMode);clipboardRequests();clipboard();saves();unsubscribe(); this.publishers.delete(publish); tools(); documents(); projects(); this.releases.delete(release); };
        this.releases.add(release); return release;
    }
    destroy(): void {
        if (this.closed) return;
        this.closed = true;
        for (const release of [...this.releases]) release();
        this.runtime.destroy(); this.documents.clear(); this.seen.clear();
    }
}
