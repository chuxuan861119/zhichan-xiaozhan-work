import { type CSSProperties, useId } from "react";
import { SpatialPresence } from "../shared/spatial-presence";
import { StandardDialog } from "../shared/standard-dialog";

export function DrawingExportSettingsDialog({
  open,
  autoAdjust,
  scale,
  disabled,
  saving,
  failure,
  onClose,
  onAutoAdjustChange,
  onScaleChange,
  onScaleCommit,
}: {
  open: boolean;
  autoAdjust: boolean;
  scale: number;
  disabled: boolean;
  saving: boolean;
  failure: string;
  onClose: () => void;
  onAutoAdjustChange: (enabled: boolean) => void;
  onScaleChange: (scale: number) => void;
  onScaleCommit: () => void;
}) {
  const scaleId = useId();
  const hintId = useId();
  const autoHintId = useId();
  const percent = Math.round(scale * 100);
  const scaleDisabled = !autoAdjust || disabled || saving;
  return (
    <StandardDialog
      open={open}
      title="CAD标号导出设置"
      size="s"
      portal
      className="drawing-export-settings-dialog"
      bodyClassName="drawing-export-settings-body"
      onCancel={onClose}
      closeDisabled={saving}
    >
      <div className="drawing-export-setting">
        <div className="drawing-export-setting__heading">
          <span className="drawing-export-setting__title">自动调整标号大小</span>
          <p id={autoHintId}>导出时自动调整标号大小</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="自动调整标号大小"
          aria-describedby={autoHintId}
          aria-checked={autoAdjust}
          className="drawing-export-toggle"
          disabled={disabled || saving}
          onClick={() => onAutoAdjustChange(!autoAdjust)}
        >
          <span />
        </button>
      </div>
      <div className="drawing-export-scale" data-disabled={scaleDisabled}>
        <div className="drawing-export-scale__heading">
          <label className="drawing-export-setting__title" htmlFor={scaleId}>
            标号大小比例
          </label>
          <output className="drawing-export-scale__value" htmlFor={scaleId}>
            {percent}%
          </output>
        </div>
        <input
          id={scaleId}
          className="drawing-export-scale__slider"
          type="range"
          aria-label="自动标号大小比例"
          aria-describedby={hintId}
          aria-valuetext={`${percent}%`}
          min={50}
          max={200}
          step={5}
          value={percent}
          disabled={scaleDisabled}
          style={
            { "--drawing-export-progress": `${((percent - 50) / 150) * 100}%` } as CSSProperties
          }
          onChange={(event) => onScaleChange(Number(event.target.value) / 100)}
          onPointerUp={onScaleCommit}
          onKeyUp={onScaleCommit}
          onBlur={onScaleCommit}
        />
        <div className="drawing-export-scale__ticks" aria-hidden="true">
          <span>50%</span>
          <span>100% 默认</span>
          <span>200%</span>
        </div>
      </div>
      <p id={hintId} className="drawing-export-settings__hint">
        仅调整成图标号，不改变原图。
      </p>
      <SpatialPresence>
        {failure && (
          <p className="drawing-export-settings__error" role="alert">
            {failure}
          </p>
        )}
      </SpatialPresence>
    </StandardDialog>
  );
}
