import { useRef, useState } from "react";
import { cadGearColor, cadGearMates, cadGearName } from "./cad-gear-feedback";
import type { CadScene } from "./cadcraft-client";

type GearEntity = CadScene["entities"][number];

export function CadGearMeshStatus({
  entity,
  mate,
  disabled,
  select,
  disconnect,
}: {
  entity: GearEntity;
  mate: GearEntity;
  disabled: boolean;
  select(): void;
  disconnect(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const running = useRef(false);
  async function unlink() {
    if (disabled || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await disconnect();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="cad-tool-settings function-rail-transient-panel" aria-label="齿轮啮合关系">
      <p>
        <span style={{ color: cadGearColor(entity) }}>{cadGearName(entity)}</span> 已与{" "}
        <span style={{ color: cadGearColor(mate) }}>{cadGearName(mate)}</span> 啮合
      </p>
      <small>转动任一齿轮即可联动；取消啮合后保留当前位置。</small>
      <div className="cad-tool-settings__actions">
        <button type="button" onClick={select} disabled={busy}>
          选中配对对象
        </button>
        <button type="button" onClick={() => void unlink()} disabled={disabled || busy}>
          取消啮合
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
export function CadGearMeshSettings({
  pair,
  disabled,
  apply,
}: {
  pair: [GearEntity, GearEntity];
  disabled: boolean;
  apply: (enabled: boolean) => Promise<void>;
}) {
  // Existing trains are always the baseline, even if the independent object was picked first.
  const [first, second] = !cadGearMates(pair[0]).length && cadGearMates(pair[1]).length ? [pair[1],pair[0]] : pair;
  const enabled = cadGearMates(first).includes(second.handle);
  const a = first.gear!,
    b = second.gear!;
  const ring = a.kind === "internal" ? a : b.kind === "internal" ? b : undefined;
  const wheel = a.kind === "external" ? a : b;
  const problem = enabled
    ? ""
    : cadGearMates(first).length && cadGearMates(second).length
      ? "两个对象均已有啮合关系，请选择一个组内齿轮和一个独立齿轮。"
      : a.kind !== "external" && b.kind !== "external"
        ? "请选择外齿轮与外齿轮、内齿圈或齿条。"
        : ring && ring.teeth - wheel.teeth < 3
          ? "内齿圈齿数至少需比外齿轮多 3 齿。"
          : "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  async function change() {
    if (disabled || problem || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await apply(!enabled);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="cad-tool-settings function-rail-transient-panel" aria-label="齿轮啮合设置">
      <header>
        <strong>齿轮啮合</strong>
      </header>
      <label className="cad-snap-toggle">
        <input
          type="checkbox"
          aria-label="啮合"
          checked={enabled}
          disabled={disabled || busy || !!problem}
          onChange={() => void change()}
        />
        啮合
      </label>
      <small>
        {enabled
          ? "已啮合，转动任一齿轮即可联动；关闭后保留当前位置。"
          : cadGearMates(first).length ? "保留已有齿轮组，仅调整独立齿轮的齿距、位置和齿位。"
          : "保留先选对象，自动匹配后选对象的齿距、位置和齿位。"}
      </small>
      <small>
        <span style={{ color: cadGearColor(first, second.handle) }}>
          基准：{cadGearName(first, second.handle)}
        </span>
        ；
        <span style={{ color: cadGearColor(second, first.handle) }}>
          调整：{cadGearName(second, first.handle)}
        </span>
      </small>
      {(problem || error) && <p role="alert">{error || problem}</p>}
    </section>
  );
}
