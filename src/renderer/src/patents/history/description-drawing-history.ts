import type { AssetDescriptor } from "../../../../shared/document/model";
import type { CanonicalPatent, PatentFigure } from "../../../../shared/patent/model";
import { nextHistoryOrder } from "./history-order";

const MAX_HISTORY_EVENTS = 100;

export type DescriptionDrawingHistorySnapshot = {
  figures: PatentFigure[];
  assets: AssetDescriptor[];
  abstractDrawingFigureId: string | null;
};

export type DescriptionDrawingHistoryState = {
  figures?: PatentFigure[];
  assets?: AssetDescriptor[];
  abstractDrawingFigureId?: string | null;
};

export type DescriptionDrawingEdit = DescriptionDrawingHistorySnapshot;

type HistoryPoint = {
  order: number;
  patentId: string;
  label: string;
  before: DescriptionDrawingHistoryState;
  after: DescriptionDrawingHistoryState;
  ownedAssetIds: string[];
};

type HistoryStacks = {
  undo: HistoryPoint[];
  redo: HistoryPoint[];
};

export type DescriptionDrawingHistoryTransition = {
  label: string;
  edit: DescriptionDrawingEdit;
  direction: "undo" | "redo";
  point: HistoryPoint;
};

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function changedFields(
  before: DescriptionDrawingHistorySnapshot,
  after: DescriptionDrawingHistorySnapshot,
): {
  before: DescriptionDrawingHistoryState;
  after: DescriptionDrawingHistoryState;
  ownedAssetIds: string[];
} {
  const changedBefore: DescriptionDrawingHistoryState = {};
  const changedAfter: DescriptionDrawingHistoryState = {};
  for (const key of ["figures", "assets", "abstractDrawingFigureId"] as const) {
    if (equal(before[key], after[key])) continue;
    Object.assign(changedBefore, { [key]: structuredClone(before[key]) });
    Object.assign(changedAfter, { [key]: structuredClone(after[key]) });
  }
  return {
    before: changedBefore,
    after: changedAfter,
    ownedAssetIds: changedAssetIds(before.assets, after.assets),
  };
}

function isEmpty(state: DescriptionDrawingHistoryState): boolean {
  return Object.keys(state).length === 0;
}

function matchesOwnedFields(
  point: HistoryPoint,
  expected: DescriptionDrawingHistoryState,
  current: DescriptionDrawingHistorySnapshot,
): boolean {
  for (const key of ["figures", "abstractDrawingFigureId"] as const) {
    if (hasOwn(expected, key) && !equal(expected[key], current[key])) return false;
  }
  return (
    !expected.assets || matchesOwnedAssets(expected.assets, current.assets, point.ownedAssetIds)
  );
}

function fillEdit(
  point: HistoryPoint,
  target: DescriptionDrawingHistoryState,
  current: DescriptionDrawingHistorySnapshot,
): DescriptionDrawingEdit {
  return {
    figures: structuredClone(target.figures ?? current.figures),
    assets: target.assets
      ? mergeOwnedAssets(target.assets, current.assets, point.ownedAssetIds)
      : structuredClone(current.assets),
    abstractDrawingFigureId: hasOwn(target, "abstractDrawingFigureId")
      ? (target.abstractDrawingFigureId ?? null)
      : current.abstractDrawingFigureId,
  };
}

function changedAssetIds(
  before: readonly AssetDescriptor[],
  after: readonly AssetDescriptor[],
): string[] {
  const beforeById = new Map(before.map((asset) => [asset.assetId, asset]));
  const afterById = new Map(after.map((asset) => [asset.assetId, asset]));
  return [...new Set([...beforeById.keys(), ...afterById.keys()])].filter(
    (assetId) => !equal(beforeById.get(assetId), afterById.get(assetId)),
  );
}

function matchesOwnedAssets(
  expected: readonly AssetDescriptor[],
  current: readonly AssetDescriptor[],
  ownedAssetIds: readonly string[],
): boolean {
  const expectedById = new Map(expected.map((asset) => [asset.assetId, asset]));
  const currentById = new Map(current.map((asset) => [asset.assetId, asset]));
  return ownedAssetIds.every((assetId) =>
    equal(expectedById.get(assetId), currentById.get(assetId)),
  );
}

