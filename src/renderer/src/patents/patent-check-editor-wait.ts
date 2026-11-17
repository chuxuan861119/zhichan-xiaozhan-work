import type { Editor } from "@tiptap/core";
import type { EditorCommandBus } from "../app/command-bus";

export function waitForPatentCheckEditor(
  commandBus: Pick<EditorCommandBus, "getEditor" | "subscribeEditors">,
  editorId: string,
  timeoutMs = 3000,
): Promise<Editor | null> {
  const existing = commandBus.getEditor(editorId);
  if (existing && !existing.isDestroyed) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => undefined;
    const finish = (editor: Editor | null) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe();
      resolve(editor);
    };
    unsubscribe = commandBus.subscribeEditors((registeredId, editor) => {
      if (registeredId !== editorId || !editor || editor.isDestroyed) return;
      finish(editor);
    });
    timeout = setTimeout(() => finish(null), Math.max(0, timeoutMs));
  });
}
