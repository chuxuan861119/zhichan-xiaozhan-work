import { SpatialView } from "../../shared/spatial-view";
export type ReferenceMarkLocatorPanelProps = {
  enabled: boolean;
  activeKeyword: string | null;
  onEnabledChange(enabled: boolean): void;
  onCancel(): void;
};

export function ReferenceMarkLocatorPanel({
  enabled,
  activeKeyword,
  onEnabledChange,
  onCancel,
}: ReferenceMarkLocatorPanelProps) {
  const visibleActiveKeyword = enabled ? activeKeyword : null;
  return (
    <section
      className={`reference-mark-locator${visibleActiveKeyword ? " is-active" : ""}`}
      aria-label="零部件定位"
    >
      <div className="reference-mark-locator__header">
        <span className="reference-mark-locator__title">零部件定位</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="零部件定位"
          className="reference-mark-locator__switch"
          onClick={() => onEnabledChange(!enabled)}
        >
          <span className="reference-mark-locator__switch-thumb" aria-hidden="true" />
        </button>
      </div>
      <SpatialView viewKey={String(visibleActiveKeyword)}>
        {visibleActiveKeyword ? (
          <div className="reference-mark-locator__active">
            <div className="reference-mark-locator__keyword-group">
              <span className="reference-mark-locator__label">当前高亮</span>
              <strong className="reference-mark-locator__keyword" title={visibleActiveKeyword}>
                {visibleActiveKeyword}
              </strong>
            </div>
            <button
              type="button"
              aria-label="取消高亮"
              className="reference-mark-locator__cancel"
              onClick={onCancel}
            >
              取消
            </button>
          </div>
        ) : (
          <p className="reference-mark-locator__hint">双击零部件高亮</p>
        )}
      </SpatialView>
    </section>
  );
}
