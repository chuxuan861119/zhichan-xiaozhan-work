import { HostDocument, THostDocumentSnapshot, THostClipboard, THostRasterSource } from './host-document';
import type { KlecksViewport } from '../../../../src/renderer/src/design-patent/correction/klecks-viewport';
import { validateEditorBinaryHeader } from '../../../../src/shared/patent/design-editor-binary';
import { retainedHistoryPixelBytes } from '../app/script/klecks/history/estimate-bytes';
import { composeHistoryStateData } from '../app/script/klecks/history/compose-history-state-data';
import { KlecksOperationRejected } from '../../../../src/renderer/src/design-patent/correction/klecks-operation-error';
import { KlecksSessionCache } from '../../../../src/renderer/src/design-patent/correction/klecks-session-cache';

export type THostPasteTarget = Readonly<{ owner: symbol; id: string; generation: symbol; request: number }>;
export type THostExternalPng = { bytes: Uint8Array; width: number; height: number };

function suspendedHistoryPixelBytes(snapshot: THostDocumentSnapshot): number {
    return retainedHistoryPixelBytes(snapshot.history.entries) + (snapshot.floatingMove ? suspendedHistoryPixelBytes(snapshot.floatingMove.source) : 0);
}

/** Owns one live engine and suspended per-image histories. No filesystem writes. */
export class HostWorkspace {
    private states = new Map<string, THostDocumentSnapshot | null>();
    private current: { id: string; document: HostDocument } | null = null;
    private destroyed = false;
    private viewports = new Map<string, KlecksViewport>();
    private clipboard: THostClipboard | null = null;
    private generations = new Map<string, symbol>();
    private openRequest = 0;
    private readonly owner = Symbol('HostWorkspace');
    private cached = new Set<string>();
    private clipboardScope = '';
    constructor(private cache?: KlecksSessionCache) {}
    cachedBytes(id: string): number { return this.cached.has(id) ? this.cache?.bytes(id) ?? 0 : 0; }

    /** Release inactive pixel histories only after the cache has accepted ownership. */
    async parkSuspended(): Promise<void> {
        if (!this.cache) return;
        for (const [id, snapshot] of this.states) {
            if (!snapshot || id === this.activeId) continue;
            await this.cache.put(id, snapshot, suspendedHistoryPixelBytes(snapshot));
            this.assertAlive();
            if (this.states.get(id) === snapshot) { this.states.set(id, null); this.cached.add(id); }
        }
    }
    async hydrate(id: string): Promise<void> {
        if (!this.cache || !this.cached.has(id)) return;
        const generation = this.generations.get(id);
        const snapshot = await this.cache.get(id) as THostDocumentSnapshot | undefined;
        this.assertAlive();
        if (!this.cached.has(id) || this.generations.get(id) !== generation) return;
        if (!snapshot) throw new Error('编辑会话缓存读取失败；未重新载入原图，请重试以保留编辑历史。');
        this.states.set(id, snapshot);
        await this.cache.remove(id);
        this.cached.delete(id);
    }
    async readSuspendedState(id: string) {
        if (!this.cached.has(id)) return this.suspendedState(id);
        const snapshot = await this.cache!.get(id) as THostDocumentSnapshot | undefined;
        this.assertAlive();
        if (!snapshot || !this.states.has(id)) throw new Error('编辑会话缓存不可用，现有编辑内容未重置。');
        const viewport = this.viewports.get(id);
        return { state: composeHistoryStateData(snapshot.history.entries.slice(0, snapshot.history.index + 1).map(entry => entry.data)), viewport: viewport ? {...viewport} : null,
            selectedLayerIds: (snapshot.selectedLayerIds ?? snapshot.history.entries[snapshot.history.index].hostSelectedLayerIds)?.slice() };
    }

