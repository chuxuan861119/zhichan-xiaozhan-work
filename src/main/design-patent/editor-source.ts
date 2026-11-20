import sharp from "sharp";
import {
  type DesignPatentImageOperation,
  DesignPatentImageOperationSchema,
  MAX_DESIGN_IMAGE_SOURCE_BYTES,
  MAX_DESIGN_IMAGE_SOURCE_EDGE_PX,
  MAX_DESIGN_IMAGE_SOURCE_PIXELS,
} from "../../shared/patent/design-patent.js";
import { type EditorOperationPool, editorOperationPool } from "./editor-operation-pool.js";
import { processDesignImage } from "./image-processor.js";

/** Full-size initial raster only. Callers must provide immutable original asset bytes, not previews. */
export async function prepareDesignEditorSource(
  source: Uint8Array,
  operations: readonly DesignPatentImageOperation[],
  admission: EditorOperationPool = editorOperationPool,
) {
  if (!source.byteLength || source.byteLength > MAX_DESIGN_IMAGE_SOURCE_BYTES)
    throw new Error("原始图片字节大小超限。");
  const releaseInput = admission.reserve(source.byteLength * 2);
  let releaseDecode = () => {};
  try {
    const owned = Buffer.from(source);
    const recipe = operations.map((operation) => DesignPatentImageOperationSchema.parse(operation));
    const metadata = await sharp(owned, {
      failOn: "error",
      limitInputPixels: MAX_DESIGN_IMAGE_SOURCE_PIXELS,
    }).metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_DESIGN_IMAGE_SOURCE_EDGE_PX ||
      metadata.height > MAX_DESIGN_IMAGE_SOURCE_EDGE_PX ||
      metadata.width * metadata.height > MAX_DESIGN_IMAGE_SOURCE_PIXELS
    )
      throw new Error("原始图片尺寸超限。");
    const workingPixels = Math.max(metadata.width * metadata.height, recipe.length ? 16000000 : 0);
    releaseDecode = admission.reserve(workingPixels * 4 * 8);
    // Legacy recipes use the old raw-image coordinate semantics. Their output is already
    // the user's corrected raster: never rotate that result using the original EXIF.
    const initial = recipe.length ? (await processDesignImage(owned, recipe)).bytes : owned;
    let pipeline = sharp(initial, {
      failOn: "error",
      limitInputPixels: MAX_DESIGN_IMAGE_SOURCE_PIXELS,
    });
    if (!recipe.length) pipeline = pipeline.rotate();
    const { data, info } = await pipeline
      .toColourspace("srgb")
      .png()
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(data),
      widthPx: info.width,
      heightPx: info.height,
      mediaType: "image/png" as const,
      initialLayerKind: info.channels === 4 ? ("regular" as const) : ("background" as const),
      initializedFrom: recipe.length ? ("legacy-recipe" as const) : ("original" as const),
    };
  } finally {
    releaseDecode();
    releaseInput();
  }
}
