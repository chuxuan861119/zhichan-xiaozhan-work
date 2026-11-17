import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import sharp from "sharp";
import type { ImageRotation } from "../../shared/document/model.js";
import { renderEditedImage } from "../assets/image-output-service.js";

export type DocxImageData =
  | { type: "png" | "jpg" | "bmp" | "tiff"; data: Uint8Array }
  | { type: "svg"; data: Uint8Array; fallback: { type: "png"; data: Uint8Array } };

/** Bake display orientation into export-only media, keeping source assets untouched. */
export async function prepareDocxImageData(
  image: DocxImageData,
  rotation: ImageRotation,
  width: number,
  height: number,
): Promise<DocxImageData> {
  if (image.type === "svg") {
    if (!rotation) return image;
    const svg = new DOMParser().parseFromString(
      Buffer.from(image.data).toString("utf8"),
      "image/svg+xml",
    ).documentElement;
    if (svg?.localName !== "svg") throw new Error("SVG 图片结构无效。");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    const quarterTurn = rotation === 90 || rotation === 270;
    const transform =
      rotation === 90
        ? `translate(${height} 0) rotate(90)`
        : rotation === 180
          ? `translate(${width} ${height}) rotate(180)`
          : `translate(0 ${width}) rotate(270)`;
    const transformed = `<svg xmlns="http://www.w3.org/2000/svg" width="${quarterTurn ? height : width}" height="${quarterTurn ? width : height}" viewBox="0 0 ${quarterTurn ? height : width} ${quarterTurn ? width : height}"><g transform="${transform}">${new XMLSerializer().serializeToString(svg)}</g></svg>`;
    return {
      type: "svg",
      data: Buffer.from(transformed),
      fallback: {
        type: "png",
        data: await renderEditedImage(image.fallback.data, {
          rotationDeg: rotation,
          format: "png",
        }),
      },
    };
  }
  if (!rotation) {
    if (image.type !== "jpg" && image.type !== "tiff") return image;
    const orientation = (await sharp(image.data).metadata()).orientation;
    if (!orientation || orientation === 1) return image;
  }
  return {
    type: "png",
    data: await renderEditedImage(image.data, { rotationDeg: rotation, format: "png" }),
  };
}
