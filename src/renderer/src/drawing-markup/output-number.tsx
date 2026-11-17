import { useEffect, useState } from "react";
import { CadNumberInput } from "./cad-number-input";

export function OutputNumber({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  onCommit,
}: {
  id?: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const number = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(number) && number >= min && number <= max;
  return (
    <CadNumberInput
      id={id}
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={draft}
      aria-invalid={!valid}
      title={`请输入 ${min}–${max} 之间的数值`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (valid) {
          if (number !== value) onCommit(number);
        } else setDraft(String(value));
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.stopPropagation();
          setDraft(String(value));
        }
      }}
    />
  );
}
