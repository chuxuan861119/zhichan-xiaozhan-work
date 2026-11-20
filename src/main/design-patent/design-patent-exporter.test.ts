import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import {
  exportDesignPatentDocx,
  exportDesignPatentPdf,
  renderDesignPatentBrief,
} from "./design-patent-exporter.js";

describe("design patent exporter", () => {
  it("exports all multi images in user order using custom names", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-design-export-"));
    try {
      const patent = createBlankPatent({ patentType: "design", name: "界面" });
      patent.designPatent!.imageMode = "multi-image";
      patent.designPatent!.views = ["参考图", "变化状态图2", "产品视图"].map((label) => {
        const assetId = crypto.randomUUID();
        patent.assets.push({
          assetId,
          kind: "image",
          originalName: "source.png",
          mediaType: "image/png",
          extension: "png",
          byteLength: 1,
          sha256: "A".repeat(64),
          previewByteLength: 1,
          previewSha256: "B".repeat(64),
          widthPx: 20,
          heightPx: 30,
        });
        return {
          viewId: crypto.randomUUID(),
          assetId,
          kind: "multi-image",
          label,
          expression: "line-drawing",
          subjectBounds: null,
          subjectBoundsSource: null,
          subjectBoundsConfirmed: false,
          assignmentStatus: "confirmed",
          assignmentEvidence: null,
          operations: [],
          note: null,
        };
      });
      const bytes = await sharp({
        create: { width: 20, height: 30, channels: 3, background: "white" },
      })
        .png()
        .toBuffer();
      const result = await exportDesignPatentDocx({
        patent,
        outputRoot: root,
        assetBytes: async () => bytes,
        confirmWarnings: true,
      });
      expect(result.imagePaths.map((path) => path.split(/[\\/]/u).at(-1))).toEqual([
        "01-参考图.jpg",
        "02-变化状态图2.jpg",
        "03-产品视图.jpg",
      ]);
      expect(await sharp(await readFile(result.imagePaths[0]!)).metadata()).toMatchObject({
        format: "jpeg",
        width: 20,
        height: 30,
        hasAlpha: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("exports the applied composite without reapplying the original raster recipe", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-applied-export-"));
    try {
      const patent = createBlankPatent({ patentType: "design", name: "应用图片" }),
        id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const asset = {
        assetId: id(1),
        kind: "image" as const,
        originalName: "source.png",
        mediaType: "image/png" as const,
        extension: "png" as const,
        byteLength: 1,
        sha256: "A".repeat(64),
        previewByteLength: 1,
        previewSha256: "B".repeat(64),
        widthPx: 10,
        heightPx: 20,
      };
      patent.assets = [asset, { ...asset, assetId: id(2), widthPx: 4, heightPx: 2 }];
      const checkpoint = {
        revisionId: id(4),
        projectAssetId: id(3),
        createdAt: "2026-11-03T00:00:00.000Z",
      };
      patent.designPatent!.views = [
        {
          viewId: id(5),
          kind: "front",
          label: "主视图",
          assetId: id(1),
          expression: "line-drawing",
          subjectBounds: null,
          subjectBoundsSource: null,
          subjectBoundsConfirmed: false,
          operations: [{ kind: "rotate", degrees: 90 }],
          note: null,
          editor: {
            version: 1,
            sourceAssetId: id(1),
            saved: checkpoint,
            recovery: null,
            applied: { ...checkpoint, imageAssetId: id(2), widthPx: 4, heightPx: 2 },
          },
        },
      ];
      const image = await sharp({ create: { width: 4, height: 2, channels: 3, background: "red" } })
        .png()
        .toBuffer();
      const reads: string[] = [];
      patent.designPatent!.brief.omissions = [
        { viewKind: "rear", reason: "same", referenceKind: "front", otherReason: null },
      ];
      const result = await exportDesignPatentDocx({
        patent,
        outputRoot: root,
        assetBytes: async (id) => {
          reads.push(id);
          return image;
        },
        confirmWarnings: true,
      });
      expect(result.imagePaths).toHaveLength(1);
      expect(renderDesignPatentBrief(patent).join("\n")).toContain(
        "后视图与主视图相同，省略后视图",
      );
      expect(reads).toEqual([id(2)]);
      expect(await sharp(await readFile(result.imagePaths[0]!)).metadata()).toMatchObject({
        width: 4,
        height: 2,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("renders canonical brief-description sentences from selected structured fields", () => {
    const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
    if (!patent.designPatent) throw new Error("fixture");
    patent.designPatent.brief = {
      ...patent.designPatent.brief,
      productUse: "用于坐具。",
      designPoints: ["shape", "color"],
      colorProtectionRequested: true,
      materialDescription: "靠背采用网布。",
    };

    expect(renderDesignPatentBrief(patent)).toContain("本外观设计产品的用途：用于坐具。");
    expect(renderDesignPatentBrief(patent)).toContain("设计要点在于形状和色彩。");
    expect(renderDesignPatentBrief(patent)).toContain("请求保护的外观设计包含色彩。");
    expect(renderDesignPatentBrief(patent)).toContain("靠背采用网布。");
  });

  it("renders partial design, representative view and omission reasons", () => {
    const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
    if (!patent.designPatent) throw new Error("fixture");
    patent.designPatent.subject = "partial-design";
    patent.designPatent.brief.partialDesignDescription = "椅背中以实线表示的部分。";
    patent.designPatent.views = [
      {
        viewId: "00000000-0000-4000-8000-000000000811",
        kind: "perspective",
        label: "立体图",
        assetId: "00000000-0000-4000-8000-000000000812",
        expression: "line-drawing",
        subjectBounds: null,
        subjectBoundsSource: null,
        subjectBoundsConfirmed: false,
        operations: [],
        note: null,
      },
    ];
    patent.designPatent.representativeViewId = patent.designPatent.views[0]?.viewId ?? null;
    patent.designPatent.brief.omissions = [
      { viewKind: "rear", reason: "same-or-symmetric", otherReason: null },
    ];
    patent.designPatent.brief.elongatedObjectLengthOmitted = true;

    const rendered = renderDesignPatentBrief(patent).join("\n");
    expect(rendered).toContain("请求保护产品的局部外观设计");
    expect(rendered).toContain("局部设计保护的部分及表示方式：椅背中以实线表示的部分");
    expect(rendered).toContain("最能表明设计要点的图片或照片：立体图");
    expect(rendered).toContain("后视图与主视图相同或对称，省略后视图");
    expect(rendered).toContain("省略长度");
  });

  it("exports processed view image files and one DOCX description as an isolated bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-patent-export-"));
    try {
      const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
      if (!patent.designPatent) throw new Error("fixture");
      const assetId = "00000000-0000-4000-8000-000000000801";
      patent.assets = [
        {
          assetId,
          kind: "image",
          originalName: "chair.png",
          mediaType: "image/png",
          extension: "png",
          byteLength: 1,
          sha256: "1".repeat(64),
          widthPx: 1,
          heightPx: 1,
          previewByteLength: 1,
          previewSha256: "2".repeat(64),
        },
      ];
      patent.designPatent.views = [
        {
          viewId: "00000000-0000-4000-8000-000000000802",
          kind: "front",
          label: "主视图",
          assetId,
          expression: "line-drawing",
          subjectBounds: null,
          subjectBoundsSource: null,
          subjectBoundsConfirmed: false,
          operations: [],
          note: null,
        },
        {
          viewId: "00000000-0000-4000-8000-000000000803",
          kind: "perspective",
          label: "立体图1",
          assetId,
          expression: "line-drawing",
          subjectBounds: null,
          subjectBoundsSource: null,
          subjectBoundsConfirmed: false,
          operations: [],
          note: null,
        },
        {
          viewId: "00000000-0000-4000-8000-000000000804",
          kind: "perspective-2",
          label: "立体图2",
          assetId,
          expression: "line-drawing",
          subjectBounds: null,
          subjectBoundsSource: null,
          subjectBoundsConfirmed: false,
          operations: [],
          note: null,
        },
        {
          viewId: "00000000-0000-4000-8000-000000000805",
          kind: "perspective-3",
          label: "立体图3",
          assetId,
          expression: "line-drawing",
          subjectBounds: null,
          subjectBoundsSource: null,
          subjectBoundsConfirmed: false,
          operations: [],
          note: null,
        },
        {
          viewId: "00000000-0000-4000-8000-000000000806",
          kind: "unassigned",
          label: "未识别图片",
          assetId,
          expression: "line-drawing",
          subjectBounds: null,
          subjectBoundsSource: null,
          subjectBoundsConfirmed: false,
          operations: [],
          note: null,
        },
      ];
      const image = Uint8Array.from(
        await sharp({
          create: { width: 1, height: 1, channels: 3, background: "black" },
        })
          .png()
          .toBuffer(),
      );
      const result = await exportDesignPatentDocx({
        patent,
        outputRoot: root,
        assetBytes: async () => image,
        confirmWarnings: true,
        zip: true,
      });

      expect(result.imagePaths.map((path) => path.split(/[\\/]/u).at(-1))).toEqual([
        "01-立体图1.jpg",
        "02-立体图2.jpg",
        "03-立体图3.jpg",
        "04-主视图.jpg",
      ]);
      expect((await readFile(result.documentPath)).byteLength).toBeGreaterThan(0);
      expect((await readFile(result.imagePaths[0] ?? "")).byteLength).toBeGreaterThan(0);
      expect(await readZipEntries(result.zipPath ?? "")).toEqual([
        "外观设计简要说明.docx",
        "图片/01-立体图1.jpg",
        "图片/02-立体图2.jpg",
        "图片/03-立体图3.jpg",
        "图片/04-主视图.jpg",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exports the same image bundle with PDF instead of DOCX when PDF is selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-patent-export-pdf-"));
    try {
      const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
      const result = await exportDesignPatentPdf({
        patent,
        outputRoot: root,
        assetBytes: async () => new Uint8Array(),
        confirmWarnings: true,
        createPdf: async (_html, outputPath) => writeFile(outputPath, "%PDF-test"),
      });

      expect(result.documentPath.endsWith(".pdf")).toBe(true);
      expect((await readFile(result.documentPath)).toString()).toBe("%PDF-test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates an optional ZIP beside the export bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-patent-export-zip-"));
    try {
      const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
      const result = await exportDesignPatentDocx({
        patent,
        outputRoot: root,
        assetBytes: async () => new Uint8Array(),
        zip: true,
        confirmWarnings: true,
      });

      expect(result.zipPath).toMatch(/\.zip$/u);
      expect((await readFile(result.zipPath ?? "")).byteLength).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit confirmation before exporting with any warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-patent-export-warning-"));
    try {
      const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
      await expect(
        exportDesignPatentDocx({
          patent,
          outputRoot: root,
          assetBytes: async () => new Uint8Array(),
          confirmWarnings: false,
        }),
      ).rejects.toThrow("确认风险");
      await expect(
        exportDesignPatentDocx({
          patent,
          outputRoot: root,
          assetBytes: async () => new Uint8Array(),
          confirmWarnings: true,
        }),
      ).resolves.toMatchObject({ documentPath: expect.stringMatching(/\.docx$/u) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes temporary output when a referenced image cannot be exported", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-patent-export-atomic-"));
    try {
      const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
      if (!patent.designPatent) throw new Error("fixture");
      patent.designPatent.views = [
        {
          viewId: "00000000-0000-4000-8000-000000000821",
          kind: "front",
          label: "主视图",
          assetId: "00000000-0000-4000-8000-000000000822",
          expression: "line-drawing",
          subjectBounds: null,
          subjectBoundsSource: null,
          subjectBoundsConfirmed: false,
          operations: [],
          note: null,
        },
      ];

      await expect(
        exportDesignPatentDocx({
          patent,
          outputRoot: root,
          assetBytes: async () => new Uint8Array(),
          confirmWarnings: true,
        }),
      ).rejects.toThrow("missing asset");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the generated bundle when PDF creation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-patent-export-pdf-atomic-"));
    try {
      const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
      await expect(
        exportDesignPatentPdf({
          patent,
          outputRoot: root,
          assetBytes: async () => new Uint8Array(),
          confirmWarnings: true,
          createPdf: async () => {
            throw new Error("PDF failure");
          },
        }),
      ).rejects.toThrow("PDF failure");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects and removes an empty PDF output", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-patent-export-pdf-empty-"));
    try {
      const patent = createBlankPatent({ patentType: "design", name: "折叠椅" });
      await expect(
        exportDesignPatentPdf({
          patent,
          outputRoot: root,
          assetBytes: async () => new Uint8Array(),
          confirmWarnings: true,
          createPdf: async (_html, outputPath) => writeFile(outputPath, new Uint8Array()),
        }),
      ).rejects.toThrow("PDF 文件为空");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function readZipEntries(path: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("ZIP unavailable"));
        return;
      }
      const entries: string[] = [];
      zip.on("entry", (entry) => {
        entries.push(entry.fileName);
        zip.readEntry();
      });
      zip.on("end", () => resolve(entries));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}
