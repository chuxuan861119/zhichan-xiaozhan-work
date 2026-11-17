import { useId, useMemo, useState } from "react";
import { CadColorPicker } from "./cad-color-picker";
import { cadLineOptionStyle } from "./cad-line-option-style";
import "./cad-appearance-panel.css";

export type CadAppearance = { color: string; lineweight: number; linetype: string };
const COLORS = [
  ["#000000", "黑色"],
  ["#ff0000", "红色"],
  ["#ffbf00", "黄色"],
  ["#008000", "绿色"],
  ["#00bfff", "青色"],
  ["#0000ff", "蓝色"],
  ["#ff00ff", "品红"],
  ["#808080", "灰色"],
];
const TYPES = [
  ["Continuous", "实线", ""],
  ["DASHED", "虚线", "8 4"],
  ["DASHED2", "短虚线", "4 3"],
  ["DOT", "点线", "1 4"],
  ["CENTER", "中心线", "12 3 3 3"],
  ["DASHDOT", "点划线", "10 3 1 3"],
  ["PHANTOM", "双点划线", "10 3 1 3 1 3"],
];
const WEIGHTS = [
  0, 0.05, 0.09, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.53, 0.6, 0.7, 0.8, 0.9, 1,
  1.06, 1.2, 1.4, 1.58, 2, 2.11,
];
export function CadAppearancePanel(props: {
  defaults: CadAppearance;
  selected: CadAppearance[];
  linetypes: string[];
  disabled: boolean;
  available?: { lineweight: boolean; linetype: boolean };
  apply(patch: Partial<CadAppearance>): Promise<void>;
  focusCanvas(): void;
  onError(message: string): void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Default appearance objects may be recreated by callers; their three scalar fields completely determine the summary.
  const [color = "", weight = "", type = ""] = useMemo(() => {
    const values = props.selected.length ? props.selected : [props.defaults];
    return (["color", "lineweight", "linetype"] as const).map(key =>
      values.every(v => v[key] === values[0]![key]) ? String(values[0]![key]) : "");
  }, [props.selected, props.defaults.color, props.defaults.lineweight, props.defaults.linetype]);
  async function change(patch: Partial<CadAppearance>) {
    if (busy || props.disabled) return;
    setBusy(true);
    try {
      await props.apply(patch);
    } catch (error) {
      props.onError(String(error));
    } finally {
      setBusy(false);
      props.focusCanvas();
    }
  }
  const types = [
    ...new Set(
      [...TYPES.map((t) => t[0]!), ...props.linetypes, type].filter(
        (n) => n && !/^(bylayer|byblock)$/i.test(n),
      ),
    ),
  ];
  return (
    <fieldset className="cad-appearance cad-tool-group" disabled={props.disabled || busy}>
      <legend className="cad-tool-heading">
        特性 <span>{props.selected.length ? `已选 ${props.selected.length} 个` : "新绘图"}</span>
      </legend>
      <div className="cad-appearance-row">
        <label htmlFor={`${id}-color`}>颜色</label>
        <CadColorPicker
          id={`${id}-color`}
          value={color}
          label={
            color ? (COLORS.find((c) => c[0] === color)?.[1] ?? color.toUpperCase()) : "多个值"
          }
          disabled={props.disabled || busy}
          onSelect={(next) => void change({ color: next })}
          focusCanvas={props.focusCanvas}
        />
      </div>
      <div className="cad-appearance-row">
        <label htmlFor={`${id}-weight`}>线宽</label>
        <div className="cad-appearance-control">
          <svg viewBox="0 0 32 16" aria-hidden="true">
            <path
              d="M1 8H31"
              stroke="currentColor"
              strokeWidth={weight ? Math.max(1, Number(weight) * 4) : 1}
            />
          </svg>
          <select
            id={`${id}-weight`}
            className="cad-line-select"
            disabled={props.available?.lineweight === false}
            value={weight}
            onChange={(e) => void change({ lineweight: Number(e.target.value) })}
          >
            {!weight && <option value="">多个值</option>}
            {weight && !WEIGHTS.includes(Number(weight)) && (
              <option value={weight} style={cadLineOptionStyle(Math.max(0.5, Number(weight) * 4))}>
                {weight} mm
              </option>
            )}
            {WEIGHTS.map((v) => (
              <option key={v} value={v} style={cadLineOptionStyle(Math.max(0.5, v * 4))}>
                {v === 0 ? "最细" : `${v.toFixed(2)} mm`}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="cad-appearance-row">
        <label htmlFor={`${id}-type`}>线型</label>
        <div className="cad-appearance-control">
          <svg viewBox="0 0 32 16" aria-hidden="true">
            <path
              d="M1 8H31"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray={TYPES.find((t) => t[0] === type)?.[2]}
            />
          </svg>
          <select
            id={`${id}-type`}
            className="cad-line-select"
            disabled={props.available?.linetype === false}
            value={type}
            onChange={(e) => void change({ linetype: e.target.value })}
          >
            {!type && <option value="">多个值</option>}
            {types.map((v) => (
              <option
                key={v}
                value={v}
                style={cadLineOptionStyle(1.5, TYPES.find((t) => t[0] === v)?.[2])}
              >
                {TYPES.find((t) => t[0] === v)?.[1] ?? v}
              </option>
            ))}
          </select>
        </div>
      </div>
      {(props.available?.lineweight === false || props.available?.linetype === false) && (
        <small>仅显示适用于所选对象的特性；文字由字体控制，填充由图案控制。</small>
      )}
    </fieldset>
  );
}
