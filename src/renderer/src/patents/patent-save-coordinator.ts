import type { AssetDescriptor, PatentBookDocument } from "../../../shared/document/model";
import {
  applyDrawingProjectEdits,
  type DrawingProjectEdits,
} from "../../../shared/drawing-markup/project-edits";
import type {
  FlowchartOpenedProject,
  FlowchartSaveRequest,
  PatentApplyAuxiliaryDocumentEditRequest,
  PatentApplyBookEditRequest,
  PatentApplyFigureEditRequest,
  PatentEditAck,
  PatentFlushRequest,
  PatentFlushResult,
  PatentUpdateDesignPatentRequest,
  PatentUpdateSettingsRequest,
} from "../../../shared/ipc/contract";
import type { JsonObject } from "../../../shared/ipc/primitives";
import type { AppError, AppResult } from "../../../shared/ipc/result";
import type { LibrarySaveState } from "../../../shared/library/model";
import { normalizeDrawingBooks } from "../../../shared/patent/drawing-content";
import type { DesignPatent } from "../../../shared/patent/design-patent";
import {
  type CanonicalPatent,
  PATENT_BOOK_ORDER,
  type PatentBookKind,
  type PatentFigure,
} from "../../../shared/patent/model";
import { inheritDocumentEcho } from "../editor/content-fingerprint";

type QueueCallbacks = {
  onQueued?(snapshot: PatentSaveCoordinatorSnapshot): void;
  onConfirmed?(snapshot: PatentSaveCoordinatorSnapshot): void;
  onAutoTitlePersisted?(snapshot: PatentSaveCoordinatorSnapshot): void;
  onFailed?(snapshot: PatentSaveCoordinatorSnapshot): void;
  onRetrying?(snapshot: PatentSaveCoordinatorSnapshot): void;
  onMutationConfirmed?(snapshot: PatentSaveCoordinatorSnapshot): void;
};

export type PatentSaveCoordinatorSnapshot = {
  patentId: string;
  sessionId: string;
  patent: CanonicalPatent;
  bookSaveStates: Record<PatentBookKind, LibrarySaveState>;
  auxiliarySaveStates?: Record<string, LibrarySaveState>;
  aggregateSaveState: LibrarySaveState;
  localRevision: number;
  persistedRevision: number;
  lastSavedAt: string | null;
  saveError: AppError | null;
  revisionStateRebased?: boolean;
};

type PatentSaveCoordinatorOptions = QueueCallbacks & {
  patentId: string;
  sessionId: string;
  initialPatent: CanonicalPatent;
  applyBookEdit(request: PatentApplyBookEditRequest): Promise<AppResult<PatentEditAck>>;
  applyAuxiliaryDocumentEdit(
    request: PatentApplyAuxiliaryDocumentEditRequest,
  ): Promise<AppResult<PatentEditAck>>;
  applyFigureEdit(request: PatentApplyFigureEditRequest): Promise<AppResult<PatentEditAck>>;
  updateSettings(request: PatentUpdateSettingsRequest): Promise<AppResult<PatentEditAck>>;
  updateDesignPatent?: (
    request: PatentUpdateDesignPatentRequest,
  ) => Promise<AppResult<PatentEditAck>>;
  flush(request: PatentFlushRequest): Promise<AppResult<PatentFlushResult>>;
  saveFlowchart?(request: FlowchartSaveRequest): Promise<AppResult<FlowchartOpenedProject>>;
};

type PendingBookEdit = {
  type: "book";
  coalescible: boolean;
  bookKind: PatentBookKind;
  document: PatentBookDocument;
  editorState: JsonObject;
  assets: AssetDescriptor[];
  localRevision: number;
};

type PendingFigureEdit = {
  type: "figures";
  baseFigures: PatentFigure[];
  baseAbstractDrawingFigureId: string | null;
  figures: PatentFigure[];
  abstractDrawingFigureId: string | null;
  assets: CanonicalPatent["assets"];
  drawingProjects?: CanonicalPatent["drawingProjects"];
  drawingProjectEdits?: DrawingProjectEdits;
  localRevision: number;
};

type PendingAuxiliaryDocumentEdit = {
  type: "auxiliary-document";
  auxiliaryDocumentId: string;
  document: PatentBookDocument;
  editorState: JsonObject;
  assets: AssetDescriptor[];
  localRevision: number;
};

type PendingSettingsEdit = {
  type: "settings";
  basePatentType: CanonicalPatent["patentType"];
  name?: CanonicalPatent["name"];
  autoTitleRecognition?: boolean;
  customer?: CanonicalPatent["customer"];
  patentType: CanonicalPatent["patentType"];
  assets?: CanonicalPatent["assets"];
  bookEdits: NonNullable<PatentUpdateSettingsRequest["bookEdits"]>;
  bookLocalRevisions: Partial<Record<PatentBookKind, number>>;
  referenceMarks?: CanonicalPatent["referenceMarks"];
  referenceMarkSettings?: CanonicalPatent["referenceMarkSettings"];
  localRevision: number;
};

type PendingDesignPatentEdit = {
  type: "design-patent";
  designPatent: DesignPatent;
  assets: CanonicalPatent["assets"];
  localRevision: number;
};

type PendingFlowchartEdit = {
  type: "flowchart-source";
  projectId: string;
  expectedProjectRevision: number;
  source: Uint8Array;
  pageCount: number;
  lastPageId: string | null;
  localRevision: number;
};

type PersistedMutation = { patent: CanonicalPatent; savedAt: string };

type PendingPersistedMutation = {
  type: "persisted-mutation";
  run(expectedRevision: number): Promise<AppResult<PersistedMutation | null>>;
  complete(): void;
  fail(error: AppError): void;
  localRevision: number;
};

type PendingEdit =
  | PendingBookEdit
  | PendingAuxiliaryDocumentEdit
  | PendingFigureEdit
  | PendingSettingsEdit
  | PendingFlowchartEdit
  | PendingDesignPatentEdit
  | PendingPersistedMutation;

type DrainWaiter = {
  resolve(): void;
  reject(error: AppError): void;
};

function internalError(): AppError {
  return { code: "INTERNAL", message: "专利保存队列失败。" };
}

