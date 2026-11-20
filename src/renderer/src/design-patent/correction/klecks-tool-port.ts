import {
  type AutoTrimOptions,
  AutoTrimOptionsSchema,
} from "../../../../shared/settings/design-auto-trim";
import {
  type ColorRangeOptions,
  ColorRangeOptionsSchema,
} from "../../../../shared/settings/design-color-range";
import {
  type DesignEditorPreferences,
  DesignEditorPreferencesSchema,
  DesignMagicWandOptionsSchema,
} from "../../../../shared/settings/design-editor-preferences";
import {
  type BucketOptions,
  BucketOptionsSchema,
  type FillOptions,
  FillOptionsSchema,
} from "../../../../shared/settings/design-fill";
import { type ToneOptions, ToneOptionsSchema } from "../../../../shared/settings/design-tone";
import {
  type WhitespaceOptions,
  WhitespaceOptionsSchema,
} from "../../../../shared/settings/design-whitespace";
import type { KlecksPortIdentity, PortCode } from "./klecks-command-port";
import { isKlecksLayerCommand, type KlecksLayerCommand } from "./klecks-layer-controls";
import type { MagicWandOptions } from "./klecks-magic-wand";
import { KlecksOperationRejected } from "./klecks-operation-error";
import { isKlecksResourceLimit, KLECKS_RESOURCE_LIMIT_MESSAGE } from "./klecks-resource-budget";
import type { KlecksTransformMatrix } from "./klecks-transform";

export type KlecksTool =
  | "brush"
  | "clone"
  | "blur"
  | "eraser"
  | "hand"
  | "zoom"
  | "eyedropper"
  | "move"
  | "crop"
  | "rectangle"
  | "ellipse"
  | "lasso"
  | "polygon"
  | "magicWand"
  | "bucket";
// Bucket is a single-click pixel operation, not a selection tool.
export type KlecksBrush = {
  size: number;
  opacity: number;
  flow: number;
  hardness: number;
  color: { r: number; g: number; b: number };
};
export type KlecksToolCommand =
  | { action: "autoTrim"; options: AutoTrimOptions }
  | { action: "retouchOptions"; aligned: boolean; merged: boolean; strength: number }
  | { action: "tone"; operation: "begin"; mode: "levels" | "threshold" }
  | { action: "tone"; operation: "options"; options: ToneOptions }
  | { action: "tone"; operation: "apply" | "cancel" }
  | { action: "whitespace"; operation: "begin"; mode: "trim" | "pad" }
  | { action: "whitespace"; operation: "options"; options: WhitespaceOptions }
  | { action: "whitespace"; operation: "apply" | "cancel" }
  | { action: "bucketOptions"; options: Partial<BucketOptions> }
  | { action: "bucketInputValidity"; field: "opacity" | "tolerance" | "color"; valid: boolean }
  | { action: "fill"; operation: "begin" | "cancel" }
  | { action: "fill"; operation: "apply"; options: FillOptions }
  | { action: "colorRange"; operation: "begin" | "apply" | "cancel" | "reset" }
  | { action: "colorRange"; operation: "options"; value: ColorRangeOptions }
  | { action: "colorRange"; operation: "patch"; change: Partial<ColorRangeOptions> }
  | {
      action: "colorRange";
      operation: "inputValidity";
      field: "fuzziness" | "range";
      valid: boolean;
    }
  | { action: "colorRange"; operation: "sampling"; mode: "replace" | "add" | "subtract" }
  | ({ action: "wandOptions" } & MagicWandOptions)
  | { action: "cancelWand" }
  | { action: "preferences"; value: DesignEditorPreferences }
  | { action: "toolKey"; key: string; shiftKey: boolean }
  | { action: "rotateCanvas"; degrees: 90 | 180 | 270 }
  | { action: "flip"; axis: "horizontal" | "vertical"; target: "canvas" | "pixels" }
  | {
      action: "resizeImage";
      width: number;
      height: number;
      interpolation: "nearest" | "smooth";
      allowDistortion: boolean;
    }
  | {
      action: "resizeCanvas";
      width: number;
      height: number;
      anchor: { horizontal: "left" | "center" | "right"; vertical: "top" | "center" | "bottom" };
    }
  | { action: "focus" }
  | { action: "transformLinked"; enabled: boolean }
  | { action: "sampleSource"; source: "current" | "merged" }
  | { action: "autoSelect"; enabled: boolean }
  | { action: "colors"; foreground: KlecksBrush["color"]; background: KlecksBrush["color"] }
  | { action: "cursor"; tip: "normal" | "full" | "precise"; crosshair: boolean }
  | {
      action: "navigation";
      mode: "marquee" | "scrubby";
      center: boolean;
      wheel: boolean;
      pixelGrid: boolean;
      selectionEdges: boolean;
    }
  | ({ action: "selectionOptions" } & KlecksSelectionOptions)
  | { action: "crop"; operation: "apply" | "cancel" }
  | {
      action: "crop";
      operation: "preview";
      rect: { left: number; top: number; width: number; height: number };
      deletePixels: boolean;
    }
  | { action: "transform"; operation: "begin"; target?: "pixels" | "selection" }
  | { action: "transform"; operation: "apply" | "cancel" }
  | { action: "transform"; operation: "preview"; matrix: KlecksTransformMatrix }
  | KlecksLayerCommand
  | { action: "tool"; tool: KlecksTool }
  | ({ action: "brush" } & KlecksBrush)
  | { action: "fit" }
  | { action: "zoom"; zoom: number };
