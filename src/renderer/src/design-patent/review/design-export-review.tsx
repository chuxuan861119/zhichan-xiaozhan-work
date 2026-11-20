import { useId, useState } from "react";
import {
  isAssignedDesignView,
  renderDesignPatentBriefLines,
} from "../../../../shared/patent/design-patent";
import type { CanonicalPatent } from "../../../../shared/patent/model";
import { DesignImagePreviewDialog } from "../import/design-image-preview-dialog";
import { resolveDesignViewPixelSize, useProcessedDesignSizes } from "../six-view-preview-context";
import "./design-export-review.css";

type Props = {
  patent: CanonicalPatent;
  previewUrls: Record<string, string>;
  format: "docx" | "pdf";
  zip: boolean;
  busy: boolean;
  error: string | null;
  success: { outputDirectory: string; imagePaths: string[] } | null;
  onFormat(value: "docx" | "pdf"): void;
  onZip(value: boolean): void;
  onExport(): void;
  onBrief(): void;
};
const order = [
  "perspective",
  "perspective-2",
  "perspective-3",
  "front",
  "rear",
  "left",
  "right",
  "top",
  "bottom",
  "reference",
  "enlarged",
  "section",
  "other",
];
export function DesignExportReview(p: Props) {
  const [preview, setPreview] = useState<string | null>(null);
  const [imagesOpen, setImagesOpen] = useState(false);
  const imagesId = useId();
  const processedSizes = useProcessedDesignSizes();
  const design = p.patent.designPatent;
  if (!design) return null;
  const views = design.views
    .filter(isAssignedDesignView)
    .sort((a, b) =>
      design.imageMode === "multi-image" ? 0 : order.indexOf(a.kind) - order.indexOf(b.kind),
    );
  const excluded = design.views.length - views.length;
  const pending = views.filter(
    (v) => v.editor?.saved && v.editor.saved.projectAssetId !== v.editor.applied?.projectAssetId,
  );
  const recoverable = views.filter((view) => view.editor?.recovery);
  const selected = views.find((v) => v.viewId === preview);
  const imageSize = (view: (typeof views)[number]) =>
    resolveDesignViewPixelSize(
      view,
      p.patent.assets.find((asset) => asset.assetId === view.assetId),
      processedSizes,
    );
  const size = selected ? imageSize(selected) : null;
  return (
    <section className="design-export-review" aria-label="导出">
      <header className="der-summary">
        <h2 id="review-heading" tabIndex={-1}>
          导出
        </h2>
      </header>
      <div className="der-body">
        <section className="der-left">
          <section className="der-scroll" aria-label="导出材料">
            {pending.length > 0 || recoverable.length > 0 ? (
              <div className="der-version">
                {pending.length > 0 ? (
                  <strong>{pending.length} 张图片有尚未应用的编辑</strong>
                ) : null}
                {recoverable.length > 0 ? (
                  <strong>{recoverable.length} 张图片有待恢复的编辑</strong>
                ) : null}
                <span>
                  {recoverable.length > 0
                    ? "导出时可先处理恢复草稿，也可以使用上次已应用的图片；未处理的草稿会保留。"
                    : "导出时可选择图片版本，编辑草稿保留。"}
                </span>
              </div>
            ) : null}
            <button
              className="der-images-toggle"
              type="button"
              aria-expanded={imagesOpen}
              aria-controls={imagesId}
              onClick={() => setImagesOpen((open) => !open)}
            >
              <strong>图片材料</strong>
              <span>{views.length} 张</span>
            </button>
            <section
              id={imagesId}
              className="der-grid"
              aria-label="导出图片顺序"
              hidden={!imagesOpen}
            >
              {imagesOpen && views.length === 0 && <p>暂无可导出的图片</p>}
              {imagesOpen &&
                views.map((v, i) => {
                  const image = imageSize(v);
                  const filename = `${String(i + 1).padStart(2, "0")}-${
                    v.label
                      .replace(/[<>:"/\\|?*]/g, "_")
                      .split("")
                      .map((c) => (c.charCodeAt(0) < 32 ? "_" : c))
                      .join("")
                      .trim()
                      .slice(0, 80) || "未命名"
                  }.jpg`;
                  return (
                    <button
                      type="button"
                      className="der-card"
                      key={v.viewId}
                      onClick={() => setPreview(v.viewId)}
                      disabled={!p.previewUrls[v.viewId]}
                      aria-label={`预览${v.label}`}
                    >
                      <div className="der-image">
                        {p.previewUrls[v.viewId] ? (
                          <img src={p.previewUrls[v.viewId]} alt={v.label} />
                        ) : (
                          <span>预览不可用</span>
                        )}
                        <span className="der-label">{v.label}</span>
                        {design.representativeViewId === v.viewId ? (
                          <span className="der-representative">最能表明设计要点</span>
                        ) : null}
                      </div>
                      <div className="der-card-info">
                        <strong>{v.label}</strong>
                        <span title={filename}>{filename}</span>
                        <small>
                          {image ? `${image.widthPx} × ${image.heightPx} px` : "分辨率未知"}
                        </small>
                      </div>
                    </button>
                  );
                })}
            </section>
            {excluded > 0 ? <p className="der-muted">不导出：暂存图片 {excluded} 张。</p> : null}
            <section className="der-brief" aria-label="简要说明正文">
              <header className="der-document">
                <h3>简要说明</h3>
                <button type="button" onClick={p.onBrief}>
                  去填写
                </button>
              </header>
              <article className="der-paper">
                <h4>外观设计简要说明</h4>
                {renderDesignPatentBriefLines(p.patent.name, design).map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Document lines can repeat; their ordinals are displayed.
                  <p key={`${i}-${line}`}>
                    {i + 1}．{line}
                  </p>
                ))}
              </article>
            </section>
          </section>
        </section>
        <aside className="der-settings" aria-label="导出申请文件">
          <h3>导出设置</h3>
          <fieldset className="der-formats" aria-label="简要说明格式">
            {(["docx", "pdf"] as const).map((f) => (
              <button
                type="button"
                key={f}
                aria-pressed={p.format === f}
                disabled={p.busy}
                onClick={() => p.onFormat(f)}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </fieldset>
          <label className="der-checkbox">
            <input
              type="checkbox"
              checked={p.zip}
              disabled={p.busy}
              onChange={(e) => p.onZip(e.target.checked)}
            />
            同时生成 ZIP 压缩包（选填）
          </label>
          <button type="button" className="der-primary" disabled={p.busy} onClick={p.onExport}>
            {p.busy ? "正在导出…" : "选择位置并导出"}
          </button>
          {p.error ? (
            <p role="alert" className="der-error">
              {p.error}
            </p>
          ) : null}
          {p.success ? (
            <section role="status" className="der-success">
              <strong>导出完成 · {p.success.imagePaths.length} 张 JPG</strong>
              <p>{p.success.outputDirectory}</p>
            </section>
          ) : null}
        </aside>
      </div>
      {selected && p.previewUrls[selected.viewId] ? (
        <DesignImagePreviewDialog
          label={selected.label}
          resolution={`${size ? `${size.widthPx} × ${size.heightPx} px · ` : ""}JPG`}
          previewUrl={p.previewUrls[selected.viewId]!}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </section>
  );
}
