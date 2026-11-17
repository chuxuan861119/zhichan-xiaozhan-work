import {
  type ComponentProps,
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useState,
} from "react";
import { detailRatioText, parseDetailRatio } from "../../../shared/drawing-markup/detail-view";

const numberFormats = {
  1: new Intl.NumberFormat("en-US", { useGrouping: false, maximumFractionDigits: 1 }),
  2: new Intl.NumberFormat("en-US", { useGrouping: false, maximumFractionDigits: 2 }),
};

/** Presentation only: never feed the rounded string back into geometry or saved drafts. */
export function formatCadNumber(value: string | number, decimals: 1 | 2 | null = 1, scientificWhenTiny = true): string {
  const text = String(value);
  const number = Number(value);
  if (decimals === null || !text.trim() || !Number.isFinite(number)) return text;
  const rounded = Number(numberFormats[decimals].format(number));
  // A valid tiny length/factor must not appear to be zero. Keep the mantissa concise.
  if (scientificWhenTiny && number !== 0 && rounded === 0) {
    const [mantissa, exponent] = number.toExponential(decimals).split("e");
    return `${Number(mantissa)}e${exponent}`;
  }
  return String(rounded);
}

type Props = Omit<ComponentProps<"input">, "value" | "defaultValue" | "type"> & {
  value: number | string;
  decimals?: 1 | 2 | null;
  scientificWhenTiny?: boolean;
  liveRef?: Ref<{ update(value: string): void }> | undefined;
  onLiveValueFocus?(value: string): void;
};

/** Preserve the caller's full-precision value and normal input events. */
export function CadNumberInput({
  value,
  decimals = 1,
  scientificWhenTiny = true,
  onChange,
  onBlur,
  onKeyDown,
  onFocus,
  liveRef,
  onLiveValueFocus,
  ...props
}: Props) {
  const [liveValue, setLiveValue] = useState<string | null>(null);
  useImperativeHandle(liveRef, () => ({ update: setLiveValue }), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A controlled value or live-mode change explicitly supersedes the transient pointer value.
  useLayoutEffect(() => {
    setLiveValue(null);
  }, [value, liveRef]);
  return (
    <FormattedCadInput
      {...props}
      type="number"
      value={liveValue ?? value}
      formatValue={(value) => formatCadNumber(value, decimals, scientificWhenTiny)}
      onChange={(event) => {
        setLiveValue(null);
        onChange?.(event);
      }}
      onFocus={(event) => {
        if (liveValue !== null) onLiveValueFocus?.(liveValue);
        onFocus?.(event);
      }}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  );
}

export function CadRatioInput(props: Omit<Props, "decimals">) {
  return (
    <FormattedCadInput
      {...props}
      type="text"
      formatValue={(value) => {
        const ratio = parseDetailRatio(String(value));
        return ratio === null ? String(value) : detailRatioText(ratio);
      }}
    />
  );
}

function FormattedCadInput({
  value,
  formatValue,
  onChange,
  onBlur,
  onKeyDown,
  ...props
}: Omit<Props, "decimals"> & {
  type: "number" | "text";
  formatValue(value: number | string): string;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <input
      {...props}
      value={editing ? value : formatValue(value)}
      onChange={(event) => {
        setEditing(true);
        onChange?.(event);
      }}
      onBlur={(event) => {
        setEditing(false);
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === "Escape") && !event.nativeEvent.isComposing)
          setEditing(false);
        onKeyDown?.(event);
      }}
    />
  );
}
