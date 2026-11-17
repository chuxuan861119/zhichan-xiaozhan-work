const HIGHLIGHT_COLORS = [
  "#FFFF00",
  "#FFE699",
  "#C6E0B4",
  "#B4C7E7",
  "#F8CBAD",
  "#EAD1DC",
  "#D9D9D9",
  "#F4B084",
];

export function HighlightColorPalette({
  value,
  onSelect,
  onCustom,
}: {
  value: string;
  onCustom(anchor: HTMLElement): void;
  onSelect(color: string | null): void;
}) {
  return (
    <section
      className="color-palette text-color-palette highlight-color-palette"
      role="dialog"
      aria-label="文本突出显示颜色"
    >
      <button className="color-palette-automatic" type="button" onClick={() => onSelect(null)}>
        <span className="color-swatch color-swatch--empty" />
        无高亮
      </button>
      <p className="color-palette-heading">突出显示颜色</p>
      <div className="color-standard-grid">
        {HIGHLIGHT_COLORS.map((highlightColorOption) => (
          <button
            className="color-swatch"
            type="button"
            aria-label={`突出显示色 ${highlightColorOption}`}
            aria-pressed={value.toUpperCase() === highlightColorOption}
            key={highlightColorOption}
            style={{ backgroundColor: highlightColorOption }}
            onClick={() => onSelect(highlightColorOption)}
          />
        ))}
      </div>
      <button
        className="color-palette-custom"
        type="button"
        aria-label="其他突出显示颜色"
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
