import { useEffect, useState } from "react";
import type { EditorCommandBus } from "../../app/command-bus";
import type { Mixed, TableSelectionSnapshot } from "./table-selection";

const draft = (value: Mixed<number> | undefined) =>
  typeof value === "number" ? String(value) : "";
const sides = ["top", "right", "bottom", "left"] as const;
export function TableFormattingControls({
  editorId,
  commandBus,
  selection,
}: {
  editorId: string;
  commandBus: EditorCommandBus;
  selection: TableSelectionSnapshot;
}) {
  const [line, setLine] = useState(draft(selection.lineSpacing));
  const [padding, setPadding] = useState({
    top: "",
    right: "",
    bottom: "",
    left: "",
  });
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setLine(draft(selection.lineSpacing));
    setError("");
  }, [selection.lineSpacing]);
  useEffect(() => {
    setPadding({
      top: draft(selection.padding?.top),
      right: draft(selection.padding?.right),
      bottom: draft(selection.padding?.bottom),
      left: draft(selection.padding?.left),
    });
  }, [
    selection.padding?.top,
    selection.padding?.right,
    selection.padding?.bottom,
    selection.padding?.left,
  ]);
  const applyLine = () => {
    if (!line.trim() || !commandBus.setTableFormatting(editorId, { lineSpacing: Number(line) }))
      setError("行距请输入 1–3 倍");
    else setError("");
  };
  const applyPadding = () => {
    const changes: Partial<Record<(typeof sides)[number], number>> = {};
    for (const side of sides) {
      if (!padding[side].trim()) continue;
      const value = Number(padding[side]);
      if (!Number.isFinite(value) || value < 0 || value > 20) {
        setError("留白请输入 0–20 毫米");
        return;
      }
      changes[side] = value;
    }
    if (commandBus.setTableFormatting(editorId, { padding: changes })) setError("");
  };
  return (
    <div className="table-rail-panel__group-content table-formatting-controls">
      <label className="table-rail-panel__dimension-field">
        <span>行距</span>
        <select
          aria-label="表格行距"
          value={["1", "1.15", "1.5", "2"].includes(line) ? line : "custom"}
          onChange={(e) => {
            if (e.target.value === "custom") {
              setLine("");
              return;
            }
            setLine(e.target.value);
            commandBus.setTableFormatting(editorId, {
              lineSpacing: Number(e.target.value),
            });
          }}
        >
          <option value="1">单倍</option>
          <option value="1.15">1.15 倍</option>
          <option value="1.5">1.5 倍</option>
          <option value="2">2 倍</option>
          <option value="custom">
            {selection.lineSpacing === "mixed" ? "多种 / 自定义" : "自定义"}
          </option>
        </select>
      </label>
      <div className="table-rail-panel__dimension-row">
        <label className="table-rail-panel__dimension-field">
          <span>自定义倍数</span>
          <input
            aria-label="表格行距倍数"
            type="number"
            min="1"
            max="3"
            step="0.05"
            value={line}
            placeholder={selection.lineSpacing === "mixed" ? "多种" : "1–3"}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyLine();
            }}
          />
        </label>
        <button className="table-rail-panel__button" type="button" onClick={applyLine}>
          应用行距
        </button>
      </div>
      {(expanded ? sides : (["top", "left"] as const)).map((side) => {
        const partner = side === "top" ? "bottom" : "right";
        const value = expanded || padding[side] === padding[partner] ? padding[side] : "";
        return (
          <label key={side} className="table-rail-panel__dimension-field">
            <span>
              {expanded
                ? { top: "上", right: "右", bottom: "下", left: "左" }[side]
                : side === "top"
                  ? "上下留白"
                  : "左右留白"}
              （mm）
            </span>
            <input
              aria-label={`单元格${expanded ? { top: "上", right: "右", bottom: "下", left: "左" }[side] : side === "top" ? "上下" : "左右"}留白`}
              type="number"
              min="0"
              max="20"
              step="0.1"
              value={value}
              placeholder="多种"
              onChange={(e) =>
                setPadding((current) => ({
                  ...current,
                  [side]: e.target.value,
                  ...(!expanded ? { [partner]: e.target.value } : {}),
                }))
              }
            />
          </label>
        );
      })}
      <div className="table-rail-panel__buttons">
        <button
          className="table-rail-panel__button"
          type="button"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "合并设置" : "分别设置"}
        </button>
        <button className="table-rail-panel__button" type="button" onClick={applyPadding}>
          应用留白
        </button>
        <button
          className="table-rail-panel__button"
          type="button"
          onClick={() => {
            commandBus.setTableFormatting(editorId, { compact: true });
            setError(selection.rowHeightRule ? "已紧凑排版；手动行高保留，可选择自动行高。" : "");
          }}
        >
          紧凑排版
        </button>
      </div>
      <p>行距调整所选段落；留白调整所选单元格。</p>
      {error ? <p role="status">{error}</p> : null}
    </div>
  );
}
