import { useId, useState } from "react";
import { type ChainSpec, chainOtherRadius, chainWheelSize } from "./cad-chain-geometry";
import { CadNumberInput } from "./cad-number-input";
export function CadChainProperties({
  chain,
  disabled,
  apply,
}: {
  chain: ChainSpec;
  disabled: boolean;
  apply: (s: ChainSpec) => Promise<void>;
}) {
  const inputId = useId();
  const [geometry, setGeometry] = useState(chain);
  const [draft, setDraft] = useState(() => ({
    radius: String(chain.radius * 2),
    otherRadius: String(chainOtherRadius(chain) * 2),
    teeth: String(chain.teeth),
    otherTeeth: String(chain.otherTeeth),
    hole: String(chain.hole * 2),
    otherHole: String(chain.otherHole * 2),
    distance: String(Math.hypot(chain.end[0] - chain.at[0], chain.end[1] - chain.at[1])),
  }));
  const [busy, setBusy] = useState(false);
  const radius = geometry.radius,
    otherRadius = chainOtherRadius(geometry),
    distance = Number(draft.distance);
  const valid =
    Object.values(draft).every((v) => v.trim() !== "" && Number.isFinite(Number(v))) &&
    Number(draft.radius) > 0 &&
    Number(draft.otherRadius) > 0 &&
    radius >= 1e-4 &&
    otherRadius >= 1e-4 &&
    radius <= 1e8 &&
    otherRadius <= 1e8 &&
    distance > 1e-6 &&
    distance <= 1e8 &&
    Number(draft.hole) >= 0 &&
    Number(draft.hole) <= radius &&
    Number(draft.otherHole) >= 0 &&
    Number(draft.otherHole) <= otherRadius &&
    [Number(draft.teeth), Number(draft.otherTeeth)].every(
      (n) => Number.isInteger(n) && n >= 8 && n <= 120,
    ) &&
    (chain.single || distance >= (radius + otherRadius) * 1.08);
  const next = {
    ...chain,
    radius,
    otherRadius,
    teeth: geometry.teeth,
    otherTeeth: geometry.otherTeeth,
    hole: Number(draft.hole) / 2,
    otherHole: Number(draft.otherHole) / 2,
  };
  const oldDistance = Math.hypot(chain.end[0] - chain.at[0], chain.end[1] - chain.at[1]);
  next.end = [
    chain.at[0] + ((chain.end[0] - chain.at[0]) * distance) / oldDistance,
    chain.at[1] + ((chain.end[1] - chain.at[1]) * distance) / oldDistance,
  ];
  const changed =
    next.teeth !== chain.teeth ||
    next.otherTeeth !== chain.otherTeeth ||
    [
      [radius, chain.radius],
      [otherRadius, chainOtherRadius(chain)],
      [next.hole, chain.hole],
      [next.otherHole, chain.otherHole],
      [distance, oldDistance],
    ].some(([a, b]) => Math.abs(a! - b!) > 1e-9 * Math.max(1, Math.abs(b!)));
  function edit(key: keyof typeof draft, value: string) {
    const number = Number(value),
      teeth = key.toLowerCase().includes("teeth");
    if (
      ["radius", "otherRadius", "teeth", "otherTeeth"].includes(key) &&
      value.trim() !== "" &&
      Number.isFinite(number) &&
      number > 0 &&
      (!teeth || (Number.isInteger(number) && number >= 8 && number <= 120)) &&
      distance > 0 &&
      Number.isFinite(distance)
    ) {
      const updated = chainWheelSize(
        next,
        key.startsWith("other"),
        teeth ? number : number / 2,
        teeth,
      );
      setGeometry(updated);
      setDraft({
        ...draft,
        radius: String(updated.radius * 2),
        otherRadius: String(chainOtherRadius(updated) * 2),
        teeth: String(updated.teeth),
        otherTeeth: String(updated.otherTeeth),
        hole: String(updated.hole * 2),
        otherHole: String(updated.otherHole * 2),
        [key]: value,
      });
    } else setDraft({ ...draft, [key]: value });
  }
  async function commit() {
    if (disabled || busy || !valid || !changed) return;
    setBusy(true);
    try {
      await apply(next);
    } finally {
      setBusy(false);
    }
  }
  const fields: [keyof typeof draft, string][] = chain.single
    ? [
        ["radius", "轮径"],
        ["teeth", "齿数"],
        ["hole", "轴孔直径"],
      ]
    : [
        ["distance", "中心距"],
        ["radius", "左轮轮径"],
        ["otherRadius", "右轮轮径"],
        ["teeth", "左轮齿数"],
        ["otherTeeth", "右轮齿数"],
        ["hole", "左轮轴孔"],
        ["otherHole", "右轮轴孔"],
      ];
  return (
    <section
      className="cad-tool-settings function-rail-transient-panel"
      aria-label="链轮设置"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          void commit();
        }
      }}
    >
      <header>
        <strong>{chain.single ? "链轮" : "链条"}设置</strong>
      </header>
      {fields.map(([key, label]) => (
        <label key={key} htmlFor={`${inputId}-${key}`}>
          {label}
          <CadNumberInput
            id={`${inputId}-${key}`}
            aria-label={label}
            value={draft[key]}
            disabled={disabled || busy}
            decimals={key.toLowerCase().includes("teeth") ? null : 1}
            step={key.toLowerCase().includes("teeth") ? 1 : "any"}
            onChange={(e) => edit(key, e.target.value)}
            onBlur={() => {
              if (key === "radius" || key === "otherRadius")
                setDraft((current) => ({
                  ...current,
                  [key]: String((key === "radius" ? radius : otherRadius) * 2),
                }));
              if (key === "teeth" || key === "otherTeeth")
                setDraft((current) => ({ ...current, [key]: String(geometry[key]) }));
            }}
          />
        </label>
      ))}
      <small>轮径与齿数联动，保持链节间距一致。</small>
      {!valid && <small role="alert">请检查轮径、轴孔及齿数；两轮不能重叠。</small>}
      <div className="cad-tool-settings__actions">
        <button
          type="button"
          disabled={disabled || busy || !valid || !changed}
          onClick={() => void commit()}
        >
          应用
        </button>
      </div>
    </section>
  );
}