    get activeId(): string | null { return this.current?.id ?? null; }
    get document(): HostDocument | null { return this.current?.document ?? null; }
    get ids(): readonly string[] { return [...this.states.keys()]; }
    /** Trusted read-only current state of a suspended document, without activating it or replaying old history. */
    suspendedState(id: string) {
        this.assertAlive();
        const snapshot = this.states.get(id);
        if (!snapshot) throw new Error('No suspended image to checkpoint');
        const viewport = this.viewports.get(id);
        return { state: composeHistoryStateData(snapshot.history.entries.slice(0, snapshot.history.index + 1).map(entry => entry.data)),
            viewport: viewport ? {...viewport} : null,
            selectedLayerIds:(snapshot.selectedLayerIds??snapshot.history.entries[snapshot.history.index].hostSelectedLayerIds)?.slice() };
    }
    /** Lower bound of known pixel storage, not process RSS or a safe admission budget. */
    resourceUsage() {
        this.assertAlive();
        const active = this.document?.resourceUsage() ?? { historyPixelBytes: 0, layerCanvasBytes: 0, scratchCanvasBytes: 0 };
        const historyPixelBytes = active.historyPixelBytes + (this.cache?.hotBytes ?? 0) + [...this.states.values()].reduce((total, state) => total + (state ? suspendedHistoryPixelBytes(state) : 0), 0);
        const clipboardBytes = this.clipboard?.image.data.buffer.byteLength ?? 0;
        return { ...active, historyPixelBytes, clipboardBytes,
            minimumKnownPixelBytes: historyPixelBytes + active.layerCanvasBytes + active.scratchCanvasBytes + clipboardBytes };
    }
    get viewport(): KlecksViewport | null {
        const view = this.activeId ? this.viewports.get(this.activeId) : undefined;
        return view ? { ...view } : null;
    }

    setViewport(view: KlecksViewport): void {
        this.assertAlive();
        if (!this.activeId) throw new Error('No active image');
        if (Object.values(view).some(value => !Number.isFinite(value)) || view.zoom <= 0 || view.pixelRatio <= 0) {
            throw new Error('Invalid viewport');
        }
        this.viewports.set(this.activeId, { ...view });
    }

    /** A case-local clipboard survives source-image removal, never crosses workspaces. */
    copy(cut = false, merged = false,backgroundColor={r:255,g:255,b:255}): void {
        this.assertAlive();
        if (!this.document) throw new Error('No active image');
        if (cut && merged) throw new Error('Merged cut is not supported');
        const pixels = cut ? this.document.cutPixels(backgroundColor) : this.document.copyPixels(merged);
        // Commit only on success; failed copy/cut keeps the previous clipboard.
        this.clipboard = pixels;
    }

    paste(inPlace = false): void {
        this.assertAlive();
        if (!this.document) throw new Error('No active image');
        if (!this.clipboard) throw new KlecksOperationRejected('剪贴板中没有可粘贴的图片，请先复制图片内容，或从图片分配导入。');
        this.document.pastePixels(this.clipboard, inPlace);
    }

