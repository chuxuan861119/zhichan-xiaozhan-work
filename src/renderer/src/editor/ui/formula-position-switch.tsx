import { useId } from "react";

export function FormulaPositionSwitch({
  mode,
  kind,
  onChange,
}: {
  mode: "inline" | "block";
  kind: "公式" | "方程式";
  onChange(mode: "inline" | "block"): void;
}) {
  const name = useId();
  return (
    <fieldset
      className="formula-position-switch"
      aria-label={`${kind}位置`}
      onPointerDownCapture={(event) => event.stopPropagation()}
    >
      {(["inline", "block"] as const).map((value) => {
        const label = value === "inline" ? "行内" : "独立";
        return (
          <label key={value} title={`${label}${kind}`}>
            <input
              className="formula-position-switch__input"
              type="radio"
              name={name}
              aria-label={`${label}${kind}`}
              checked={mode === value}
              onChange={() => onChange(value)}
            />
            <span aria-hidden="true">{label}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
