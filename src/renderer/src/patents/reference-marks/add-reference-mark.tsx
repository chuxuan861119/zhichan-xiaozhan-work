import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import type { ParsedReferenceMark } from "../../../../shared/patent/reference-marks";
import { referenceMarkRegistrationProblem } from "../../../../shared/patent/reference-mark-registration";
import { MotionPresence } from "../../app/motion-presence";
import { StandardDialog } from "../../shared/standard-dialog";
import { useEditorSessionVisible } from "../../shared/editor-session-scope";
import "./add-reference-mark.css";

export type AddReferenceMarkAction = (entry: ParsedReferenceMark) => { ok: boolean; message: string };

export function AddReferenceMark({ entries, onAdd, disabled = false }: {
  entries: readonly ParsedReferenceMark[];
  onAdd?: AddReferenceMarkAction;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sessionVisible = useEditorSessionVisible();
  const [number, setNumber] = useState("1");
  const [keyword, setKeyword] = useState("");
  const [error, setError] = useState("");
  const keywordRef = useRef<HTMLInputElement>(null);
  function add() {
    if (!open || !onAdd || disabled) return;
    const entry = { number: Number(number), keyword: keyword.trim() };
    const problem = referenceMarkRegistrationProblem(entries, entry);
    if (problem) { setError(problem); return; }
    const result = onAdd(entry);
    if (result.ok) setOpen(false);
    else setError(result.message);
  }
  return <>
    <button type="button" className="reference-mark-panel__add" aria-label="新增附图标记"
      title="新增附图标记" disabled={disabled || !onAdd} onClick={() => {
        let next = entries.reduce((max, mark) => Math.max(max, mark.number), 0) + 1;
        if (!Number.isSafeInteger(next)) {
          const used = new Set(entries.map(mark => mark.number));
          next = 1;
          while (used.has(next)) next++;
        }
        setNumber(String(next)); setKeyword(""); setError(""); setOpen(true);
      }}><Plus size={16} aria-hidden="true" /></button>
    {sessionVisible && <MotionPresence>{open && <StandardDialog open portal title="新增附图标记" size="s"
      onCancel={() => setOpen(false)} initialFocusRef={keywordRef}
      footer={<><button type="button" onClick={() => setOpen(false)}>取消</button>
        <button type="button" disabled={disabled} onClick={add}>添加</button></>}>
      <form className="reference-mark-add-form" onSubmit={event => { event.preventDefault(); add(); }}>
        <label>编号<input aria-label="编号" inputMode="numeric" value={number}
          onChange={event => { setNumber(event.target.value); setError(""); }} /></label>
        <label>关键词<input ref={keywordRef} aria-label="关键词" value={keyword}
          onChange={event => { setKeyword(event.target.value); setError(""); }}
          onKeyDown={event => {
            if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
          }} /></label>
        <p className="reference-mark-add-hint">登记后，可使用增补编号为正文中的关键词补充编号。</p>
        {error && <p role="alert" className="reference-mark-add-error">{error}</p>}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1}>添加</button>
      </form>
    </StandardDialog>}</MotionPresence>}
  </>;
}
