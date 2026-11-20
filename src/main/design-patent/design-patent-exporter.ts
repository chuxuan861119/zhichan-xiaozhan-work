import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import yazl from "yazl";
import {
  inspectDesignPatent,
  renderDesignPatentBriefLines,
} from "../../shared/patent/design-patent.js";
import { resolveDesignViewImage } from "../../shared/patent/design-view-image.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import { processDesignImage } from "./image-processor.js";

export type DesignPatentDocxExport = {
  outputDirectory: string;
  documentPath: string;
  imagePaths: string[];
  zipPath: string | null;
};

const DESIGN_VIEW_EXPORT_ORDER = [
  "perspective",
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
] as const;

export async function exportDesignPatentPdf(input: {
  patent: CanonicalPatent;
  outputRoot: string;
  assetBytes(assetId: string): Promise<Uint8Array>;
  zip?: boolean;
  confirmWarnings: boolean;
  createPdf(html: string, outputPath: string): Promise<void>;
}): Promise<DesignPatentDocxExport> {
  return exportDesignPatentBundle({ ...input, format: "pdf" });
}

export async function exportDesignPatentDocx(input: {
  patent: CanonicalPatent;
  outputRoot: string;
  assetBytes(assetId: string): Promise<Uint8Array>;
  zip?: boolean;
  confirmWarnings: boolean;
}): Promise<DesignPatentDocxExport> {
  return exportDesignPatentBundle({ ...input, format: "docx" });
}

async function exportDesignPatentBundle(input: {
  patent: CanonicalPatent;
  outputRoot: string;
  assetBytes(assetId: string): Promise<Uint8Array>;
  zip?: boolean;
  confirmWarnings: boolean;
  format: "docx" | "pdf";
  createPdf?(html: string, outputPath: string): Promise<void>;
}): Promise<DesignPatentDocxExport> {
  if (input.patent.patentType !== "design" || input.patent.designPatent === null) {
    throw new Error("Only design patents can use the design-patent exporter.");
  }
  const design = input.patent.designPatent;
  if (inspectDesignPatent(design).length > 0 && !input.confirmWarnings) {
    throw new Error("存在导出前提示，请确认风险后继续导出。");
  }
  const assets = new Map(input.patent.assets.map((asset) => [asset.assetId, asset]));
  await mkdir(input.outputRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(input.outputRoot, ".design-export-"));
  const outputDirectory = join(
    input.outputRoot,
    `${safeName(input.patent.name ?? "外观设计")}-导出-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
  );
  const temporaryZipPath = `${temporaryDirectory}.zip`;
  const finalZipPath = `${outputDirectory}.zip`;
  try {
    const imagesDirectory = join(temporaryDirectory, "图片");
    await mkdir(imagesDirectory);
    const temporaryImagePaths: string[] = [];
    const orderedViews = [...design.views].sort(
      (left, right) =>
        DESIGN_VIEW_EXPORT_ORDER.indexOf(left.kind) - DESIGN_VIEW_EXPORT_ORDER.indexOf(right.kind),
    );
    for (const [index, view] of orderedViews.entries()) {
      const asset = assets.get(resolveDesignViewImage(view).assetId);
      if (!asset) throw new Error(`Design view ${view.viewId} references a missing asset.`);
      const processed = await processDesignImage(
        await input.assetBytes(asset.assetId),
        resolveDesignViewImage(view).operations,
      );
      const filename = `${String(index + 1).padStart(2, "0")}-${safeName(view.label)}.${asset.mediaType === "image/jpeg" ? "jpg" : "png"}`;
      const imagePath = join(imagesDirectory, filename);
      await writeFile(imagePath, processed.bytes);
      temporaryImagePaths.push(imagePath);
    }
    const documentFilename = `外观设计简要说明.${input.format}`;
    const temporaryDocumentPath = join(temporaryDirectory, documentFilename);
    if (input.format === "docx") {
      const docx = new Document({
        sections: [
          {
            children: [
              new Paragraph({
                children: [new TextRun({ text: "外观设计简要说明", bold: true })],
              }),
              ...renderDesignPatentBrief(input.patent).map((text) => new Paragraph({ text })),
            ],
          },
        ],
      });
      await writeFile(temporaryDocumentPath, await Packer.toBuffer(docx));
    } else {
      if (!input.createPdf) throw new Error("PDF creation service is unavailable.");
      await input.createPdf(renderDesignPatentBriefHtml(input.patent), temporaryDocumentPath);
      if ((await stat(temporaryDocumentPath)).size === 0) {
        throw new Error("生成的 PDF 文件为空。");
      }
    }
    if (input.zip) {
      await createZip(
        temporaryZipPath,
        temporaryDocumentPath,
        temporaryImagePaths,
        documentFilename,
      );
    }
    await rename(temporaryDirectory, outputDirectory);
    if (input.zip) await rename(temporaryZipPath, finalZipPath);
    const documentPath = join(outputDirectory, documentFilename);
    const imagePaths = temporaryImagePaths.map((path) =>
      join(outputDirectory, "图片", basename(path)),
    );
    return {
      outputDirectory,
      documentPath,
      imagePaths,
      zipPath: input.zip ? finalZipPath : null,
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    await rm(temporaryZipPath, { force: true });
    await rm(outputDirectory, { recursive: true, force: true });
    await rm(finalZipPath, { force: true });
    throw error;
  }
}

export function renderDesignPatentBrief(patent: CanonicalPatent): string[] {
  if (patent.patentType !== "design" || patent.designPatent === null) return [];
  return renderDesignPatentBriefLines(patent.name, patent.designPatent);
}

export function renderDesignPatentBriefHtml(patent: CanonicalPatent): string {
  const paragraphs = renderDesignPatentBrief(patent)
    .map((sentence) => `<p>${escapeHtml(sentence)}</p>`)
    .join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font-family:SimSun,serif;font-size:12pt;line-height:1.6;padding:24mm}h1{text-align:center;font-size:16pt}</style><body><h1>外观设计简要说明</h1>${paragraphs}</body></html>`;
}

function safeName(value: string): string {
  return (
    value
      .replace(/[<>:"/\\|?*]/g, "_")
      .split("")
      .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
      .join("")
      .trim()
      .slice(0, 80) || "未命名"
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ??
      character
    );
  });
}

async function createZip(
  zipPath: string,
  documentPath: string,
  imagePaths: readonly string[],
  documentEntry = "外观设计简要说明.docx",
): Promise<void> {
  const archive = new yazl.ZipFile();
  archive.addFile(documentPath, documentEntry);
  for (const imagePath of imagePaths) {
    archive.addFile(imagePath, `图片/${basename(imagePath)}`);
  }
  const stream = createWriteStream(zipPath);
  archive.outputStream.pipe(stream);
  archive.end();
  await Promise.race([
    once(stream, "close"),
    once(stream, "error").then(([error]) => Promise.reject(error)),
  ]);
}
