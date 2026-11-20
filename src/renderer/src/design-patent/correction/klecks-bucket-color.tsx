import { useEffect, useRef, useState } from "react";

type Color = { r: number; g: number; b: number };
const hex = (c: Color) =>
  "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
export function KlecksBucketColor({
  color,
  disabled,
  onChange,
  onValidity,
}: {
  color: Color;
  disabled: boolean;
  onChange(c: Color): void;
  onValidity(valid: boolean): void;
}) {
  const value = hex(color),
    [draft, setDraft] = useState(value),
    focusColor = useRef(value);
  const valid = /^#?[0-9a-f]{6}$/i.test(draft);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new committed color resets the draft; the inline validity callback changes while typing.
  useEffect(() => {
    setDraft(value);
    onValidity(true);
  }, [value]);
  const set = (text: string) => {
    setDraft(text);
    const valid = /^#?[0-9a-f]{6}$/i.test(text);
    onValidity(valid);
    if (valid) {
      const h = text.replace("#", "");
      onChange({
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
      });
    }
  };
  return (
    <div className="klecks-bucket-color">
      <label title="点击色块任意选色，与左侧前景色同步">
        颜色
        <input
          aria-label="油漆桶颜色"
          type="color"
          disabled={disabled}
          value={value}
          onChange={(e) => set(e.currentTarget.value)}
        />
      </label>
      <input
        aria-label="油漆桶 HEX 颜色"
        title="支持 #RRGGBB，例如 #ffffff 为白色"
        aria-invalid={!valid}
        value={draft}
        disabled={disabled}
        maxLength={7}
        spellCheck={false}
        onFocus={() => {
          focusColor.current = value;
        }}
        onChange={(e) => set(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            set(focusColor.current);
            e.currentTarget.blur();
          } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (valid) e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
