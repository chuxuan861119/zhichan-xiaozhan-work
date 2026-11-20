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
          operations: [],
          note: null,
        },
        {
          viewId: "00000000-0000-4000-8000-000000000803",
          kind: "perspective",
          label: "立体图",
          assetId,
          expression: "line-drawing",
          subjectBounds: null,
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
        "01-立体图.png",
        "02-主视图.png",
      ]);
      expect((await readFile(result.documentPath)).byteLength).toBeGreaterThan(0);
      expect((await readFile(result.imagePaths[0] ?? "")).byteLength).toBeGreaterThan(0);
      expect(await readZipEntries(result.zipPath ?? "")).toEqual([
        "外观设计简要说明.docx",
        "图片/01-立体图.png",
        "图片/02-主视图.png",
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
