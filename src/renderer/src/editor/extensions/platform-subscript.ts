import Subscript from "@tiptap/extension-subscript";
import { isMacPlatform } from "../../../../shared/platform";

/** Command-comma belongs to Settings on macOS. */
export const PlatformSubscript = Subscript.extend({
  excludes: "superscript",
  addKeyboardShortcuts() {
    return isMacPlatform()
      ? { "Mod-Alt-,": () => this.editor.commands.toggleSubscript() }
      : (this.parent?.() ?? {});
  },
});
