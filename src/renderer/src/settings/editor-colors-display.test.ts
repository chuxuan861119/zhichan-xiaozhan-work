import { DEFAULT_EDITOR_COLORS } from "../../../shared/settings/editor-colors";
import { applyEditorColors } from "./editor-colors-display";

test("display preferences do not mutate document HTML and are cleaned up", () => {
  const root = document.createElement("div");
  root.innerHTML = '<article><p style="color: #b91c1c">正文</p><img src="example.png"></article>';
  const before = root.innerHTML;
  const cleanup = applyEditorColors(root, { ...DEFAULT_EDITOR_COLORS, panel: "#000000" });
  expect(root.style.getPropertyValue("--editor-display-panel-ink")).toBe("#ffffff");
  expect(root.innerHTML).toBe(before);
  cleanup();
  expect(root.style.getPropertyValue("--editor-display-page")).toBe("");
  expect(root.hasAttribute("data-editor-colors")).toBe(false);
});
