import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../../shared/document/defaults.js";
import type { AssetDescriptor, ParagraphNode, SemanticRole } from "../../shared/document/model.js";
import { createImportedPatent } from "../../shared/patent/defaults.js";
import { CanonicalPatentSchema } from "../../shared/patent/model.js";
import {
  type TutorialContext,
  type TutorialLessonId,
  tutorialLesson,
} from "../../shared/tutorial/model.js";
import { importImage } from "../assets/image-importer.js";
import type { LibraryRuntime } from "../library/library-runtime.js";

function paragraph(text: string, role?: SemanticRole): ParagraphNode {
  return {
    id: randomUUID(),
    type: "paragraph",
    ...(role ? { semanticRole: role } : {}),
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: text ? [{ type: "text", text, marks: [] }] : [],
  };
}
export function createTutorialPatent(lessonId: TutorialLessonId, assets: AssetDescriptor[] = []) {
  const patent = createImportedPatent({ name: "练习 · 可调节夹持装置", patentType: "invention" });
  const exercise = paragraph(
    lessonId === "supplement-number"
      ? "底座上设置夹持板，调节杆与底座连接。"
      : "底座上设置夹持板，调节杆带动夹持板移动。",
    "description-background",
  );
  if (lessonId === "clear-format") {
    exercise.content = [
      {
        type: "text",
        text: "底座上设置夹持板，调节杆带动夹持板移动。",
        marks: [{ type: "italic" }, { type: "color", value: "#C2416B" }, { type: "underline" }],
      },
    ];
  }
  patent.books.find((book) => book.kind === "description")!.document.content = [
    paragraph("可调节夹持装置", "invention-title"),
    paragraph("技术领域", "description-technical-field"),
    paragraph("本示例涉及用于机械加工的夹持装置。", "description-technical-field"),
    paragraph("背景技术", "description-background"),
    ...(lessonId === "supplement-number" ? [] : [exercise]),
    paragraph("发明内容", "description-summary"),
    paragraph("", "description-summary"),
    paragraph("附图说明", "description-drawings"),
    ...(lessonId === "figure-sort"
      ? ["图1为局部图。", "图2为整体图。", "图3为侧视图。"].map((text) =>
          paragraph(text, "description-drawings"),
        )
      : [paragraph("", "description-drawings")]),
    paragraph("具体实施方式", "description-embodiments"),
    ...(lessonId === "supplement-number"
      ? [{ ...exercise, semanticRole: "description-embodiments" as const }]
      : [paragraph("", "description-embodiments")]),
  ];
  const claims = [
    paragraph(
      "1.一种可调节夹持装置，其特征在于，包括底座、夹持板及调节杆，所述夹持板设置于所述底座，所述调节杆带动所述夹持板移动。",
      "claim",
    ),
  ];
  if (lessonId === "invention-content" || lessonId === "embodiments")
    claims.push(
      paragraph(
        "2.根据权利要求1所述的可调节夹持装置，其特征在于，所述调节杆与所述底座螺纹连接。",
        "claim",
      ),
    );
  patent.books.find((book) => book.kind === "claims")!.document.content = claims;
  patent.activeBookKind = tutorialLesson(lessonId).book;
  if (lessonId === "supplement-number")
    patent.referenceMarks.push({ referenceMarkId: randomUUID(), keyword: "底座", number: 1 });
  patent.assets = assets;
  const figureOrder: string[] = [];
  if (lessonId === "figure-sort" && assets.length === 3) {
    const figures = assets.map((asset) => ({
      figureId: randomUUID(),
      assetId: asset.assetId,
      widthMm: 90,
    }));
    figureOrder.push(...figures.map((figure) => figure.figureId));
    patent.figures = [figures[2]!, figures[0]!, figures[1]!];
  }
  if (lessonId === "cad-label" && assets[0])
    patent.drawingProjects.push({
      projectId: randomUUID(),
      name: "教学图纸 · 可调节夹持装置",
      sourceAssetId: assets[0].assetId,
      baseAssetId: assets[0].assetId,
      sourceKind: "image",
      pageNumber: 1,
      width: assets[0].widthPx,
      height: assets[0].heightPx,
      annotations: [],
      regions: [],
      warnings: [],
      revision: 0,
    });
  return {
    patent: CanonicalPatentSchema.parse(patent),
    baseline: {
      paragraphId:
        lessonId === "sequential-number" || lessonId === "custom-number"
          ? claims[0]!.id
          : exercise.id,
      figureOrder,
    },
  };
}

function drawingSvg(view: number): string {
  const geometries = [
    '<path d="M140 350H660V410H140Z M240 215H470V350H240Z M470 270H625V305H470Z M625 240H660V335H625Z"/><path d="M165 380H630 M268 245H440 M495 284H612" stroke-width="2"/>',
    '<path d="M240 200H400V350H240Z M180 350H540V405H180Z M400 270H600V300H400Z M600 240H635V330H600Z"/><path d="M260 235H380 M420 285H575" stroke-width="2"/>',
    '<path d="M150 200H370V365H150Z M370 255H610V310H370Z M610 210H655V355H610Z"/><path d="M375 264L395 305 M400 264L420 305 M425 264L445 305 M450 264L470 305 M475 264L495 305 M500 264L520 305 M525 264L545 305" stroke-width="2"/>',
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520"><rect width="800" height="520" fill="white"/><g fill="none" stroke="#1E293B" stroke-width="4" stroke-linejoin="round">${geometries[view]}</g><text x="400" y="475" text-anchor="middle" font-family="sans-serif" font-size="24">${["整体图", "侧视图", "局部图"][view]}</text></svg>`;
}

export class TutorialSeedService {
  #context: TutorialContext | null = null;
  #pending = false;
  constructor(
    readonly sessionId: string,
    readonly runtime: LibraryRuntime,
  ) {}
  read(): TutorialContext | null {
    return this.#context ? structuredClone(this.#context) : null;
  }
  async prepare(lessonId: TutorialLessonId): Promise<TutorialContext> {
    if (this.#pending) throw new Error("练习正在准备，请稍候。");
    this.#pending = true;
    const lease = randomUUID();
    let stagedIds: string[] = [];
    let committed = false;
    try {
      const count = lessonId === "figure-sort" ? 3 : lessonId === "cad-label" ? 1 : 0;
      const stored = [];
      for (let index = 0; index < count; index++) {
        const bytes = await sharp(Buffer.from(drawingSvg(index)))
          .png()
          .toBuffer();
        stored.push(
          await importImage({
            originalName: `${["整体图", "侧视图", "局部图"][index]}.png`,
            bytes,
          }),
        );
      }
      const imported = await this.runtime.assetStore.stageMany(lease, stored);
      stagedIds = imported.map((asset) => asset.descriptor.assetId);
      const { patent, baseline } = createTutorialPatent(
        lessonId,
        imported.map((asset) => asset.descriptor),
      );
      await this.runtime.patents.importBundle({
        bundleId: randomUUID(),
        patents: [{ patent, assets: [] }],
      });
      committed = true;
      await this.runtime.assetStore.commitStaged(lease, stagedIds);
      this.#context = { sessionId: this.sessionId, lessonId, patentId: patent.patentId, baseline };
      return this.read()!;
    } finally {
      if (!committed) await this.runtime.assetStore.discardStaged(lease, stagedIds);
      this.#pending = false;
    }
  }
}
