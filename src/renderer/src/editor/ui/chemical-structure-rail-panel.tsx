import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { useEffect, useState } from "react";
import type { EditorCommandBus } from "../../app/command-bus";
import { TransientFunctionRailSlot } from "../../shared/transient-function-rail-slot";
import type { ChemicalStructureEditRequest } from "../nodes/chemical-structure-node";
import { ChemicalStructureTools } from "./chemical-structure-tools";

type StructureSelection = ChemicalStructureEditRequest & {
  widthMm: number;
  alignment: "left" | "center" | "right";
};

function selectedStructure(editor: Editor | null): StructureSelection | null {
  if (!editor || editor.isDestroyed || !editor.isEditable) return null;
  const selection = editor.state.selection;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "chemicalStructure")
    return null;
  const attrs = selection.node.attrs;
  return {
    position: selection.from,
    nodeId: String(attrs.nodeId),
    ketSource: String(attrs.ketSource),
    editorMode: attrs.editorMode === "macromolecule" ? "macromolecule" : "molecule",
    widthMm: Number(attrs.widthMm),
    alignment: attrs.alignment,
  };
}

export function ChemicalStructureRailPanel({
  commandBus,
  editorId,
  contentWidthMm,
}: {
  commandBus: EditorCommandBus;
  editorId: string;
  contentWidthMm: number;
}) {
  const [selection, setSelection] = useState(() =>
    selectedStructure(commandBus.getEditor(editorId) ?? null),
  );
  useEffect(() => {
    let detach = () => {};
    const bind = (editor: Editor | null) => {
      detach();
      const update = () => setSelection(selectedStructure(editor));
      update();
      if (!editor) {
        detach = () => {};
        return;
      }
      editor.on("transaction", update);
      detach = () => {
        editor.off("transaction", update);
      };
    };
    bind(commandBus.getEditor(editorId) ?? null);
    const unsubscribe = commandBus.subscribeEditors((id, editor) => {
      if (id === editorId) bind(editor);
    });
    return () => {
      unsubscribe();
      detach();
    };
  }, [commandBus, editorId]);

  if (!selection) {
    return <TransientFunctionRailSlot open={false}>{null}</TransientFunctionRailSlot>;
  }
  const currentEditor = () => {
    const editor = commandBus.getEditor(editorId);
    return selectedStructure(editor ?? null)?.nodeId === selection.nodeId ? editor : null;
  };
  const update = (attrs: Record<string, unknown>) => {
    currentEditor()?.commands.updateAttributes("chemicalStructure", attrs);
  };
  return (
    <TransientFunctionRailSlot open>
      <section
        className="chemical-structure-rail-panel function-rail-transient-panel"
        aria-label="结构式设置"
        onPointerDown={(event) => {
          if (
            event.button === 0 &&
            event.target instanceof Element &&
            !event.target.closest("input, select, textarea")
          )
            event.preventDefault();
        }}
      >
        <h3>结构式设置</h3>
        <ChemicalStructureTools
          key={selection.nodeId}
          widthMm={selection.widthMm}
          maxWidthMm={contentWidthMm}
          alignment={selection.alignment}
          onWidthChange={(widthMm) => update({ widthMm })}
          onAlignmentChange={(alignment) => update({ alignment })}
          onEdit={() => {
            const editor = currentEditor();
            if (!editor) return;
            const current = selectedStructure(editor);
            const options = editor.extensionManager.extensions.find(
              (extension) => extension.name === "chemicalStructure",
            )?.options as { onEdit?: (request: ChemicalStructureEditRequest) => void } | undefined;
            if (current) {
              const { nodeId, ketSource, editorMode, position } = current;
              options?.onEdit?.({
                nodeId,
                ketSource,
                position,
                ...(editorMode ? { editorMode } : {}),
              });
            }
          }}
          onDelete={() => currentEditor()?.commands.deleteSelection()}
        />
      </section>
    </TransientFunctionRailSlot>
  );
}
