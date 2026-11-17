import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export const inspectionSelectionKey = new PluginKey<boolean>("inspectionSelection");

export const InspectionSelection = Extension.create({
  name: "inspectionSelection",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: inspectionSelectionKey,
        state: {
          init: () => false,
          apply: (tr, value) => {
            const origin = tr.getMeta(inspectionSelectionKey);
            if (typeof origin === "boolean") return origin;
            return tr.selectionSet || tr.docChanged ? false : value;
          },
        },
        props: {
          handleDOMEvents: {
            pointerdown: (view) => {
              if (inspectionSelectionKey.getState(view.state))
                view.dispatch(view.state.tr.setMeta(inspectionSelectionKey, false));
              return false;
            },
          },
        },
      }),
    ];
  },
});
