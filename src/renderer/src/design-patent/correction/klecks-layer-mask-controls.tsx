import { Link2, Unlink, X } from "lucide-react";
import { type KlecksMenuItem, showKlecksContextMenu } from "./klecks-context-menu";
import type { KlecksLayerCommand, KlecksLayerState } from "./klecks-layer-controls";

type Operation = Extract<KlecksLayerCommand, { operation: "mask" }>["maskOperation"];
export function maskMenuItems(
  layer: KlecksLayerState,
  run: (operation: Operation) => void,
): KlecksMenuItem[] {
  const disabled = layer.locks.all;
  if (!layer.mask)
    return [
      { label: "添加图层蒙版", disabled, run: () => run("add") },
      { label: "添加反向蒙版", disabled, run: () => run("addHide") },
    ];
  return [
    {
      label: layer.mask.enabled ? "停用图层蒙版" : "启用图层蒙版",
      disabled,
      run: () => run("toggle"),
    },
    { label: layer.mask.linked ? "取消链接蒙版" : "链接蒙版", disabled, run: () => run("link") },
    { label: "载入蒙版选区", run: () => run("selection") },
    { label: "蒙版反相", disabled, run: () => run("invert") },
    { label: "应用图层蒙版", disabled, separator: true, run: () => run("apply") },
    { label: "删除图层蒙版", disabled, run: () => run("delete") },
  ];
}
export function KlecksLayerMaskControls({
  layer,
  active,
  disabled,
  send,
}: {
  layer: KlecksLayerState;
  active: boolean;
  disabled: boolean;
  send: (command: KlecksLayerCommand) => void;
}) {
  const run = (maskOperation: Operation) =>
    send({ action: "layer", operation: "mask", id: layer.id, maskOperation });
  return (
    <div className="klecks-layer-thumbnails">
      <button
        type="button"
        className="klecks-layer-thumbnail"
        aria-label={`编辑图像 ${layer.name}`}
        aria-pressed={active && !layer.mask?.active}
        disabled={disabled}
        title="编辑图像像素"
        onClick={() => run("image")}
      >
        {layer.thumbnail ? <img src={layer.thumbnail} alt="" /> : <span />}
      </button>
      {layer.mask ? (
        <>
          <button
            type="button"
            className="klecks-layer-mask-link"
            aria-label={`${layer.mask.linked ? "取消链接" : "链接"}蒙版 ${layer.name}`}
            disabled={disabled || layer.locks.all}
            title={
              layer.mask.linked ? "取消链接：图像与蒙版可独立移动" : "链接：图像与蒙版一起移动"
            }
            onClick={() => run("link")}
          >
            {layer.mask.linked ? <Link2 size={12} /> : <Unlink size={12} />}
          </button>
          <button
            type="button"
            className="klecks-layer-thumbnail klecks-layer-mask-thumbnail"
            aria-label={`编辑蒙版 ${layer.name}`}
            aria-pressed={layer.mask.active}
            disabled={disabled}
            title="编辑蒙版；Shift 单击启用/停用，Alt/Option 单击单独查看，Ctrl/Cmd 单击载入选区"
            onClick={(event) =>
              run(
                event.shiftKey
                  ? "toggle"
                  : event.altKey
                    ? "view"
                    : event.ctrlKey || event.metaKey
                      ? "selection"
                      : "target",
              )
            }
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              showKlecksContextMenu(
                event.currentTarget.ownerDocument,
                { x: event.clientX, y: event.clientY },
                maskMenuItems(layer, run),
              );
            }}
          >
            {layer.mask.thumbnail ? (
              <img src={layer.mask.thumbnail} alt="" />
            ) : (
              <span className="klecks-layer-mask-placeholder" />
            )}
            {!layer.mask.enabled ? <X size={28} className="klecks-layer-mask-disabled" /> : null}
          </button>
        </>
      ) : null}
    </div>
  );
}
export function LayerMaskIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="14" rx="1.8" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}