function toAppError(error: unknown): AppError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    const typed = error as AppError;
    return { code: typed.code, message: typed.message, nextAction: typed.nextAction };
  }
  return internalError();
}

function rebaseFigures(
  base: PatentFigure[],
  requested: PatentFigure[],
  persisted: PatentFigure[],
): PatentFigure[] {
  const baseById = new Map(base.map((figure) => [figure.figureId, figure]));
  const requestedById = new Map(requested.map((figure) => [figure.figureId, figure]));
  const merged = new Map<string, PatentFigure>();
  for (const remote of persisted) {
    const before = baseById.get(remote.figureId);
    const after = requestedById.get(remote.figureId);
    if (before && !after) continue;
    const figure = { ...remote };
    if (before && after) {
      for (const key of ["assetId", "widthMm", "rotationDeg", "flowchartLink"] as const) {
        if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
        Object.assign(figure, { [key]: after[key] });
        if (after[key] === undefined) delete figure[key];
      }
    }
    merged.set(figure.figureId, figure);
  }
  for (const figure of requested) {
    if (!baseById.has(figure.figureId)) merged.set(figure.figureId, figure);
  }
  const retainedBase = base.filter((figure) => merged.has(figure.figureId));
  const localOrderChanged =
    JSON.stringify(requested.map((figure) => figure.figureId)) !==
    JSON.stringify(retainedBase.map((figure) => figure.figureId));
  if (!localOrderChanged) return [...merged.values()];

  const ordered = requested.flatMap((figure) => {
    const value = merged.get(figure.figureId);
    return value ? [value] : [];
  });
  // Keep unseen inserted figures beside their persisted neighbours even when
  // the user reordered/removed other figures while the reply was in flight.
  for (let index = 0; index < persisted.length; index += 1) {
    const figure = persisted[index];
    if (!figure || baseById.has(figure.figureId) || requestedById.has(figure.figureId)) continue;
    const nextIds = new Set(persisted.slice(index + 1).map((candidate) => candidate.figureId));
    const nextIndex = ordered.findIndex((candidate) => nextIds.has(candidate.figureId));
    ordered.splice(nextIndex < 0 ? ordered.length : nextIndex, 0, figure);
  }
  return ordered;
}

export class PatentSaveCoordinator {
  readonly patentId: string;
  readonly sessionId: string;

  #patent: CanonicalPatent;
  #bookSaveStates: Record<PatentBookKind, LibrarySaveState>;
  #auxiliarySaveStates: Record<string, LibrarySaveState>;
  #localRevision: number;
  #persistedRevision: number;
  #aggregateSaveState: LibrarySaveState = "saved";
  #lastSavedAt: string | null = null;
  #saveError: AppError | null = null;
  #running = false;
  #disposed = false;
  #freezeToken: string | null = null;
  readonly #applyBookEdit: PatentSaveCoordinatorOptions["applyBookEdit"];
  readonly #applyAuxiliaryDocumentEdit: PatentSaveCoordinatorOptions["applyAuxiliaryDocumentEdit"];
  readonly #applyFigureEdit: PatentSaveCoordinatorOptions["applyFigureEdit"];
  readonly #updateSettings: PatentSaveCoordinatorOptions["updateSettings"];
  readonly #updateDesignPatent: PatentSaveCoordinatorOptions["updateDesignPatent"];
  readonly #flush: PatentSaveCoordinatorOptions["flush"];
  readonly #saveFlowchart: PatentSaveCoordinatorOptions["saveFlowchart"];
  readonly #callbacks: QueueCallbacks;
  readonly #pending: PendingEdit[] = [];
  readonly #waiters: DrainWaiter[] = [];

