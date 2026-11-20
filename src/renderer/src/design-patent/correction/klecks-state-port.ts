import { type ToneState, ToneStateSchema } from "../../../../shared/settings/design-tone";
import { type ColorRangeState, isColorRangeState } from "./klecks-color-range-state";
import type { KlecksPortIdentity } from "./klecks-command-port";
import { isKlecksLayerState, type KlecksLayerState } from "./klecks-layer-controls";
import {
  isKlecksToolCommand,
  type KlecksBrush,
  type KlecksSelectionOptions,
  type KlecksTool,
} from "./klecks-tool-port";
import type { KlecksTransformBounds, KlecksTransformMatrix } from "./klecks-transform";
import { type WhitespaceState, WhitespaceStateSchema } from "./klecks-whitespace-state";

export type KlecksEditorControls = {
  bucket?: import("../../../../shared/settings/design-fill").BucketOptions;
  magicWand?: import("./klecks-magic-wand").MagicWandOptions;
  colors: {
    foreground: KlecksBrush["color"];
    background: KlecksBrush["color"];
  };
  sampleSource: "current" | "merged";
  autoSelect: boolean;
  transformLinked: boolean;
  cursor: { tip: "normal" | "full" | "precise"; crosshair: boolean };
  navigation: {
    mode: "marquee" | "scrubby";
    center: boolean;
    wheel: boolean;
    pixelGrid: boolean;
    selectionEdges: boolean;
  };
  selection: KlecksSelectionOptions;
  crop: { left: number; top: number; width: number; height: number } | null;
  transform: {
    bounds: KlecksTransformBounds;
    matrix: KlecksTransformMatrix;
    target: "pixels" | "selection";
  } | null;
  deletePixels: boolean;
};

