import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./cad-text-editor.css";

type Props = {
  value: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  readOnly?: boolean;
  onChange(value: string): void;
  onFinish(save: boolean): void;
};

/** A plain-text editing surface in drawing coordinates, never a screen-sized form. */
export function CadTextEditor({
  value,
  x,
  y,
  width,
  fontSize,
  readOnly = false,
  onChange,
  onFinish,
}: Props) {
  const element = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(fontSize * 1.5);
  const initialized = useRef(false);
  const finish = useRef(onFinish);
  finish.current = onFinish;
  useEffect(() => {
    if (readOnly) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        element.current?.contains(target) ||
        target.closest(".cad-tool-settings") ||
        target.closest("[aria-label='CAD标号画布']")
      )
        return;
      if (event.button === 0 || event.button === 2) finish.current(true);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [readOnly]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    // Do not reconcile text children while typing: that resets selection and IME.
    if (readOnly) node.textContent = value;
    if (!initialized.current && !readOnly) {
      initialized.current = true;
      node.textContent = value;
      node.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    setHeight(Math.max(fontSize * 1.5, node.scrollHeight));
  }, [value, width, fontSize, readOnly]);
  return (
    <foreignObject
      x={x}
      y={y - fontSize * 0.311}
      width={width}
      height={height}
      overflow="visible"
      pointerEvents={readOnly ? "none" : undefined}
    >
      <div
        ref={element}
        role={readOnly ? undefined : "textbox"}
        aria-label={readOnly ? undefined : "画布文字"}
        aria-multiline="true"
        contentEditable={readOnly ? false : "plaintext-only"}
        suppressContentEditableWarning
        spellCheck={false}
        style={{
          width: "100%",
          minHeight: fontSize * 1.5,
          fontFamily: '"CAD Unified Text", serif',
          fontSize,
          lineHeight: 1.215,
          fontKerning: "none",
          fontVariantLigatures: "none",
          wordBreak: "break-all",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          color: "black",
          background: "transparent",
          padding: 0,
          margin: 0,
          outline: readOnly ? "none" : "1px solid #1677ff",
          cursor: "text",
          userSelect: "text",
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        onInput={(event) => {
          const node = event.currentTarget;
          onChange(
            (node.innerText ?? node.textContent ?? "").replace(/\r\n?/g, "\n"),
          );
          setHeight(Math.max(fontSize * 1.5, node.scrollHeight));
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (
            event.key === "Escape" ||
            (event.key === "Enter" && (event.ctrlKey || event.metaKey))
          ) {
            event.preventDefault();
            onFinish(event.key !== "Escape");
          }
        }}
      />
    </foreignObject>
  );
}
