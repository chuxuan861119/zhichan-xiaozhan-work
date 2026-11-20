import type { KlecksPointerDriver } from "./klecks-pointer-input";

export type KlecksShortcutContext = {
  platform: "windows" | "mac" | "harmony";
  editingText: boolean;
  enabled: boolean;
  pending: boolean;
  navigationWhilePending?: boolean;
  transformHistoryWhilePending?: boolean;
  paintingTool?: "brush" | "eraser" | "clone" | "blur" | null;
  strokeScope?: string;
  activeTool?: ReturnType<KlecksPointerDriver["getTool"]>;
  maskTarget?: boolean;
};
type ToolGroup =
  | "move"
  | "marquee"
  | "lasso"
  | "brush"
  | "clone"
  | "blur"
  | "eraser"
  | "eyedropper"
  | "crop"
  | "hand"
  | "zoom"
  | "magicWand"
  | "bucket";
export type KlecksKeyboardCommand =
  | { action: "nudge"; target: "pixels" | "selection"; dx: number; dy: number }
  | { action: "strokeValue"; field: "opacity" | "flow"; value: number }
  | { action: "tool"; group: ToolGroup; cycle: boolean }
  | {
      action:
        | "undo"
        | "redo"
        | "copy"
        | "copyMerged"
        | "cut"
        | "paste"
        | "pasteInPlace"
        | "selectAll"
        | "deselect"
        | "reselect"
        | "invertSelection"
        | "clear"
        | "fillDialog"
        | "fillForeground"
        | "fillBackground"
        | "fillForegroundPreserve"
        | "fillBackgroundPreserve"
        | "transform"
        | "saveProject"
        | "layerViaCopy"
        | "mergeLayers"
        | "mergeVisible"
        | "stampLayers"
        | "stampVisible"
        | "layerForward"
        | "layerBackward"
        | "layerToFront"
        | "layerToBack"
        | "selectAllLayers"
        | "deleteLayers"
        | "selectLayerAbove"
        | "selectLayerBelow"
        | "extendLayerAbove"
        | "extendLayerBelow"
        | "zoomIn"
        | "zoomOut"
        | "fitCanvas"
        | "actualPixels"
        | "defaultColors"
        | "swapColors"
        | "invertMask"
        | "targetMask"
        | "targetImage"
        | "viewMask"
        | "smallerBrush"
        | "largerBrush"
        | "softerBrush"
        | "harderBrush";
    };
type Key = Pick<
  KeyboardEvent,
  | "key"
  | "ctrlKey"
  | "metaKey"
  | "altKey"
  | "shiftKey"
  | "isComposing"
  | "keyCode"
  | "defaultPrevented"
>;