export type KlecksEditorState = {
  canUndo?: boolean;
  canRedo?: boolean;
  whitespace?: WhitespaceState | null;
  tone?: ToneState | null;
  fill?: { dialog: boolean; busy: boolean; error: string } | null;
  colorRange?: ColorRangeState | null;
  wandBusy?: boolean;
  preferences?: import("../../../../shared/settings/design-editor-preferences").DesignEditorPreferences;
  controls?: KlecksEditorControls;
  identity: KlecksPortIdentity | null;
  activeId: string | null;
  ids: string[];
  dirty: boolean;
  selectionDirty?: boolean;
  unapplied: boolean;
  pending: boolean;
  hasSelection?: boolean;
  /** Viewport gesture only; pending still protects saves and document commands. */
  navigationActive?: boolean;
  locked: boolean;
  checkpointRevision: number;
  tool: KlecksTool;
  zoom: number | null;
  size: { width: number; height: number } | null;
  brush: KlecksBrush;
  activeLayerId: string | null;
  selectedLayerIds?: string[];
  layers: KlecksLayerState[];
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200;
export function isKlecksEditorState(value: unknown): value is KlecksEditorState {
  if (
    !record(value) ||
    !exact(value, [
      ...(Object.hasOwn(value, "controls") ? ["controls"] : []),
      ...(Object.hasOwn(value, "preferences") ? ["preferences"] : []),
      ...(Object.hasOwn(value, "wandBusy") ? ["wandBusy"] : []),
      ...(Object.hasOwn(value, "colorRange") ? ["colorRange"] : []),
      ...(Object.hasOwn(value, "fill") ? ["fill"] : []),
      ...(Object.hasOwn(value, "whitespace") ? ["whitespace"] : []),
      ...(Object.hasOwn(value, "tone") ? ["tone"] : []),
      ...(Object.hasOwn(value, "canUndo") ? ["canUndo"] : []),
      ...(Object.hasOwn(value, "canRedo") ? ["canRedo"] : []),
      "identity",
      "activeId",
      "ids",
      "dirty",
      ...(Object.hasOwn(value, "selectionDirty") ? ["selectionDirty"] : []),
      "unapplied",
      "pending",
      ...(Object.hasOwn(value, "hasSelection") ? ["hasSelection"] : []),
      ...(Object.hasOwn(value, "navigationActive") ? ["navigationActive"] : []),
      "locked",
      "checkpointRevision",
      "tool",
      "zoom",
      "size",
      "brush",
      "activeLayerId",
      ...(Object.hasOwn(value, "selectedLayerIds") ? ["selectedLayerIds"] : []),
      "layers",
    ]) ||
    (value.selectionDirty !== undefined && typeof value.selectionDirty !== "boolean") ||
    (value.wandBusy !== undefined && typeof value.wandBusy !== "boolean") ||
    (value.colorRange !== undefined &&
      value.colorRange !== null &&
      !isColorRangeState(value.colorRange)) ||
    (value.whitespace !== undefined &&
      value.whitespace !== null &&
      !WhitespaceStateSchema.safeParse(value.whitespace).success) ||
    (value.tone !== undefined &&
      value.tone !== null &&
      !ToneStateSchema.safeParse(value.tone).success) ||
    (value.fill !== undefined &&
      value.fill !== null &&
      (!record(value.fill) ||
        !exact(value.fill, ["dialog", "busy", "error"]) ||
        typeof value.fill.dialog !== "boolean" ||
        typeof value.fill.busy !== "boolean" ||
        typeof value.fill.error !== "string" ||
        value.fill.error.length > 500)) ||
    !Array.isArray(value.ids) ||
    value.ids.length > 500 ||
    !value.ids.every(text) ||
    new Set(value.ids).size !== value.ids.length ||
    !Number.isSafeInteger(value.checkpointRevision) ||
    (value.checkpointRevision as number) < 0 ||
    ![value.dirty, value.unapplied, value.pending, value.locked].every(
      (item) => typeof item === "boolean",
    ) ||
    !isKlecksToolCommand({ action: "tool", tool: value.tool }) ||
    !record(value.brush) ||
    !isKlecksToolCommand({ action: "brush", ...value.brush }) ||
    Object.hasOwn(value.brush, "action")
  )
    return false;
  if (Object.hasOwn(value, "hasSelection") && typeof value.hasSelection !== "boolean") return false;
  if (
    Object.hasOwn(value, "navigationActive") &&
    (typeof value.navigationActive !== "boolean" || (value.navigationActive && !value.pending))
  )
    return false;
  if (
    (value.canUndo !== undefined && typeof value.canUndo !== "boolean") ||
    (value.canRedo !== undefined && typeof value.canRedo !== "boolean")
  )
    return false;
  if (value.controls !== undefined && !isKlecksEditorControls(value.controls)) return false;
  if (
    value.preferences !== undefined &&
    !isKlecksToolCommand({ action: "preferences", value: value.preferences })
  )
    return false;
  if (
    value.zoom !== null &&
    (typeof value.zoom !== "number" || !Number.isFinite(value.zoom) || value.zoom <= 0)
  )
    return false;
  if (
    !Array.isArray(value.layers) ||
    value.layers.length > 16 ||
    !value.layers.every(isKlecksLayerState) ||
    new Set(value.layers.map((layer) => layer.id)).size !== value.layers.length
  )
    return false;
  if (value.activeId === null)
    return (
      value.identity === null &&
      value.size === null &&
      value.activeLayerId === null &&
      value.layers.length === 0 &&
      (value.selectedLayerIds === undefined ||
        (Array.isArray(value.selectedLayerIds) && value.selectedLayerIds.length === 0))
    );
  if (!value.layers.some((layer) => layer.id === value.activeLayerId)) return false;
  const layerIds = value.layers.map((layer) => layer.id);
  if (
    value.selectedLayerIds !== undefined &&
    (!Array.isArray(value.selectedLayerIds) ||
      value.selectedLayerIds.length > 16 ||
      new Set(value.selectedLayerIds).size !== value.selectedLayerIds.length ||
      (value.selectedLayerIds.length > 0 &&
        !value.selectedLayerIds.includes(value.activeLayerId)) ||
      !value.selectedLayerIds.every((id) => layerIds.includes(id)))
  )
    return false;
  const id = value.identity,
    size = value.size;
  return (
    text(value.activeId) &&
    value.ids.includes(value.activeId) &&
    record(id) &&
    exact(id, ["sessionId", "viewId", "generation"]) &&
    text(id.sessionId) &&
    id.viewId === value.activeId &&
    Number.isSafeInteger(id.generation) &&
    (id.generation as number) > 0 &&
    record(size) &&
    exact(size, ["width", "height"]) &&
    [size.width, size.height].every(
      (item) => typeof item === "number" && Number.isSafeInteger(item) && item > 0 && item <= 10000,
    ) &&
    (size.width as number) * (size.height as number) <= 40000000
  );
}
export function isKlecksEditorControls(value: unknown): value is KlecksEditorControls {
  if (
    !record(value) ||
    !exact(value, [
      ...(Object.hasOwn(value, "magicWand") ? ["magicWand"] : []),
      ...(Object.hasOwn(value, "bucket") ? ["bucket"] : []),
      "cursor",
      "colors",
      "sampleSource",
      "autoSelect",
      "transformLinked",
      "navigation",
      "selection",
      "crop",
      "transform",
      "deletePixels",
    ]) ||
    (value.magicWand !== undefined &&
      (!record(value.magicWand) ||
        !isKlecksToolCommand({ action: "wandOptions", ...value.magicWand }))) ||
    (value.bucket !== undefined &&
      !isKlecksToolCommand({ action: "bucketOptions", options: value.bucket })) ||
    typeof value.transformLinked !== "boolean" ||
    !record(value.cursor) ||
    Object.hasOwn(value.cursor, "action") ||
    !isKlecksToolCommand({ action: "cursor", ...value.cursor }) ||
    !record(value.colors) ||
    Object.hasOwn(value.colors, "action") ||
    !isKlecksToolCommand({ action: "colors", ...value.colors }) ||
    !["current", "merged"].includes(value.sampleSource as string) ||
    typeof value.autoSelect !== "boolean" ||
    typeof value.deletePixels !== "boolean" ||
    !record(value.navigation) ||
    Object.hasOwn(value.navigation, "action") ||
    !isKlecksToolCommand({ action: "navigation", ...value.navigation }) ||
    !record(value.selection) ||
    Object.hasOwn(value.selection, "action") ||
    !isKlecksToolCommand({ action: "selectionOptions", ...value.selection })
  )
    return false;
  if (
    value.crop !== null &&
    !isKlecksToolCommand({
      action: "crop",
      operation: "preview",
      rect: value.crop,
      deletePixels: value.deletePixels,
    })
  )
    return false;
  if (value.transform !== null) {
    const t = value.transform;
    if (
      !record(t) ||
      !exact(t, ["bounds", "matrix", "target"]) ||
      !["pixels", "selection"].includes(t.target as string) ||
      !record(t.bounds) ||
      !exact(t.bounds, ["left", "top", "width", "height"]) ||
      !Object.values(t.bounds).every(
        (x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 100000,
      ) ||
      !(Number(t.bounds.width) > 0 && Number(t.bounds.height) > 0) ||
      !isKlecksToolCommand({
        action: "transform",
        operation: "preview",
        matrix: t.matrix,
      })
    )
      return false;
  }
  return true;
}
export function createKlecksStateClient(port: MessagePort) {
  let latest: KlecksEditorState | null = null,
    sequence = 0,
    closed = false;
  const listeners = new Set<(state: KlecksEditorState | null) => void>();
  const snapshot = () => (latest ? structuredClone(latest) : null);
  const receive = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (
      closed ||
      !record(data) ||
      !exact(data, ["type", "version", "sequence", "state"]) ||
      data.type !== "klecks:state" ||
      data.version !== 1 ||
      !Number.isSafeInteger(data.sequence) ||
      (data.sequence as number) <= sequence ||
      !isKlecksEditorState(data.state)
    )
      return;
    sequence = data.sequence as number;
    latest = structuredClone(data.state);
    for (const listener of listeners) {
      try {
        listener(snapshot());
      } catch {
        /* One view cannot interrupt other subscribers. */
      }
    }
  };
  port.addEventListener("message", receive);
  port.start();
  return {
    snapshot,
    subscribe(listener: (state: KlecksEditorState | null) => void) {
      if (closed) return () => {};
      listeners.add(listener);
      listener(snapshot());
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      port.removeEventListener("message", receive);
      listeners.clear();
      latest = null;
    },
  };
}
