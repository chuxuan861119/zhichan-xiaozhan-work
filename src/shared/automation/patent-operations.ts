import { z } from "zod";
import { createBlankBookDocument } from "../document/defaults.js";
import {
  BlockNodeSchema,
  ImageRotationSchema,
  MAX_DOCUMENT_NODES,
  PageSettingsSchema,
} from "../document/model.js";
import { FlowchartFigureLinkSchema } from "../flowcharts/model.js";
import { randomUuid } from "../id.js";
import { moveAuxiliaryDocument, uniqueAuxiliaryTitle } from "../patent/auxiliary-management.js";
import { planDisableDrawingBooks, planEnableDrawingBooks } from "../patent/drawing-books.js";
import { reorderFigures } from "../patent/figures.js";
import {
  type CanonicalPatent,
  MAX_PATENT_FIGURE_WIDTH_MM,
  MIN_PATENT_FIGURE_WIDTH_MM,
  PatentTypeSchema,
} from "../patent/model.js";
import {
  planAssignReferenceNumber,
  planCancelReferenceMark,
  planCompleteReferenceMarkReview,
  planFillReferenceMarksIntoDescription,
  planRemoveReferenceMarkRegistration,
  planReorderReferenceMarks,
  planSetReferenceMarkSync,
  planSupplementClaimsReferenceNumbers,
  planSupplementDescriptionReferenceNumbers,
  planUpdateReferenceMark,
  type ReferenceMarkPlanResult,
} from "../patent/reference-mark-operations.js";
import { PatentReferenceMarkSchema } from "../patent/reference-marks.js";

import {
  applyDrawingOperation,
  DRAWING_OPERATIONS,
  DrawingOperationSchema,
  DrawingOperationSchemas,
} from "./drawings.js";

const uuid = z.string().uuid();
const content = z.array(BlockNodeSchema).max(MAX_DOCUMENT_NODES);
const title = z.string().trim().min(1).max(200);
export const PatentOperationSchemas = [
  ...DrawingOperationSchemas,
  z
    .object({
      type: z.literal("attachFlowchartFigure"),
      assetId: uuid,
      link: FlowchartFigureLinkSchema,
      widthMm: z.number().min(10).max(165),
      replaceFigureId: uuid.optional(),
    })
    .strict(),
  z.object({ type: z.literal("setPatentType"), patentType: PatentTypeSchema }).strict(),
  z.object({ type: z.literal("setDrawingBooksEnabled"), enabled: z.boolean() }).strict(),
  z
    .object({
      type: z.literal("createAuxiliary"),
      title,
      content,
      page: PageSettingsSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("editAuxiliary"),
      auxiliaryDocumentId: uuid,
      content,
      page: PageSettingsSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("renameAuxiliary"), auxiliaryDocumentId: uuid, title }).strict(),
  z
    .object({
      type: z.literal("moveAuxiliary"),
      auxiliaryDocumentId: uuid,
      direction: z.enum(["up", "down"]),
    })
    .strict(),
  z.object({ type: z.literal("deleteAuxiliary"), auxiliaryDocumentId: uuid }).strict(),
  z
    .object({
      type: z.literal("moveFigure"),
      figureId: uuid,
      targetIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ type: z.literal("deleteFigure"), figureId: uuid }).strict(),
  z
    .object({
      type: z.literal("resizeFigure"),
      figureId: uuid,
      widthMm: z.number().min(MIN_PATENT_FIGURE_WIDTH_MM).max(MAX_PATENT_FIGURE_WIDTH_MM),
    })
    .strict(),
  z
    .object({ type: z.literal("rotateFigure"), figureId: uuid, rotationDeg: ImageRotationSchema })
    .strict(),
  z
    .object({
      type: z.literal("assignReferenceMark"),
      keyword: PatentReferenceMarkSchema.shape.keyword,
      number: PatentReferenceMarkSchema.shape.number.optional(),
      interruptedKeywordDecision: z.enum(["keep", "repair"]).optional(),
      bodyNumberConflictDecision: z.literal("use-anyway").optional(),
    })
    .strict(),
  z.object({ type: z.literal("updateReferenceMark"), ...PatentReferenceMarkSchema.shape }).strict(),
  z.object({ type: z.literal("cancelReferenceMark"), referenceMarkId: uuid }).strict(),
  z
    .object({
      type: z.literal("completeReferenceMarkReview"),
      referenceMarkId: uuid,
      acceptCurrentDocument: z.boolean().default(false),
    })
    .strict(),
  z.object({ type: z.literal("setReferenceMarkSync"), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("removeReferenceMark"), referenceMarkId: uuid }).strict(),
  z.object({ type: z.literal("reorderReferenceMarks"), ids: z.array(uuid).max(10000) }).strict(),
  z.object({ type: z.literal("fillReferenceMarks") }).strict(),
  z
    .object({
      type: z.literal("supplementReferenceNumbers"),
      bookKind: z.enum(["claims", "description"]),
      referenceMarkId: uuid.optional(),
    })
    .strict(),
] as const;
export const PatentOperationSchema = z.discriminatedUnion("type", PatentOperationSchemas);
export type PatentOperation = z.infer<typeof PatentOperationSchema>;
export const PATENT_SETTINGS_OPERATIONS = new Set<string>([
  "setPatentType",
  "setDrawingBooksEnabled",
  "assignReferenceMark",
  "updateReferenceMark",
  "cancelReferenceMark",
  "completeReferenceMarkReview",
  "setReferenceMarkSync",
  "removeReferenceMark",
  "reorderReferenceMarks",
  "fillReferenceMarks",
  "supplementReferenceNumbers",
]);
export const AUXILIARY_OPERATIONS = new Set<string>([
  "createAuxiliary",
  "editAuxiliary",
  "renameAuxiliary",
  "moveAuxiliary",
  "deleteAuxiliary",
]);

