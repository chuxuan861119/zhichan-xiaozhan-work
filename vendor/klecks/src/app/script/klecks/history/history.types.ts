import { MultiPolygon } from 'polygon-clipping';
import { TLayerFill, TMixMode } from '../kl-types';
import type { DesignSelectionCoverage } from '../../../../../../../src/shared/patent/design-selection-coverage';

export type TLayerId = string;
export type THostLayerLocks = { all: boolean; pixels: boolean; position: boolean; alpha: boolean };
export type THostLayerMask = { x:number; y:number; width:number; height:number; outside:0|255; enabled:boolean; linked:boolean; tiles:THistoryEntryLayerTile[] };
export type TImageDataTile = {
    id: string;
    /*
    // unix timestamp
    timestamp: number;
     */
    data: ImageData;
};
// image data, or a fill color
// can be transparent: {fill: 'transparent'} -> useful if empty layer
export type THistoryEntryLayerTile = TImageDataTile | TLayerFill;
export type THistoryEntryLayer = {
    hostBackground?: boolean;
    hostBacking?: { x: number; y: number; width: number; height: number; tiles: THistoryEntryLayerTile[] } | null;
    hostLocks?: THostLayerLocks;
    hostMask?: THostLayerMask | null;
    // if layer exists but did not change, must be in the layerMap. object can be empty

    // if name changed
    name?: string;

    // if opacity changed
    opacity?: number;

    // if visibility changed
    isVisible?: boolean;

    // if blend mode changed
    mixModeStr?: TMixMode;

    // if clipping changed
    hasClipping?: boolean;

    // if index changed (did it move up or down)
    index?: number;

    // if contents changed
    tiles?: (THistoryEntryLayerTile | undefined)[]; // undefined if tile did not change
};
export type THistoryEntryData = {
    // if project changed
    projectId?: {
        value: string; // uuid
    };

    // if size changed
    size?: {
        width: number;
        height: number;
    };

    // if selection changed
    selection?: {
        coverage?: DesignSelectionCoverage;
        value?: MultiPolygon;
        feather?: number;
        antiAlias?: boolean;
        previous?: { value: MultiPolygon; feather?: number; antiAlias?: boolean; coverage?: DesignSelectionCoverage };
    };

    // if active layer changed
    activeLayerId?: string;

    // if layers changed
    // map, so can quickly project through
    layerMap?: Record<TLayerId, THistoryEntryLayer>;
};

export type THistoryEntry = {
    /** Host-only focus metadata; selecting layers does not create an undo action. */
    hostSelectedLayerIds?: string[];
    timestamp: number; // maybe for comparing with indexedDB?
    memoryEstimateBytes: number;
    description?: string; // human-readable description of the action. e.g. 'brush stroke'
    data: THistoryEntryData;
};

export type THistoryEntryLayerComposed = Omit<Required<THistoryEntryLayer>, 'tiles' | 'hostLocks' | 'hostBacking' | 'hostBackground' | 'hostMask'> & {
    hostMask?: THostLayerMask | null;
    hostBackground?: boolean;
    hostBacking?: THistoryEntryLayer['hostBacking'];
    hostLocks?: THostLayerLocks;
    tiles: THistoryEntryLayerTile[];
};

export type THistoryEntryDataComposed = Omit<Required<THistoryEntryData>, 'layerMap'> & {
    layerMap: Record<TLayerId, THistoryEntryLayerComposed>;
};