export type KlecksSelectionOptions = {
  mode: "replace" | "add" | "subtract" | "intersect";
  style: "normal" | "ratio" | "fixed";
  width: number;
  height: number;
  feather: number;
  antiAlias: boolean;
};
const tools = new Set([
  "brush",
  "clone",
  "blur",
  "eraser",
  "hand",
  "zoom",
  "eyedropper",
  "move",
  "crop",
  "rectangle",
  "ellipse",
  "lasso",
  "polygon",
  "magicWand",
  "bucket",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const number = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
function identity(value: unknown): value is KlecksPortIdentity {
  return (
    record(value) &&
    exact(value, ["sessionId", "viewId", "generation"]) &&
    [value.sessionId, value.viewId].every(
      (item) => typeof item === "string" && item.length > 0 && item.length <= 200,
    ) &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) > 0
  );
}
export function isKlecksToolCommand(value: unknown): value is KlecksToolCommand {
  if (!record(value)) return false;
  if (value.action === "retouchOptions")
    return (
      exact(value, ["action", "aligned", "merged", "strength"]) &&
      typeof value.aligned === "boolean" &&
      typeof value.merged === "boolean" &&
      number(value.strength, 0, 1)
    );
  if (value.action === "tone") {
    if (value.operation === "begin")
      return (
        exact(value, ["action", "operation", "mode"]) &&
        ["levels", "threshold"].includes(value.mode as string)
      );
    if (value.operation === "options")
      return (
        exact(value, ["action", "operation", "options"]) &&
        ToneOptionsSchema.safeParse(value.options).success
      );
    return (
      exact(value, ["action", "operation"]) &&
      ["apply", "cancel"].includes(value.operation as string)
    );
  }
  if (value.action === "autoTrim")
    return (
      exact(value, ["action", "options"]) && AutoTrimOptionsSchema.safeParse(value.options).success
    );
  if (value.action === "whitespace") {
    if (value.operation === "begin")
      return (
        exact(value, ["action", "operation", "mode"]) &&
        ["trim", "pad"].includes(value.mode as string)
      );
    if (value.operation === "options")
      return (
        exact(value, ["action", "operation", "options"]) &&
        WhitespaceOptionsSchema.safeParse(value.options).success
      );
    return (
      exact(value, ["action", "operation"]) &&
      ["apply", "cancel"].includes(value.operation as string)
    );
  }
  if (value.action === "bucketOptions")
    return (
      exact(value, ["action", "options"]) &&
      BucketOptionsSchema.partial().strict().safeParse(value.options).success
    );
  if (value.action === "bucketInputValidity")
    return (
      exact(value, ["action", "field", "valid"]) &&
      ["opacity", "tolerance", "color"].includes(value.field as string) &&
      typeof value.valid === "boolean"
    );
  if (value.action === "fill")
    return value.operation === "apply"
      ? exact(value, ["action", "operation", "options"]) &&
          FillOptionsSchema.safeParse(value.options).success
      : exact(value, ["action", "operation"]) &&
          ["begin", "cancel"].includes(value.operation as string);
  if (value.action === "colorRange") {
    if (value.operation === "patch")
      return (
        exact(value, ["action", "operation", "change"]) &&
        ColorRangeOptionsSchema.partial().strict().safeParse(value.change).success
      );
    if (value.operation === "inputValidity")
      return (
        exact(value, ["action", "operation", "field", "valid"]) &&
        ["fuzziness", "range"].includes(value.field as string) &&
        typeof value.valid === "boolean"
      );
    if (value.operation === "options")
      return (
        exact(value, ["action", "operation", "value"]) &&
        ColorRangeOptionsSchema.safeParse(value.value).success
      );
    if (value.operation === "sampling")
      return (
        exact(value, ["action", "operation", "mode"]) &&
        ["replace", "add", "subtract"].includes(value.mode as string)
      );
    return (
      exact(value, ["action", "operation"]) &&
      ["begin", "apply", "cancel", "reset"].includes(value.operation as string)
    );
  }
  if (value.action === "cancelWand") return exact(value, ["action"]);
  if (value.action === "wandOptions") {
    const { action: _action, ...options } = value;
    return (
      DesignMagicWandOptionsSchema.safeParse({ ...options, mode: "replace" }).success &&
      exact(value, [
        "action",
        "tolerance",
        "contiguous",
        "antiAlias",
        "sampleSize",
        "sampleAllLayers",
      ])
    );
  }
  if (value.action === "preferences")
    return (
      exact(value, ["action", "value"]) &&
      DesignEditorPreferencesSchema.safeParse(value.value).success
    );
  if (value.action === "toolKey")
    return (
      exact(value, ["action", "key", "shiftKey"]) &&
      typeof value.key === "string" &&
      /^[vmlbeichzwg]$/i.test(value.key) &&
      typeof value.shiftKey === "boolean"
    );
  if (value.action === "rotateCanvas")
    return exact(value, ["action", "degrees"]) && [90, 180, 270].includes(value.degrees as number);
  if (value.action === "flip")
    return (
      exact(value, ["action", "axis", "target"]) &&
      ["horizontal", "vertical"].includes(value.axis as string) &&
      ["canvas", "pixels"].includes(value.target as string)
    );
  if (value.action === "resizeImage" || value.action === "resizeCanvas") {
    if (
      !Number.isSafeInteger(value.width) ||
      !Number.isSafeInteger(value.height) ||
      !number(value.width, 1, 10000) ||
      !number(value.height, 1, 10000) ||
      value.width * value.height > 40000000
    )
      return false;
    if (value.action === "resizeImage")
      return (
        exact(value, ["action", "width", "height", "interpolation", "allowDistortion"]) &&
        ["nearest", "smooth"].includes(value.interpolation as string) &&
        typeof value.allowDistortion === "boolean"
      );
    return (
      exact(value, ["action", "width", "height", "anchor"]) &&
      record(value.anchor) &&
      exact(value.anchor, ["horizontal", "vertical"]) &&
      ["left", "center", "right"].includes(value.anchor.horizontal as string) &&
      ["top", "center", "bottom"].includes(value.anchor.vertical as string)
    );
  }
  if (value.action === "focus") return exact(value, ["action"]);
  if (value.action === "transformLinked")
    return exact(value, ["action", "enabled"]) && typeof value.enabled === "boolean";
  if (value.action === "sampleSource")
    return (
      exact(value, ["action", "source"]) && ["current", "merged"].includes(value.source as string)
    );
  if (value.action === "autoSelect")
    return exact(value, ["action", "enabled"]) && typeof value.enabled === "boolean";
  if (value.action === "colors")
    return (
      exact(value, ["action", "foreground", "background"]) &&
      [value.foreground, value.background].every(
        (color) =>
          record(color) &&
          exact(color, ["r", "g", "b"]) &&
          Object.values(color).every((x) => number(x, 0, 255) && Number.isInteger(x)),
      )
    );
  if (value.action === "cursor")
    return (
      exact(value, ["action", "tip", "crosshair"]) &&
      ["normal", "full", "precise"].includes(value.tip as string) &&
      typeof value.crosshair === "boolean"
    );
  if (value.action === "navigation")
    return (
      exact(value, ["action", "mode", "center", "wheel", "pixelGrid", "selectionEdges"]) &&
      ["marquee", "scrubby"].includes(value.mode as string) &&
      [value.center, value.wheel, value.pixelGrid, value.selectionEdges].every(
        (item) => typeof item === "boolean",
      )
    );
  if (value.action === "selectionOptions")
    return (
      exact(value, ["action", "mode", "style", "width", "height", "feather", "antiAlias"]) &&
      ["replace", "add", "subtract", "intersect"].includes(value.mode as string) &&
      ["normal", "ratio", "fixed"].includes(value.style as string) &&
      number(value.width, 1, 10000) &&
      number(value.height, 1, 10000) &&
      number(value.feather, 0, 1000) &&
      typeof value.antiAlias === "boolean"
    );
  if (value.action === "crop") {
    if (value.operation !== "preview")
      return (
        exact(value, ["action", "operation"]) &&
        ["apply", "cancel"].includes(value.operation as string)
      );
    const rect = value.rect;
    return (
      exact(value, ["action", "operation", "rect", "deletePixels"]) &&
      typeof value.deletePixels === "boolean" &&
      record(rect) &&
      exact(rect, ["left", "top", "width", "height"]) &&
      Object.values(rect).every(Number.isSafeInteger) &&
      number(rect.left, -10000, 10000) &&
      number(rect.top, -10000, 10000) &&
      number(rect.width, 1, 10000) &&
      number(rect.height, 1, 10000) &&
      rect.width * rect.height <= 40000000
    );
  }
  if (value.action === "transform") {
    if (value.operation === "begin" && value.target !== undefined)
      return (
        exact(value, ["action", "operation", "target"]) &&
        ["pixels", "selection"].includes(value.target as string)
      );
    if (value.operation !== "preview")
      return (
        exact(value, ["action", "operation"]) &&
        ["begin", "apply", "cancel"].includes(value.operation as string)
      );
    const matrix = value.matrix;
    return (
      exact(value, ["action", "operation", "matrix"]) &&
      record(matrix) &&
      exact(matrix, ["a", "b", "c", "d", "e", "f"]) &&
      Object.values(matrix).every((item) => number(item, -100000, 100000)) &&
      Math.abs(
        (matrix.a as number) * (matrix.d as number) - (matrix.b as number) * (matrix.c as number),
      ) > 1e-12
    );
  }
  if (value.action === "layer") return isKlecksLayerCommand(value);
  if (value.action === "fit") return exact(value, ["action"]);
  if (value.action === "zoom")
    return exact(value, ["action", "zoom"]) && number(value.zoom, 0.01, 32);
  if (value.action === "tool")
    return (
      exact(value, ["action", "tool"]) && typeof value.tool === "string" && tools.has(value.tool)
    );
  return (
    value.action === "brush" &&
    exact(value, ["action", "size", "opacity", "flow", "hardness", "color"]) &&
    number(value.size, 1, 5000) &&
    number(value.opacity, 0, 1) &&
    number(value.flow, 0, 1) &&
    number(value.hardness, 0, 1) &&
    record(value.color) &&
    exact(value.color, ["r", "g", "b"]) &&
    [value.color.r, value.color.g, value.color.b].every(
      (channel) => number(channel, 0, 255) && Number.isInteger(channel),
    )
  );
}
export function handleKlecksToolRequest(
  input: unknown,
  current: KlecksPortIdentity | null,
  previous: number,
  execute: (command: KlecksToolCommand) => void,
): { sequence: number; code: PortCode; message?: string } {
  if (
    !record(input) ||
    !exact(input, ["type", "version", "sequence", "identity", "command"]) ||
    input.type !== "klecks:tools" ||
    input.version !== 1 ||
    !Number.isSafeInteger(input.sequence) ||
    (input.sequence as number) < 1 ||
    !identity(input.identity) ||
    !isKlecksToolCommand(input.command)
  )
    return { sequence: previous, code: "INVALID_MESSAGE" };
  const sequence = input.sequence as number;
  if (sequence <= previous) return { sequence: previous, code: "REPLAY" };
  if (
    !current ||
    current.sessionId !== input.identity.sessionId ||
    current.viewId !== input.identity.viewId ||
    current.generation !== input.identity.generation
  )
    return { sequence, code: "STALE_TARGET" };
  try {
    execute(input.command);
    return { sequence, code: "ACCEPTED" };
  } catch (error) {
    return {
      sequence,
      code: isKlecksResourceLimit(error) ? "EDITOR_RESOURCE_LIMIT" : "COMMAND_FAILED",
      ...(error instanceof KlecksOperationRejected ? { message: error.message.slice(0, 500) } : {}),
    };
  }
}
export function bindKlecksToolPort(
  port: MessagePort,
  current: () => KlecksPortIdentity | null,
  execute: (command: KlecksToolCommand) => void,
): () => void {
  let sequence = 0;
  const receive = (event: MessageEvent<unknown>) => {
    if (!record(event.data) || event.data.type !== "klecks:tools") return;
    const result = handleKlecksToolRequest(event.data, current(), sequence, execute);
    sequence = result.sequence;
    port.postMessage({
      type: "klecks:tools:reply",
      version: 1,
      sequence: event.data.sequence,
      code: result.code,
      ...(result.message ? { message: result.message } : {}),
    });
  };
  port.addEventListener("message", receive);
  port.start();
  return () => port.removeEventListener("message", receive);
}
export function createKlecksToolClient(port: MessagePort, timeoutMs = 10000) {
  let sequence = 0,
    closed = false;
  const pending = new Map<
    number,
    { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  const receive = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (
      !record(data) ||
      !exact(data, [
        "type",
        "version",
        "sequence",
        "code",
        ...(Object.hasOwn(data, "message") ? ["message"] : []),
      ]) ||
      (data.message !== undefined &&
        (typeof data.message !== "string" || data.message.length > 500)) ||
      data.type !== "klecks:tools:reply" ||
      data.version !== 1 ||
      typeof data.sequence !== "number"
    )
      return;
    const item = pending.get(data.sequence);
    if (!item) return;
    pending.delete(data.sequence);
    clearTimeout(item.timer);
    if (data.code === "ACCEPTED") item.resolve();
    else
      item.reject(
        Object.assign(
          new Error(
            data.code === "EDITOR_RESOURCE_LIMIT"
              ? KLECKS_RESOURCE_LIMIT_MESSAGE
              : typeof data.message === "string"
                ? data.message
                : "图片工具操作未完成。",
          ),
          { code: data.code },
        ),
      );
  };
  port.addEventListener("message", receive);
  port.start();
  return {
    send(target: KlecksPortIdentity, command: KlecksToolCommand): Promise<void> {
      if (closed || !identity(target) || !isKlecksToolCommand(command))
        return Promise.reject(new Error("图片工具参数无效或连接已关闭。"));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("图片工具操作等待超时。"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          port.postMessage({
            type: "klecks:tools",
            version: 1,
            sequence: id,
            identity: { ...target },
            command,
          });
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error("图片工具操作发送失败。"));
        }
      });
    },
    close() {
      closed = true;
      port.removeEventListener("message", receive);
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("图片工具连接已关闭。"));
      }
      pending.clear();
    },
  };
}