export function applyPatentOperation(patent: CanonicalPatent, operation: PatentOperation): void {
  if (DRAWING_OPERATIONS.has(operation.type)) {
    applyDrawingOperation(patent, DrawingOperationSchema.parse(operation));
    return;
  }
  if (operation.type === "attachFlowchartFigure") {
    if (!patent.drawingBooksEnabled) throw new Error("Drawing books are disabled.");
    const asset = patent.assets.find((item) => item.assetId === operation.assetId);
    const project = patent.flowchartProjects.find(
      (item) => item.projectId === operation.link.projectId,
    );
    if (!asset || asset.kind !== "flowchart-preview")
      throw new Error("Flowchart asset is unavailable.");
    if (
      !project ||
      project.revision !== operation.link.exportedProjectRevision ||
      project.sourceSha256 !== operation.link.exportedSourceSha256
    )
      throw new Error("Flowchart source has changed; render it again.");
    const existing = operation.replaceFigureId
      ? patent.figures.find((item) => item.figureId === operation.replaceFigureId)
      : undefined;
    if (operation.replaceFigureId && !existing) throw new Error("Target figure is unavailable.");
    const figure = {
      figureId: existing?.figureId ?? randomUuid(),
      assetId: operation.assetId,
      widthMm: operation.widthMm,
      flowchartLink: structuredClone(operation.link),
    };
    if (existing) Object.assign(existing, figure);
    else patent.figures.push(figure);
    return;
  }
  const dependencies = { now: () => new Date(), createId: randomUuid };
  const assignPlan = (result: ReferenceMarkPlanResult) => {
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    Object.assign(patent, result.plan.after);
  };
  const toggleDrawings = (enabled: boolean) => {
    if (patent.drawingBooksEnabled === enabled) return;
    const books = patent.books;
    const changed = enabled
      ? planEnableDrawingBooks(patent, dependencies)
      : planDisableDrawingBooks(patent, dependencies).patent;
    // GUI helpers create fresh empty books. CLI transactions preserve saved book identities.
    changed.books = changed.books.map((book) => {
      const original = books.find((item) => item.kind === book.kind)!;
      return {
        ...book,
        bookId: original.bookId,
        document: {
          ...book.document,
          documentId: original.document.documentId,
          createdAt: original.document.createdAt,
        },
      };
    });
    Object.assign(patent, changed);
  };
  switch (operation.type) {
    case "setPatentType":
      if (operation.patentType === "utility-model") toggleDrawings(true);
      patent.patentType = operation.patentType;
      return;
    case "setDrawingBooksEnabled":
      toggleDrawings(operation.enabled);
      return;
    case "createAuxiliary": {
      const name = uniqueAuxiliaryTitle(
        operation.title,
        patent.auxiliaryDocuments.map((document) => document.title),
      );
      const document = createBlankBookDocument(name);
      document.content = structuredClone(operation.content);
      if (operation.page) document.page = structuredClone(operation.page);
      patent.auxiliaryDocuments.push({
        auxiliaryDocumentId: randomUuid(),
        title: name,
        document,
        editorState: {},
        localRevision: patent.revision,
        persistedRevision: patent.revision,
        sourceFileName: null,
      });
      return;
    }
    case "editAuxiliary":
    case "renameAuxiliary":
    case "moveAuxiliary":
    case "deleteAuxiliary": {
      const document = patent.auxiliaryDocuments.find(
        (entry) => entry.auxiliaryDocumentId === operation.auxiliaryDocumentId,
      );
      if (!document) throw new Error("Auxiliary document is unavailable.");
      if (operation.type === "deleteAuxiliary")
        patent.auxiliaryDocuments = patent.auxiliaryDocuments.filter((entry) => entry !== document);
      else if (operation.type === "moveAuxiliary")
        patent.auxiliaryDocuments = moveAuxiliaryDocument(
          patent.auxiliaryDocuments,
          operation.auxiliaryDocumentId,
          operation.direction,
        );
      else if (operation.type === "renameAuxiliary") {
        if (
          patent.auxiliaryDocuments.some(
            (entry) => entry !== document && entry.title === operation.title,
          )
        )
          throw new Error("Auxiliary title is already in use.");
        document.title = operation.title;
        document.document.title = operation.title;
      } else {
        document.document.content = structuredClone(operation.content);
        if (operation.page) document.document.page = structuredClone(operation.page);
      }
      return;
    }
    case "moveFigure":
    case "deleteFigure":
    case "resizeFigure":
    case "rotateFigure": {
      const figure = patent.figures.find((entry) => entry.figureId === operation.figureId);
      if (!figure) throw new Error("Figure is unavailable.");
      if (operation.type === "moveFigure") {
        if (operation.targetIndex >= patent.figures.length)
          throw new Error("Figure position is out of range.");
        patent.figures = reorderFigures(patent.figures, figure.figureId, operation.targetIndex);
      } else if (operation.type === "deleteFigure") {
        patent.figures = patent.figures.filter((entry) => entry !== figure);
        if (patent.abstractDrawingFigureId === figure.figureId)
          patent.abstractDrawingFigureId = null;
      } else if (operation.type === "resizeFigure") figure.widthMm = operation.widthMm;
      else figure.rotationDeg = operation.rotationDeg;
      // Visible description text is independent, matching the GUI's current figure behavior.
      return;
    }
    case "assignReferenceMark":
      assignPlan(
        planAssignReferenceNumber(patent, operation.keyword, dependencies, operation.number, {
          ...(operation.interruptedKeywordDecision
            ? { interruptedKeywordDecision: operation.interruptedKeywordDecision }
            : {}),
          ...(operation.bodyNumberConflictDecision
            ? { bodyNumberConflictDecision: operation.bodyNumberConflictDecision }
            : {}),
        }),
      );
      return;
    case "updateReferenceMark":
      assignPlan(planUpdateReferenceMark(patent, operation));
      return;
    case "cancelReferenceMark":
      assignPlan(planCancelReferenceMark(patent, operation.referenceMarkId));
      return;
    case "completeReferenceMarkReview":
      assignPlan(
        planCompleteReferenceMarkReview(patent, operation.referenceMarkId, {
          acceptCurrentDocument: operation.acceptCurrentDocument,
        }),
      );
      return;
    case "setReferenceMarkSync":
      assignPlan(planSetReferenceMarkSync(patent, operation.enabled));
      return;
    case "removeReferenceMark":
      assignPlan(planRemoveReferenceMarkRegistration(patent, operation.referenceMarkId));
      return;
    case "reorderReferenceMarks":
      assignPlan(planReorderReferenceMarks(patent, operation.ids));
      return;
    case "fillReferenceMarks":
      assignPlan(planFillReferenceMarksIntoDescription(patent));
      return;
    case "supplementReferenceNumbers":
      assignPlan(
        operation.bookKind === "claims"
          ? planSupplementClaimsReferenceNumbers(patent, operation.referenceMarkId)
          : planSupplementDescriptionReferenceNumbers(patent),
      );
      return;
  }
}
