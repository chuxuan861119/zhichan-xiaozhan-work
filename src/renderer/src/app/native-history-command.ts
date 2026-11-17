export type NativeEditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "select-all";

/** Route native menus through focused custom editors, preserving native text editing. */
export function dispatchNativeEditCommand(
  command: NativeEditCommand,
  nativeFallback: (command: NativeEditCommand) => void = (value) => {
    if (value === "paste") void window.patentApi.clipboard.paste();
    else document.execCommand(value === "select-all" ? "selectAll" : value);
  },
) {
  const keys = { undo: "z", redo: "z", cut: "x", copy: "c", paste: "v", "select-all": "a" };
  const key = keys[command];
  const target = document.activeElement ?? document.body;
  const handled = !target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: `Key${key.toUpperCase()}`,
      metaKey: isMacPlatform(),
      ctrlKey: !isMacPlatform(),
      shiftKey: command === "redo",
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
  if (!handled) nativeFallback(command);
}

export function dispatchNativeHistoryCommand(
  command: "undo" | "redo",
  nativeFallback: (command: "undo" | "redo") => void = (value) => document.execCommand(value),
) {
  dispatchNativeEditCommand(command, () => nativeFallback(command));
}

import { isMacPlatform } from "../../../shared/platform";
