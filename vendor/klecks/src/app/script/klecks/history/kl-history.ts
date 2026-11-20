import { THistoryEntry, THistoryEntryData, THistoryEntryDataComposed } from './history.types';
import { composeHistoryStateData } from './compose-history-state-data';
import { estimateBytes, retainedHistoryPixelBytes } from './estimate-bytes';
import { entryCausesChange } from './entry-causes-change';
import { getTotalMemoryBytes, trimOldestEntries } from './trim-oldest-entries';
import { validateHistoryEntry } from './validate-history-entry';
import { THostHistoryPolicy, trimHostHistory, validateHostHistoryPolicy } from './host-history-policy';

/*
todo memory could be better limited.
When pushing, all entries and the new entry are in memory which already exceeds the limit.
You can potentially be 268.44 MB over the memory limit.
The new entry should only be created after freeing up some space in entries.
 */

// tied to indexed db. don't change.
export const HISTORY_TILE_SIZE = 256;

export type TKlHistoryListener = () => void;

export type TKlHistoryParams = {
    oldest: THistoryEntryDataComposed;
    hostPolicy?: THostHistoryPolicy;
};

const HISTORY_DEBUGGING = false;

/** Host-owned, in-memory snapshot. Not a persistent file format or untrusted input. */
export type TKlHistorySnapshot = {
    version: 1;
    entries: THistoryEntry[];
    index: number;
    totalActions: number;
    hostPolicy?: THostHistoryPolicy;
};

export class KlHistory {
    private entries: THistoryEntry[]; // diffs or what changed each step. 0 is oldest
    private index: number = 0; // current action the user is on.
    private composed: THistoryEntryDataComposed; // all diffs until current action combined

    private totalActions: number = 0;
    private changeCount: number = 0; // number keeps incrementing with each change (push, undo, redo)
    private pauseStack: number = 0; // how often paused without unpause. push does nothing when paused.
    private readonly listeners: TKlHistoryListener[] = []; // broadcasts on undo, redo, push
    private hostPolicy?: THostHistoryPolicy;
    private undoAdmissionFailure:(()=>never)|undefined;
    setUndoAdmissionFailure(callback:()=>never):void{this.undoAdmissionFailure=callback;}

    private broadcast(): void {
        this.changeCount++;
        setTimeout(() => {
            for (let i = 0; i < this.listeners.length; i++) {
                this.listeners[i]();
            }
        });
    }

    private updateComposed(): void {
        this.composed = composeHistoryStateData(
            this.entries.slice(0, this.index + 1).map((item) => item.data),
        );
    }

    // ----------------------------------- public -----------------------------------
    constructor(p: TKlHistoryParams) {
        if (p.hostPolicy) this.setHostPolicy(p.hostPolicy);
        validateHistoryEntry(p.oldest, p.oldest.size);
        this.entries = [
            {
                timestamp: Date.now(),
                memoryEstimateBytes: estimateBytes(p.oldest),
                data: p.oldest,
            },
        ];
        this.composed = p.oldest;
        if (HISTORY_DEBUGGING) {
            (window as any).getHistoryEntries = () => this.entries;
        }
    }

    /**
     * Needed, because sometimes there are actions that would cause other undo steps.
     * For example a filter that does something with two layers and then merges them.
     * That should be a single undo step, and prevent merging from creating its own undo step.
     * Pause prevents creation of unintended undo steps.
     */
    pause(b: boolean): void {
        if (b) {
            this.pauseStack++;
        } else {
            this.pauseStack = Math.max(0, this.pauseStack - 1);
        }
    }

    /**
     * listens to changes - on undo, redo, push
     */
    addListener(l: TKlHistoryListener): void {
        this.listeners.push(l);
    }

    // doesn't push if: paused or if entry is empty
    push(entryData: THistoryEntryData, replaceTop?: boolean): void {
        if (this.pauseStack > 0) {
            return;
        }
        if (Object.keys(entryData).length === 0) {
            // no change -> noop
            return;
        }
        validateHistoryEntry(entryData, this.composed.size);
        if(this.undoAdmissionFailure&&!this.canRetainUndo(entryData))this.undoAdmissionFailure();
        const entry: THistoryEntry = {
            timestamp: Date.now(),
            memoryEstimateBytes: estimateBytes(entryData),
            data: entryData,
        };
        if (this.hostPolicy) {
            const active=entryData.activeLayerId??this.composed.activeLayerId;
            const selected=this.getSelectedLayers().filter(id=>!!(entryData.layerMap??this.composed.layerMap)[id]);
            entry.hostSelectedLayerIds=selected.includes(active)||!selected.length&&active===this.composed.activeLayerId?selected:[active];
        }

        if (replaceTop && this.index > 0) {
            this.index--;
            // remove current top
            while (this.index < this.entries.length - 1) {
                this.entries.pop();
            }
            // it's possible that new entry replacing top is same to composed history
            // e.g. toggle layer visibility twice
            const isDifferent = entryCausesChange(
                entryData,
                composeHistoryStateData(
                    this.entries.slice(0, this.index + 1).map((item) => item.data),
                ),
            );
            // only need to push if it's different
            isDifferent && this.entries.push(entry);
        } else {
            while (this.index < this.entries.length - 1) {
                this.entries.pop();
            }
            this.entries.push(entry);
        }

        this.entries = this.hostPolicy ? trimHostHistory(this.entries, this.hostPolicy) : trimOldestEntries(this.entries);
        if (HISTORY_DEBUGGING) {
            const totalBytes = getTotalMemoryBytes(this.entries);
            console.log(
                `[KlHistory] pushed ${(entry.memoryEstimateBytes / 1e6).toFixed(1)} MB — total: ${(totalBytes / 1e6).toFixed(1)} MB (${this.entries.length} entries)`,
            );
        }
        this.totalActions++;
        this.index = this.entries.length - 1;
        this.updateComposed();
        this.broadcast();
    }

