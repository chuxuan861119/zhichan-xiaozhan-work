import { ChevronLeft, ChevronRight, Images, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { AssetDescriptor } from "../../../../shared/document/model";
import { DESIGN_IMAGE_NAME_PRESETS } from "../../../../shared/patent/design-image-modes";
import type { DesignPatent } from "../../../../shared/patent/design-patent";
import { DESIGN_IMPORT_FORMAT_LABEL } from "./design-file-drop";

type Props = {
  design: DesignPatent;
  assets: readonly AssetDescriptor[];
  previewUrls: Record<string, string>;
  disabled?: boolean;
  onImport(): void;
  onPreview(id: string): void;
  onRemove(id: string): void;
  onRename(id: string, name: string): void;
  onReorder(id: string, beforeId: string | null, swap?: boolean): void;
};
function ImageName({
  id,
  index,
  label,
  disabled,
  onRename,
}: {
  id: string;
  index: number;
  label: string;
  disabled: boolean;
  onRename: Props["onRename"];
}) {
  const [draft, setDraft] = useState(label);
  useEffect(() => setDraft(label), [label]);
  const save = () => {
    const value = draft.trim();
    if (!value) {
      setDraft(label);
      return;
    }
    if (value !== label) onRename(id, value);
  };
  return (
    <input
      aria-label={`图片${index + 1}名称`}
      value={draft}
      maxLength={100}
      disabled={disabled}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDraft(label);
        }
      }}
    />
  );
}
export function DesignMultiImageGrid({
  design,
  assets,
  previewUrls,
  disabled = false,
  onImport,
  onPreview,
  onRemove,
  onRename,
  onReorder,
}: Props) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  return (
    <section
      className="design-multi-grid"
      data-empty={design.views.length === 0}
      aria-label="多图列表"
      aria-busy={disabled}
    >
      {design.views.map((view, index) => {
        const asset = assets.find((item) => item.assetId === view.assetId),
          size = view.editor?.applied ?? asset;
        return (
          <article
            key={view.viewId}
            className="design-multi-grid__card"
            data-drop-target={dropTarget === view.viewId}
            aria-label={`图片${index + 1}：${view.label}`}
            draggable={!disabled}
            onDragStart={(event) => {
              if (
                disabled ||
                (event.target as Element).closest(
                  "input,select,.design-import-step__delete,.design-multi-grid__order",
                )
              ) {
                event.preventDefault();
                return;
              }
              event.dataTransfer.setData("application/x-design-view-id", view.viewId);
              event.dataTransfer.setData("text/plain", view.viewId);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => setDropTarget(null)}
            onDragOver={(event) => {
              if (!disabled && event.dataTransfer.types.includes("application/x-design-view-id")) {
                event.preventDefault();
                setDropTarget(view.viewId);
              }
            }}
            onDragLeave={(event) => {
              if (
                !(event.relatedTarget instanceof Node) ||
                !event.currentTarget.contains(event.relatedTarget)
              )
                setDropTarget(null);
            }}
            onDrop={(event) => {
              const id = event.dataTransfer.getData("application/x-design-view-id");
              if (!id || disabled) return;
              event.preventDefault();
              event.stopPropagation();
              setDropTarget(null);
              onReorder(id, view.viewId, true);
            }}
          >
            <div className="design-multi-grid__preview">
              <button
                type="button"
                className="design-multi-grid__open"
                disabled={!previewUrls[view.viewId] || disabled}
                aria-label={`查看${view.label}大图`}
                onClick={() => onPreview(view.viewId)}
              >
                {previewUrls[view.viewId] ? (
                  <img src={previewUrls[view.viewId]} alt={view.label} draggable={false} />
                ) : (
                  <span>正在准备预览…</span>
                )}
              </button>
              <span className="design-multi-grid__index">{index + 1}</span>
              <button
                type="button"
                className="design-import-step__delete design-import-step__delete--formula"
                disabled={disabled}
                aria-label={`删除${view.label}`}
                title="删除图片"
                onClick={() => onRemove(view.viewId)}
              >
                ✕
              </button>
            </div>
            <div className="design-multi-grid__name">
              <ImageName
                id={view.viewId}
                index={index}
                label={view.label}
                disabled={disabled}
                onRename={onRename}
              />
              <select
                aria-label={`图片${index + 1}常用名称`}
                value=""
                disabled={disabled}
                onChange={(event) => {
                  if (event.currentTarget.value) onRename(view.viewId, event.currentTarget.value);
                }}
              >
                <option value="" disabled>
                  常用名称
                </option>
                {DESIGN_IMAGE_NAME_PRESETS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <footer>
              <div className="design-multi-grid__order">
                <button
                  type="button"
                  aria-label={`图片${index + 1}前移`}
                  disabled={disabled || index === 0}
                  onClick={() => onReorder(view.viewId, design.views[index - 1]!.viewId)}
                >
                  <ChevronLeft size={15} />
                </button>
                <button
                  type="button"
                  aria-label={`图片${index + 1}后移`}
                  disabled={disabled || index === design.views.length - 1}
                  onClick={() => onReorder(view.viewId, design.views[index + 2]?.viewId ?? null)}
                >
                  <ChevronRight size={15} />
                </button>
              </div>
              <small title={asset?.originalName}>
                {size?.widthPx && size.heightPx
                  ? `${size.widthPx} × ${size.heightPx} px`
                  : "分辨率未知"}
              </small>
            </footer>
          </article>
        );
      })}
      <button
        type="button"
        className="design-multi-grid__add"
        aria-label="添加图片"
        disabled={disabled}
        onClick={onImport}
        onDragOver={(event) => {
          if (!disabled) event.preventDefault();
        }}
        onDrop={(event) => {
          const id = event.dataTransfer.getData("application/x-design-view-id");
          if (!id || disabled) return;
          event.preventDefault();
          event.stopPropagation();
          onReorder(id, null);
        }}
      >
        <span className="design-multi-grid__add-icon">
          {design.views.length ? (
            <Plus size={28} strokeWidth={1.5} />
          ) : (
            <Images size={36} strokeWidth={1.4} />
          )}
        </span>
        <strong>{design.views.length ? "继续添加图片" : "添加本次申请的图片"}</strong>
        <span>{design.views.length ? "点击或拖入图片" : "将图片拖到此处，或点击选择文件"}</span>
        {!design.views.length ? (
          <span className="design-multi-grid__choose">
            选择图片 <Plus size={15} />
          </span>
        ) : null}
        <small>{DESIGN_IMPORT_FORMAT_LABEL} · 支持批量添加</small>
      </button>
    </section>
  );
}
