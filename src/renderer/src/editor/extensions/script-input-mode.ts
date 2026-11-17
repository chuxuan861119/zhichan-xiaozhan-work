import { type Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type ScriptInputMode = "superscript" | "subscript";
type ScriptInputCaret = ScriptInputMode | "normal";

type ScriptInputPluginState = {
  mode: ScriptInputMode | null;
  caret: ScriptInputCaret | null;
};

type ScriptInputMeta = {
  mode: ScriptInputMode | null;
  caret: ScriptInputCaret | null;
};

const scriptInputPluginKey = new PluginKey<ScriptInputPluginState>("scriptInputMode");

function createScriptCaret(caretMode: ScriptInputCaret): HTMLElement {
  const caret = document.createElement("span");
  caret.className = "script-input-caret";
  caret.dataset.scriptInputCaret = caretMode;
  caret.setAttribute("aria-hidden", "true");
  return caret;
}

function scriptCaretDecorations(state: Editor["state"]): DecorationSet {
  const { caret } = scriptInputPluginKey.getState(state) ?? { caret: null };
  if (!caret || !state.selection.empty) return DecorationSet.empty;
  return DecorationSet.create(state.doc, [
    Decoration.widget(state.selection.head, () => createScriptCaret(caret), {
      key: `script-input-caret-${caret}`,
      side: 1,
      ignoreSelection: true,
    }),
  ]);
}

function syncCaretClass(editorElement: HTMLElement, caret: ScriptInputCaret | null): void {
  editorElement.classList.toggle("has-script-input-caret", caret !== null);
}

function leaveScriptInputMode(editor: Editor, mode: ScriptInputMode): boolean {
  const mark = editor.state.schema.marks[mode];
  if (!mark) return false;
  const remainingMarks = (editor.state.storedMarks ?? editor.state.selection.$from.marks()).filter(
    (activeMark) => activeMark.type !== mark,
  );
  // Remove the script caret before dispatch, then bridge the mark boundary with a normal caret.
  // Chromium otherwise keeps its native caret inside the preceding sup/sub DOM node.
  syncCaretClass(editor.view.dom, null);
  editor.view.dispatch(
    editor.state.tr.setStoredMarks(remainingMarks).setMeta(scriptInputPluginKey, {
      mode: null,
      caret: "normal",
    } satisfies ScriptInputMeta),
  );
  return true;
}

export function runScriptInputCommand(editor: Editor, mode: ScriptInputMode): boolean {
  if (!editor.state.selection.empty) {
    return mode === "superscript"
      ? editor.chain().focus().toggleSuperscript().run()
      : editor.chain().focus().toggleSubscript().run();
  }

  const pluginMode = scriptInputPluginKey.getState(editor.state)?.mode ?? null;
  const isAlreadyActive = pluginMode === mode || (pluginMode === null && editor.isActive(mode));
  const nextMode = isAlreadyActive ? null : mode;
  const mark = editor.state.schema.marks[mode];
  const oppositeMark =
    editor.state.schema.marks[mode === "superscript" ? "subscript" : "superscript"];
  if (!mark || !oppositeMark) return false;
  if (!nextMode) syncCaretClass(editor.view.dom, null);

  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.removeStoredMark(oppositeMark);
      if (nextMode) tr.addStoredMark(mark.create());
      else tr.removeStoredMark(mark);
      tr.setMeta(scriptInputPluginKey, {
        mode: nextMode,
        caret: nextMode ?? "normal",
      } satisfies ScriptInputMeta);
      return true;
    })
    .run();
}

export const ScriptInputMode = Extension.create({
  name: "scriptInputMode",

  addProseMirrorPlugins() {
    return [
      new Plugin<ScriptInputPluginState>({
        key: scriptInputPluginKey,
        state: {
          init: () => ({ mode: null, caret: null }),
          apply: (transaction, previous, oldState, newState) => {
            const meta = transaction.getMeta(scriptInputPluginKey) as ScriptInputMeta | undefined;
            if (meta) return meta;
            if (!newState.selection.empty) return { mode: null, caret: null };
            if (
              previous.caret === "normal" &&
              (transaction.docChanged ||
                (transaction.selectionSet && oldState.selection.head !== newState.selection.head))
            ) {
              return { mode: null, caret: null };
            }
            if (
              previous.mode &&
              transaction.selectionSet &&
              !transaction.docChanged &&
              oldState.selection.head !== newState.selection.head
            ) {
              return { mode: null, caret: null };
            }
            return previous;
          },
        },
        props: {
          decorations: scriptCaretDecorations,
          handleKeyDown: (_view, event) => {
            const mode = scriptInputPluginKey.getState(this.editor.state)?.mode ?? null;
            if (!mode || event.key !== "ArrowRight") return false;
            return leaveScriptInputMode(this.editor, mode);
          },
        },
        view: (view) => {
          const update = () => {
            const caret = scriptInputPluginKey.getState(view.state)?.caret ?? null;
            syncCaretClass(view.dom, caret);
          };
          update();
          return {
            update,
            destroy: () => syncCaretClass(view.dom, null),
          };
        },
      }),
    ];
  },
});
