import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ImageRotation, PageSettings } from "../../shared/document/model.js";
import type { FlowchartProjectDescriptor } from "../../shared/flowcharts/model.js";
import { FlowchartFigureLinkSchema } from "../../shared/flowcharts/model.js";
import { fitInsertedFigures } from "../../shared/patent/figure-insertion-size.js";
import type { PersistentAssetStore } from "../assets/asset-store.js";
import { decodeEnvelope, LibraryServiceError } from "../library/edit-journal.js";
import type { LibraryDatabase } from "../library/library-database.js";
import type { PatentService } from "../library/patent-service.js";
import { decodeJson } from "../library/plaintext-codec.js";
import { FlowchartImportService } from "./flowchart-import-service.js";
import {
  type FlowchartFigureTarget,
  type FlowchartRenderPreview,
  FlowchartRenderService,
} from "./flowchart-render-service.js";
import type { FlowchartSourceSnapshot, FlowchartSourceStore } from "./flowchart-source-store.js";

export type FlowchartCommitContext = Pick<
  Parameters<PatentService["mutateFlowcharts"]>[0],
  "beforeCommit" | "inTransaction"
>;

const IdentitySchema = z.string().uuid();

export type FlowchartOpenedProject = {
  project: FlowchartProjectDescriptor;
  source: Uint8Array;
  patentRevision: number;
};

type FlowchartServiceOptions = {
  database: LibraryDatabase;
  sourceStore: FlowchartSourceStore;
  patentService: PatentService;
  randomUUID?: () => string;
  assetStore?: PersistentAssetStore;
};

function descriptor(snapshot: FlowchartSourceSnapshot): FlowchartProjectDescriptor {
  return {
    projectId: snapshot.projectId,
    name: snapshot.metadata.name,
    revision: snapshot.revision,
    pageCount: snapshot.metadata.pageCount,
    lastPageId: snapshot.metadata.lastPageId,
    sourceSha256: snapshot.sourceSha256,
    createdAt: snapshot.createdAt,
    modifiedAt: snapshot.modifiedAt,
  };
}

export class FlowchartService {
  readonly #database: LibraryDatabase;
  readonly #sourceStore: FlowchartSourceStore;
  readonly #patentService: PatentService;
  readonly #randomUUID: () => string;
  readonly #assetStore: PersistentAssetStore | undefined;
  readonly #importService = new FlowchartImportService();
  readonly #renderService = new FlowchartRenderService();
  #disposed = false;

  constructor(options: FlowchartServiceOptions) {
    this.#database = options.database;
    this.#sourceStore = options.sourceStore;
    this.#patentService = options.patentService;
    this.#randomUUID = options.randomUUID ?? (() => randomUUID());
    this.#assetStore = options.assetStore;
  }

  list(patentId: string): FlowchartProjectDescriptor[] {
    this.#assertActive();
    return this.#sourceStore.list(IdentitySchema.parse(patentId)).map(descriptor);
  }

  load(patentId: string, projectId: string): FlowchartOpenedProject {
    this.#assertActive();
    const snapshot = this.#sourceStore.loadCurrent(patentId, projectId);
    return {
      project: descriptor(snapshot),
      source: Uint8Array.from(snapshot.source),
      patentRevision: this.#patentRevision(patentId),
    };
  }

