import { Editor } from "@tiptap/core";
import Superscript from "@tiptap/extension-superscript";
import StarterKit from "@tiptap/starter-kit";
import { PlatformSubscript } from "./platform-subscript";

afterEach(() => vi.unstubAllGlobals());

test.each(["darwin", "win32"])(
  "%s keeps subscript available without taking the Mac Settings key",
  (platform) => {
    vi.stubGlobal("documentFontPlatform", platform);
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit, Superscript, PlatformSubscript],
      content: "<p>HX</p>",
    });
    try {
      editor.commands.setTextSelection({ from: 1, to: 3 });
      editor.commands.keyboardShortcut("Mod-,");
      expect(editor.isActive("subscript")).toBe(platform === "win32");
      if (platform === "darwin") {
        editor.commands.keyboardShortcut("Mod-Alt-,");
        expect(editor.isActive("subscript")).toBe(true);
      }
    } finally {
      editor.destroy();
    }
  },
);
