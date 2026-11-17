/** Renderer platform adaptation. Persistent documents/settings remain platform neutral. */
export function runtimePlatform(): string {
  // The preload's trusted runtime value disambiguates Harmony from Chromium's
  // generic Linux navigator.platform without changing document/font policy.
  const runtime = globalThis as typeof globalThis & { documentFontPlatform?: string };
  return (
    runtime.documentFontPlatform ?? (typeof navigator === "undefined" ? "" : navigator.platform)
  );
}

export function isHarmonyPlatform(platform = runtimePlatform()): boolean {
  return platform === "openharmony" || platform === "ohos";
}

/** Harmony first release ships without network AI; saved settings remain portable. */
export function isNetworkAiAvailable(platform = runtimePlatform()): boolean {
  return !isHarmonyPlatform(platform);
}

/** Re-enable Harmony Agent CLI only after physical-device acceptance. */
export function isAgentCliAvailable(platform = runtimePlatform()): boolean {
  return !isHarmonyPlatform(platform);
}

export function ignoreApplicationKeyEvent(
  event: { isComposing?: boolean; keyCode?: number; metaKey?: boolean },
  platform?: string,
): boolean {
  return Boolean(
    event.isComposing || event.keyCode === 229 || (isHarmonyPlatform(platform) && event.metaKey),
  );
}

export function isMacPlatform(platform = runtimePlatform()): boolean {
  return platform === "darwin" || /^Mac/iu.test(platform);
}

export function isSentenceSelectionClick(
  event: { button: number; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  platform?: string,
): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.shiftKey &&
    (isMacPlatform(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}

export function platformShortcut(shortcut: string, platform?: string): string {
  if (!isMacPlatform(platform)) return shortcut.replaceAll("Control", "Ctrl");
  return shortcut
    .replaceAll("Control", "⌃")
    .replaceAll("Ctrl", "⌘")
    .replaceAll("Alt", "⌥")
    .replaceAll("Shift", "⇧");
}

/** Third-party hints already describe physical keys: Ctrl must not become Command. */
export function platformNativeShortcut(shortcut: string, platform?: string): string {
  const mac = isMacPlatform(platform);
  return shortcut.replace(/\b(Control|Ctrl|Shift|Option|Alt|Command|Cmd|Meta|Mod)\b/giu, (key) => {
    const modifier = key.toLowerCase();
    if (modifier === "mod") return mac ? "⌘" : "Ctrl";
    if (modifier === "control" || modifier === "ctrl") return mac ? "⌃" : "Ctrl";
    if (modifier === "alt" || modifier === "option") return mac ? "⌥" : "Alt";
    if (modifier === "shift") return mac ? "⇧" : "Shift";
    return mac ? "⌘" : "Meta";
  });
}

/** Fixed editor actions have native bindings; custom settings retain literal keys. */
export function editorShortcutBinding(shortcut: string, platform?: string): string {
  if (!isMacPlatform(platform)) return shortcut;
  if (shortcut.endsWith("+Tab")) return shortcut.replaceAll("Ctrl", "Control");
  return shortcut
    .replaceAll("Ctrl+,", "Ctrl+Alt+,")
    .replaceAll("Ctrl+Y", "Ctrl+Shift+Z")
    .replace(/Ctrl\+H(?![A-Za-z])/gu, "Ctrl+Alt+F");
}

export function platformEditorShortcut(shortcut: string, platform?: string): string {
  return platformShortcut(editorShortcutBinding(shortcut, platform), platform);
}

export function findShortcutMode(
  event: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
  },
  platform?: string,
): "find" | "replace" | null {
  if (isHarmonyPlatform(platform) && event.metaKey) return null;
  if (!event.ctrlKey && !event.metaKey) return null;
  const key = event.key.toLowerCase();
  if (isMacPlatform(platform) && event.metaKey) {
    return key === "f" ? (event.altKey ? "replace" : "find") : null;
  }
  return key === "f" ? "find" : key === "h" ? "replace" : null;
}
