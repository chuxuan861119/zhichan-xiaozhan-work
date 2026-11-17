import {
  findShortcutMode,
  ignoreApplicationKeyEvent,
  platformEditorShortcut,
  platformNativeShortcut,
  platformShortcut,
} from "./platform.js";

test.each(["win32", "darwin", "openharmony", "ohos"])(
  "literal shortcut hints preserve keys on %s",
  (platform) => {
    const mac = platform === "darwin";
    expect(platformNativeShortcut("Shift+T", platform)).toBe(mac ? "⇧+T" : "Shift+T");
    expect(platformNativeShortcut("Ctrl+Option+A", platform)).toBe(mac ? "⌃+⌥+A" : "Ctrl+Alt+A");
    expect(platformNativeShortcut("Mod+Shift+Z", platform)).toBe(mac ? "⌘+⇧+Z" : "Ctrl+Shift+Z");
    expect(platformNativeShortcut("⌘+⇧+Z", platform)).toBe("⌘+⇧+Z");
    expect(platformEditorShortcut("Ctrl+H", platform)).toBe(mac ? "⌘+⌥+F" : "Ctrl+H");
  },
);

test("Mac labels preserve physical Control and use platform bindings", () => {
  expect(platformShortcut("Control+K", "darwin")).toBe("⌃+K");
  expect(platformShortcut("Control+K", "win32")).toBe("Ctrl+K");
  expect(platformEditorShortcut("下标（Ctrl+,）", "darwin")).toBe("下标（⌘+⌥+,）");
  expect(platformEditorShortcut("重做（Ctrl+Y）", "darwin")).toBe("重做（⌘+⇧+Z）");
});

test("Harmony system modifiers and IME events cannot invoke application commands", () => {
  expect(ignoreApplicationKeyEvent({ isComposing: true }, "openharmony")).toBe(true);
  expect(ignoreApplicationKeyEvent({ keyCode: 229 }, "win32")).toBe(true);
  expect(ignoreApplicationKeyEvent({ metaKey: true }, "openharmony")).toBe(true);
  expect(ignoreApplicationKeyEvent({ metaKey: true }, "darwin")).toBe(false);
  expect(
    findShortcutMode({ key: "f", ctrlKey: false, metaKey: true, altKey: false }, "openharmony"),
  ).toBeNull();
});

test("Mac find/replace preserves the native Hide accelerator", () => {
  const event = { key: "f", metaKey: true, ctrlKey: false, altKey: false };
  expect(findShortcutMode(event, "darwin")).toBe("find");
  expect(findShortcutMode({ ...event, altKey: true }, "darwin")).toBe("replace");
  expect(findShortcutMode({ ...event, key: "h" }, "darwin")).toBeNull();
  expect(findShortcutMode({ ...event, key: "h", metaKey: false, ctrlKey: true }, "win32")).toBe(
    "replace",
  );
  expect(platformEditorShortcut("Ctrl+H", "darwin")).toBe("⌘+⌥+F");
  expect(platformEditorShortcut("Ctrl+Tab", "darwin")).toBe("⌃+Tab");
  expect(platformShortcut("Ctrl+H", "darwin")).toBe("⌘+H");
  expect(platformShortcut("Ctrl+Tab", "darwin")).toBe("⌘+Tab");
});

test("sentence selection uses Command on Mac and Control on Windows", async () => {
  const { isSentenceSelectionClick } = await import("./platform.js");
  const event = { button: 0, ctrlKey: false, metaKey: true, altKey: false, shiftKey: false };
  expect(isSentenceSelectionClick(event, "darwin")).toBe(true);
  expect(isSentenceSelectionClick({ ...event, metaKey: false, ctrlKey: true }, "darwin")).toBe(
    false,
  );
  expect(isSentenceSelectionClick({ ...event, metaKey: false, ctrlKey: true }, "Win32")).toBe(true);
  expect(isSentenceSelectionClick({ ...event, button: 2 }, "darwin")).toBe(false);
});
