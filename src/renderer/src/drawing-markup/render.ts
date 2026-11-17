import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PageSettings } from "../../../shared/document/model";
import { automaticAnnotationStyle } from "../../../shared/drawing-markup/automatic-annotation-style";
import { baseFragments, fragmentWorldPoint } from "../../../shared/drawing-markup/base-fragments";
import {
  cadLabelLineweight,
  cadLabelOutputWidth,
} from "../../../shared/drawing-markup/cad-label-style";
import { nativeCadLabelIds } from "../../../shared/drawing-markup/cad-native-label";
import { detailLeader, detailRatioText } from "../../../shared/drawing-markup/detail-view";
import { bounds, outputSize, pointInside } from "../../../shared/drawing-markup/geometry";
import { jpegWithDensity } from "../../../shared/drawing-markup/jpeg-density";
import { leaderPoints } from "../../../shared/drawing-markup/label-layout";
import type {
  DrawingDetailView,
  DrawingProject,
  DrawingRegion,
} from "../../../shared/drawing-markup/model";
import {
  annotationOutputStyle,
  drawingAnnotationScale,
  drawingLeaderWidth,
} from "../../../shared/drawing-markup/output-settings";
import { intersects } from "../../../shared/drawing-markup/tiles";
import { insertedFigureWidthMm } from "../../../shared/patent/figure-insertion-size";
import { prepareCadExportStrokes } from "./cad-export-strokes";
import { cadExportViewport } from "./cad-export-viewport";
import { DrawingPixelScanner } from "./drawing-pixels";
import { exportLabelFont, exportLeaderWidth } from "./export-label-style";
import { findNewLabelOverlap } from "./label-overlap";
import type { TiledDrawingSource } from "./tiled-drawing-preview";

export async function pngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("无法生成图片。"))), "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
}
export function imageUrl(bytes: Uint8Array, type: string): string {
  // Blob snapshots its input. Avoid copying ordinary worker buffers a second time,
  // while keeping the exact view bounds and supporting shared-buffer callers.
  const view =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Uint8Array.from(bytes);
  return URL.createObjectURL(new Blob([view], { type }));
}
async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}
export function detailRasterStrokeScale(detail: Pick<DrawingDetailView, "ratio" | "sourceScale">) {
  return (detail.sourceScale ?? 1) * detail.ratio;
}
export async function pdfDocument(bytes: Uint8Array, CanvasFactory?: object) {
  const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdf.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdf.getDocument({
    data: Uint8Array.from(bytes),
    disableAutoFetch: true,
    disableStream: true,
    useWorkerFetch: false,
    stopAtErrors: true,
    ...(CanvasFactory ? { CanvasFactory } : {}),
  });
  return { task, doc: await task.promise };
}
export async function pdfPreview(bytes: Uint8Array, pageNumber: number) {
  const { task, doc } = await pdfDocument(bytes);
  try {
    const page = await doc.getPage(pageNumber);
    const original = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 1600 / Math.max(original.width, original.height) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d")!, canvas, viewport }).promise;
    return {
      bytes: await pngBytes(canvas),
      width: canvas.width,
      height: canvas.height,
      totalPages: doc.numPages,
    };
  } finally {
    await task.destroy();
  }
}
type DrawingRenderOptions = {
  readCadDetail?: (assetId: string) => Promise<Uint8Array>;
  /** The supplied CAD SVG was rendered without its native patent-label entities. */
  nativeLabelsRemoved?: boolean;
  labelFreeCadOverlay?: Uint8Array | undefined;
  autoAdjustLabelSize?: boolean;
  autoLabelScale?: number;
  fitToPage?: PageSettings;
  tiled?: TiledDrawingSource | undefined;
  readTile?: ((id: string) => Promise<Uint8Array>) | undefined;
};
type ExportResources = {
  tiled?: TiledDrawingSource | undefined;
  readTile?: ((id: string) => Promise<Uint8Array>) | undefined;
  images: Map<string, Promise<HTMLImageElement>>;
  cadSources: Map<string, Uint8Array>;
  imageUrls: Set<string>;
  scanner: DrawingPixelScanner;
};