/** Only documented base mappings; temporary-tool and pending-gesture keys belong to pointer routing. */
function transformHistoryKey(
  event: Key,
  context: Pick<KlecksShortcutContext, "platform" | "transformHistoryWhilePending">,
): boolean {
  const primary =
    context.platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return (
    !!context.transformHistoryWhilePending &&
    primary &&
    !event.altKey &&
    (event.key.toLowerCase() === "z" ||
      (context.platform !== "mac" && !event.shiftKey && event.key.toLowerCase() === "y"))
  );
}
export function resolveKlecksShortcut(
  event: Key,
  context: KlecksShortcutContext,
): KlecksKeyboardCommand | null {
  if (
    !context.enabled ||
    context.editingText ||
    (context.pending &&
      !transformHistoryKey(event, context) &&
      !(
        context.navigationWhilePending &&
        !event.altKey &&
        ["+", "=", "-", "0", "1"].includes(event.key.toLowerCase()) &&
        (context.platform === "mac"
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey)
      )) ||
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229
  )
    return null;
  const key = event.key.toLowerCase();
  const primary =
    context.platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (key === "f5" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)
    return { action: "fillDialog" };
  if (key === "backspace" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)
    return { action: "fillDialog" };
  if (key === "backspace") {
    if (event.altKey && !event.ctrlKey && !event.metaKey)
      return { action: event.shiftKey ? "fillForegroundPreserve" : "fillForeground" };
    if (primary && !event.altKey)
      return { action: event.shiftKey ? "fillBackgroundPreserve" : "fillBackground" };
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && ["[", "]", "{", "}"].includes(key)) {
    const above = key === "]" || key === "}";
    return {
      action: event.shiftKey
        ? above
          ? "extendLayerAbove"
          : "extendLayerBelow"
        : above
          ? "selectLayerAbove"
          : "selectLayerBelow",
    };
  }
  if (primary) {
    if (!event.altKey && !event.shiftKey && key === "i") return { action: "invertMask" };
    if (!event.altKey && !event.shiftKey && key === "\\") return { action: "targetMask" };
    if (!event.altKey && !event.shiftKey && key === "2") return { action: "targetImage" };
    if (context.platform !== "mac" && key === "y" && !event.shiftKey && !event.altKey)
      return { action: "redo" };
    if (key === "e")
      return {
        action: event.altKey
          ? event.shiftKey
            ? "stampVisible"
            : "stampLayers"
          : event.shiftKey
            ? "mergeVisible"
            : "mergeLayers",
      };
    if (event.altKey) return key === "a" && !event.shiftKey ? { action: "selectAllLayers" } : null;
    if (["[", "]", "{", "}"].includes(key)) {
      const up = key === "]" || key === "}";
      return {
        action:
          event.shiftKey || key === "{" || key === "}"
            ? up
              ? "layerToFront"
              : "layerToBack"
            : up
              ? "layerForward"
              : "layerBackward",
      };
    }
    if (key === "+" || key === "=") return { action: "zoomIn" };
    if (key === "-") return { action: "zoomOut" };
    if (!event.shiftKey && key === "0") return { action: "fitCanvas" };
    if (!event.shiftKey && key === "1") return { action: "actualPixels" };
    const actions = event.shiftKey
      ? ({
          z: "redo",
          c: "copyMerged",
          v: "pasteInPlace",
          d: "reselect",
          i: "invertSelection",
        } as const)
      : ({
          z: "undo",
          c: "copy",
          x: "cut",
          v: "paste",
          a: "selectAll",
          d: "deselect",
          t: "transform",
          s: "saveProject",
          j: "layerViaCopy",
        } as const);
    const action = actions[key as keyof typeof actions];
    return action ? { action } : null;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (!event.shiftKey && (key === "backspace" || key === "delete"))
    return {
      action: context.activeTool === "move" && !context.maskTarget ? "deleteLayers" : "clear",
    };
  const direction = {
    arrowleft: [-1, 0],
    arrowright: [1, 0],
    arrowup: [0, -1],
    arrowdown: [0, 1],
  } as const;
  const delta = direction[key as keyof typeof direction];
  if (delta && context.activeTool) {
    const target =
      context.activeTool === "move"
        ? "pixels"
        : ["rectangle", "ellipse", "lasso", "polygon", "magicWand"].includes(context.activeTool)
          ? "selection"
          : null;
    if (target) {
      const step = event.shiftKey ? 10 : 1;
      return { action: "nudge", target, dx: delta[0] * step, dy: delta[1] * step };
    }
  }
  const tools: Record<string, ToolGroup> = {
    v: "move",
    m: "marquee",
    l: "lasso",
    b: "brush",
    s: "clone",
    e: "eraser",
    i: "eyedropper",
    c: "crop",
    h: "hand",
    z: "zoom",
    w: "magicWand",
    g: "bucket",
  };
  if (tools[key]) return { action: "tool", group: tools[key], cycle: event.shiftKey };
  if (context.paintingTool && ["[", "]", "{", "}"].includes(key)) {
    const smaller = key === "[" || key === "{";
    return {
      action:
        event.shiftKey || key === "{" || key === "}"
          ? smaller
            ? "softerBrush"
            : "harderBrush"
          : smaller
            ? "smallerBrush"
            : "largerBrush",
    };
  }
  if (event.shiftKey) return null;
  const actions = {
    d: "defaultColors",
    x: "swapColors",
  } as const;
  const action = actions[key as keyof typeof actions];
  return action ? { action } : null;
}

/** Attach to the editor scope, not window. Menus/buttons should dispatch the same commands. */
export function bindKlecksKeyboard(
  scope: HTMLElement,
  context: () => Omit<KlecksShortcutContext, "editingText">,
  dispatch: (command: KlecksKeyboardCommand) => boolean,
  now: () => number = () => performance.now(),
): () => void {
  const groupFor = (tool: KlecksShortcutContext["activeTool"]): ToolGroup | undefined =>
    tool === "rectangle" || tool === "ellipse"
      ? "marquee"
      : tool === "polygon" || tool === "lasso"
        ? "lasso"
        : tool;
  let spring: {
    key: string;
    previous: ToolGroup;
    temporary: ToolGroup;
    time: number;
    restore: boolean;
    used: boolean;
  } | null = null;
  const restoreSpring = () => {
    if (!spring?.restore) return;
    const snapshot = context();
    if (snapshot.pending) return;
    const original = spring;
    spring = null;
    if (snapshot.enabled && groupFor(snapshot.activeTool) === original.temporary)
      dispatch({ action: "tool", group: original.previous, cycle: false });
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (spring && event.key.toLowerCase() === spring.key) {
      if (now() - spring.time >= 200 || (spring.key === "h" && spring.used)) spring.restore = true;
      else spring = null;
    }
    restoreSpring();
  };
  const markSpringUsed = () => {
    if (spring) spring.used = true;
  };
  const onBlur = () => {
    if (spring) spring.restore = true;
    queueMicrotask(restoreSpring);
  };
  let prefix: { digit: number; field: "opacity" | "flow"; scope: string; time: number } | null =
    null;
  const reset = () => {
    prefix = null;
  };
  const clearEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.isComposing) {
      spring = null;
      reset();
    }
  };
  const onKey = (event: KeyboardEvent) => {
    const editingText = event
      .composedPath()
      .some(
        (node) =>
          node instanceof HTMLElement &&
          (node.isContentEditable ||
            node.matches(
              "input,textarea,select,[role='textbox'],[contenteditable]:not([contenteditable='false'])",
            )),
      );
    const snapshot = context();
    if (
      snapshot.pending &&
      resolveKlecksShortcut(event, { ...snapshot, pending: false, editingText })?.action.startsWith(
        "fill",
      )
    ) {
      event.preventDefault();
      event.stopPropagation();
      reset();
      return;
    }
    if (
      snapshot.enabled &&
      snapshot.pending &&
      !transformHistoryKey(event, snapshot) &&
      !(
        snapshot.navigationWhilePending &&
        !event.altKey &&
        ["+", "=", "-", "0", "1"].includes(event.key.toLowerCase())
      ) &&
      !editingText &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      (snapshot.platform === "mac"
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey) &&
      [
        "s",
        "c",
        "x",
        "v",
        "a",
        "z",
        "y",
        "d",
        "t",
        "i",
        "j",
        "e",
        "[",
        "]",
        "+",
        "=",
        "-",
        "0",
        "1",
      ].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      event.stopPropagation();
      reset();
      return;
    }
    const digitKey = /^[0-9]$/.test(event.key)
      ? event.key
      : event.shiftKey && /^Digit[0-9]$/.test(event.code)
        ? event.code.slice(-1)
        : null;
    let command: KlecksKeyboardCommand | null;
    if (
      digitKey !== null &&
      snapshot.paintingTool &&
      snapshot.enabled &&
      !snapshot.pending &&
      !editingText &&
      !event.defaultPrevented &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.repeat
    ) {
      const digit = Number(digitKey),
        field = event.shiftKey ? "flow" : "opacity";
      const scopeKey = snapshot.strokeScope ?? snapshot.paintingTool,
        time = now();
      // Adobe specifies rapid two-key entry, not a duration; 500ms is this host's explicit threshold.
      const paired =
        prefix &&
        prefix.field === field &&
        prefix.scope === scopeKey &&
        time >= prefix.time &&
        time - prefix.time <= 500
          ? prefix
          : null;
      const value = paired ? (paired.digit * 10 + digit) / 100 : digit === 0 ? 1 : digit / 10;
      prefix = paired ? null : { digit, field, scope: scopeKey, time };
      command = { action: "strokeValue", field, value };
    } else {
      reset();
      command = resolveKlecksShortcut(event, { ...snapshot, editingText });
    }
    if (command?.action === "tool" && event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (command && dispatch(command)) {
      if (command.action === "tool") {
        const previous = groupFor(snapshot.activeTool);
        spring =
          !command.cycle && previous && previous !== command.group
            ? {
                key: event.key.toLowerCase(),
                previous,
                temporary: command.group,
                time: now(),
                restore: false,
                used: false,
              }
            : null;
      }
      event.preventDefault();
      event.stopPropagation();
    } else reset();
  };
  scope.addEventListener("keydown", onKey);
  scope.addEventListener("keydown", clearEscape, true);
  scope.addEventListener("keyup", onKeyUp);
  scope.addEventListener("pointerup", restoreSpring);
  scope.addEventListener("pointerdown", markSpringUsed);
  scope.addEventListener("pointercancel", restoreSpring);
  scope.addEventListener("blur", onBlur, true);
  scope.ownerDocument.defaultView?.addEventListener("blur", onBlur);
  scope.addEventListener("blur", reset, true);
  scope.addEventListener("pointerdown", reset);
  scope.ownerDocument.defaultView?.addEventListener("blur", reset);
  return () => {
    scope.removeEventListener("keydown", onKey);
    scope.removeEventListener("keydown", clearEscape, true);
    spring = null;
    scope.removeEventListener("keyup", onKeyUp);
    scope.removeEventListener("pointerup", restoreSpring);
    scope.removeEventListener("pointerdown", markSpringUsed);
    scope.removeEventListener("pointercancel", restoreSpring);
    scope.removeEventListener("blur", onBlur, true);
    scope.ownerDocument.defaultView?.removeEventListener("blur", onBlur);
    scope.removeEventListener("blur", reset, true);
    scope.removeEventListener("pointerdown", reset);
    scope.ownerDocument.defaultView?.removeEventListener("blur", reset);
  };
}
