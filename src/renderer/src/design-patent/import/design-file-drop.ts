import type { AssetDescriptor } from "../../../../shared/document/model";
import type { ImportedAsset, PatentApi } from "../../../../shared/ipc/contract";
import type { DesignEditorState } from "../../../../shared/patent/design-editor-state";
import {
  DESIGN_IMAGE_EXTENSIONS,
  DESIGN_IMAGE_FORMAT_LABEL,
} from "../../../../shared/patent/design-image-formats";

export const DESIGN_IMPORT_FORMAT_LABEL = DESIGN_IMAGE_FORMAT_LABEL;
export type DesignImportedAsset = ImportedAsset & {
  editor?: DesignEditorState;
  projectAsset?: AssetDescriptor;
};
async function thumbnail(bytes: Uint8Array) {
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: "image/png" }));
  try {
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法生成工程预览。");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("无法生成工程预览。"))), "image/png"),
    );
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

export async function importDroppedDesignFiles(
  files: readonly File[],
  sessionId: string,
  api: PatentApi["assets"],
  options?: {
    decoder: PatentApi["imageEditor"] | undefined;
    selectPage(name: string, count: number): Promise<number | null>;
  },
): Promise<{
  assets: DesignImportedAsset[];
  errors: Array<{ originalName: string; message: string }>;
}> {
  const assets: DesignImportedAsset[] = [];
  const errors: Array<{ originalName: string; message: string }> = [];
  for (const file of files) {
    if (
      !(DESIGN_IMAGE_EXTENSIONS as readonly string[]).includes(
        file.name.split(".").at(-1)?.toLowerCase() ?? "",
      )
    ) {
      errors.push({
        originalName: file.name,
        message: `支持 ${DESIGN_IMPORT_FORMAT_LABEL} 图片；不支持文件夹。`,
      });
      continue;
    }
    if (file.size > 50 * 1024 * 1024) {
      errors.push({ originalName: file.name, message: "图片文件不能超过 50 MB。" });
      continue;
    }
    try {
      let bytes = new Uint8Array(await file.arrayBuffer());
      let project:
        | Awaited<ReturnType<NonNullable<PatentApi["imageEditor"]>["decodePsd"]>>
        | undefined;
      const extended = !/\.(jpe?g|png)$/iu.test(file.name);
      if (extended) {
        const decoder = options?.decoder;
        if (!decoder) throw new Error("当前实例未加载扩展图片解码接口，请保存后重启。");
        if (/\.psd$/iu.test(file.name)) {
          project = await decoder.decodePsd({ bytes });
          if (!project.ok) throw project.error;
          if (!project.value.composite)
            throw new Error("当前实例未加载PSD预览接口，请保存后重启。");
          bytes = Uint8Array.from(project.value.composite);
        } else {
          let decoded = await decoder.decodeRaster({ bytes });
          if (!decoded.ok) throw decoded.error;
          if (decoded.value.pageCount > 1) {
            const page = await options!.selectPage(file.name, decoded.value.pageCount);
            if (page === null) continue;
            if (page !== 0) decoded = await decoder.decodeRaster({ bytes, page });
            if (!decoded.ok) throw decoded.error;
          }
          bytes = Uint8Array.from(decoded.value.bytes);
        }
      }
      const result = await api.importBytes({
        sessionId,
        originalName: file.name,
        declaredMediaType: extended ? "image/png" : file.type || null,
        bytes,
      });
      if (result.ok) {
        const item: DesignImportedAsset = { ...result.value, importedName: file.name };
        if (project?.ok) {
          if (!api.stageDesignEditorProject) throw new Error("当前平台未提供分层工程保存能力。");
          const { metadata, psd, backings } = project.value;
          const staged = await api.stageDesignEditorProject({
            sessionId,
            project: { metadata, psd, backings },
            thumbnail: await thumbnail(bytes),
          });
          if (!staged.ok) throw staged.error;
          const checkpoint = {
            revisionId: crypto.randomUUID(),
            projectAssetId: staged.value.descriptor.assetId,
            createdAt: new Date().toISOString(),
          };
          item.projectAsset = staged.value.descriptor;
          item.editor = {
            version: 1,
            sourceAssetId: item.descriptor.assetId,
            saved: checkpoint,
            recovery: null,
            applied: {
              ...checkpoint,
              imageAssetId: item.descriptor.assetId,
              widthPx: metadata.size.width,
              heightPx: metadata.size.height,
            },
          };
        }
        assets.push(item);
      } else errors.push({ originalName: file.name, message: result.error.message });
    } catch (error) {
      errors.push({
        originalName: file.name,
        message:
          error && typeof error === "object" && "message" in error
            ? String(error.message)
            : "无法读取或导入此文件，请检查文件后重试。",
      });
    }
  }
  return { assets, errors };
}