  async create(
    input: {
      patentId: string;
      expectedPatentRevision: number;
      name: string;
      source: Uint8Array;
      pageCount: number;
      lastPageId: string | null;
    },
    context: FlowchartCommitContext = {},
  ): Promise<FlowchartOpenedProject> {
    this.#assertActive();
    const projectId = IdentitySchema.parse(this.#randomUUID());
    const committed = await this.#patentService.mutateFlowcharts({
      ...context,
      patentId: input.patentId,
      expectedRevision: input.expectedPatentRevision,
      mutation: (database) => {
        const snapshot = this.#sourceStore.appendRevisionInTransaction(database, {
          patentId: input.patentId,
          projectId,
          expectedProjectRevision: 0,
          source: input.source,
          metadata: { name: input.name, pageCount: input.pageCount, lastPageId: input.lastPageId },
        });
        return {
          changed: true,
          value: snapshot,
          retainedSources: [{ projectId, sourceRevisionId: snapshot.sourceRevisionId }],
        };
      },
    });
    return {
      project: descriptor(committed.value),
      source: Uint8Array.from(committed.value.source),
      patentRevision: committed.patent.revision,
    };
  }

  import(input: Parameters<FlowchartService["create"]>[0]): Promise<FlowchartOpenedProject> {
    return this.create(input);
  }

  importExternal(input: {
    patentId: string;
    expectedPatentRevision: number;
    fileName: string;
    bytes: Uint8Array;
  }): Promise<FlowchartOpenedProject> {
    this.#assertActive();
    const parsed = this.#importService.parse({ name: input.fileName, bytes: input.bytes });
    return this.create({
      patentId: input.patentId,
      expectedPatentRevision: input.expectedPatentRevision,
      name: parsed.name,
      source: parsed.source,
      pageCount: parsed.pageCount,
      lastPageId: parsed.lastPageId,
    });
  }

  async save(
    input: {
      patentId: string;
      projectId: string;
      expectedPatentRevision: number;
      expectedProjectRevision: number;
      source: Uint8Array;
      pageCount: number;
      lastPageId: string | null;
    },
    context: FlowchartCommitContext = {},
  ): Promise<FlowchartOpenedProject> {
    this.#assertActive();
    const existing = this.#sourceStore.loadCurrent(input.patentId, input.projectId);
    const committed = await this.#patentService.mutateFlowcharts({
      ...context,
      patentId: input.patentId,
      expectedRevision: input.expectedPatentRevision,
      mutation: (database) => {
        const snapshot = this.#sourceStore.appendRevisionInTransaction(database, {
          patentId: input.patentId,
          projectId: input.projectId,
          expectedProjectRevision: input.expectedProjectRevision,
          source: input.source,
          metadata: {
            name: existing.metadata.name,
            pageCount: input.pageCount,
            lastPageId: input.lastPageId,
          },
        });
        const changed = snapshot.sourceRevisionId !== existing.sourceRevisionId;
        return {
          changed,
          value: snapshot,
          retainedSources: changed
            ? [{ projectId: input.projectId, sourceRevisionId: snapshot.sourceRevisionId }]
            : [],
        };
      },
    });
    return {
      project: descriptor(committed.value),
      source: Uint8Array.from(committed.value.source),
      patentRevision: committed.patent.revision,
    };
  }

  async rename(
    input: {
      patentId: string;
      projectId: string;
      expectedPatentRevision: number;
      expectedProjectRevision: number;
      name: string;
    },
    context: FlowchartCommitContext = {},
  ): Promise<FlowchartOpenedProject> {
    this.#assertActive();
    const committed = await this.#patentService.mutateFlowcharts({
      ...context,
      patentId: input.patentId,
      expectedRevision: input.expectedPatentRevision,
      mutation: (database) => {
        const snapshot = this.#sourceStore.renameInTransaction(
          database,
          input.patentId,
          input.projectId,
          input.expectedProjectRevision,
          input.name,
        );
        return {
          changed: true,
          value: snapshot,
          retainedSources: [
            { projectId: input.projectId, sourceRevisionId: snapshot.sourceRevisionId },
          ],
        };
      },
    });
    return {
      project: descriptor(committed.value),
      source: Uint8Array.from(committed.value.source),
      patentRevision: committed.patent.revision,
    };
  }

  async duplicate(
    input: {
      patentId: string;
      projectId: string;
      expectedPatentRevision: number;
      name: string;
    },
    context: FlowchartCommitContext = {},
  ): Promise<FlowchartOpenedProject> {
    this.#assertActive();
    const original = this.#sourceStore.loadCurrent(input.patentId, input.projectId);
    return this.create(
      {
        patentId: input.patentId,
        expectedPatentRevision: input.expectedPatentRevision,
        name: input.name,
        source: original.source,
        pageCount: original.metadata.pageCount,
        lastPageId: original.metadata.lastPageId,
      },
      context,
    );
  }

  async delete(
    input: {
      patentId: string;
      projectId: string;
      expectedPatentRevision: number;
    },
    context: FlowchartCommitContext = {},
  ): Promise<{ patentRevision: number; detachedFigureCount: number }> {
    this.#assertActive();
    const current = this.#sourceStore.loadCurrent(input.patentId, input.projectId);
    const committed = await this.#patentService.mutateFlowcharts({
      ...context,
      patentId: input.patentId,
      expectedRevision: input.expectedPatentRevision,
      mutation: (database) => {
        const rows = database
          .prepare(
            "SELECT figure_id, flowchart_link FROM patent_figures WHERE patent_id = ? AND flowchart_link IS NOT NULL",
          )
          .all(input.patentId) as Array<{
          figure_id: string;
          flowchart_link: Uint8Array;
        }>;
        let detachedFigureCount = 0;
        for (const row of rows) {
          let link: z.infer<typeof FlowchartFigureLinkSchema>;
          try {
            link = FlowchartFigureLinkSchema.parse(decodeJson(decodeEnvelope(row.flowchart_link)));
          } catch {
            throw new LibraryServiceError("CORRUPT_FILE", "附图中的流程图关联数据已损坏。");
          }
          if (link.projectId !== input.projectId) continue;
          database
            .prepare(
              "UPDATE patent_figures SET flowchart_link = NULL WHERE patent_id = ? AND figure_id = ?",
            )
            .run(input.patentId, row.figure_id);
          detachedFigureCount += 1;
        }
        const deleted = database
          .prepare("DELETE FROM patent_flowcharts WHERE patent_id = ? AND project_id = ?")
          .run(input.patentId, input.projectId);
        if (deleted.changes !== 1) {
          throw new LibraryServiceError("NOT_FOUND", "流程图工程不存在。");
        }
        return {
          changed: true,
          value: detachedFigureCount,
          retainedSources: [
            { projectId: input.projectId, sourceRevisionId: current.sourceRevisionId },
          ],
        };
      },
    });
    return {
      patentRevision: committed.patent.revision,
      detachedFigureCount: committed.value,
    };
  }

  exportBackup(patentId: string, projectId: string): Uint8Array {
    this.#assertActive();
    return Uint8Array.from(this.#sourceStore.loadCurrent(patentId, projectId).source);
  }

  async renderPreview(input: {
    patentId: string;
    projectId: string;
    expectedProjectRevision: number;
    expectedSourceSha256: string;
    pageId: string;
    exportScope: "page" | "selection";
    selectedCellIds: string[];
    borderMm: number;
    outputWidthMm?: number | undefined;
    drawingPage?: PageSettings | undefined;
    rotationDeg?: ImageRotation | undefined;
    svg: string;
    target: FlowchartFigureTarget;
  }): Promise<Omit<FlowchartRenderPreview, "sanitizedSvg">> {
    this.#assertActive();
    const current = this.#sourceStore.loadCurrent(input.patentId, input.projectId);
    if (
      current.revision !== input.expectedProjectRevision ||
      current.sourceSha256 !== input.expectedSourceSha256
    ) {
      throw new LibraryServiceError("REVISION_CONFLICT", "源工程已发生变化，请重新生成预览。");
    }
    const patent = this.#patentService.loadSavedPatent(input.patentId);
    const target = input.target;
    const drawingPage =
      input.drawingPage ??
      patent.books.find((book) => book.kind === "description-drawings")?.document.page;
    const rotationDeg =
      input.rotationDeg ??
      (target.kind === "replace"
        ? patent.figures.find((figure) => figure.figureId === target.figureId)?.rotationDeg
        : 0) ??
      0;
    const rendered = await this.#renderService.render({
      patentId: input.patentId,
      project: descriptor(current),
      pageId: input.pageId,
      exportScope: input.exportScope,
      selectedCellIds: input.selectedCellIds,
      borderMm: input.borderMm,
      ...(input.outputWidthMm === undefined ? {} : { outputWidthMm: input.outputWidthMm }),
      ...(drawingPage === undefined ? {} : { drawingPage }),
      rotationDeg,
      svg: input.svg,
      target: input.target,
    });
    return {
      previewToken: rendered.previewToken,
      outputWidthMm: rendered.outputWidthMm,
      preview: rendered.preview,
      widthPx: rendered.widthPx,
      heightPx: rendered.heightPx,
      warnings: rendered.warnings,
    };
  }

  async commitPreview(input: {
    patentId: string;
    sessionId: string;
    expectedPatentRevision: number;
    projectId: string;
    previewToken: string;
  }) {
    this.#assertActive();
    if (
      !this.#assetStore?.stageMany ||
      !this.#assetStore.commitStaged ||
      !this.#assetStore.discardStaged
    ) {
      throw new LibraryServiceError("INTERNAL", "资源存储不支持流程图附图事务。");
    }
    const patent = await this.#patentService.loadForExport({
      patentId: input.patentId,
      sessionId: input.sessionId,
      expectedRevision: input.expectedPatentRevision,
    });
    const project = patent.flowchartProjects.find((item) => item.projectId === input.projectId);
    if (!project) throw new LibraryServiceError("NOT_FOUND", "流程图工程不存在。");
    const claimed = this.#renderService.claim(input.previewToken, { project });
    if (claimed.patentId !== input.patentId) {
      throw new LibraryServiceError("INVALID_INPUT", "预览不属于当前专利。");
    }
    let stagedAssetIds: string[] = [];
    try {
      const staged = await this.#assetStore.stageMany(input.sessionId, [claimed.asset]);
      const imported = staged[0];
      if (!imported) throw new LibraryServiceError("INTERNAL", "流程图附图暂存失败。");
      stagedAssetIds = [imported.descriptor.assetId];
      const figures = patent.figures.map((figure) => structuredClone(figure));
      const target = claimed.target;
      if (target.kind === "new") {
        if (target.insertIndex > figures.length) {
          throw new LibraryServiceError("REVISION_CONFLICT", "附图插入位置已发生变化。");
        }
        figures.splice(target.insertIndex, 0, {
          figureId: this.#randomUUID(),
          assetId: imported.descriptor.assetId,
          widthMm: claimed.outputWidthMm,
          flowchartLink: claimed.link,
        });
      } else {
        const index = figures.findIndex((figure) => figure.figureId === target.figureId);
        const existing = figures[index];
        if (!existing || existing.assetId !== target.assetId) {
          throw new LibraryServiceError("REVISION_CONFLICT", "目标附图已发生变化。");
        }
        figures[index] = {
          ...existing,
          assetId: imported.descriptor.assetId,
          widthMm: claimed.outputWidthMm,
          flowchartLink: claimed.link,
        };
      }
      const referencedFigureAssetIds = new Set(figures.map((figure) => figure.assetId));
      const replacedAssetId = target.kind === "replace" ? target.assetId : undefined;
      const assets = [
        ...patent.assets.filter(
          (asset) =>
            asset.assetId !== imported.descriptor.assetId &&
            (asset.assetId !== replacedAssetId || referencedFigureAssetIds.has(asset.assetId)),
        ),
        imported.descriptor,
      ];
      const acknowledgement = await this.#patentService.applyFigureEdit({
        patentId: input.patentId,
        sessionId: input.sessionId,
        expectedRevision: input.expectedPatentRevision,
        figures: fitInsertedFigures(patent, figures, assets),
        abstractDrawingFigureId: patent.abstractDrawingFigureId,
        assets,
      });
      await this.#assetStore.commitStaged(input.sessionId, stagedAssetIds);
      return {
        patent: await this.#patentService.loadForExport({
          patentId: input.patentId,
          sessionId: input.sessionId,
          expectedRevision: acknowledgement.revision,
        }),
        savedAt: acknowledgement.savedAt,
      };
    } catch (error) {
      await this.#assetStore.discardStaged(input.sessionId, stagedAssetIds).catch(() => undefined);
      throw error;
    }
  }

  #patentRevision(patentId: string): number {
    const row = this.#database.read((database) =>
      database
        .prepare("SELECT revision FROM patents WHERE patent_id = ? AND deleted_at IS NULL")
        .get(patentId),
    ) as { revision: number } | undefined;
    if (row === undefined) throw new LibraryServiceError("NOT_FOUND", "专利不存在。");
    return row.revision;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Flowchart service is disposed");
  }
}