async function renderBase(
  project: DrawingProject,
  bytes: Uint8Array,
  mediaType: string,
  width: number,
  height: number,
  scale: number,
  box: { x: number; y: number },
  sourceStrokeScale: number,
  cadStrokeReferencePixels: number,
  resources: ExportResources,
  transparent = false,
) {
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const sourceContext = source.getContext("2d")!;
  let viewportKey = "";
  // A native drawing's saved frame is a coordinate reference, not a paper clip.
  // Reframe before decoding: an SVG image has already lost out-of-viewport ink
  // by the time drawImage runs. Explicit raster fragment clips remain unchanged.
  if (
    project.cad?.unified &&
    !project.baseFragments &&
    (!project.cad.overlayAssetId || transparent) &&
    (project.sourceKind === "dxf" || project.sourceKind === "dwg") &&
    mediaType.toLowerCase().includes("svg") &&
    !resources.tiled
  ) {
    const viewport = { ...box, width: width / scale, height: height / scale };
    viewportKey = `${box.x}:${box.y}:${viewport.width}:${viewport.height}:`;
    bytes = cadExportViewport(bytes, project, viewport);
    project = {
      ...project,
      width: viewport.width,
      height: viewport.height,
      baseFragments: [{ id: "cad-export", offset: { x: box.x, y: box.y }, clips: [], holes: [] }],
    };
  }
  const fragments = baseFragments(project);
  const paintFragment = async (
    fragment: (typeof fragments)[number],
    paint: () => Promise<void>,
  ) => {
    sourceContext.save();
    const path = (points: DrawingRegion["points"]) => {
      points.forEach((p, i) => {
        const q = fragmentWorldPoint(fragment, p);
        const x = (q.x - box.x) * scale;
        const y = (q.y - box.y) * scale;
        if (i === 0) sourceContext.moveTo(x, y);
        else sourceContext.lineTo(x, y);
      });
      sourceContext.closePath();
    };
    for (const clip of fragment.clips) {
      sourceContext.beginPath();
      path(clip);
      sourceContext.clip("evenodd");
    }
    for (const hole of fragment.holes) {
      sourceContext.beginPath();
      sourceContext.rect(-1, -1, width + 2, height + 2);
      path(hole);
      sourceContext.clip("evenodd");
    }
    try {
      await paint();
    } finally {
      sourceContext.restore();
    }
  };
  if (resources.tiled) {
    const tiled = resources.tiled;
    const factor = project.width / tiled.index.width;
    const factorY = project.height / tiled.index.height;
    for (const fragment of fragments) {
      await paintFragment(fragment, async () => {
        sourceContext.translate(
          (fragment.offset.x - box.x) * scale,
          (fragment.offset.y - box.y) * scale,
        );
        sourceContext.rotate(((fragment.rotation ?? 0) * Math.PI) / 180);
        sourceContext.scale(scale * (fragment.scale ?? 1), scale * (fragment.scale ?? 1));
        sourceContext.fillStyle = "white";
        sourceContext.fillRect(0, 0, project.width, project.height);
        for (const tile of tiled.index.tiles) {
          const c = tile.core,
            r = tile.render;
          const points = [
            { x: c.x, y: c.y },
            { x: c.x + c.width, y: c.y },
            { x: c.x, y: c.y + c.height },
            { x: c.x + c.width, y: c.y + c.height },
          ].map((p) => fragmentWorldPoint(fragment, { x: p.x * factor, y: p.y * factorY }));
          const xs = points.map((p) => p.x),
            ys = points.map((p) => p.y);
          if (
            !intersects(
              {
                x: Math.min(...xs),
                y: Math.min(...ys),
                width: Math.max(...xs) - Math.min(...xs),
                height: Math.max(...ys) - Math.min(...ys),
              },
              { ...box, width: width / scale, height: height / scale },
            )
          )
            continue;
          const response = resources.readTile
            ? { ok: true as const, value: await resources.readTile(tile.id) }
            : await window.patentApi.assets.readDrawingTile(
                tiled.sessionId,
                tiled.assetId,
                tile.id,
              );
          if (!response.ok) throw new Error(response.error.message);
          const prepared = prepareCadExportStrokes(
            response.value,
            sourceStrokeScale * (fragment.scale ?? 1),
            r.width * factor * scale * (fragment.scale ?? 1),
            cadStrokeReferencePixels,
          );
          const url = imageUrl(prepared, "image/svg+xml");
          let image: HTMLImageElement | undefined;
          try {
            image = await loadImage(url);
            sourceContext.save();
            try {
              sourceContext.beginPath();
              sourceContext.rect(c.x * factor, c.y * factorY, c.width * factor, c.height * factorY);
              sourceContext.clip();
              sourceContext.drawImage(
                image,
                r.x * factor,
                r.y * factorY,
                r.width * factor,
                r.height * factorY,
              );
            } finally {
              sourceContext.restore();
            }
          } finally {
            if (image) image.src = "";
            URL.revokeObjectURL(url);
          }
        }
      });
    }
  } else if (project.sourceKind === "pdf") {
    const { task, doc } = await pdfDocument(bytes);
    try {
      const page = await doc.getPage(project.pageNumber);
      const original = page.getViewport({ scale: 1 });
      // PDF.js owns its render context. Composite its output through our independent clip context.
      const tile = document.createElement("canvas");
      tile.width = width;
      tile.height = height;
      for (const fragment of fragments) {
        await page.render({
          canvas: tile,
          canvasContext: tile.getContext("2d")!,
          viewport: page.getViewport({
            scale: (scale * project.width * (fragment.scale ?? 1)) / original.width,
          }),
          transform: [
            Math.cos(((fragment.rotation ?? 0) * Math.PI) / 180),
            Math.sin(((fragment.rotation ?? 0) * Math.PI) / 180),
            -Math.sin(((fragment.rotation ?? 0) * Math.PI) / 180),
            Math.cos(((fragment.rotation ?? 0) * Math.PI) / 180),
            (fragment.offset.x - box.x) * scale,
            (fragment.offset.y - box.y) * scale,
          ],
        }).promise;
        await paintFragment(fragment, async () => {
          sourceContext.drawImage(tile, 0, 0);
        });
      }
    } finally {
      await task.destroy();
    }
  } else {
    const svg = mediaType.toLowerCase().includes("svg");
    const imageUrls = svg ? new Set<string>() : resources.imageUrls;
    // SVG image objects retain browser rasterization state across differently clipped
    // canvases. Share preprocessing, but retain separate SVG decodes for exact output.
    const images = svg ? new Map<string, Promise<HTMLImageElement>>() : resources.images;
    const getImage = (strokeScale: number, fragmentScale: number) => {
      const normalizedScale = Number.isFinite(strokeScale) && strokeScale > 0 ? strokeScale : 1;
      const cadSvg =
        (project.sourceKind === "dwg" || project.sourceKind === "dxf") &&
        mediaType.toLowerCase().includes("svg");
      const key = cadSvg
        ? `${viewportKey}${normalizedScale}:${project.width * scale * fragmentScale}:${cadStrokeReferencePixels}`
        : "raster";
      const cached = images.get(key);
      if (cached) return cached;
      let sourceBytes = bytes;
      if (cadSvg) {
        sourceBytes =
          resources.cadSources.get(key) ??
          prepareCadExportStrokes(
            bytes,
            normalizedScale,
            project.width * scale * fragmentScale,
            cadStrokeReferencePixels,
          );
        // Bound preprocessing retention independently of drawing/detail count.
        if (sourceBytes.byteLength <= 32 * 1024 * 1024) {
          while (
            resources.cadSources.size >= 8 ||
            [...resources.cadSources.values()].reduce((sum, item) => sum + item.byteLength, 0) +
              sourceBytes.byteLength >
              32 * 1024 * 1024
          ) {
            const oldest = resources.cadSources.keys().next().value;
            if (oldest === undefined) break;
            resources.cadSources.delete(oldest);
          }
          resources.cadSources.set(key, sourceBytes);
        }
      }
      const url = imageUrl(sourceBytes, mediaType);
      imageUrls.add(url);
      const loaded = loadImage(url).catch((error) => {
        URL.revokeObjectURL(url);
        imageUrls.delete(url);
        throw error;
      });
      images.set(key, loaded);
      return loaded;
    };
    try {
      for (const fragment of fragments) {
        const image = await getImage(
          sourceStrokeScale * (fragment.scale ?? 1),
          fragment.scale ?? 1,
        );
        await paintFragment(fragment, async () => {
          sourceContext.translate(
            (fragment.offset.x - box.x) * scale,
            (fragment.offset.y - box.y) * scale,
          );
          sourceContext.rotate(((fragment.rotation ?? 0) * Math.PI) / 180);
          sourceContext.fillStyle = "white";
          if (!transparent)
            sourceContext.fillRect(
              0,
              0,
              project.width * scale * (fragment.scale ?? 1),
              project.height * scale * (fragment.scale ?? 1),
            );
          sourceContext.drawImage(
            image,
            0,
            0,
            project.width * scale * (fragment.scale ?? 1),
            project.height * scale * (fragment.scale ?? 1),
          );
        });
      }
    } finally {
      if (svg) for (const url of imageUrls) URL.revokeObjectURL(url);
    }
  }
  return source;
}