function mergeOwnedAssets(
  target: readonly AssetDescriptor[],
  current: readonly AssetDescriptor[],
  ownedAssetIds: readonly string[],
): AssetDescriptor[] {
  const owned = new Set(ownedAssetIds);
  const currentById = new Map(current.map((asset) => [asset.assetId, asset]));
  const merged: AssetDescriptor[] = [];
  const included = new Set<string>();
  for (const targetAsset of target) {
    const asset = owned.has(targetAsset.assetId)
      ? targetAsset
      : currentById.get(targetAsset.assetId);
    if (!asset) continue;
    merged.push(structuredClone(asset));
    included.add(asset.assetId);
  }
  for (const currentAsset of current) {
    if (owned.has(currentAsset.assetId) || included.has(currentAsset.assetId)) continue;
    merged.push(structuredClone(currentAsset));
  }
  return merged;
}

export function captureDescriptionDrawingState(
  patent: CanonicalPatent,
): DescriptionDrawingHistorySnapshot {
  return {
    figures: structuredClone(patent.figures),
    assets: structuredClone(patent.assets),
    abstractDrawingFigureId: patent.abstractDrawingFigureId,
  };
}

export class DescriptionDrawingHistoryManager {
  readonly #history = new Map<string, HistoryStacks>();

  record(input: {
    patentId: string;
    label: string;
    before: DescriptionDrawingHistorySnapshot;
    after: DescriptionDrawingHistorySnapshot;
  }): boolean {
    const fields = changedFields(input.before, input.after);
    if (isEmpty(fields.before)) return false;
    const stacks = this.#stacks(input.patentId);
    stacks.undo.push({
      order: nextHistoryOrder(),
      patentId: input.patentId,
      label: input.label,
      before: fields.before,
      after: fields.after,
      ownedAssetIds: fields.ownedAssetIds,
    });
    if (stacks.undo.length > MAX_HISTORY_EVENTS) {
      stacks.undo.splice(0, stacks.undo.length - MAX_HISTORY_EVENTS);
    }
    stacks.redo = [];
    return true;
  }

  canUndo(patentId: string): boolean {
    return Boolean(this.#history.get(patentId)?.undo.length);
  }

  canRedo(patentId: string): boolean {
    return Boolean(this.#history.get(patentId)?.redo.length);
  }

  takeUndo(patentId: string, patent: CanonicalPatent): DescriptionDrawingHistoryTransition | null {
    return this.#take(patentId, patent, "undo");
  }

  takeRedo(patentId: string, patent: CanonicalPatent): DescriptionDrawingHistoryTransition | null {
    return this.#take(patentId, patent, "redo");
  }

  commitUndo(patentId: string, transition: DescriptionDrawingHistoryTransition): boolean {
    return this.#commit(patentId, transition, "undo");
  }

  commitRedo(patentId: string, transition: DescriptionDrawingHistoryTransition): boolean {
    return this.#commit(patentId, transition, "redo");
  }

  invalidate(patentId: string): void {
    this.#history.delete(patentId);
  }

  order(patentId: string, patent: CanonicalPatent, direction: "undo" | "redo"): number {
    const point = this.#history.get(patentId)?.[direction].at(-1);
    if (!point) return 0;
    const expected = direction === "undo" ? point.after : point.before;
    return matchesOwnedFields(point, expected, patent) ? point.order : 0;
  }

  discardRedo(patentId: string): void {
    const stacks = this.#history.get(patentId);
    if (stacks) stacks.redo = [];
  }

  #stacks(patentId: string): HistoryStacks {
    const existing = this.#history.get(patentId);
    if (existing) return existing;
    const created = { undo: [], redo: [] };
    this.#history.set(patentId, created);
    return created;
  }

  #take(
    patentId: string,
    patent: CanonicalPatent,
    direction: "undo" | "redo",
  ): DescriptionDrawingHistoryTransition | null {
    const stack = this.#history.get(patentId)?.[direction];
    const point = stack?.at(-1);
    if (!point) return null;
    const current = captureDescriptionDrawingState(patent);
    const expected = direction === "undo" ? point.after : point.before;
    if (!matchesOwnedFields(point, expected, current)) return null;
    const target = direction === "undo" ? point.before : point.after;
    return { label: point.label, edit: fillEdit(point, target, current), direction, point };
  }

  #commit(
    patentId: string,
    transition: DescriptionDrawingHistoryTransition,
    direction: "undo" | "redo",
  ): boolean {
    if (transition.direction !== direction) return false;
    const stacks = this.#history.get(patentId);
    if (!stacks) return false;
    const source = stacks[direction];
    if (source.at(-1) !== transition.point) return false;
    source.pop();
    transition.point.order = nextHistoryOrder();
    const destination = direction === "undo" ? stacks.redo : stacks.undo;
    destination.push(transition.point);
    if (destination.length > MAX_HISTORY_EVENTS) destination.shift();
    return true;
  }
}
