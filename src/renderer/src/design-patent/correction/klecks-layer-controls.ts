export type KlecksLayerLocks = {
  all: boolean;
  pixels: boolean;
  position: boolean;
  alpha: boolean;
};
export type KlecksLayerState = {
  mask?: { enabled: boolean; linked: boolean; active: boolean; view: boolean; thumbnail?: string };
  id: string;
  name: string;
  opacity: number;
  visible: boolean;
  background: boolean;
  locks: KlecksLayerLocks;
  thumbnail?: string;
};
export type KlecksLayerCommand =
  | {
      action: "layer";
      operation: "mask";
      id: string;
      maskOperation:
        | "add"
        | "addHide"
        | "target"
        | "image"
        | "view"
        | "toggle"
        | "link"
        | "delete"
        | "apply"
        | "invert"
        | "selection";
    }
  | { action: "layer"; operation: "selectMany"; id: string; ids: string[] }
  | {
      action: "layer";
      operation: "deleteMany" | "duplicateMany" | "mergeMany" | "stampMany";
      ids: string[];
    }
  | { action: "layer"; operation: "solo"; id: string }
  | { action: "layer"; operation: "new"; name: string }
  | {
      action: "layer";
      operation: "select" | "delete" | "duplicate" | "mergeDown";
      id: string;
    }
  | {
      action: "layer";
      operation: "rename" | "backgroundToLayer";
      id: string;
      name: string;
    }
  | {
      action: "layer";
      operation: "opacity";
      id: string;
      ids?: string[];
      opacity: number;
    }
  | { action: "layer"; operation: "visibility"; id: string; visible: boolean }
  | {
      action: "layer";
      operation: "move";
      id: string;
      ids?: string[];
      index: number;
    }
  | {
      action: "layer";
      operation: "locks";
      id: string;
      ids?: string[];
      locks: Partial<KlecksLayerLocks>;
    };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 200;
export function isKlecksLayerLocks(value: unknown): value is KlecksLayerLocks {
  return (
    record(value) &&
    exact(value, ["all", "pixels", "position", "alpha"]) &&
    Object.values(value).every((item) => typeof item === "boolean")
  );
}
export function isKlecksLayerState(value: unknown): value is KlecksLayerState {
  return (
    record(value) &&
    exact(value, [
      "id",
      "name",
      "opacity",
      "visible",
      "background",
      "locks",
      ...(Object.hasOwn(value, "thumbnail") ? ["thumbnail"] : []),
      ...(Object.hasOwn(value, "mask") ? ["mask"] : []),
    ]) &&
    (value.thumbnail === undefined ||
      (typeof value.thumbnail === "string" &&
        value.thumbnail.length <= 32768 &&
        /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.thumbnail))) &&
    (value.mask === undefined ||
      (record(value.mask) &&
        exact(value.mask, [
          "enabled",
          "linked",
          "active",
          "view",
          ...(Object.hasOwn(value.mask, "thumbnail") ? ["thumbnail"] : []),
        ]) &&
        [value.mask.enabled, value.mask.linked, value.mask.active, value.mask.view].every(
          (v) => typeof v === "boolean",
        ) &&
        (value.mask.thumbnail === undefined ||
          (typeof value.mask.thumbnail === "string" &&
            value.mask.thumbnail.length <= 32768 &&
            /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.mask.thumbnail))))) &&
    text(value.id) &&
    typeof value.name === "string" &&
    value.name.length <= 200 &&
    typeof value.opacity === "number" &&
    Number.isFinite(value.opacity) &&
    value.opacity >= 0 &&
    value.opacity <= 1 &&
    typeof value.visible === "boolean" &&
    typeof value.background === "boolean" &&
    isKlecksLayerLocks(value.locks)
  );
}
export function isKlecksLayerCommand(value: unknown): value is KlecksLayerCommand {
  if (!record(value) || value.action !== "layer") return false;
  const hasIds = Object.hasOwn(value, "ids");
  if (
    hasIds &&
    (!Array.isArray(value.ids) ||
      (value.operation !== "selectMany" && value.ids.length < 1) ||
      value.ids.length > 16 ||
      !value.ids.every(text) ||
      new Set(value.ids).size !== value.ids.length)
  )
    return false;
  if (["deleteMany", "duplicateMany", "mergeMany", "stampMany"].includes(value.operation as string))
    return hasIds && exact(value, ["action", "operation", "ids"]);
  if (value.operation === "selectMany")
    return (
      hasIds &&
      text(value.id) &&
      (!(value.ids as string[]).length || (value.ids as string[]).includes(value.id)) &&
      exact(value, ["action", "operation", "id", "ids"])
    );
  if (value.operation === "new")
    return exact(value, ["action", "operation", "name"]) && text(value.name);
  if (!text(value.id)) return false;
  if (value.operation === "mask")
    return (
      exact(value, ["action", "operation", "id", "maskOperation"]) &&
      [
        "add",
        "addHide",
        "target",
        "image",
        "view",
        "toggle",
        "link",
        "delete",
        "apply",
        "invert",
        "selection",
      ].includes(value.maskOperation as string)
    );
  if (["select", "delete", "duplicate", "mergeDown", "solo"].includes(value.operation as string))
    return exact(value, ["action", "operation", "id"]);
  if (value.operation === "rename" || value.operation === "backgroundToLayer")
    return exact(value, ["action", "operation", "id", "name"]) && text(value.name);
  if (value.operation === "visibility")
    return (
      exact(value, ["action", "operation", "id", "visible"]) && typeof value.visible === "boolean"
    );
  if (value.operation === "opacity")
    return (
      exact(value, ["action", "operation", "id", "opacity", ...(hasIds ? ["ids"] : [])]) &&
      typeof value.opacity === "number" &&
      Number.isFinite(value.opacity) &&
      value.opacity >= 0 &&
      value.opacity <= 1
    );
  if (value.operation === "move")
    return (
      exact(value, ["action", "operation", "id", "index", ...(hasIds ? ["ids"] : [])]) &&
      Number.isSafeInteger(value.index) &&
      (value.index as number) >= 0 &&
      (value.index as number) < 16
    );
  return (
    value.operation === "locks" &&
    exact(value, ["action", "operation", "id", "locks", ...(hasIds ? ["ids"] : [])]) &&
    record(value.locks) &&
    Object.keys(value.locks).length > 0 &&
    Object.entries(value.locks).every(
      ([key, item]) =>
        ["all", "pixels", "position", "alpha"].includes(key) && typeof item === "boolean",
    )
  );
}
