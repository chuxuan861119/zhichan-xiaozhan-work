import { useId, useState } from "react";
import { CadNumberInput } from "./cad-number-input";
import type { CadScene } from "./cadcraft-client";

type Spring = NonNullable<CadScene["entities"][number]["spring"]>;
export function CadSpringProperties({
  spring,
  disabled,
  apply,
}: {
  spring: Spring;
  disabled: boolean;
  apply: (spring: Spring) => Promise<void>;
}) {
  const id = useId();
  const [turns, setTurns] = useState(String(spring.turns));
  const [length, setLength] = useState(String(spring.length));
  const [width, setWidth] = useState(String(spring.width));
  const [wire, setWire] = useState(String(spring.wire));
  const [applying, setApplying] = useState(false);
  const n = Number(turns),
    l = Number(length),
    w = Number(width),
    d = Number(wire);
  const valid =
    Number.isInteger(n) &&
    n >= 3 &&
    n <= 24 &&
    l > 1e-6 &&
    l <= 1e8 &&
    w > 1e-6 &&
    w <= 1e8 &&
    d > 1e-6 &&
    d < w / 3 &&
    (spring.kind === "extension" ? l >= 2 * w + (n - 1) * d : d < l / (2 * n));
  const changed =
    n !== spring.turns || l !== spring.length || w !== spring.width || d !== spring.wire;
  async function commit() {
    if (!valid || !changed || disabled || applying) return;
    setApplying(true);
    try {
      await apply({ ...spring, turns: n, length: l, width: w, wire: d });
    } finally {
      setApplying(false);
    }
  }
  return (
    <section
      className="cad-tool-settings function-rail-transient-panel"
      aria-label="弹簧设置"
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          void commit();
        }
      }}
    >
      <header>
        <strong>{spring.kind === "extension" ? "拉伸弹簧设置" : "压缩弹簧设置"}</strong>
      </header>
      {(
        [
          ["圈数", turns, setTurns, 3, 24, 1],
          ["长度", length, setLength, 0.001, 1e8, "any"],
          ["宽度", width, setWidth, 0.001, 1e8, "any"],
          ["线径", wire, setWire, 0.001, 1e8, "any"],
        ] as const
      ).map(([label, value, setValue, min, max, step]) => (
        <label key={label} htmlFor={`${id}-${label}`}>
          {label}
          <CadNumberInput
            id={`${id}-${label}`}
            aria-label={`弹簧${label}`}
            decimals={label === "圈数" ? null : 1}
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled || applying}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
      ))}
      {!valid && (
        <small role="alert">
          {spring.kind === "extension"
            ? "圈数须为 3～24 的整数；线径须小于宽度的三分之一，总长须容纳两端挂钩和线圈。"
            : "圈数须为 3～24 的整数；线径须小于宽度的三分之一和半圈间距。"}
        </small>
      )}
      <div className="cad-tool-settings__actions">
        <button
          type="button"
          disabled={disabled || applying || !valid || !changed}
          onClick={() => void commit()}
        >
          应用
        </button>
      </div>
    </section>
  );
}
