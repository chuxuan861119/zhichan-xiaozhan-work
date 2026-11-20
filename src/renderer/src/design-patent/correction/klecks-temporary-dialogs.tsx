import { useEffect, useRef, useState } from "react";
import type { TemporaryRasterExport } from "../../../../shared/ipc/temporary-images";

export type TemporaryExportOptions = Omit<TemporaryRasterExport["options"], "format"> & {
  format: TemporaryRasterExport["options"]["format"] | "psd";
};
export function TemporaryExportDialog({
  name,
  size,
  onFinish,
  layered = false,
  batch = false,
}: {
  name: string;
  size: { width: number; height: number };
  onFinish(options: TemporaryExportOptions | null): void;
  layered?: boolean;
  batch?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState<TemporaryExportOptions["format"]>(layered ? "psd" : "png");
  const [quality, setQuality] = useState(90),
    [density, setDensity] = useState(300);
  const [width, setWidth] = useState(size.width),
    [height, setHeight] = useState(size.height);
  const [background, setBackground] = useState("#ffffff");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const validSize =
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= 10000 &&
    height <= 10000 &&
    width * height <= 40_000_000;
  const valid =
    (format === "psd" || validSize) &&
    (format === "gif" || (Number.isInteger(density) && density > 0 && density <= 1200));
  return (
    <dialog
      ref={dialog}
      className="klecks-size-dialog"
      aria-label="导出图片"
      onCancel={(event) => {
        event.preventDefault();
        onFinish(null);
      }}
    >
      <h2>导出图片</h2>
      <p>{name} · 只写入你选择的位置，不保存到专利。</p>
      <label>
        格式
        <select value={format} onChange={(event) => setFormat(event.target.value as typeof format)}>
          {(["png", "jpeg", "webp", "avif", "tiff", "bmp", "gif", "psd"] as const).map((value) => (
            <option key={value} value={value}>
              {value.toUpperCase()}
              {value === "gif" ? "（静态）" : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        宽度（像素）
        <input
          type="number"
          min={1}
          max={10000}
          value={format === "psd" ? size.width : width}
          disabled={format === "psd"}
          onChange={(event) => {
            const next = Number(event.target.value);
            setWidth(next);
            setHeight(Math.max(1, Math.round((next * size.height) / size.width)));
          }}
        />
      </label>
      <label>
        高度（像素）
        <input
          type="number"
          min={1}
          max={10000}
          value={format === "psd" ? size.height : height}
          disabled={format === "psd"}
          onChange={(event) => {
            const next = Number(event.target.value);
            setHeight(next);
            setWidth(Math.max(1, Math.round((next * size.width) / size.height)));
          }}
        />
      </label>
      <p>
        {format === "psd"
          ? "PSD按当前画布的像素尺寸保留图层；调整尺寸请先使用图像大小。"
          : batch
            ? "按首张图片的缩放比例导出全部图片，保持各自比例，不改变编辑中的图片。"
            : "保持原图比例；改变导出尺寸不改变编辑中的图片。"}
      </p>
      <label>
        分辨率（PPI）
        <input
          type="number"
          min={1}
          max={1200}
          value={density}
          disabled={format === "gif"}
          onChange={(event) => setDensity(Number(event.target.value))}
        />
      </label>
      {["jpeg", "webp", "avif"].includes(format) ? (
        <label>
          质量 {quality}%
          <input
            type="range"
            min={1}
            max={100}
            value={quality}
            onChange={(event) => setQuality(Number(event.target.value))}
          />
        </label>
      ) : null}
      {["jpeg", "bmp"].includes(format) ? (
        <label>
          透明区域底色
          <input
            type="color"
            value={background}
            onChange={(event) => setBackground(event.target.value)}
          />
        </label>
      ) : null}
      <p>
        {format === "psd"
          ? "PSD保留基础栅格图层和画布外像素，不包含操作历史、选区和Photoshop高级功能。"
          : "平面图片不保留可继续编辑的图层。"}
        导出时移除原始隐私元数据。
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={() => onFinish(null)}>
          取消
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={!valid}
          onClick={() =>
            onFinish({
              format,
              width: format === "psd" ? size.width : width,
              height: format === "psd" ? size.height : height,
              quality,
              ...(format !== "gif" ? { density } : {}),
              background,
            })
          }
        >
          {batch ? "选择导出目录" : "选择保存位置"}
        </button>
      </div>
    </dialog>
  );
}
export function TemporaryFrameDialog({
  count,
  name,
  onFinish,
}: {
  count: number;
  name: string;
  onFinish(page: number | null): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="klecks-size-dialog"
      aria-label="选择图片页面或帧"
      onCancel={(event) => {
        event.preventDefault();
        onFinish(null);
      }}
    >
      <h2>选择页面或帧</h2>
      <p>
        {name} 共 {count} 页或帧，将选中的一张作为静态图片编辑。
      </p>
      <label>
        页面 / 帧
        <select value={page} onChange={(event) => setPage(Number(event.target.value))}>
          {Array.from({ length: Math.min(count, 256) }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: The index is the stable source page number.
            <option key={index} value={index}>
              第 {index + 1} 张
            </option>
          ))}
        </select>
      </label>
      {count > 256 ? <p>本次支持选择前256张。</p> : null}
      <div className="dialog-actions">
        <button type="button" onClick={() => onFinish(null)}>
          取消
        </button>
        <button type="button" className="primary-button" onClick={() => onFinish(page)}>
          打开
        </button>
      </div>
    </dialog>
  );
}