    /** Snapshot of the internal clipboard for a platform's explicit image-write action. */
    async exportClipboardPng(): Promise<THostExternalPng | null> {
        this.assertAlive();
        if (!this.clipboard) return null;
        const { image } = this.clipboard;
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d')!.putImageData(image, 0, 0);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Clipboard PNG encoding failed')), 'image/png'));
        if (blob.size > 50 * 1024 * 1024) throw new Error('Clipboard PNG exceeds safe size');
        return { bytes: new Uint8Array(await blob.arrayBuffer()), width: image.width, height: image.height };
    }

    /** Capture before awaiting platform clipboard access, not after it returns. */
    captureTarget(): THostPasteTarget {
        this.assertAlive();
        const id = this.activeId, generation = id ? this.generations.get(id) : undefined;
        if (!id || !generation) throw new Error('No active paste target');
        return Object.freeze({ owner: this.owner, id, generation, request: this.openRequest });
    }

    async pasteExternalPng(input: THostExternalPng, target = this.captureTarget(),allow=()=>true): Promise<boolean> {
        const isCurrent = () => !this.destroyed && target.owner === this.owner && target.request === this.openRequest &&
            target.id === this.activeId && this.generations.get(target.id) === target.generation && allow();
        if (!isCurrent()) return false;
        if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > 50 * 1024 * 1024) throw new Error('Clipboard PNG exceeds safe size');
        validateEditorBinaryHeader(input.bytes, 'png', input);
        // Own the bytes before the asynchronous decoder; caller mutation cannot alter the pending paste.
        const blob = new Blob([new Uint8Array(input.bytes)], { type: 'image/png' });
        const width = input.width, height = input.height;
        let bitmap: ImageBitmap;
        try { bitmap = await createImageBitmap(blob); }
        catch (error) { if (!isCurrent()) return false; throw error; }
        try {
            if (!isCurrent()) return false;
            if (bitmap.width !== width || bitmap.height !== height) throw new Error('Clipboard PNG dimensions changed during decoding');
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
            const context = canvas.getContext('2d')!;
            context.drawImage(bitmap, 0, 0);
            this.document!.pastePixels({ image: context.getImageData(0, 0, width, height), x: 0, y: 0 });
            return true;
        } finally { bitmap.close(); }
    }

    /** Business deletion confirmation must precede this incremental reconciliation. */
    sync(ids: readonly string[]): void {
        this.assertAlive();
        if (ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) throw new Error('Invalid document identifiers');
        const removingActive = this.current && !ids.includes(this.current.id);
        // Capture is also the idle guard: fail before changing either collection.
        if (removingActive) this.current!.document.capture();
        const next = new Map(ids.map(id => [id, this.states.get(id) ?? null]));
        if (removingActive) {
            this.current!.document.destroy();
            this.current = null;
        }
        this.states = next;
        this.generations = new Map(ids.map(id => [id, this.generations.get(id) ?? Symbol(id)]));
        for (const id of this.viewports.keys()) if (!next.has(id)) this.viewports.delete(id);
        for (const id of this.cached) if (!next.has(id)) {
            this.cached.delete(id);
            void this.cache?.remove(id).catch(() => {});
        }
    }

    open(id: string, initialize: () => HostDocument): HostDocument {
        this.assertAlive();
        if (!this.states.has(id)) throw new Error('Document no longer exists');
        this.openRequest++;
        if (this.current?.id === id) return this.current.document;
        const previous = this.current;
        const previousState = previous?.document.capture();
        const saved = this.states.get(id);
        if (this.cached.has(id) && !saved) throw new Error('请先恢复该图片的完整编辑会话。');
        // Construct before destroying the previous engine; failure must preserve it.
        const next = saved ? HostDocument.restore(saved) : initialize();
        if (previous && previousState) {
            this.states.set(previous.id, previousState);
            previous.document.destroy();
        }
        this.current = { id, document: next };
        // Internal clipboard is never implicitly reused across unrelated patent cases.
        const scope = id.includes(':') ? id.split(':')[0] : '';
        if (scope !== this.clipboardScope) { this.clipboard = null; this.clipboardScope = scope; }
        // Active state lives in the engine, not in a redundant retained snapshot.
        this.states.set(id, null);
        return next;
    }

    /** Latest target wins; stale decode results are destroyed, never attached to a new generation. */
    openRaster(id: string, name: string, readSource: () => Promise<THostRasterSource>): Promise<HostDocument | null> {
        return this.openAsync(id, async () => HostDocument.fromPng(id, name, await readSource()));
    }

    async openAsync(id: string, initialize: () => Promise<HostDocument>): Promise<HostDocument | null> {
        this.assertAlive();
        if (!this.states.has(id)) throw new Error('Document no longer exists');
        if (this.current?.id === id || this.states.get(id)) return this.open(id, () => { throw new Error('Missing suspended state'); });
        const request = ++this.openRequest;
        const generation = this.generations.get(id);
        const isCurrent = () => !this.destroyed && request === this.openRequest && this.generations.get(id) === generation;
        let decoded: HostDocument;
        try { decoded = await initialize(); }
        catch (error) { if (!isCurrent()) return null; throw error; }
        if (!isCurrent()) { decoded.destroy(); return null; }
        // Capture the previous document now, not before await: edits during decode must survive.
        try { return this.open(id, () => decoded); }
        catch (error) { decoded.destroy(); throw error; }
    }

    cancelPendingOpen(): void { this.assertAlive(); this.openRequest++; }

    destroy(): void {
        if (this.destroyed) return;
        this.current?.document.destroy();
        this.current = null;
        this.states.clear();
        this.cached.clear();
        this.viewports.clear();
        this.clipboard = null;
        this.generations.clear();
        this.openRequest++;
        this.destroyed = true;
    }

    private assertAlive(): void {
        if (this.destroyed) throw new Error('Editor workspace has been destroyed');
    }
}
