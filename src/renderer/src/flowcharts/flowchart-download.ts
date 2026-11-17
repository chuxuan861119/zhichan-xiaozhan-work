import type { DrawioExportFormat } from "../../../shared/flowcharts/bridge";

type RasterizedImage = Readonly<{
  dataUrl: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}>;

export function getFlowchartExportMediaType(format: DrawioExportFormat): string {
  if (format === "drawio") return "application/xml";
  if (format === "svg") return "image/svg+xml";
  if (format === "png") return "image/png";
  if (format === "jpeg") return "image/jpeg";
  return "application/pdf";
}

export function getFlowchartExportExtension(format: DrawioExportFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function createJpegPdf(jpeg: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("流程图图片尺寸无效。");
  }
  const content = ascii(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`);
  const objects = [
    ascii("<< /Type /Catalog /Pages 2 0 R >>"),
    ascii("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    ),
    concat([
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`,
      ),
      jpeg,
      ascii("\nendstream"),
    ]),
    concat([ascii(`<< /Length ${content.byteLength} >>\nstream\n`), content, ascii("endstream")]),
  ];
  const header = concat([
    ascii("%PDF-1.7\n%"),
    Uint8Array.from([0xe2, 0xe3, 0xcf, 0xd3]),
    ascii("\n"),
  ]);
  const parts: Uint8Array[] = [header];
  const offsets = [0];
  let offset = header.byteLength;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const wrapped = concat([ascii(`${index + 1} 0 obj\n`), object, ascii("\nendobj\n")]);
    parts.push(wrapped);
    offset += wrapped.byteLength;
  });
  const xrefOffset = offset;
  const xref = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (const objectOffset of offsets.slice(1)) {
    xref.push(`${String(objectOffset).padStart(10, "0")} 00000 n `);
  }
  xref.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    `startxref\n${xrefOffset}`,
    "%%EOF\n",
  );
  parts.push(ascii(`${xref.join("\n")}\n`));
  return concat(parts);
}

function decodeDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !dataUrl.slice(0, comma).includes(";base64")) {
    throw new Error("流程图编辑器返回了无效的图片数据。");
  }
  const binary = atob(dataUrl.slice(comma + 1));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function rasterizeSvg(
  svgDataUrl: string,
  mediaType: "image/jpeg" | "image/png",
  scale = 1,
): Promise<RasterizedImage> {
  const image = new Image();
  image.decoding = "async";
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("流程图 SVG 无法转换为图片。"));
  });
  image.src = svgDataUrl;
  await loaded;
  const width = Math.ceil((image.naturalWidth || image.width) * scale);
  const height = Math.ceil((image.naturalHeight || image.height) * scale);
  if (!width || !height) throw new Error("流程图图片尺寸无效。");
  if (
    !Number.isFinite(width * height) ||
    width > 16384 ||
    height > 16384 ||
    width * height > 40_000_000
  )
    throw new Error("图片尺寸过大，请降低清晰度或缩小导出范围。");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建流程图图片画布。");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL(mediaType, mediaType === "image/jpeg" ? 0.95 : undefined);
  return { dataUrl, bytes: decodeDataUrl(dataUrl), width, height };
}

export async function prepareFlowchartExport(
  data: string,
  format: DrawioExportFormat,
  options: {
    scale?: number;
    allPages?: boolean;
    renderPdf?: (svgs: string[]) => Promise<Uint8Array>;
  } = {},
): Promise<string | Uint8Array> {
  if (format === "pdf") {
    if (!options.renderPdf) throw new Error("矢量 PDF 输出服务不可用，请重启应用后重试。");
    const pages: string[] = options.allPages ? JSON.parse(data) : [data];
    if (!Array.isArray(pages) || pages.length === 0 || pages.length > 100)
      throw new Error("PDF 页面数据无效。");
    return options.renderPdf(
      pages.map((page) => {
        if (typeof page !== "string") throw new Error("PDF 页面数据无效。");
        if (!page.startsWith("data:")) return page;
        if (!page.startsWith("data:image/svg+xml")) throw new Error("PDF 页面不是 SVG。");
        const separator = page.indexOf(",");
        return page.slice(0, separator).includes(";base64")
          ? new TextDecoder().decode(decodeDataUrl(page))
          : decodeURIComponent(page.slice(separator + 1));
      }),
    );
  }
  if (format === "png" && data.startsWith("data:image/svg")) {
    return (await rasterizeSvg(data, "image/png", options.scale)).dataUrl;
  }
  if (format !== "jpeg") return data;
  return (await rasterizeSvg(data, "image/jpeg", options.scale)).dataUrl;
}