    increaseIndex(): THistoryEntry {
        if (this.canRedo()) {
            this.index++;
        }
        this.updateComposed();
        this.broadcast();
        return this.entries[this.index];
    }

    decreaseIndex(): THistoryEntry {
        if (this.canUndo()) {
            this.index--;
        }
        this.updateComposed();
        this.broadcast();
        return this.entries[this.index];
    }

    canUndo(): boolean {
        return this.index > 0;
    }

    canRedo(): boolean {
        return this.index < this.entries.length - 1;
    }

    getEntries(): THistoryEntry[] {
        return this.entries.slice(0, this.index + 1);
    }

    getRetainedPixelBytes(): number { return retainedHistoryPixelBytes(this.entries); }
    /** Admission check for operations that promise immediate undo; no entries or redo state are mutated. */
    canRetainUndo(entryData:THistoryEntryData):boolean{
        return !this.hostPolicy||estimateBytes(this.composed)+estimateBytes(entryData)<=this.hostPolicy.maxEstimatedBytes;
    }

    setHostPolicy(policy: THostHistoryPolicy): void {
        validateHostHistoryPolicy(policy);
        this.hostPolicy = { ...policy };
    }
    getHostPolicy():THostHistoryPolicy|undefined{return this.hostPolicy?{...this.hostPolicy}:undefined;}

    exportSnapshot(): TKlHistorySnapshot {
        if (this.isPaused()) throw new Error('Cannot suspend an unfinished history operation');
        return structuredClone({
            version: 1 as const,
            entries: this.entries,
            index: this.index,
            totalActions: this.totalActions,
            hostPolicy: this.hostPolicy,
        });
    }

    static fromSnapshot(input: TKlHistorySnapshot): KlHistory {
        if (input.version !== 1 || !input.entries.length ||
            !Number.isInteger(input.index) || input.index < 0 || input.index >= input.entries.length ||
            !Number.isSafeInteger(input.totalActions) || input.totalActions < 0) {
            throw new Error('Invalid host history snapshot');
        }
        const snapshot = structuredClone(input);
        const history = new KlHistory({
            oldest: composeHistoryStateData([snapshot.entries[0].data]),
            hostPolicy: snapshot.hostPolicy,
        });
        history.entries = snapshot.entries;
        history.index = snapshot.index;
        history.totalActions = snapshot.totalActions;
        history.updateComposed();
        return history;
    }

    getComposed(): THistoryEntryDataComposed {
        return this.composed;
    }

    /** Layer focus is workspace metadata, not an undo step. Never discard the redo branch. */
    setActiveLayer(id: string, selected: readonly string[] = [id]): void {
        if (!this.composed.layerMap[id]) throw new Error('Missing focused layer');
        if (new Set(selected).size!==selected.length || selected.length>16 || selected.some(id=>!this.composed.layerMap[id]) || selected.length>0&&!selected.includes(id)) throw new Error('Invalid focused layers');
        this.entries[this.index].data = { ...this.entries[this.index].data, activeLayerId: id };
        this.entries[this.index].hostSelectedLayerIds =
            this.hostPolicy && selected.length === 0 && Object.keys(this.composed.layerMap).length === 1
                ? [id]
                : selected.slice();
        this.composed = { ...this.composed, activeLayerId: id };
    }

    getSelectedLayers(): string[] {
        const active=this.composed.activeLayerId,ids=this.entries[this.index].hostSelectedLayerIds;
        // Old saves and undo entries can still contain an explicit empty selection.
        if (this.hostPolicy && ids?.length === 0 && Object.keys(this.composed.layerMap).length === 1)
            return [active];
        if (!ids) return [active];
        const selected=ids.filter(id=>!!this.composed.layerMap[id]);
        return ids.length===0 || selected.includes(active) ? selected : [active];
    }

    getChangeCount(): number {
        return this.changeCount;
    }

    getTotalIndex(): number {
        return this.totalActions;
    }

    isPaused(): boolean {
        return this.pauseStack > 0;
    }
}
