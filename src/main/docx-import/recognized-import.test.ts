import { describe, expect, it, vi } from "vitest";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import { DocxImportSessionService } from "./docx-import-session-service.js";
import type { ParsedWordDocument } from "./wordprocessingml-parser.js";

function setup(files: string[][]) {
  const stageMany = vi.fn(async () => []);
  const createImported = vi.fn(async ({ patent }: { patent: CanonicalPatent }) => ({
    patent,
    patentId: patent.patentId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    saveState: "saved" as const,
  }));
  const service = new DocxImportSessionService({
    dialog: {
      showOpenDialog: async () => ({
        canceled: false,
        filePaths: files.map((_, i) => `C:/imports/file${i}.docx`),
      }),
    },
    readPackage: async (path) => ({
      sourceFileName: path,
      parts: new Map(),
      findings: [],
      externalRelationships: [],
    }),
    parseDocument: async (pkg): Promise<ParsedWordDocument> => ({
      warnings: [],
      blocks: (files[Number(/file(\d+)/.exec(pkg.sourceFileName)?.[1])] ?? []).map((text) => ({
        type: "paragraph",
        headingLevel: null,
        alignment: "left",
        firstLineIndentMm: null,
        lineSpacing: null,
        list: null,
        inlines: [{ type: "text", text, style: {} }],
      })),
    }),
    assetStore: { stageMany, commitStaged: async () => {}, discardStaged: async () => {} },
    patents: { createImported },
  });
  return { service, stageMany, createImported };
}

describe("recognized-only DOCX import", () => {
  it.each([
    [
      ["权利要求书", "1. 一种装置。"],
      ["实验记录", "温度25度"],
    ],
    [["无法识别的前言", "权利要求书", "1. 一种装置。", "说明书", "技术领域"]],
    [["权利要求书"], ["权利要求书"]],
  ])("rejects the entire selection before staging or creating any data: %j", async (...files) => {
    const { service, stageMany, createImported } = setup(files);
    await expect(service.prepare("owner")).rejects.toThrow(/无法识别|重复/);
    expect(stageMany).not.toHaveBeenCalled();
    expect(createImported).not.toHaveBeenCalled();
  });

  it.each([
    [
      [
        "说明书摘要",
        "摘要正文",
        "说明书",
        "技术领域",
        "摘要附图",
        "说明书附图",
        "权利要求书",
        "1. 一种装置。",
      ],
    ],
    [
      ["说明书", "技术领域"],
      ["权利要求书", "1. 一种装置。"],
    ],
  ])(
    "imports recognized sections regardless of order and creates no auxiliary documents: %j",
    async (...files) => {
      const { service } = setup(files);
      const preview = await service.prepare("owner");
      if (!preview) throw Error("Missing preview");
      const opened = await service.commit("owner", {
        sessionId: preview.sessionId,
        name: null,
        customer: null,
        patentType: "invention",
        assignments: preview.units.map(({ unitId, title, target }) => ({ unitId, title, target })),
        acknowledgedWarningIds: [],
      });
      expect(opened.patent.auxiliaryDocuments).toEqual([]);
      expect(JSON.stringify(opened.patent.books.find((book) => book.kind === "claims"))).toContain(
        "一种装置",
      );
      expect(
        JSON.stringify(opened.patent.books.find((book) => book.kind === "description")),
      ).toContain("技术领域");
    },
  );

  it("rejects a forged assignment instead of redirecting recognized text", async () => {
    const { service, createImported } = setup([["权利要求书", "1. 一种装置。"]]);
    const preview = await service.prepare("owner");
    if (!preview) throw Error("Missing preview");
    await expect(
      service.commit("owner", {
        sessionId: preview.sessionId,
        name: null,
        customer: null,
        patentType: "invention",
        assignments: preview.units.map(({ unitId, title }) => ({
          unitId,
          title,
          target: { kind: "auxiliary" as const },
        })),
        acknowledgedWarningIds: [],
      }),
    ).rejects.toThrow("必须与五书识别结果一致");
    expect(createImported).not.toHaveBeenCalled();
  });
});
