import { type ChangeEvent, useId, useState } from "react";
import { supportsCadProperty, validCadProperty } from "./cad-interaction";
import { CadNumberInput } from "./cad-number-input";
import type { CadcraftClient, CadScene } from "./cadcraft-client";
import "./cad-object-properties.css";

type Props = {
  client: CadcraftClient;
  handles: string[];
  entities: CadScene["entities"];
  revision: number;
  disabled: boolean;
  execute(command: string, params: object): Promise<void>;
  onError(message: string): void;
  center: [number, number];
};
type PropertyEntity = CadScene["entities"][number];
const FIELDS = [
  { key: "text", label: "文字内容", invalid: "请输入文字内容。" },
  { key: "height", label: "文字高度", invalid: "文字高度须大于 0。" },
  { key: "radius", label: "半径", invalid: "半径须大于 0。" },
  { key: "rotation", label: "旋转角度（°）", invalid: "请输入有效的旋转角度。" },
  { key: "lineweight", label: "线宽（mm）", invalid: "线宽范围为 0–2.11 mm。" },
] as const;
type PropertyKey = (typeof FIELDS)[number]["key"];

function currentValue(entities: PropertyEntity[], key: PropertyKey) {
  const first = entities[0]?.[key];
  const mixed = entities.some((entity) => entity[key] !== first);
  return { value: mixed || first === undefined ? "" : String(first), mixed };
}

export function CadPropertiesPanel({ entities, handles, revision, ...props }: Props) {
  const selected: PropertyEntity[] = entities.filter((entity) => handles.includes(entity.handle));
  if (!selected.length) return null;
  // A different selection or saved scene must never inherit another object's unfinished edits.
  const selectionKey = JSON.stringify([
    revision,
    selected.map((entity) => [entity.handle, ...FIELDS.map((field) => entity[field.key])]),
  ]);
  return <SelectedCadProperties key={selectionKey} entities={selected} {...props} />;
}

function SelectedCadProperties({
  entities,
  disabled,
  execute,
  onError,
}: Pick<Props, "disabled" | "execute" | "onError"> & { entities: PropertyEntity[] }) {
  const id = useId();
  const [drafts, setDrafts] = useState<Partial<Record<PropertyKey, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const types = entities.map((entity) => entity.type);
  const fields = FIELDS.filter((field) => supportsCadProperty(field.key, types));
  const changed = fields.flatMap((field) => {
    const draft = drafts[field.key];
    const current = currentValue(entities, field.key);
    return draft !== undefined && (current.mixed || draft !== current.value)
      ? [{ ...field, value: draft }]
      : [];
  });
  const invalid = changed.find((field) => !validCadProperty(field.key, field.value, types));
  const locked = entities.some((entity) => entity.locked);
  const blocked = disabled || submitting || locked;
  const canApply = !blocked && changed.length > 0 && !invalid;

  async function apply() {
    if (!canApply) return;
    const params: Record<string, string[] | string | number> = {
      handles: entities.map((entity) => entity.handle),
    };
    for (const field of changed) {
      params[field.key] = field.key === "text" ? field.value : Number(field.value);
    }
    setSubmitting(true);
    try {
      await execute("properties.set", params);
    } catch (error) {
      onError(String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="cad-properties-panel" aria-labelledby={`${id}-heading`}>
      <header className="cad-properties-heading">
        <h3 id={`${id}-heading`}>对象属性</h3>
        <span>已选 {entities.length} 个</span>
      </header>
      <form
        className="cad-properties-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void apply();
        }}
      >
        {fields.map((field) => {
          const current = currentValue(entities, field.key);
          const value = drafts[field.key] ?? current.value;
          const isInvalid = invalid?.key === field.key;
          const inputProps = {
            id: `${id}-${field.key}`,
            value,
            disabled: blocked,
            placeholder: current.mixed ? "多个值" : current.value ? undefined : "未提供当前值",
            "aria-invalid": isInvalid || undefined,
            "aria-describedby": isInvalid ? `${id}-error` : undefined,
            onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
              setDrafts((previous) => ({ ...previous, [field.key]: event.target.value })),
          };
          return (
            <label
              key={field.key}
              className={`cad-property-field${field.key === "text" ? " cad-property-field--text" : ""}`}
              htmlFor={inputProps.id}
            >
              <span>{field.label}</span>
              {field.key === "text" ? (
                <textarea {...inputProps} rows={2} />
              ) : (
                <CadNumberInput
                  {...inputProps}
                  decimals={field.key === "lineweight" ? 2 : 1}
                  step="any"
                  min={field.key === "rotation" ? undefined : 0}
                  max={field.key === "lineweight" ? 2.11 : undefined}
                />
              )}
            </label>
          );
        })}
        {invalid && (
          <p id={`${id}-error`} className="cad-property-error" role="alert">
            {invalid.invalid}
          </p>
        )}
        {locked && <p className="cad-property-note">选中对象已锁定，无法修改。</p>}
        <button type="submit" className="cad-properties-apply" disabled={!canApply}>
          {submitting ? "正在应用…" : "应用修改"}
        </button>
      </form>
    </section>
  );
}
