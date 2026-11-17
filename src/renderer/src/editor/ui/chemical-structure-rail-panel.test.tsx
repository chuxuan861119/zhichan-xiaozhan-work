import { act, fireEvent, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { EditorCommandBus } from "../../app/command-bus";
import { createPatentExtensions } from "../extensions";
import { ChemicalStructureRailPanel } from "./chemical-structure-rail-panel";

test("edits the selected structure in its own rail, respects page width and editor replacement", () => {
  const bus = new EditorCommandBus();
  const onEdit = vi.fn();
  const createEditor = () =>
    new Editor({
      extensions: createPatentExtensions("session", { onChemicalStructureEdit: onEdit }),
      content: {
        type: "doc",
        content: [
          {
            type: "chemicalStructure",
            attrs: { nodeId: "structure-1", ketSource: "ket", widthMm: 80, alignment: "center" },
          },
          { type: "paragraph" },
        ],
      },
    });
  const editor = createEditor();
  const other = createEditor();
  const unregister = bus.register("left", editor);
  const unregisterOther = bus.register("right", other);
  const view = render(
    <ChemicalStructureRailPanel commandBus={bus} editorId="left" contentWidthMm={130} />,
  );
  act(() => editor.commands.setNodeSelection(0));
  expect(screen.getByRole("region", { name: "结构式设置" }).className).toContain(
    "function-rail-transient-panel",
  );
  const width = screen.getByRole("spinbutton", { name: "结构式宽度（毫米）" });
  fireEvent.change(width, { target: { value: "150" } });
  fireEvent.blur(width);
  expect(editor.state.doc.firstChild?.attrs.widthMm).toBe(130);
  expect(other.state.doc.firstChild?.attrs.widthMm).toBe(80);
  fireEvent.click(screen.getByRole("button", { name: "右对齐" }));
  expect(editor.state.doc.firstChild?.attrs.alignment).toBe("right");
  fireEvent.click(screen.getByRole("button", { name: "编辑结构式" }));
  expect(onEdit).toHaveBeenCalledWith(
    expect.objectContaining({ nodeId: "structure-1", position: 0 }),
  );
  act(() => editor.commands.setTextSelection(2));
  expect(screen.queryByRole("region", { name: "结构式设置" })).toBeNull();
  act(() => editor.commands.setNodeSelection(0));
  fireEvent.click(screen.getByRole("button", { name: "删除结构式" }));
  expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
  act(() => unregister());
  expect(screen.queryByRole("region", { name: "结构式设置" })).toBeNull();
  const replacement = createEditor();
  let releaseReplacement = () => {};
  act(() => {
    releaseReplacement = bus.register("left", replacement);
    replacement.commands.setNodeSelection(0);
  });
  expect(screen.getByRole("spinbutton", { name: "结构式宽度（毫米）" }).getAttribute("value")).toBe(
    "80",
  );
  view.unmount();
  releaseReplacement();
  unregisterOther();
  editor.destroy();
  other.destroy();
  replacement.destroy();
});
