const THEME_COLORS = [
  { label: "黑色", shades: ["#000000", "#7F7F7F", "#A6A6A6", "#BFBFBF", "#D9D9D9", "#F2F2F2"] },
  { label: "白色", shades: ["#FFFFFF", "#F2F2F2", "#D9D9D9", "#BFBFBF", "#A6A6A6", "#7F7F7F"] },
  { label: "深蓝", shades: ["#17365D", "#244061", "#366092", "#4F81BD", "#95B3D7", "#DCE6F1"] },
  { label: "蓝绿", shades: ["#0F4C5C", "#1F6D86", "#31859C", "#5B9BD5", "#9CC2E5", "#DDEBF7"] },
  { label: "橙色", shades: ["#C65911", "#E36C0A", "#F79646", "#FABF8F", "#FCD5B4", "#FDE9D9"] },
  { label: "绿色", shades: ["#0F5B2A", "#1B7A3A", "#2E8B57", "#70AD47", "#A9D18E", "#E2F0D9"] },
  { label: "青色", shades: ["#0070C0", "#00A6D6", "#00B0F0", "#5B9BD5", "#9DC3E6", "#DDEBF7"] },
  { label: "紫红", shades: ["#7F1D6D", "#9E2A8E", "#C050B8", "#D996D3", "#E4B7E5", "#F2DDF3"] },
  { label: "草绿", shades: ["#38761D", "#548235", "#70AD47", "#93D36D", "#B7E1A1", "#E2F0D9"] },
];

const STANDARD_COLORS = [
  "#C00000",
  "#FF0000",
  "#FFC000",
  "#FFFF00",
  "#92D050",
  "#00B050",
  "#00B0F0",
  "#0070C0",
  "#002060",
  "#7030A0",
];

export function TextColorPalette({
  value,
  onSelect,
  onCustom,
  label = "文字颜色",
}: {
  value: string;
  label?: string;
  onCustom(anchor: HTMLElement): void;
  onSelect(color: string): void;
}) {
  return (
    <section className="color-palette text-color-palette" role="dialog" aria-label={label}>
      <button className="color-palette-automatic" type="button" onClick={() => onSelect("#000000")}>
        <span className="color-swatch" style={{ backgroundColor: "#000000" }} />
        自动(A)
      </button>
      <p className="color-palette-heading">主题颜色</p>
      <div className="color-theme-grid">
        {THEME_COLORS.map((theme) => (
          <div className="color-theme-column" key={theme.label}>
            {theme.shades.map((shade, index) => (
              <button
                className="color-swatch"
                type="button"
                aria-label={index === 0 ? `主题色 ${theme.label}` : `${theme.label} 色阶 ${index}`}
                aria-pressed={value.toUpperCase() === shade}
                key={shade}
                style={{ backgroundColor: shade }}
                onClick={() => onSelect(shade)}
              />
            ))}
          </div>
        ))}
      </div>
      <p className="color-palette-heading">标准色</p>
      <div className="color-standard-grid">
        {STANDARD_COLORS.map((standardColor) => (
          <button
            className="color-swatch"
            type="button"
            aria-label={`标准色 ${standardColor}`}
            aria-pressed={value.toUpperCase() === standardColor}
            key={standardColor}
            style={{ backgroundColor: standardColor }}
            onClick={() => onSelect(standardColor)}
          />
        ))}
      </div>
      <button
        className="color-palette-custom"
        type="button"
        aria-label="其他颜色"
        aria-haspopup="dialog"
        onClick={(event) =>
          onCustom(
            event.currentTarget.querySelector<HTMLElement>(".color-control") ?? event.currentTarget,
          )
        }
      >
        其他颜色
        <span className="color-control" style={{ backgroundColor: value }} />
      </button>
    </section>
  );
}
