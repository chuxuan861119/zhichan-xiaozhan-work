import { useId, useState } from "react";
import { CadNumberInput } from "./cad-number-input";
import type { CadScene } from "./cadcraft-client";

type Gear = NonNullable<CadScene["entities"][number]["gear"]>;
export function CadGearProperties({
  gear,
  disabled,
  apply,
}: {
  gear: Gear;
  disabled: boolean;
  apply: (gear: Gear) => Promise<void>;
}) {
  const sizeId = useId();
  const [teeth, setTeeth] = useState(String(gear.teeth));
  const [size, setSize] = useState(String(gear.size));
  const [hole, setHole] = useState(gear.hole);
  const [applying, setApplying] = useState(false);
  const min = gear.kind === "rack" ? 2 : 8;
  const valid =
    Number.isInteger(Number(teeth)) &&
    Number(teeth) >= min &&
    Number(teeth) <= 120 &&
    Number(size) > 1e-6 &&
    Number(size) <= 1e8;
  const changed =
    Number(teeth) !== gear.teeth ||
    hole !== gear.hole ||
    Math.abs(Number(size) - gear.size) > 1e-7 * Math.max(1, gear.size);
  async function commit() {
    if (disabled || applying || !valid || !changed) return;
    setApplying(true);
    try {
      await apply({ ...gear, teeth: Number(teeth), size: Number(size), hole });
    } finally {
      setApplying(false);
    }
  }
  return (
    <section
      className="cad-tool-settings function-rail-transient-panel"
      aria-label="齿轮设置"
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          void commit();
        }
      }}
    >
      <header>
        <strong>
          {gear.kind === "rack" ? "齿条" : gear.kind === "internal" ? "内齿圈" : "外齿轮"}设置
        </strong>
      </header>
      <label>
        齿数
        <input
          aria-label="齿轮齿数"
          type="number"
          min={min}
          max={120}
          step={1}
          value={teeth}
          disabled={disabled || applying}
          onChange={(e) => setTeeth(e.target.value)}
        />
      </label>
      <label htmlFor={sizeId}>
        {gear.kind === "rack" ? "长度" : "外径"}
        <CadNumberInput
          id={sizeId}
          aria-label="齿轮大小"
          min={0.001}
          max={1e8}
          step="any"
          value={size}
          disabled={disabled || applying}
          onChange={(e) => setSize(e.target.value)}
        />
      </label>
      {gear.kind === "external" && (
        <label className="cad-snap-toggle">
          <input
            type="checkbox"
            checked={hole}
            disabled={disabled || applying}
            onChange={(e) => setHole(e.target.checked)}
          />
          中心孔
        </label>
      )}
      {!valid && <small role="alert">齿数须为 {min}～120 的整数，大小须大于 0。</small>}
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