export async function renderDrawing(
  project: DrawingProject,
  region: DrawingRegion,
  bytes: Uint8Array,
  mediaType: string,
  widthMm: number,
  dpi: number,
  options: DrawingRenderOptions = {},
): Promise<{ bytes: Uint8Array; width: number; height: number; widthMm: number }> {
  const resources: ExportResources = {
    tiled: options.tiled,
    readTile: options.readTile,
    images: new Map(),
    cadSources: new Map(),
    imageUrls: new Set(),
    scanner: new DrawingPixelScanner(),
  };
  try {
    return await renderDrawingPass(
      project,
      region,
      bytes,
      mediaType,
      widthMm,
      dpi,
      options,
      resources,
    );
  } finally {
    resources.scanner.dispose();
    for (const url of resources.imageUrls) URL.revokeObjectURL(url);
  }
}

async function renderDrawingPass(
  project: DrawingProject,
  region: DrawingRegion,
  bytes: Uint8Array,
  mediaType: string,
  widthMm: number,
  dpi: number,
  options: DrawingRenderOptions,
  resources: ExportResources,
  contentBox?: { x: number; y: number; width: number; height: number },
): Promise<{ bytes: Uint8Array; width: number; height: number; widthMm: number }> {
  const fittedWidth = (size: { width: number; height: number }) =>
    options.fitToPage
      ? Math.min(
          widthMm,
          insertedFigureWidthMm(options.fitToPage, { widthPx: size.width, heightPx: size.height }),
        )
      : widthMm;
  const automaticStyle = (size: { width: number; height: number }) => {
    const style = automaticAnnotationStyle(size, options.autoLabelScale)!;
    // Page fitting must precede lettering, not shrink the finished JPEG afterwards.
    const compensation = widthMm / fittedWidth(size);
    return { fontSize: style.fontSize * compensation, lineWidth: style.lineWidth * compensation };
  };
  const includedAnnotations = options.autoAdjustLabelSize
    ? project.annotations.filter((a) => pointInside(a, region.points))
    : project.annotations;
  const nativeLabelIds = nativeCadLabelIds(project);
  if (
    options.autoAdjustLabelSize &&
    !options.nativeLabelsRemoved &&
    includedAnnotations.some((a) => nativeLabelIds.has(a.id))
  )
    throw new Error("自动字号取图需要无标号 CAD 底图，未生成不完整预览。");
  const detailMarks = (fontSize?: number) =>
    (project.detailViews ?? []).flatMap((original) => {
      const d = { ...original, fontSize: fontSize ?? original.fontSize };
      const size = d.fontSize;
      return [
        ...(!d.markerHidden && pointInside(d.marker, region.points)
          ? [{ ...d.marker, text: d.label, fontSize: size, points: detailLeader(d) }]
          : []),
        ...(!d.titleHidden && pointInside(d.title, region.points)
          ? [
              {
                ...d.title,
                text: d.label,
                fontSize: size,
                points: [
                  { x: d.title.x - size * 1.3, y: d.title.y + size * 0.7 },
                  { x: d.title.x + size * 1.3, y: d.title.y + size * 0.7 },
                ],
              },
              {
                x: d.title.x,
                y: d.title.y + size * 1.5,
                text: detailRatioText(d.ratio),
                fontSize: size,
                points: [],
              },
            ]
          : []),
      ];
    });
  if (contentBox && options.autoAdjustLabelSize) {
    const measure = document.createElement("canvas").getContext("2d")!;
    measure.textAlign = "center";
    measure.textBaseline = "middle";
    // Expansion changes the world-space size needed for a fixed output font.
    // Solve that dependency before rendering, without widening the base-image clip.
    for (let iteration = 0; iteration < 64; iteration++) {
      const style = automaticStyle(contentBox);
      measure.font = exportLabelFont(project.sourceKind, style.fontSize);
      const padding = style.fontSize * 0.1;
      let left = contentBox.x,
        top = contentBox.y;
      let right = left + contentBox.width,
        bottom = top + contentBox.height;
      for (const a of [
        ...includedAnnotations.map((a) => ({ ...a, points: leaderPoints({ ...a, ...style }) })),
        ...detailMarks(style.fontSize),
      ]) {
        const metrics = measure.measureText(a.text);
        left = Math.min(left, a.x - metrics.actualBoundingBoxLeft - padding);
        right = Math.max(right, a.x + metrics.actualBoundingBoxRight + padding);
        top = Math.min(top, a.y - metrics.actualBoundingBoxAscent - padding);
        bottom = Math.max(bottom, a.y + metrics.actualBoundingBoxDescent + padding);
        for (const p of a.points) {
          left = Math.min(left, p.x - padding);
          right = Math.max(right, p.x + padding);
          top = Math.min(top, p.y - padding);
          bottom = Math.max(bottom, p.y + padding);
        }
      }
      const next: { x: number; y: number; width: number; height: number } = {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      };
      const change = Math.max(
        Math.abs(next.x - contentBox.x),
        Math.abs(next.y - contentBox.y),
        next.width - contentBox.width,
        next.height - contentBox.height,
      );
      contentBox = next;
      if (change < contentBox.width * 0.000001) break;
      if (iteration === 63)
        throw new Error("标号过长，无法自动适配，请缩短标号或关闭自动调整标号大小。");
    }
  }
  const outputPoints = contentBox
    ? [
        { x: contentBox.x, y: contentBox.y },
        { x: contentBox.x + contentBox.width, y: contentBox.y },
        { x: contentBox.x + contentBox.width, y: contentBox.y + contentBox.height },
        { x: contentBox.x, y: contentBox.y + contentBox.height },
      ]
    : region.points;
  const actualWidthMm = fittedWidth(bounds(outputPoints));
  const { width, height, scale, box } = outputSize(outputPoints, actualWidthMm, dpi);
  // Reference CAD strokes to physical output density, not the crop or detail zoom.
  const strokeScale = scale / ((dpi / 96) * 0.4);
  // Native 0.25 mm CAD strokes use a restrained 0.1 mm patent-output reference;
  // their relative lineweights remain distinct instead of collapsing to a dark floor.
  const cadStrokeReferencePixels = (0.1 * dpi) / 25.4;
  const source = await renderBase(
    project.cad?.backgroundSize
      ? { ...project, width: project.cad.backgroundSize[0], height: project.cad.backgroundSize[1] }
      : project,
    bytes,
    mediaType,
    width,
    height,
    scale,
    box,
    strokeScale,
    cadStrokeReferencePixels,
    resources,
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  region.points.forEach((p, i) => {
    const x = (p.x - box.x) * scale,
      y = (p.y - box.y) * scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.clip("evenodd");
  ctx.drawImage(source, 0, 0);
  source.width = source.height = 1;
  for (const d of project.detailViews ?? []) {
    if (
      project.cad?.unified &&
      !project.cad.overlayAssetId &&
      project.cad.objects?.some((o) => o.id === d.id && o.body !== undefined)
    )
      continue;
    const radius = d.radius * d.ratio;
    if (
      d.center.x + radius < box.x ||
      d.center.y + radius < box.y ||
      d.center.x - radius > box.x + width / scale ||
      d.center.y - radius > box.y + height / scale
    )
      continue;
    const transformPoints = (points: DrawingRegion["points"]) =>
      points.map((p) => ({ x: p.x * d.ratio, y: p.y * d.ratio }));
    const frozen = d.cadSource && d.cadSource.baseAssetId !== project.baseAssetId;
    if (frozen && !options.readCadDetail)
      throw new Error("局部放大原始图形未加载，未导出不完整的图像。");
    const detailBytes = frozen ? await options.readCadDetail!(d.cadSource!.baseAssetId) : bytes;
    const content = await renderBase(
      {
        ...project,
        width:
          (d.cadSource?.backgroundSize?.[0] ?? d.cadSource?.width ?? project.width) *
          (d.sourceScale ?? 1) *
          d.ratio,
        height:
          (d.cadSource?.backgroundSize?.[1] ?? d.cadSource?.height ?? project.height) *
          (d.sourceScale ?? 1) *
          d.ratio,
        baseFragments: d.fragments.map((f) => ({
          ...f,
          offset: {
            x: d.center.x + (f.offset.x - d.source.x) * d.ratio,
            y: d.center.y + (f.offset.y - d.source.y) * d.ratio,
          },
          clips: f.clips.map(transformPoints),
          holes: f.holes.map(transformPoints),
        })),
      },
      detailBytes,
      frozen ? "image/svg+xml" : mediaType,
      width,
      height,
      scale,
      box,
      detailRasterStrokeScale(d) * strokeScale,
      cadStrokeReferencePixels,
      frozen
        ? { ...resources, tiled: undefined, images: new Map(), cadSources: new Map() }
        : resources,
    );
    ctx.save();
    ctx.beginPath();
    ctx.arc(
      (d.center.x - box.x) * scale,
      (d.center.y - box.y) * scale,
      radius * scale,
      0,
      Math.PI * 2,
    );
    ctx.clip();
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(content, 0, 0);
    content.width = content.height = 1;
    ctx.restore();
  }
  // Measure only the clipped drawing: old label sizes and blank selection margins
  if (project.cad?.overlayAssetId) {
    if (!options.readCadDetail) throw new Error("可编辑图形资源未加载，未导出不完整的图像。");
    const overlay = await renderBase(
      { ...project, sourceKind: "dxf", baseFragments: undefined },
      options.labelFreeCadOverlay ?? (await options.readCadDetail(project.cad.overlayAssetId)),
      "image/svg+xml",
      width,
      height,
      scale,
      box,
      strokeScale,
      cadStrokeReferencePixels,
      { ...resources, tiled: undefined, images: new Map(), cadSources: new Map() },
      true,
    );
    ctx.drawImage(overlay, 0, 0);
    overlay.width = overlay.height = 1;
  }
  // must not influence the initial size. Recompute against the final output on rerender.
  const visibleDrawing =
    options.autoAdjustLabelSize && !contentBox
      ? await resources.scanner.scan(ctx, width, height)
      : null;
  const autoStyle = options.autoAdjustLabelSize
    ? automaticStyle(
        visibleDrawing
          ? { width: visibleDrawing.width / scale, height: visibleDrawing.height / scale }
          : box,
      )
    : null;
  if (contentBox && autoStyle) {
    const measure = document.createElement("canvas").getContext("2d")!;
    measure.textAlign = "center";
    measure.textBaseline = "middle";
    const glyphBounds = (mark: { x: number; y: number; text: string }, size: number) => {
      measure.font = exportLabelFont(project.sourceKind, size);
      const metrics = measure.measureText(mark.text);
      return {
        x: mark.x - metrics.actualBoundingBoxLeft,
        y: mark.y - metrics.actualBoundingBoxAscent,
        width: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
        height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
      };
    };
    const originalDetails = detailMarks();
    const labels = [
      ...includedAnnotations.map((mark) => ({
        text: mark.text,
        original: glyphBounds(mark, mark.fontSize),
        output: glyphBounds(mark, autoStyle.fontSize),
      })),
      ...detailMarks(autoStyle.fontSize).map((mark, index) => ({
        text: mark.text,
        original: glyphBounds(originalDetails[index]!, originalDetails[index]!.fontSize),
        output: glyphBounds(mark, autoStyle.fontSize),
      })),
    ];
    const collision = findNewLabelOverlap(labels, autoStyle.fontSize);
    if (collision)
      throw new Error(
        `自动调整后标号“${collision[0]}”与“${collision[1]}”重叠，请移动标号、降低大小比例或关闭自动调整后重试。`,
      );
  }
  ctx.translate(-box.x * scale, -box.y * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "black";
  ctx.strokeStyle = "black";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const originalDetail of project.detailViews ?? []) {
    const d = autoStyle ? { ...originalDetail, fontSize: autoStyle.fontSize } : originalDetail;
    // Detail circles and leaders are output marks, so their physical weight
    // must not change with the selected crop or the detail magnification.
    ctx.lineWidth = Math.max(d.lineWidth * (dpi / 96), 1.25 * (dpi / 300)) / scale;
    if (!d.markerHidden) {
      ctx.beginPath();
      ctx.arc(d.source.x, d.source.y, d.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(d.center.x, d.center.y, d.radius * d.ratio, 0, Math.PI * 2);
    ctx.stroke();
    if (!d.markerHidden && !autoStyle) {
      const circleWidth = ctx.lineWidth;
      ctx.lineWidth = exportLeaderWidth(project.sourceKind, drawingLeaderWidth(1 / scale, dpi));
      ctx.beginPath();
      detailLeader(d).forEach((p, i) => {
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      });
      ctx.stroke();
      ctx.lineWidth = circleWidth;
    }
    ctx.font = exportLabelFont(project.sourceKind, d.fontSize);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (!d.markerHidden && !autoStyle) ctx.fillText(d.label, d.marker.x, d.marker.y);
    if (!d.titleHidden && !autoStyle) {
      ctx.fillText(d.label, d.title.x, d.title.y);
      ctx.beginPath();
      ctx.moveTo(d.title.x - d.fontSize * 1.3, d.title.y + d.fontSize * 0.7);
      ctx.lineTo(d.title.x + d.fontSize * 1.3, d.title.y + d.fontSize * 0.7);
      ctx.stroke();
      ctx.fillText(detailRatioText(d.ratio), d.title.x, d.title.y + d.fontSize * 1.5);
    }
  }
  // 引出线线宽按实际输出框换算：白边裁掉后重新成图时不会被裁切比例带偏。
  // 关闭自动适配时保留原字号，并按统一物理宽度输出引线。
  const annotationScale = region.output
    ? drawingAnnotationScale(outputPoints, { ...region.output, widthMm: actualWidthMm })
    : null;
  if (options.autoAdjustLabelSize) {
    ctx.restore();
    ctx.save();
    ctx.translate(-box.x * scale, -box.y * scale);
    ctx.scale(scale, scale);
    ctx.fillStyle = "black";
    ctx.strokeStyle = "black";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (autoStyle) {
      ctx.font = exportLabelFont(project.sourceKind, autoStyle.fontSize);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = exportLeaderWidth(project.sourceKind, autoStyle.lineWidth);
      for (const mark of detailMarks(autoStyle.fontSize)) {
        ctx.fillText(mark.text, mark.x, mark.y);
        if (mark.points.length) {
          ctx.beginPath();
          mark.points.forEach((p, i) => {
            if (i) ctx.lineTo(p.x, p.y);
            else ctx.moveTo(p.x, p.y);
          });
          ctx.stroke();
        }
      }
    }
  }
  for (const a of includedAnnotations) {
    // The CAD patent-preview source hides PW_LABEL proxy entities. Native DXF/DWG
    // keeps those entities editable; raster preview/export paints the semantic
    // text and leader here so a synchronized label is not omitted.
    const style = autoStyle ?? annotationOutputStyle(a, annotationScale);
    ctx.lineWidth = project.cad
      ? cadLabelOutputWidth(cadLabelLineweight(project, a), dpi, 1 / scale)
      : exportLeaderWidth(
          project.sourceKind,
          autoStyle?.lineWidth ?? drawingLeaderWidth(1 / scale, dpi),
        );
    if (a.points.length) {
      ctx.beginPath();
      leaderPoints({ ...a, ...style }).forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }
    ctx.font = exportLabelFont(project.sourceKind, style.fontSize);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(a.text, a.x, a.y);
  }
  ctx.restore();
  let content = await resources.scanner.scan(ctx, width, height);
  if (!content) throw new Error("所选范围没有可见图形或标号，请重新取图。");
  // White-margin trimming must not lower the effective resolution when the
  // result is inserted at widthMm. Render the tight bounds at that width once.
  if (
    (project.sourceKind === "dwg" || project.sourceKind === "dxf" || options.autoAdjustLabelSize) &&
    !contentBox &&
    (options.autoAdjustLabelSize || content.width < width - 4) &&
    content.width / scale >= 1 &&
    content.height / scale >= 1
  ) {
    canvas.width = canvas.height = 1;
    return renderDrawingPass(project, region, bytes, mediaType, widthMm, dpi, options, resources, {
      x: box.x + content.x / scale,
      y: box.y + content.y / scale,
      width: content.width / scale,
      height: content.height / scale,
    });
  }
  // Keep the final output scale: another crop here would enlarge the marks again.
  if (options.autoAdjustLabelSize) content = { x: 0, y: 0, width, height };
  const trimmed = document.createElement("canvas");
  trimmed.width = content.width + 2;
  trimmed.height = content.height + 2;
  const trimmedContext = trimmed.getContext("2d")!;
  trimmedContext.fillStyle = "white";
  trimmedContext.fillRect(0, 0, trimmed.width, trimmed.height);
  trimmedContext.drawImage(
    canvas,
    content.x,
    content.y,
    content.width,
    content.height,
    1,
    1,
    content.width,
    content.height,
  );
  const jpeg = await new Promise<Blob>((resolve, reject) =>
    trimmed.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("无法生成图片。"))),
      "image/jpeg",
      1,
    ),
  );
  return {
    bytes: jpegWithDensity(new Uint8Array(await jpeg.arrayBuffer()), dpi),
    width: trimmed.width,
    height: trimmed.height,
    widthMm: Math.min(actualWidthMm, fittedWidth({ width: trimmed.width, height: trimmed.height })),
  };
}
