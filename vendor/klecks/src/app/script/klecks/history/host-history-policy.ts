import type { THistoryEntry } from './history.types';
import { composeHistoryStateData } from './compose-history-state-data';
import { estimateBytes } from './estimate-bytes';

export type THostHistoryPolicy = { maxUndoSteps: number; maxEstimatedBytes: number };
export const DEFAULT_HOST_HISTORY_POLICY: Readonly<THostHistoryPolicy> = Object.freeze({ maxUndoSteps: 100, maxEstimatedBytes: 128 * 1024 ** 2 });
export function validateHostHistoryPolicy(policy: THostHistoryPolicy): void {
    if (!Number.isSafeInteger(policy.maxUndoSteps) || policy.maxUndoSteps < 1 || policy.maxUndoSteps > 1000 ||
        !Number.isSafeInteger(policy.maxEstimatedBytes) || policy.maxEstimatedBytes < 1) throw new Error('Invalid host history policy');
}

/** Only called after a new push has discarded its obsolete redo branch.
 * The oldest retained state is materialized, never deleted. An oversized single
 * base cannot be compacted further; workspace admission handles that footprint.
 */
export function trimHostHistory(input: readonly THistoryEntry[], policy: THostHistoryPolicy): THistoryEntry[] {
    validateHostHistoryPolicy(policy);
    if (!input.length) throw new Error('History must retain a base state');
    let entries = [...input];
    let total = entries.reduce((sum, entry) => sum + entry.memoryEstimateBytes, 0);
    while (entries.length > 1 && (entries.length - 1 > policy.maxUndoSteps || total > policy.maxEstimatedBytes)) {
        const previous = entries[1];
        const data = composeHistoryStateData([entries[0].data, previous.data]);
        const memoryEstimateBytes = estimateBytes(data);
        total += memoryEstimateBytes - entries[0].memoryEstimateBytes - previous.memoryEstimateBytes;
        entries = [{ timestamp: previous.timestamp, memoryEstimateBytes, description: 'oldest', data,
            ...(previous.hostSelectedLayerIds?{hostSelectedLayerIds:previous.hostSelectedLayerIds.slice()}:{}),
        }, ...entries.slice(2)];
    }
    return entries;
}
