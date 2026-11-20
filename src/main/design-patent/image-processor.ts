import sharp from "sharp";
import {
  type DesignPatentImageOperation,
  MAX_DESIGN_IMAGE_EDGE_PX,
  MAX_DESIGN_IMAGE_PIXELS,
  MAX_DESIGN_IMAGE_SOURCE_BYTES,
  MAX_DESIGN_IMAGE_SOURCE_EDGE_PX,
  MAX_DESIGN_IMAGE_SOURCE_PIXELS,
} from "../../shared/patent/design-patent.js";

export type ProcessedDesignImage = {
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
  subjectBounds: { leftPx: number; topPx: number; widthPx: number; heightPx: number } | null;
};

/** Applies the saved edit recipe to an image copy; the source asset is never modified. */
export async function processDesignImage(
  source: Uint8Array,
  operations: readonly DesignPatentImageOperation[],
): Promise<ProcessedDesignImage> {
  if (source.byteLength > MAX_DESIGN_IMAGE_SOURCE_BYTES) {
    throw new Error("Design image source exceeds the safe byte limit.");
  }
  const input = sharp(source, { failOn: "error" });
  const metadata = await input.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Design image dimensions are unavailable.");
  }
  assertSafeSourceDimensions(metadata.width, metadata.height);
  let estimatedWidth = metadata.width;
  let estimatedHeight = metadata.height;
  let pipeline = input.clone();
  for (const operation of operations) {
    if (operation.kind === "trim") {
      estimatedWidth = operation.width;
      estimatedHeight = operation.height;
      pipeline = pipeline.extract({
        left: operation.left,
        top: operation.top,
        width: operation.width,
        height: operation.height,
      });
    } else if (operation.kind === "rotate") {
      const radians = (operation.degrees * Math.PI) / 180;
      const width = Math.ceil(
        Math.abs(estimatedWidth * Math.cos(radians)) +
          Math.abs(estimatedHeight * Math.sin(radians)),
      );
      const height = Math.ceil(
        Math.abs(estimatedWidth * Math.sin(radians)) +
          Math.abs(estimatedHeight * Math.cos(radians)),
      );
      estimatedWidth = width;
      estimatedHeight = height;
      pipeline = pipeline.rotate(operation.degrees, { background: "white" });
    } else if (operation.kind === "affine") {
      const width = Math.ceil(estimatedWidth + Math.abs(operation.xSkew) * estimatedHeight);
      const height = Math.ceil(estimatedHeight + Math.abs(operation.ySkew) * estimatedWidth);
      estimatedWidth = width;
      estimatedHeight = height;
      pipeline = pipeline.affine(
        [
          [1, operation.xSkew],
          [operation.ySkew, 1],
        ],
        { background: "white" },
      );
    } else {
      estimatedWidth = operation.width;
      estimatedHeight = operation.height;
      pipeline = pipeline.resize(operation.width, operation.height, {
        fit: operation.fit,
        background: "white",
      });
    }
    assertSafeProcessingDimensions(estimatedWidth, estimatedHeight);
  }
  const output = metadata.format === "jpeg" ? pipeline.jpeg() : pipeline.png();
  const bytes = await output.toBuffer();
  const outputMetadata = await sharp(bytes).metadata();
  if (!outputMetadata.width || !outputMetadata.height) {
    throw new Error("Processed design image dimensions are unavailable.");
  }
  assertSafeProcessingDimensions(outputMetadata.width, outputMetadata.height);
  return {
    bytes,
    widthPx: outputMetadata.width,
    heightPx: outputMetadata.height,
    subjectBounds: await detectSubjectBounds(bytes),
  };
}

function assertSafeSourceDimensions(width: number, height: number): void {
  if (
    width > MAX_DESIGN_IMAGE_SOURCE_EDGE_PX ||
    height > MAX_DESIGN_IMAGE_SOURCE_EDGE_PX ||
    width * height > MAX_DESIGN_IMAGE_SOURCE_PIXELS
  ) {
    throw new Error("Design image dimensions exceed the safe processing limit.");
  }
}

function assertSafeProcessingDimensions(width: number, height: number): void {
  assertSafeSourceDimensions(width, height);
}

async function detectSubjectBounds(
  bytes: Uint8Array,
): Promise<{ leftPx: number; topPx: number; widthPx: number; heightPx: number } | null> {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) return null;
  const scale = Math.min(
    1,
    MAX_DESIGN_IMAGE_EDGE_PX / metadata.width,
    MAX_DESIGN_IMAGE_EDGE_PX / metadata.height,
    Math.sqrt(MAX_DESIGN_IMAGE_PIXELS / (metadata.width * metadata.height)),
  );
  const analysisWidth = Math.max(1, Math.floor(metadata.width * scale));
  const analysisHeight = Math.max(1, Math.floor(metadata.height * scale));
  const { data, info } = await sharp(bytes)
    .resize(analysisWidth, analysisHeight, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const red = data[offset] ?? 255;
      const green = data[offset + 1] ?? 255;
      const blue = data[offset + 2] ?? 255;
      const alpha = data[offset + 3] ?? 255;
      if (alpha > 10 && (red < 245 || green < 245 || blue < 245)) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < left || bottom < top) return null;
  const scaleX = metadata.width / info.width;
  const scaleY = metadata.height / info.height;
  const sourceLeft = Math.floor(left * scaleX);
  const sourceTop = Math.floor(top * scaleY);
  const sourceRight = Math.min(metadata.width, Math.ceil((right + 1) * scaleX));
  const sourceBottom = Math.min(metadata.height, Math.ceil((bottom + 1) * scaleY));
  return {
    leftPx: sourceLeft,
    topPx: sourceTop,
    widthPx: sourceRight - sourceLeft,
    heightPx: sourceBottom - sourceTop,
  };
}
