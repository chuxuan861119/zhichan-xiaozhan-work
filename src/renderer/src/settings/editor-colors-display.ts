import { type EditorColors, editorColorTokens } from "../../../shared/settings/editor-colors";

export function applyEditorColors(root: HTMLElement, colors: EditorColors): () => void {
  const tokens = editorColorTokens(colors);
  const previous = Object.keys(tokens).map(
    (key) => [key, root.style.getPropertyValue(key)] as const,
  );
  const attribute = root.getAttribute("data-editor-colors");
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
  root.setAttribute("data-editor-colors", "true");
  return () => {
    for (const [key, value] of previous) {
      if (value) root.style.setProperty(key, value);
      else root.style.removeProperty(key);
    }
    if (attribute === null) root.removeAttribute("data-editor-colors");
    else root.setAttribute("data-editor-colors", attribute);
  };
}
