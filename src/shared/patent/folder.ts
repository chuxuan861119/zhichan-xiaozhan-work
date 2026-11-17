import { z } from "zod";
import {
  availablePatentBookKinds,
  type CanonicalPatent,
  PATENT_BOOK_LABELS,
  type PatentBookKind,
} from "./model.js";

export const FolderFormatSchema = z.enum([
  "docx",
  "pdf",
  "drawio",
  "dwg",
  "dxf",
  "png",
  "jpg",
  "jpeg",
  "svg",
  "tif",
  "tiff",
  "bmp",
  "webp",
]);
export type FolderFormat = z.infer<typeof FolderFormatSchema>;
export type PatentFolderEntry = {
  key: string;
  kind: "book" | "auxiliary" | "flowchart" | "drawing";
  id: string;
  name: string;
  label: string;
  formats: FolderFormat[];
};
const displayName = (name: string) =>
  name.replace(/\.(?:docx|pdf|drawio|dwg|dxf|png|jpe?g|svg|tiff?|bmp|webp)$/iu, "");

export function patentFolderEntries(patent: CanonicalPatent): PatentFolderEntry[] {
  return [
    ...availablePatentBookKinds(patent).map(
      (id: PatentBookKind): PatentFolderEntry => ({
        key: `book:${id}`,
        kind: "book",
        id,
        name: PATENT_BOOK_LABELS[id],
        label: "专利文档",
        formats: ["docx", "pdf"],
      }),
    ),
    ...patent.auxiliaryDocuments.map(
      (doc): PatentFolderEntry => ({
        key: `auxiliary:${doc.auxiliaryDocumentId}`,
        kind: "auxiliary",
        id: doc.auxiliaryDocumentId,
        name: displayName(doc.title),
        label: "其他文档",
        formats: ["docx", "pdf"],
      }),
    ),
    ...patent.flowchartProjects.map(
      (project): PatentFolderEntry => ({
        key: `flowchart:${project.projectId}`,
        kind: "flowchart",
        id: project.projectId,
        name: displayName(project.name),
        label: "流程图工作稿",
        formats: ["drawio"],
      }),
    ),
    ...patent.drawingProjects.map((project): PatentFolderEntry => {
      const source = patent.assets.find((a) => a.assetId === project.sourceAssetId);
      const format = FolderFormatSchema.safeParse(source?.extension);
      return {
        key: `drawing:${project.projectId}`,
        kind: "drawing",
        id: project.projectId,
        name: displayName(project.name),
        label: project.cad ? "CAD 图纸" : "导入图纸原件",
        formats: project.cad ? ["dwg", "dxf"] : format.success ? [format.data] : [],
      };
    }),
  ];
}

export function folderExportItems(
  entries: PatentFolderEntry[],
  keys: string[],
  format?: FolderFormat,
): { key: string; format: FolderFormat }[] {
  if (!keys.length || new Set(keys).size !== keys.length) throw new Error("请选择不重复的文件。");
  return keys.map((key) => {
    const entry = entries.find((e) => e.key === key);
    const selected = keys.length === 1 ? (format ?? entry?.formats[0]) : entry?.formats[0];
    if (!entry || !selected || !entry.formats.includes(selected))
      throw new Error("文件不存在或不支持所选导出格式。");
    return { key, format: selected };
  });
}

export const PatentFolderExportRequestSchema = z
  .object({
    patentId: z.string().uuid(),
    sessionId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    items: z
      .array(z.object({ key: z.string().min(1).max(100), format: FolderFormatSchema }).strict())
      .min(1)
      .max(500),
    cad: z
      .array(
        z
          .object({
            projectId: z.string().uuid(),
            bytes: z
              .instanceof(Uint8Array)
              .refine((b) => b.byteLength > 0 && b.byteLength <= 100 * 1024 * 1024),
          })
          .strict(),
      )
      .max(500),
  })
  .strict()
  .refine(
    (r) =>
      new Set(r.items.map((i) => i.key)).size === r.items.length &&
      new Set(r.cad.map((c) => c.projectId)).size === r.cad.length,
    "文件不能重复。",
  );
export type PatentFolderExportRequest = z.infer<typeof PatentFolderExportRequestSchema>;
