import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import { NodeSelection, Plugin } from "@tiptap/pm/state";
import {
  BLOCK_FORMULA_MATH_STYLE,
  BLOCK_FORMULA_STYLE,
} from "../../../../shared/document/formula-layout";
import type { FormulaKind } from "../../../../shared/document/model";

export type FormulaMode = "inline" | "block";
export type FormulaEditRequest = {
  mode: FormulaMode;
  latex: string;
  kind: FormulaKind;
  position?: number;
};

function formulaKindFor(value: unknown): FormulaKind {
  return value === "chemistry" ? "chemistry" : "math";
}

function formulaInteractionPlugin(onEdit?: (request: FormulaEditRequest) => void) {
  return new Plugin({
    view(view) {
      const handleFormulaClick = (event: MouseEvent) => {
        if (!(event.target instanceof Element)) return;
        const formula = event.target.closest("[data-type='inline-math'], [data-type='block-math']");
        if (!formula || !view.dom.contains(formula)) return;
        const position = view.posAtDOM(formula, 0);
        const node = view.state.doc.nodeAt(position);
        if (!node) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === "dblclick") {
          onEdit?.({
            mode: node.type.name === "inlineMath" ? "inline" : "block",
            latex: String(node.attrs.latex),
            kind: formulaKindFor(node.attrs.formulaKind),
            position,
          });
          return;
        }
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)));
      };
      view.dom.addEventListener("click", handleFormulaClick, true);
      view.dom.addEventListener("dblclick", handleFormulaClick, true);
      return {
        destroy() {
          view.dom.removeEventListener("click", handleFormulaClick, true);
          view.dom.removeEventListener("dblclick", handleFormulaClick, true);
        },
      };
    },
  });
}

export function createMathematicsExtension(onEdit?: (request: FormulaEditRequest) => void) {
  const katexOptions = {
    throwOnError: false,
    strict: "warn",
    trust: false,
  } as const;
  const formulaKindAttribute = {
    default: "math",
    parseHTML: (element: HTMLElement) => element.getAttribute("data-formula-kind") ?? "math",
    renderHTML: (attributes: Record<string, unknown>) => ({
      "data-formula-kind": formulaKindFor(attributes.formulaKind),
    }),
  };
  const fontSizeAttribute = {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const value = Number(element.getAttribute("data-font-size-pt"));
      return Number.isFinite(value) && value >= 8 && value <= 72 ? value : null;
    },
    renderHTML: (attributes: Record<string, unknown>) =>
      typeof attributes.fontSizePt === "number"
        ? {
            "data-font-size-pt": attributes.fontSizePt,
            style: `font-size: ${attributes.fontSizePt}pt`,
          }
        : {},
  };
  const colorAttribute = {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const color = element.getAttribute("data-formula-color");
      return color && /^#[0-9a-f]{6}$/iu.test(color) ? color.toUpperCase() : null;
    },
    renderHTML: (attributes: Record<string, unknown>) =>
      typeof attributes.color === "string" && /^#[0-9a-f]{6}$/iu.test(attributes.color)
        ? { "data-formula-color": attributes.color, style: `color: ${attributes.color}` }
        : {},
  };

  return [
    BlockMath.extend({
      addNodeView() {
        const createParentView = this.parent?.();
        if (!createParentView) throw new Error("Block math NodeView is unavailable");
        return (props) => {
          const nodeView = createParentView(props);
          const dom = nodeView.dom as HTMLElement;
          dom.dataset.formulaAlignment = props.node.attrs.alignment;
          dom.style.cssText = `${BLOCK_FORMULA_STYLE} text-align: ${props.node.attrs.alignment};`;
          if (props.node.attrs.color) dom.style.color = props.node.attrs.color;
          if (props.node.attrs.fontSizePt != null)
            dom.style.fontSize = `${props.node.attrs.fontSizePt}pt`;
          const math = dom.querySelector<HTMLElement>(".katex-display");
          if (math) math.style.cssText = BLOCK_FORMULA_MATH_STYLE;
          const content = math?.querySelector<HTMLElement>(".katex");
          if (content) {
            content.style.textAlign = "inherit";
            content.style.fontSize = "1em";
          }
          return nodeView;
        };
      },
      addAttributes() {
        return {
          ...this.parent?.(),
          formulaKind: formulaKindAttribute,
          fontSizePt: fontSizeAttribute,
          color: colorAttribute,
          alignment: {
            default: "center",
            parseHTML: (element: HTMLElement) =>
              element.getAttribute("data-formula-alignment") ?? "center",
            renderHTML: (attributes: Record<string, unknown>) => ({
              "data-formula-alignment": attributes.alignment,
              style: `text-align: ${attributes.alignment}`,
            }),
          },
        };
      },
      addProseMirrorPlugins() {
        return [formulaInteractionPlugin(onEdit)];
      },
    }).configure({ katexOptions: { ...katexOptions, displayMode: true } }),
    InlineMath.extend({
      addNodeView() {
        const createParentView = this.parent?.();
        if (!createParentView) throw new Error("Inline math NodeView is unavailable");
        return (props) => {
          const nodeView = createParentView(props);
          const dom = nodeView.dom as HTMLElement;
          if (props.node.attrs.color) dom.style.color = props.node.attrs.color;
          if (props.node.attrs.fontSizePt != null)
            dom.style.fontSize = `${props.node.attrs.fontSizePt}pt`;
          const content = dom.querySelector<HTMLElement>(".katex");
          if (content) content.style.fontSize = "1em";
          return nodeView;
        };
      },
      addAttributes() {
        return {
          ...this.parent?.(),
          formulaKind: formulaKindAttribute,
          fontSizePt: fontSizeAttribute,
          color: colorAttribute,
        };
      },
      addProseMirrorPlugins() {
        return [formulaInteractionPlugin(onEdit)];
      },
    }).configure({ katexOptions }),
  ];
}
