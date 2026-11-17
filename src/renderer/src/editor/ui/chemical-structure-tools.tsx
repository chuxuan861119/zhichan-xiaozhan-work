import { useEffect, useState } from "react";

type ChemicalStructureAlignment = "left" | "center" | "right";

type ChemicalStructureToolsProps = {
  widthMm: number;
  maxWidthMm?: number;
  alignment: ChemicalStructureAlignment;
  onWidthChange(widthMm: number): void;
  onAlignmentChange(alignment: ChemicalStructureAlignment): void;
  onEdit(): void;
  onDelete(): void;
};

export function ChemicalStructureTools({
  widthMm,
  maxWidthMm = 165,
  alignment,
  onWidthChange,
  onAlignmentChange,
  onEdit,
  onDelete,
}: ChemicalStructureToolsProps) {
  const maximum = Math.max(10, Math.min(165, maxWidthMm));
  const [widthInput, setWidthInput] = useState(String(widthMm));
  useEffect(() => setWidthInput(String(widthMm)), [widthMm]);
  const clampWidth = (value: number) => Math.min(maximum, Math.max(10, value));
  const commitWidth = () => {
    const value = Number(widthInput);
    if (!widthInput.trim() || !Number.isFinite(value)) {
      setWidthInput(String(widthMm));
      return;
    }
    const next = Math.round(clampWidth(value) * 10) / 10;
    setWidthInput(String(next));
    if (next !== widthMm) onWidthChange(next);
  };
  return (
    <fieldset className="chemical-structure-tools" contentEditable={false}>
      <legend className="screen-reader-only">结构式工具</legend>
      <label>
        宽度（毫米）
        <input
          type="number"
          min="10"
          max={maximum}
          step="0.1"
          value={widthInput}
          aria-label="结构式宽度（毫米）"
          onChange={(event) => setWidthInput(event.target.value)}
          onBlur={commitWidth}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitWidth();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setWidthInput(String(widthMm));
            }
          }}
        />
      </label>
      <input
        type="range"
        min="10"
        max={maximum}
        step="1"
        value={clampWidth(widthMm)}
        aria-label="结构式宽度"
        onChange={(event) => onWidthChange(clampWidth(Number(event.target.value)))}
      />
      <fieldset className="chemical-structure-alignments">
        <legend className="screen-reader-only">结构式对齐方式</legend>
        {(["left", "center", "right"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={alignment === value ? "is-active" : undefined}
            aria-label={value === "left" ? "左对齐" : value === "center" ? "居中" : "右对齐"}
            aria-pressed={alignment === value}
            onClick={() => onAlignmentChange(value)}
          >
            {value === "left" ? "左" : value === "center" ? "中" : "右"}
          </button>
        ))}
      </fieldset>
      <button type="button" className="chemical-structure-edit" onClick={onEdit}>
        编辑结构式
      </button>
      <button type="button" aria-label="删除结构式" onClick={onDelete}>
        删除
      </button>
    </fieldset>
  );
}
