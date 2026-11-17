import { type Ref, useImperativeHandle, useRef, useState } from "react";
import "./cad-label-keyword-prompt.css";

/** Local text state keeps typing out of the CAD scene and persistence hot paths. */
export type CadLabelKeywordPromptHandle = { finish(): boolean };
export function CadLabelKeywordPrompt({ ref, x, y, units, number, onCommit, onClose }: {
  ref?: Ref<CadLabelKeywordPromptHandle>;
  x: number; y: number; units: number; number: number;
  onCommit(keyword: string): { ok: boolean; message: string };
  onClose(): void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const finished = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  function close() { finished.current = true; onClose(); }
  function save() {
    if (finished.current) return true;
    const keyword = (input.current?.value ?? text).trim();
    if (!keyword) { close(); return true; }
    const result = onCommit(keyword);
    if (result.ok) close();
    else setError(result.message);
    return result.ok;
  }
  // Only the drawing command decides when the next label starts. Panning,
  // zooming and losing focus are not confirmation or cancellation.
  useImperativeHandle(ref, () => ({ finish: save }));
  return <foreignObject x={x} y={y} width={248 * units} height={(error ? 92 : 46) * units}
    data-cad-keyword-prompt style={{ fontSize: 14 * units, cursor: "auto" }}
    onPointerDown={event => event.stopPropagation()}
    onPointerUp={event => event.stopPropagation()}
    onPointerMove={event => event.stopPropagation()}
    onWheel={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => event.stopPropagation()}
    onKeyUp={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); save(); }
    }}>
    <div className="cad-label-keyword-prompt">
      <input ref={input} aria-label={`标号${number}关键词`} placeholder="填入关键词（选填）" value={text}
        onChange={event => { setText(event.target.value); setError(""); }} />
      {error && <div role="alert">{error}</div>}
    </div>
  </foreignObject>;
}