  constructor(options: PatentSaveCoordinatorOptions) {
    this.patentId = options.patentId;
    this.sessionId = options.sessionId;
    this.#patent = structuredClone(options.initialPatent);
    this.#localRevision = options.initialPatent.revision;
    this.#persistedRevision = options.initialPatent.revision;
    this.#bookSaveStates = Object.fromEntries(
      PATENT_BOOK_ORDER.map((kind) => [kind, "saved"]),
    ) as Record<PatentBookKind, LibrarySaveState>;
    this.#auxiliarySaveStates = Object.fromEntries(
      options.initialPatent.auxiliaryDocuments.map((document) => [
        document.auxiliaryDocumentId,
        "saved",
      ]),
    );
    this.#applyBookEdit = options.applyBookEdit;
    this.#applyAuxiliaryDocumentEdit = options.applyAuxiliaryDocumentEdit;
    this.#applyFigureEdit = options.applyFigureEdit;
    this.#updateSettings = options.updateSettings;
    this.#updateDesignPatent = options.updateDesignPatent;
    this.#flush = options.flush;
    this.#saveFlowchart = options.saveFlowchart;
    const callbacks: QueueCallbacks = {};
    if (options.onQueued) callbacks.onQueued = options.onQueued;
    if (options.onConfirmed) callbacks.onConfirmed = options.onConfirmed;
    if (options.onAutoTitlePersisted) callbacks.onAutoTitlePersisted = options.onAutoTitlePersisted;
    if (options.onFailed) callbacks.onFailed = options.onFailed;
    if (options.onRetrying) callbacks.onRetrying = options.onRetrying;
    if (options.onMutationConfirmed) callbacks.onMutationConfirmed = options.onMutationConfirmed;
    this.#callbacks = callbacks;
  }

  snapshot(): PatentSaveCoordinatorSnapshot {
    return {
      patentId: this.patentId,
      sessionId: this.sessionId,
      patent: this.#patent,
      bookSaveStates: this.#bookSaveStates,
      auxiliarySaveStates: this.#auxiliarySaveStates,
      aggregateSaveState: this.#aggregateSaveState,
      localRevision: this.#localRevision,
      persistedRevision: this.#persistedRevision,
      lastSavedAt: this.#lastSavedAt,
      saveError: this.#saveError,
    };
  }

  automationStatus(): { frozen: boolean; pending: boolean; dirty: boolean } {
    return {
      frozen: this.#freezeToken !== null,
      pending: this.#running || this.#pending.length > 0,
      dirty:
        this.#running ||
        this.#pending.length > 0 ||
        this.#localRevision !== this.#persistedRevision ||
        this.#saveError !== null,
    };
  }

  freeze(token: string): boolean {
    if (this.#freezeToken !== null && this.#freezeToken !== token) return false;
    this.#freezeToken = token;
    return true;
  }

  releaseFreeze(token: string): boolean {
    if (this.#freezeToken !== token) return false;
    this.#freezeToken = null;
    return true;
  }

  #assertEditable(): void {
    if (this.#freezeToken !== null) throw new Error("本地 agent 正在同步专利，请稍后再编辑。");
  }

  enqueueAuxiliaryDocumentEdit(
    auxiliaryDocumentId: string,
    documentInput: PatentBookDocument,
    editorStateInput: JsonObject = {},
    assetsInput: readonly AssetDescriptor[] = this.#patent.assets,
  ): PatentSaveCoordinatorSnapshot {
    this.#assertEditable();
    const current = this.#patent.auxiliaryDocuments.find(
      (document) => document.auxiliaryDocumentId === auxiliaryDocumentId,
    );
    if (!current) return this.snapshot();

    const document = structuredClone(documentInput);
    inheritDocumentEcho(documentInput, document);
    const editorState = structuredClone(editorStateInput);
    const assets = Array.from(assetsInput, (asset) => structuredClone(asset));
    if (
      JSON.stringify(current.document) === JSON.stringify(document) &&
      JSON.stringify(current.editorState) === JSON.stringify(editorState) &&
      JSON.stringify(this.#patent.assets) === JSON.stringify(assets)
    ) {
      return this.snapshot();
    }

    const firstReplaceableIndex = this.#running ? 1 : 0;
    let replaceIndex = -1;
    for (let index = this.#pending.length - 1; index >= firstReplaceableIndex; index -= 1) {
      const pending = this.#pending[index];
      if (
        pending?.type === "auxiliary-document" &&
        pending.auxiliaryDocumentId === auxiliaryDocumentId
      ) {
        replaceIndex = index;
        break;
      }
    }
    const localRevision =
      replaceIndex >= 0
        ? (this.#pending[replaceIndex] as PendingAuxiliaryDocumentEdit).localRevision
        : this.#localRevision + 1;
    if (replaceIndex < 0) this.#localRevision = localRevision;
    this.#patent = {
      ...this.#patent,
      auxiliaryDocuments: this.#patent.auxiliaryDocuments.map((candidate) =>
        candidate.auxiliaryDocumentId === auxiliaryDocumentId
          ? { ...candidate, document, editorState, localRevision }
          : candidate,
      ),
      assets,
      revision: this.#localRevision,
    };
    const pendingEdit: PendingAuxiliaryDocumentEdit = {
      type: "auxiliary-document",
      auxiliaryDocumentId,
      document,
      editorState,
      assets,
      localRevision,
    };
    if (replaceIndex >= 0) this.#pending[replaceIndex] = pendingEdit;
    else this.#pending.push(pendingEdit);
    this.#auxiliarySaveStates = {
      ...this.#auxiliarySaveStates,
      [auxiliaryDocumentId]: "saving",
    };
    this.#aggregateSaveState = this.#saveError ? "failed" : "saving";
    this.#emit("onQueued");
    this.#startPump();
    return this.snapshot();
  }

  enqueueBookEdit(
    bookKind: PatentBookKind,
    documentInput: PatentBookDocument,
    editorState: JsonObject = {},
    assetsInput: readonly AssetDescriptor[] = this.#patent.assets,
  ): PatentSaveCoordinatorSnapshot {
    return this.#enqueueBookEdits(
      [{ bookKind, document: documentInput, editorState, assets: assetsInput }],
      true,
    );
  }

  enqueueTransaction(
    edits: readonly {
      bookKind: PatentBookKind;
      document: PatentBookDocument;
      editorState: JsonObject;
      assets?: readonly AssetDescriptor[];
    }[],
  ): PatentSaveCoordinatorSnapshot {
    return this.#enqueueBookEdits(edits, false);
  }

  #enqueueBookEdits(
    edits: Parameters<PatentSaveCoordinator["enqueueTransaction"]>[0],
    coalescible: boolean,
  ): PatentSaveCoordinatorSnapshot {
    this.#assertEditable();
    for (const edit of edits) {
      const currentBook = this.#patent.books.find((book) => book.kind === edit.bookKind);
      if (!currentBook) continue;

      const document = structuredClone(edit.document);
      inheritDocumentEcho(edit.document, document);
      const editorState = structuredClone(edit.editorState);
      const assets = Array.from(edit.assets ?? this.#patent.assets, (asset) =>
        structuredClone(asset),
      );
      if (
        // A changed timestamp already proves inequality. Avoid two full JSON
        // serializations on the ordinary typing path; same-tick edits still compare fully.
        currentBook.document.modifiedAt === document.modifiedAt &&
        JSON.stringify(currentBook.document) === JSON.stringify(document) &&
        JSON.stringify(currentBook.editorState) === JSON.stringify(editorState) &&
        JSON.stringify(this.#patent.assets) === JSON.stringify(assets)
      ) {
        continue;
      }

      const localRevision = currentBook.localRevision + 1;
      const tail = this.#pending.at(-1);
      const replaceTail =
        coalescible && tail?.type === "book" && tail.coalescible && tail.bookKind === edit.bookKind;
      // Aggregate revisions count writes; book revisions count user edits.
      // Do not cross a different book or a semantic transaction boundary.
      if (!replaceTail) this.#localRevision += 1;
      this.#patent = {
        ...updateBook(this.#patent, edit.bookKind, (book) => ({
          ...book,
          document,
          editorState,
          localRevision,
        })),
        assets,
        revision: this.#localRevision,
      };
      this.#bookSaveStates = { ...this.#bookSaveStates, [edit.bookKind]: "saving" };
      const pending: PendingBookEdit = {
        type: "book",
        coalescible,
        bookKind: edit.bookKind,
        document,
        editorState,
        assets,
        localRevision,
      };
      if (replaceTail) this.#pending[this.#pending.length - 1] = pending;
      else this.#pending.push(pending);
    }

    if (this.#pending.length > 0 || this.#localRevision > this.#persistedRevision) {
      this.#aggregateSaveState = this.#saveError ? "failed" : "saving";
      this.#emit("onQueued");
      this.#startPump();
    }

    return this.snapshot();
  }

  enqueueFigureEdit(input: {
    figures: PatentFigure[];
    abstractDrawingFigureId: string | null;
    assets: CanonicalPatent["assets"];
    drawingProjects?: CanonicalPatent["drawingProjects"];
    drawingProjectEdits?: DrawingProjectEdits;
  }): PatentSaveCoordinatorSnapshot {
    this.#assertEditable();
    if (input.drawingProjects !== undefined && input.drawingProjectEdits !== undefined)
      throw new Error("不能同时提交完整图纸和图纸编辑。");
    const edit =
      input.drawingProjectEdits === undefined
        ? undefined
        : structuredClone(input.drawingProjectEdits);
    const drawings = edit
      ? applyDrawingProjectEdits(this.#patent.drawingProjects, edit)
      : input.drawingProjects === undefined
        ? this.#patent.drawingProjects
        : structuredClone(input.drawingProjects);
    const drawingsUnchanged = edit
      ? drawings.length === this.#patent.drawingProjects.length &&
        drawings.every(
          (project, i) =>
            project.projectId === this.#patent.drawingProjects[i]?.projectId &&
            (project === this.#patent.drawingProjects[i] ||
              JSON.stringify(project) === JSON.stringify(this.#patent.drawingProjects[i])),
        )
      : input.drawingProjects === undefined ||
        JSON.stringify(this.#patent.drawingProjects) === JSON.stringify(drawings);
    const figures = structuredClone(input.figures);
    const assets = structuredClone(input.assets);
    const abstractDrawingFigureId = input.abstractDrawingFigureId;
    if (
      JSON.stringify(this.#patent.figures) === JSON.stringify(figures) &&
      this.#patent.abstractDrawingFigureId === abstractDrawingFigureId &&
      JSON.stringify(this.#patent.assets) === JSON.stringify(assets) &&
      drawingsUnchanged
    ) {
      return this.snapshot();
    }

    const baseFigures = this.#patent.figures;
    const baseAbstractDrawingFigureId = this.#patent.abstractDrawingFigureId;
    const books = normalizeDrawingBooks(this.#patent);
    this.#localRevision += 1;
    const localRevision = this.#localRevision;
    this.#patent = {
      ...this.#patent,
      figures,
      books,
      abstractDrawingFigureId,
      assets,
      drawingProjects: drawings,
      revision: localRevision,
    };
    this.#pending.push({
      type: "figures",
      baseFigures,
      baseAbstractDrawingFigureId,
      figures,
      abstractDrawingFigureId,
      assets,
      ...(edit
        ? { drawingProjectEdits: edit }
        : input.drawingProjects === undefined
          ? {}
          : { drawingProjects: drawings }),
      localRevision,
    });
    this.#aggregateSaveState = this.#saveError ? "failed" : "saving";
    this.#emit("onQueued");
    this.#startPump();
    return this.snapshot();
  }

  enqueueFlowchartSource(input: {
    projectId: string;
    expectedProjectRevision: number;
    source: Uint8Array;
    pageCount: number;
    lastPageId: string | null;
  }): PatentSaveCoordinatorSnapshot {
    this.#assertEditable();
    this.#localRevision += 1;
    this.#patent = { ...this.#patent, revision: this.#localRevision };
    this.#pending.push({
      type: "flowchart-source",
      projectId: input.projectId,
      expectedProjectRevision: input.expectedProjectRevision,
      source: Uint8Array.from(input.source),
      pageCount: input.pageCount,
      lastPageId: input.lastPageId,
      localRevision: this.#localRevision,
    });
    this.#aggregateSaveState = this.#saveError ? "failed" : "saving";
    this.#emit("onQueued");
    this.#startPump();
    return this.snapshot();
  }

  enqueueSettings(input: {
    name?: CanonicalPatent["name"];
    autoTitleRecognition?: boolean;
    customer?: CanonicalPatent["customer"];
    patentType: CanonicalPatent["patentType"];
    assets?: CanonicalPatent["assets"];
    bookEdits?: NonNullable<PatentUpdateSettingsRequest["bookEdits"]>;
    referenceMarks?: CanonicalPatent["referenceMarks"];
    referenceMarkSettings?: CanonicalPatent["referenceMarkSettings"];
  }): PatentSaveCoordinatorSnapshot {
    this.#assertEditable();
    const bookEdits = structuredClone(input.bookEdits ?? []);
    const assets = input.assets === undefined ? undefined : structuredClone(input.assets);
    if ((input.referenceMarks === undefined) !== (input.referenceMarkSettings === undefined)) {
      throw new Error("Reference marks and settings must be supplied together.");
    }
    const referenceStateChanged =
      input.referenceMarks !== undefined &&
      (JSON.stringify(input.referenceMarks) !== JSON.stringify(this.#patent.referenceMarks) ||
        JSON.stringify(input.referenceMarkSettings) !==
          JSON.stringify(this.#patent.referenceMarkSettings));
    const assetsChanged =
      assets !== undefined && JSON.stringify(assets) !== JSON.stringify(this.#patent.assets);
    if (
      (input.name === undefined || this.#patent.name === input.name) &&
      (input.customer === undefined || this.#patent.customer === input.customer) &&
      this.#patent.patentType === input.patentType &&
      bookEdits.length === 0 &&
      !assetsChanged &&
      !referenceStateChanged
    ) {
      return this.snapshot();
    }

    const basePatentType = this.#patent.patentType;
    this.#localRevision += 1;
    const localRevision = this.#localRevision;
    const bookLocalRevisions: Partial<Record<PatentBookKind, number>> = {};
    for (const book of this.#patent.books) {
      if (bookEdits.some((edit) => edit.bookKind === book.kind)) {
        bookLocalRevisions[book.kind] = book.localRevision + 1;
      }
    }
    this.#patent = {
      ...this.#patent,
      name: input.name === undefined ? this.#patent.name : input.name,
      customer: input.customer === undefined ? this.#patent.customer : input.customer,
      patentType: input.patentType,
      assets: structuredClone(assets ?? this.#patent.assets),
      referenceMarks: structuredClone(input.referenceMarks ?? this.#patent.referenceMarks),
      referenceMarkSettings: structuredClone(
        input.referenceMarkSettings ?? this.#patent.referenceMarkSettings,
      ),
      books: this.#patent.books.map((book) => {
        const edit = bookEdits.find((candidate) => candidate.bookKind === book.kind);
        return edit
          ? {
              ...book,
              document: edit.document,
              editorState: edit.editorState,
              localRevision: bookLocalRevisions[book.kind] ?? book.localRevision,
            }
          : book;
      }),
      revision: localRevision,
    };
    for (const edit of bookEdits) {
      this.#bookSaveStates = { ...this.#bookSaveStates, [edit.bookKind]: "saving" };
    }
    this.#pending.push({
      type: "settings",
      basePatentType,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.autoTitleRecognition ? { autoTitleRecognition: true } : {}),
      ...(input.customer !== undefined ? { customer: input.customer } : {}),
      patentType: input.patentType,
      ...(assets !== undefined ? { assets } : {}),
      bookEdits,
      bookLocalRevisions,
      ...(input.referenceMarks ? { referenceMarks: structuredClone(input.referenceMarks) } : {}),
      ...(input.referenceMarkSettings
        ? { referenceMarkSettings: structuredClone(input.referenceMarkSettings) }
        : {}),
      localRevision,
    });
    this.#aggregateSaveState = this.#saveError ? "failed" : "saving";
    this.#emit("onQueued");
    this.#startPump();
    return this.snapshot();
  }

  enqueueDesignPatent(
    designPatent: DesignPatent,
    assets: readonly AssetDescriptor[],
  ): PatentSaveCoordinatorSnapshot {
    if (this.#patent.patentType !== "design") throw new Error("Patent is not a design patent.");
    this.#localRevision += 1;
    const localRevision = this.#localRevision;
    this.#patent = {
      ...this.#patent,
      revision: localRevision,
      designPatent: structuredClone(designPatent),
      assets: Array.from(assets, (asset) => structuredClone(asset)),
    };
    this.#pending.push({
      type: "design-patent",
      designPatent: structuredClone(designPatent),
      assets: Array.from(assets, (asset) => structuredClone(asset)),
      localRevision,
    });
    this.#aggregateSaveState = this.#saveError ? "failed" : "saving";
    this.#emit("onQueued");
    this.#startPump();
    return this.snapshot();
  }

  enqueueReferenceMarkTransaction(input: {
    referenceMarks: CanonicalPatent["referenceMarks"];
    referenceMarkSettings: CanonicalPatent["referenceMarkSettings"];
    assets?: CanonicalPatent["assets"];
    bookEdits: NonNullable<PatentUpdateSettingsRequest["bookEdits"]>;
  }): PatentSaveCoordinatorSnapshot {
    return this.enqueueSettings({
      patentType: this.#patent.patentType,
      ...input,
    });
  }

  async retry(): Promise<void> {
    if (!this.#saveError) return this.flush();
    this.#saveError = null;
    this.#aggregateSaveState = "saving";
    const failedKinds = this.#pendingBookKinds();
    this.#bookSaveStates = Object.fromEntries(
      PATENT_BOOK_ORDER.map((kind) => [
        kind,
        failedKinds.has(kind) ? "saving" : this.#bookSaveStates[kind],
      ]),
    ) as Record<PatentBookKind, LibrarySaveState>;
    const failedAuxiliaryIds = new Set(
      this.#pending.flatMap((edit) =>
        edit.type === "auxiliary-document" ? [edit.auxiliaryDocumentId] : [],
      ),
    );
    this.#auxiliarySaveStates = Object.fromEntries(
      Object.entries(this.#auxiliarySaveStates).map(([id, state]) => [
        id,
        failedAuxiliaryIds.has(id) ? "saving" : state,
      ]),
    );
    this.#emit("onRetrying");
    this.#startPump();
    await this.flush();
  }

  async runPersistedMutation<T>(
    work: (expectedRevision: number) => Promise<AppResult<T>>,
    reconcile: (value: T, patent: CanonicalPatent) => PersistedMutation | null,
  ): Promise<AppResult<T>> {
    this.#assertEditable();
    if (this.#disposed) throw internalError();
    if (this.#saveError) throw this.#saveError;
    this.#localRevision += 1;
    this.#patent = { ...this.#patent, revision: this.#localRevision };
    const result = new Promise<AppResult<T>>((resolve) => {
      let outcome: AppResult<T>;
      this.#pending.push({
        type: "persisted-mutation",
        localRevision: this.#localRevision,
        run: async (expectedRevision) => {
          outcome = await work(expectedRevision);
          return outcome.ok ? { ok: true, value: reconcile(outcome.value, this.#patent) } : outcome;
        },
        complete: () => resolve(outcome),
        fail: (error) => resolve({ ok: false, error }),
      });
    });
    this.#aggregateSaveState = "saving";
    this.#emit("onQueued");
    this.#startPump();
    return result;
  }

  async flush(): Promise<void> {
    if (this.#saveError) throw this.#saveError;
    await this.#waitForDrain();
    if (this.#saveError) throw this.#saveError;
  }

  async drainAndVerify(): Promise<boolean> {
    try {
      for (;;) {
        await this.flush();
        const verifiedRevision = this.#persistedRevision;
        const result = await this.#flush({
          patentId: this.patentId,
          expectedRevision: verifiedRevision,
        });
        const changed =
          this.#localRevision !== verifiedRevision || this.#running || this.#pending.length > 0;
        if (changed && (result.ok || result.error.code === "REVISION_CONFLICT")) continue;
        if (!result.ok) {
          this.#fail(result.error);
          return false;
        }
        this.#aggregateSaveState = this.#deriveAggregateSaveState();
        this.#emit("onConfirmed");
        return true;
      }
    } catch {
      return false;
    }
  }

  adoptPersistedPatent(
    patentInput: CanonicalPatent,
    savedAt: string,
  ): PatentSaveCoordinatorSnapshot {
    if (this.#pending.length > 0 || this.#running) {
      throw new Error("Cannot adopt a persisted patent while edits are pending.");
    }
    const patent = structuredClone(patentInput);
    if (patent.patentId !== this.patentId || patent.revision <= this.#persistedRevision) {
      throw new Error("Persisted patent result does not advance this save coordinator.");
    }
    this.#patent = patent;
    this.#localRevision = patent.revision;
    this.#persistedRevision = patent.revision;
    this.#bookSaveStates = Object.fromEntries(
      PATENT_BOOK_ORDER.map((kind) => [kind, "saved"]),
    ) as Record<PatentBookKind, LibrarySaveState>;
    this.#auxiliarySaveStates = Object.fromEntries(
      patent.auxiliaryDocuments.map((document) => [document.auxiliaryDocumentId, "saved"]),
    );
    this.#aggregateSaveState = "saved";
    this.#lastSavedAt = savedAt;
    this.#saveError = null;
    return this.snapshot();
  }

  dispose(): void {
    this.#disposed = true;
    for (const edit of this.#pending) {
      if (edit.type === "persisted-mutation") edit.fail(internalError());
    }
    for (const waiter of this.#waiters.splice(0)) waiter.reject(internalError());
  }

  #startPump(): void {
    if (this.#running || this.#saveError || this.#disposed) return;
    this.#running = true;
    void this.#pump();
  }

  async #pump(): Promise<void> {
    try {
      while (!this.#disposed && !this.#saveError && this.#pending.length > 0) {
        const item = this.#pending[0];
        if (!item) break;
        if (item.type === "persisted-mutation") {
          await this.#persistMutation(item);
          continue;
        }
        // Once sent, preserve the exact operation, including across failed retries.
        if (item.type === "book") item.coalescible = false;
        const result = await this.#persist(item);
        if (!result.ok) {
          this.#fail(result.error);
          break;
        }
        const acceptedFlowchartNoOp =
          item.type === "flowchart-source" && result.value.revision === this.#persistedRevision;
        if (
          result.value.patentId !== this.patentId ||
          result.value.revision < this.#persistedRevision ||
          (result.value.revision === this.#persistedRevision && !acceptedFlowchartNoOp)
        ) {
          this.#fail({
            code: "REVISION_CONFLICT",
            message: "专利修订与保存队列不一致。",
          });
          break;
        }

        this.#pending.shift();
        this.#persistedRevision = result.value.revision;
        if (acceptedFlowchartNoOp) this.#rebaseAfterFlowchartNoOp(item.localRevision);
        this.#lastSavedAt = result.value.savedAt;
        if (item.type === "book") {
          this.#patent = {
            ...updateBook(this.#patent, item.bookKind, (book) => ({
              ...book,
              persistedRevision:
                item.localRevision > book.persistedRevision
                  ? item.localRevision
                  : book.persistedRevision,
            })),
            revision: this.#persistedRevision,
          };
          this.#bookSaveStates = {
            ...this.#bookSaveStates,
            [item.bookKind]: this.#bookHasPending(item.bookKind) ? "saving" : "saved",
          };
        } else if (item.type === "auxiliary-document") {
          this.#patent = {
            ...this.#patent,
            auxiliaryDocuments: this.#patent.auxiliaryDocuments.map((document) =>
              document.auxiliaryDocumentId === item.auxiliaryDocumentId
                ? {
                    ...document,
                    persistedRevision: Math.max(document.persistedRevision, item.localRevision),
                  }
                : document,
            ),
            revision: this.#persistedRevision,
          };
          this.#auxiliarySaveStates = {
            ...this.#auxiliarySaveStates,
            [item.auxiliaryDocumentId]: this.#auxiliaryDocumentHasPending(item.auxiliaryDocumentId)
              ? "saving"
              : "saved",
          };
        } else if (item.type === "settings") {
          for (const edit of item.bookEdits) {
            this.#patent = updateBook(this.#patent, edit.bookKind, (book) => ({
              ...book,
              persistedRevision: Math.max(
                book.persistedRevision,
                item.bookLocalRevisions[edit.bookKind] ?? book.persistedRevision,
              ),
            }));
            this.#bookSaveStates = {
              ...this.#bookSaveStates,
              [edit.bookKind]: this.#bookHasPending(edit.bookKind) ? "saving" : "saved",
            };
          }
          this.#patent = { ...this.#patent, revision: this.#persistedRevision };
        } else if (item.type === "flowchart-source") {
          const project = result.value.flowchartProject;
          if (!project) {
            this.#fail(internalError());
            break;
          }
          this.#patent = {
            ...this.#patent,
            revision: this.#persistedRevision,
            flowchartProjects: [
              ...this.#patent.flowchartProjects.filter(
                (candidate) => candidate.projectId !== project.projectId,
              ),
              project,
            ],
          };
        } else {
          this.#patent = { ...this.#patent, revision: this.#persistedRevision };
        }
        this.#aggregateSaveState = this.#deriveAggregateSaveState();
        this.#emit("onConfirmed", acceptedFlowchartNoOp);
        if (item.type === "settings" && item.autoTitleRecognition) {
          this.#callbacks.onAutoTitlePersisted?.(this.snapshot());
        }
      }
    } catch (error) {
      this.#fail(toAppError(error));
    } finally {
      this.#running = false;
      this.#notifyWaiters();
      if (!this.#disposed && !this.#saveError && this.#pending.length > 0) this.#startPump();
    }
  }

  async #persist(
    item: Exclude<PendingEdit, PendingPersistedMutation>,
  ): Promise<AppResult<PatentEditAck & { flowchartProject?: FlowchartOpenedProject["project"] }>> {
    if (item.type === "book") {
      return this.#applyBookEdit({
        patentId: this.patentId,
        sessionId: this.sessionId,
        bookKind: item.bookKind,
        expectedRevision: this.#persistedRevision,
        document: item.document,
        editorState: item.editorState,
        assets: item.assets,
      });
    }
    if (item.type === "auxiliary-document") {
      return this.#applyAuxiliaryDocumentEdit({
        patentId: this.patentId,
        sessionId: this.sessionId,
        auxiliaryDocumentId: item.auxiliaryDocumentId,
        expectedRevision: this.#persistedRevision,
        document: item.document,
        editorState: item.editorState,
        assets: item.assets,
      });
    }
    if (item.type === "figures") {
      return this.#applyFigureEdit({
        patentId: this.patentId,
        sessionId: this.sessionId,
        expectedRevision: this.#persistedRevision,
        figures: item.figures,
        abstractDrawingFigureId: item.abstractDrawingFigureId,
        assets: item.assets,
        ...(item.drawingProjects === undefined ? {} : { drawingProjects: item.drawingProjects }),
        ...(item.drawingProjectEdits === undefined
          ? {}
          : { drawingProjectEdits: item.drawingProjectEdits }),
      });
    }
    if (item.type === "flowchart-source") {
      if (!this.#saveFlowchart) {
        return { ok: false, error: internalError() };
      }
      const result = await this.#saveFlowchart({
        patentId: this.patentId,
        projectId: item.projectId,
        expectedPatentRevision: this.#persistedRevision,
        expectedProjectRevision: item.expectedProjectRevision,
        source: new Uint8Array(item.source),
        pageCount: item.pageCount,
        lastPageId: item.lastPageId,
      });
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          patentId: this.patentId,
          revision: result.value.patentRevision,
          savedAt: result.value.project.modifiedAt,
          flowchartProject: result.value.project,
        },
      };
    }
    if (item.type === "design-patent") {
      if (!this.#updateDesignPatent) throw new Error("Design patent save service is unavailable.");
      return this.#updateDesignPatent({
        patentId: this.patentId,
        sessionId: this.sessionId,
        expectedRevision: this.#persistedRevision,
        designPatent: item.designPatent,
        assets: item.assets,
      });
    }
    return this.#updateSettings({
      patentId: this.patentId,
      expectedRevision: this.#persistedRevision,
      patentType: item.patentType,
      ...(item.name !== undefined ? { name: item.name } : {}),
      ...(item.customer !== undefined ? { customer: item.customer } : {}),
      ...(item.referenceMarks ? { referenceMarks: item.referenceMarks } : {}),
      ...(item.referenceMarkSettings ? { referenceMarkSettings: item.referenceMarkSettings } : {}),
      ...(item.assets ? { assets: item.assets } : {}),
      ...(item.bookEdits.length > 0 ? { bookEdits: item.bookEdits } : {}),
    });
  }

  async #persistMutation(item: PendingPersistedMutation): Promise<void> {
    let result: AppResult<PersistedMutation | null>;
    try {
      result = await item.run(this.#persistedRevision);
    } catch (error) {
      result = { ok: false, error: toAppError(error) };
    }
    const mutation = result.ok ? result.value : null;
    if (
      mutation &&
      (mutation.patent.patentId !== this.patentId ||
        mutation.patent.revision < this.#persistedRevision)
    ) {
      item.fail({ code: "REVISION_CONFLICT", message: "专利修订与保存队列不一致。" });
      this.#fail({ code: "REVISION_CONFLICT", message: "专利修订与保存队列不一致。" });
      return;
    }
    this.#pending.shift();
    const noOp = !mutation || mutation.patent.revision === this.#persistedRevision;
    if (noOp) this.#rebaseAfterFlowchartNoOp(item.localRevision);
    else {
      this.#persistedRevision = mutation.patent.revision;
      this.#lastSavedAt = mutation.savedAt;
      this.#replayPendingEdits(mutation.patent);
    }
    this.#patent = { ...this.#patent, revision: this.#persistedRevision };
    this.#aggregateSaveState = this.#deriveAggregateSaveState();
    this.#emit("onMutationConfirmed", noOp);
    if (result.ok) item.complete();
    else item.fail(result.error);
  }

  // A returned aggregate precedes edits made while its IPC reply was in flight.
  // Replay those edits without resending the mutation or marking them as saved.
  #replayPendingEdits(persisted: CanonicalPatent): void {
    const previousBooks = this.#patent.books;
    const previousAuxiliaryDocuments = this.#patent.auxiliaryDocuments;
    this.#patent = structuredClone(persisted);
    for (const book of this.#patent.books) {
      const previous = previousBooks.find((candidate) => candidate.kind === book.kind);
      if (previous && JSON.stringify(previous.document) === JSON.stringify(book.document)) {
        inheritDocumentEcho(previous.document, book.document);
      }
    }
    for (const document of this.#patent.auxiliaryDocuments) {
      const previous = previousAuxiliaryDocuments.find(
        (candidate) => candidate.auxiliaryDocumentId === document.auxiliaryDocumentId,
      );
      if (previous && JSON.stringify(previous.document) === JSON.stringify(document.document)) {
        inheritDocumentEcho(previous.document, document.document);
      }
    }
    const mutationAssets = this.#patent.assets;
    for (const edit of this.#pending) {
      if ("assets" in edit && edit.assets) {
        const assets = new Map(mutationAssets.map((asset) => [asset.assetId, asset]));
        for (const asset of edit.assets) assets.set(asset.assetId, asset);
        edit.assets = [...assets.values()];
        this.#patent = { ...this.#patent, assets: edit.assets };
      }
      if (edit.type === "book") {
        this.#patent = updateBook(this.#patent, edit.bookKind, (book) => ({
          ...book,
          document: edit.document,
          editorState: edit.editorState,
          localRevision: edit.localRevision,
        }));
      } else if (edit.type === "auxiliary-document") {
        this.#patent = {
          ...this.#patent,
          auxiliaryDocuments: this.#patent.auxiliaryDocuments.map((document) =>
            document.auxiliaryDocumentId === edit.auxiliaryDocumentId
              ? {
                  ...document,
                  document: edit.document,
                  editorState: edit.editorState,
                  localRevision: edit.localRevision,
                }
              : document,
          ),
        };
      } else if (edit.type === "figures") {
        const baseFigures = this.#patent.figures;
        edit.figures = rebaseFigures(edit.baseFigures, edit.figures, baseFigures);
        edit.baseFigures = baseFigures;
        const baseAbstractDrawingFigureId = this.#patent.abstractDrawingFigureId;
        if (edit.abstractDrawingFigureId === edit.baseAbstractDrawingFigureId) {
          edit.abstractDrawingFigureId = baseAbstractDrawingFigureId;
        }
        edit.baseAbstractDrawingFigureId = baseAbstractDrawingFigureId;
        this.#patent = {
          ...this.#patent,
          figures: edit.figures,
          books: normalizeDrawingBooks(this.#patent),
          abstractDrawingFigureId: edit.abstractDrawingFigureId,
          drawingProjects: edit.drawingProjectEdits
            ? applyDrawingProjectEdits(this.#patent.drawingProjects, edit.drawingProjectEdits)
            : (edit.drawingProjects ?? this.#patent.drawingProjects),
        };
      } else if (edit.type === "settings") {
        const basePatentType = this.#patent.patentType;
        if (edit.patentType === edit.basePatentType) edit.patentType = basePatentType;
        edit.basePatentType = basePatentType;
        this.#patent = {
          ...this.#patent,
          ...(edit.name !== undefined ? { name: edit.name } : {}),
          ...(edit.customer !== undefined ? { customer: edit.customer } : {}),
          patentType: edit.patentType,
          referenceMarks: edit.referenceMarks ?? this.#patent.referenceMarks,
          referenceMarkSettings: edit.referenceMarkSettings ?? this.#patent.referenceMarkSettings,
          books: this.#patent.books.map((book) => {
            const pending = edit.bookEdits.find((candidate) => candidate.bookKind === book.kind);
            return pending
              ? {
                  ...book,
                  document: pending.document,
                  editorState: pending.editorState,
                  localRevision: edit.bookLocalRevisions[book.kind] ?? book.localRevision,
                }
              : book;
          }),
        };
      }
    }
    this.#bookSaveStates = Object.fromEntries(
      PATENT_BOOK_ORDER.map((kind) => [kind, this.#bookHasPending(kind) ? "saving" : "saved"]),
    ) as Record<PatentBookKind, LibrarySaveState>;
    this.#auxiliarySaveStates = Object.fromEntries(
      this.#patent.auxiliaryDocuments.map((document) => [
        document.auxiliaryDocumentId,
        this.#auxiliaryDocumentHasPending(document.auxiliaryDocumentId) ? "saving" : "saved",
      ]),
    );
  }

  #bookHasPending(bookKind: PatentBookKind): boolean {
    return this.#pendingBookKinds().has(bookKind);
  }

  #auxiliaryDocumentHasPending(auxiliaryDocumentId: string): boolean {
    return this.#pending.some(
      (edit) =>
        edit.type === "auxiliary-document" && edit.auxiliaryDocumentId === auxiliaryDocumentId,
    );
  }

  #deriveAggregateSaveState(): LibrarySaveState {
    if (Object.values(this.#bookSaveStates).some((saveState) => saveState === "failed")) {
      return "failed";
    }
    if (Object.values(this.#auxiliarySaveStates).some((saveState) => saveState === "failed")) {
      return "failed";
    }
    if (
      this.#localRevision > this.#persistedRevision ||
      Object.values(this.#bookSaveStates).some((saveState) => saveState === "saving") ||
      Object.values(this.#auxiliarySaveStates).some((saveState) => saveState === "saving")
    ) {
      return "saving";
    }
    return "saved";
  }

  #rebaseAfterFlowchartNoOp(noOpLocalRevision: number): void {
    this.#localRevision -= 1;
    for (let index = 0; index < this.#pending.length; index += 1) {
      const pending = this.#pending[index];
      if (!pending || pending.type === "book" || pending.localRevision <= noOpLocalRevision)
        continue;
      this.#pending[index] = { ...pending, localRevision: pending.localRevision - 1 };
    }
  }

  #fail(error: AppError): void {
    let cancelledMutation = false;
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      const edit = this.#pending[index];
      if (edit?.type !== "persisted-mutation") continue;
      this.#pending.splice(index, 1);
      this.#rebaseAfterFlowchartNoOp(edit.localRevision);
      edit.fail(error);
      cancelledMutation = true;
    }
    this.#saveError = error;
    this.#aggregateSaveState = "failed";
    const failedKinds = this.#pendingBookKinds();
    this.#bookSaveStates = Object.fromEntries(
      PATENT_BOOK_ORDER.map((kind) => [
        kind,
        failedKinds.has(kind) ? "failed" : this.#bookSaveStates[kind],
      ]),
    ) as Record<PatentBookKind, LibrarySaveState>;
    const failedAuxiliaryIds = new Set(
      this.#pending.flatMap((edit) =>
        edit.type === "auxiliary-document" ? [edit.auxiliaryDocumentId] : [],
      ),
    );
    this.#auxiliarySaveStates = Object.fromEntries(
      Object.entries(this.#auxiliarySaveStates).map(([id, state]) => [
        id,
        failedAuxiliaryIds.has(id) ? "failed" : state,
      ]),
    );
    this.#emit("onFailed", cancelledMutation);
  }

  #pendingBookKinds(): Set<PatentBookKind> {
    return new Set(
      this.#pending.flatMap((edit) => {
        if (edit.type === "book") return [edit.bookKind];
        if (edit.type === "settings") return edit.bookEdits.map((bookEdit) => bookEdit.bookKind);
        return [];
      }),
    );
  }

  #waitForDrain(): Promise<void> {
    if (this.#saveError) return Promise.reject(this.#saveError);
    if (!this.#running && this.#pending.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  #notifyWaiters(): void {
    if (this.#running || (!this.#saveError && this.#pending.length > 0)) return;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      if (this.#saveError) waiter.reject(this.#saveError);
      else waiter.resolve();
    }
  }

  #emit(callback: keyof QueueCallbacks, revisionStateRebased = false): void {
    if (this.#disposed) return;
    this.#callbacks[callback]?.({ ...this.snapshot(), revisionStateRebased });
  }
}

function updateBook(
  patent: CanonicalPatent,
  bookKind: PatentBookKind,
  update: (book: CanonicalPatent["books"][number]) => CanonicalPatent["books"][number],
): CanonicalPatent {
  return {
    ...patent,
    books: patent.books.map((book) => (book.kind === bookKind ? update(book) : book)),
  };
}
