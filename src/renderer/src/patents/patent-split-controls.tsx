import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type CustomDualViewPreset,
  customDualViewFullLabel,
  customDualViewShortcutId,
  customDualViewShortLabel,
} from "../../../shared/settings/custom-dual-view";
import { SpatialPresence } from "../shared/spatial-presence";
import type { PatentWorkspacePair } from "./patent-workspace-layout";

type PatentSplitControlsProps = Readonly<{
  active: boolean;
  columnsActive?: boolean;
  onToggleColumns?: (() => void) | undefined;
  drawingsAvailable: boolean;
  onToggle(): void;
  onSelectPair(pair: PatentWorkspacePair): void;
  customPresets?: readonly CustomDualViewPreset[] | undefined;
  onOpenCustom?: (() => void) | undefined;
  onSelectCustomPreset?: ((index: number) => void) | undefined;
}>;

const DRAWING_PAIR_UNAVAILABLE_REASON = "当前专利未启用说明书附图和摘要附图。";

const QUICK_PAIRS: readonly Readonly<{
  pair: PatentWorkspacePair;
  label: string;
  requiresDrawings: boolean;
}>[] = [
  { pair: "claims-description", label: "权／说", requiresDrawings: false },
  { pair: "claims-drawings", label: "权／图", requiresDrawings: true },
  { pair: "drawings-description", label: "图／说", requiresDrawings: true },
];

export function PatentSplitControls({
  active,
  columnsActive = false,
  onToggleColumns,
  drawingsAvailable,
  onToggle,
  onSelectPair,
  customPresets = [],
  onOpenCustom,
  onSelectCustomPreset,
}: PatentSplitControlsProps) {
  const rootRef = useRef<HTMLFieldSetElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [menuOpen]);

  return (
    <fieldset ref={rootRef} className="patent-split-controls" aria-label="同屏双显控制">
      <span className="patent-split-controls__separator" aria-hidden="true" />
      <div className="patent-split-controls__buttons">
        {onToggleColumns ? (
          <button
            type="button"
            className="patent-split-controls__toggle"
            aria-pressed={columnsActive}
            onClick={onToggleColumns}
          >
            双列显示
          </button>
        ) : null}
        <button
          type="button"
          className="patent-split-controls__toggle"
          aria-pressed={active}
          onClick={onToggle}
        >
          同屏双显
        </button>
        <button
          type="button"
          className="patent-split-controls__menu-trigger"
          aria-label="打开常用双文档搭配"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="常用双文档搭配"
          onClick={() => setMenuOpen((current) => !current)}
        >
          <ChevronDown aria-hidden="true" size={14} strokeWidth={2} />
        </button>
      </div>
      {customPresets.map((preset, index) => {
        const shortcutId = customDualViewShortcutId(index);
        const drawingUnavailable =
          !drawingsAvailable &&
          (preset.leftBookKind === "description-drawings" ||
            preset.rightBookKind === "description-drawings");
        const [leftLabel, rightLabel] = customDualViewShortLabel(preset);
        const fullLabel = customDualViewFullLabel(preset);
        return (
          <button
            className="patent-split-controls__custom-preset"
            key={shortcutId}
            type="button"
            aria-label={fullLabel}
            title={drawingUnavailable ? "当前专利未启用说明书附图" : fullLabel}
            disabled={drawingUnavailable}
            onClick={() => onSelectCustomPreset?.(index)}
          >
            <span>{leftLabel}</span>
            <span className="patent-split-controls__custom-divider" aria-hidden="true" />
            <span>{rightLabel}</span>
          </button>
        );
      })}
      <SpatialPresence>
        {menuOpen ? (
          <div className="patent-split-controls__menu" role="menu" aria-label="常用双文档搭配">
            {QUICK_PAIRS.map(({ pair, label, requiresDrawings }) => {
              const unavailable = requiresDrawings && !drawingsAvailable;
              return (
                <button
                  key={pair}
                  type="button"
                  role="menuitem"
                  disabled={unavailable}
                  title={unavailable ? DRAWING_PAIR_UNAVAILABLE_REASON : label}
                  onClick={() => {
                    setMenuOpen(false);
                    onSelectPair(pair);
                  }}
                >
                  {label}
                </button>
              );
            })}
            <span className="patent-split-controls__menu-separator" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpenCustom?.();
              }}
            >
              自定义
            </button>
          </div>
        ) : null}
      </SpatialPresence>
    </fieldset>
  );
}
