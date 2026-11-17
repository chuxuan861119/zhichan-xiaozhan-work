import {
  act,
  fireEvent,
  render as renderBase,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactElement, useState } from "react";
import type { AssetDescriptor, PatentBookDocument } from "../../../shared/document/model";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import type {
  DocxImportCommitRequest,
  OpenedPatent,
  PatentApi,
  PatentApplyBookEditRequest,
  PatentApplyFigureEditRequest,
  PatentEditAck,
  PatentFlushRequest,
  PatentFlushResult,
  SavedDocument,
} from "../../../shared/ipc/contract";
import type { AppResult } from "../../../shared/ipc/result";
import { createBlankPatent } from "../../../shared/patent/defaults";
import type { CanonicalPatent, PatentBookKind, PatentFigure } from "../../../shared/patent/model";
import { CanonicalPatentSchema } from "../../../shared/patent/model";
import {
  planAssignReferenceNumber,
  planFillReferenceMarksIntoDescription,
  planSupplementClaimsReferenceNumbers,
} from "../../../shared/patent/reference-mark-operations";

import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { ApplicationCloseProvider } from "../app/application-close-coordinator";
import * as appDialogs from "../shared/app-dialog";
import { PatentProvider, usePatents } from "./patent-context";

function render(ui: ReactElement) {
  return renderBase(<ApplicationCloseProvider>{ui}</ApplicationCloseProvider>);
}

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

test("late edit during application close snapshot must be drained before proceed", async () => {
  let prepareClose: ((token: string) => void) | undefined;
  let finishSnapshot!: () => void;
  let finishEdit!: () => void;
  const closeResult = vi.fn(async (_request: { token: string; proceed: boolean }) => ({
    ok: true as const,
    value: undefined,
  }));
  const applyBookEdit = vi.fn(
    (request: PatentApplyBookEditRequest) =>
      new Promise<AppResult<PatentEditAck>>((resolve) => {
        finishEdit = () =>
          resolve({
            ok: true,
            value: {
              patentId: request.patentId,
              revision: request.expectedRevision + 1,
              savedAt: "2026-10-10T00:00:00.000Z",
            },
          });
      }),
  );
  const createSnapshot = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      value: {
        outcome: "created",
        revision: 1,
        createdAt: "2026-10-10T00:00:00.000Z",
        source: "application-close",
      },
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSnapshot = () =>
            resolve({
              ok: true,
              value: {
                outcome: "created",
                revision: 0,
                createdAt: "2026-10-10T00:00:00.000Z",
                source: "application-close",
              },
            });
        }),
    );
  window.patentApi = patentApi({
    patents: { applyBookEdit },
    snapshot: { create: createSnapshot as PatentApi["snapshot"]["create"] },
    application: {
      onPrepareClose: vi.fn((listener) => {
        prepareClose = listener;
        return vi.fn();
      }),
      closeResult,
    },
  }) as PatentApi;
  render(
    <PatentProvider>
      <Harness />
    </PatentProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
  act(() => prepareClose?.(testUuid(888)));
  await waitFor(() => expect(createSnapshot).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "修改当前书" }));
  await waitFor(() => expect(applyBookEdit).toHaveBeenCalled());
  await act(async () => finishSnapshot());
  const proceeded = closeResult.mock.calls.some(
    (call) => (call[0] as unknown as { proceed: boolean }).proceed,
  );
  await act(async () => finishEdit());
  expect(proceeded).toBe(false);
  await waitFor(() =>
    expect(closeResult).toHaveBeenCalledWith({ token: testUuid(888), proceed: true }),
  );
  expect(createSnapshot).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("persisted-revision").textContent).toBe("1");
});

function SnapshotPreparationHarness() {
  const patents = usePatents();
  const [result, setResult] = useState("waiting");
  return (
    <>
      <Harness />
      <output aria-label="快照保存结果">{result}</output>
      <button
        type="button"
        onClick={async () => {
          try {
            setResult(String(await patents.preparePatentSnapshot(testUuid(101))));
          } catch {
            setResult("error");
          }
        }}
      >
        准备指定专利快照
      </button>
    </>
  );
}

test("snapshot preparation waits for an open patent's pending write and flush", async () => {
  let completeEdit!: () => void;
  const applyBookEdit = vi.fn(
    (request: PatentApplyBookEditRequest) =>
      new Promise<AppResult<PatentEditAck>>((resolve) => {
        completeEdit = () =>
          resolve({
            ok: true,
            value: {
              patentId: request.patentId,
              revision: request.expectedRevision + 1,
              savedAt: "2026-09-11T00:00:00.000Z",
            },
          });
      }),
  );
  const api = patentApi({ patents: { applyBookEdit } });
  window.patentApi = api as PatentApi;
  render(
    <PatentProvider>
      <SnapshotPreparationHarness />
    </PatentProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
  await userEvent.click(screen.getByRole("button", { name: "修改当前书" }));
  await userEvent.click(screen.getByRole("button", { name: "准备指定专利快照" }));
  expect(screen.getByLabelText("快照保存结果").textContent).toBe("waiting");
  expect(api.patents.flush).not.toHaveBeenCalled();
  await act(async () => completeEdit());
  await waitFor(() => expect(screen.getByLabelText("快照保存结果").textContent).toBe("true"));
  expect(api.patents.flush).toHaveBeenCalledWith({ patentId: testUuid(101), expectedRevision: 1 });
});

test("snapshot preparation rejects a failed persistence verification", async () => {
  const flush = vi.fn(async () => ({
    ok: false as const,
    error: { code: "DISK_FULL" as const, message: "磁盘空间不足" },
  }));
  window.patentApi = patentApi({ patents: { flush } }) as PatentApi;
  render(
    <PatentProvider>
      <SnapshotPreparationHarness />
    </PatentProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
  await userEvent.click(screen.getByRole("button", { name: "准备指定专利快照" }));
  await waitFor(() => expect(screen.getByLabelText("快照保存结果").textContent).toBe("false"));
});

function openedPatent(index: number, name: string | null = `专利 ${index}`): OpenedPatent {
  const patent = createBlankPatent({ patentType: "invention", name });
  patent.patentId = testUuid(100 + index);
  patent.books.forEach((book, bookIndex) => {
    book.bookId = testUuid(300 + index * 10 + bookIndex);
    book.document.documentId = testUuid(400 + index * 10 + bookIndex);
  });
  return {
    patentId: patent.patentId,
    sessionId: testUuid(200 + index),
    revision: 0,
    patent,
    saveState: "saved",
  };
}

function withParagraph(document: PatentBookDocument, text: string): PatentBookDocument {
  return {
    ...document,
    content: [
      {
        id: testUuid(900),
        type: "paragraph",
        attrs: {
          alignment: "left",
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text", text, marks: [] }],
      },
    ],
  };
}

function withInventionTitle(document: PatentBookDocument, text: string): PatentBookDocument {
  const title = document.content[0];
  if (title?.type !== "paragraph") throw new Error("说明书标题缺失");
  return {
    ...document,
    content: document.content.map((block) =>
      block.id === title.id
        ? { ...block, content: [{ type: "text", text, marks: [{ type: "bold" }] }] }
        : block,
    ),
  };
}

function asset(index: number): AssetDescriptor {
  return {
    assetId: `00000000-0000-4000-8001-${index.toString(16).padStart(12, "0")}`,
    kind: "image",
    originalName: `figure-${index}.png`,
    mediaType: "image/png",
    extension: "png",
    byteLength: 10 + index,
    sha256: index.toString(16).toUpperCase().padStart(64, "0"),
    widthPx: 100 + index,
    heightPx: 80 + index,
    previewByteLength: 5 + index,
    previewSha256: (100 + index).toString(16).toUpperCase().padStart(64, "0"),
  };
}

function figure(index: number, descriptor = asset(index)): PatentFigure {
  return {
    figureId: `00000000-0000-4000-8002-${index.toString(16).padStart(12, "0")}`,
    assetId: descriptor.assetId,
    widthMm: 80,
  };
}

function firstText(document: PatentBookDocument | undefined): string {
  const paragraph = document?.content[0];
  if (paragraph?.type !== "paragraph") return "";
  const text = paragraph?.content[0];
  return text?.type === "text" ? text.text : "";
}

function Harness({ settingsName = "改名后的夹具" }: { settingsName?: string | null } = {}) {
  const patents = usePatents();
  const [exportPreparation, setExportPreparation] = useState("未准备");
  const [savedPath, setSavedPath] = useState("未导出");
  const [aiPreparation, setAiPreparation] = useState("未准备");
  const [closeResults, setCloseResults] = useState<boolean[]>([]);
  const activeSession = patents.activeSession;
  const activeBookKind = activeSession?.activeBookKind ?? "description";
  const referenceHistoryBookKind =
    activeBookKind === "claims" || activeBookKind === "description" || activeBookKind === "abstract"
      ? activeBookKind
      : null;
  const activeBook = activeSession?.patent.books.find((book) => book.kind === activeBookKind);
  return (
    <div>
      <span data-testid="active-name">{activeSession?.patent.name ?? "无活动专利"}</span>
      <span data-testid="active-book">{activeBookKind}</span>
      <span data-testid="active-auxiliary">
        {activeSession?.activeAuxiliaryDocumentId ?? "none"}
      </span>
      <span data-testid="session-count">{patents.state.sessions.length}</span>
      <span data-testid="save-state">{activeSession?.aggregateSaveState ?? "none"}</span>
      <span data-testid="local-revision">{activeSession?.localRevision ?? -1}</span>
      <span data-testid="persisted-revision">{activeSession?.persistedRevision ?? -1}</span>
      <span data-testid="figure-count">{activeSession?.patent.figures.length ?? 0}</span>
      <span data-testid="first-figure-width">
        {activeSession?.patent.figures[0]?.widthMm ?? "none"}
      </span>
      <span data-testid="reference-count">{activeSession?.patent.referenceMarks.length ?? 0}</span>
      <span data-testid="description-document">
        {JSON.stringify(
          activeSession?.patent.books.find((book) => book.kind === "description")?.document,
        )}
      </span>
      <span data-testid="claims-document">
        {JSON.stringify(
          activeSession?.patent.books.find((book) => book.kind === "claims")?.document,
        )}
      </span>

      <span data-testid="can-undo-reference">
        {activeSession &&
        referenceHistoryBookKind &&
        patents.canUndoReferenceMarkOperation(activeSession.patentId, referenceHistoryBookKind)
          ? "是"
          : "否"}
      </span>
      <span data-testid="can-redo-reference">
        {activeSession &&
        referenceHistoryBookKind &&
        patents.canRedoReferenceMarkOperation(activeSession.patentId, referenceHistoryBookKind)
          ? "是"
          : "否"}
      </span>
      <span data-testid="abstract-figure">
        {activeSession?.patent.abstractDrawingFigureId ?? "无"}
      </span>
      <span data-testid="can-undo-drawing">
        {activeSession && patents.canUndoDescriptionDrawing(activeSession.patentId) ? "是" : "否"}
      </span>
      <span data-testid="can-redo-drawing">
        {activeSession && patents.canRedoDescriptionDrawing(activeSession.patentId) ? "是" : "否"}
      </span>
      <span data-testid="patent-type">{activeSession?.patent.patentType ?? "无"}</span>
      <span data-testid="drawing-books-enabled">
        {activeSession?.patent.drawingBooksEnabled ? "已启用" : "已停用"}
      </span>
      <span data-testid="active-book-text">{firstText(activeBook?.document)}</span>
      <span data-testid="active-book-margin-top">
        {activeBook?.document.page.marginTopMm ?? "none"}
      </span>
      <span data-testid="active-book-margin-left">
        {activeBook?.document.page.marginLeftMm ?? "none"}
      </span>
      <span data-testid="all-books-margin-top">
        {activeSession?.patent.books.map((book) => book.document.page.marginTopMm).join(",") ??
          "none"}
      </span>
      <span data-testid="export-preparation">{exportPreparation}</span>
      <span data-testid="saved-path">{savedPath}</span>
      <span data-testid="ai-preparation">{aiPreparation}</span>
      <span data-testid="close-results">{closeResults.join(",")}</span>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) return;
          const result = planAssignReferenceNumber(activeSession.patent, "夹具专利", {
            now: () => new Date("2026-08-07T00:00:00.000Z"),
            createId: () => testUuid(9999),
          });
          if (result.ok && referenceHistoryBookKind)
            patents.applyReferenceMarkPlan(
              activeSession.patentId,
              referenceHistoryBookKind,
              result.plan,
            );
        }}
      >
        编号关键词
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) return;
          const result = planSupplementClaimsReferenceNumbers(activeSession.patent);
          if (!result.ok) throw new Error(result.message);
          patents.applyReferenceMarkPlan(activeSession.patentId, "claims", result.plan);
        }}
      >
        增补权利要求书编号
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession || !referenceHistoryBookKind) return;
          const result = planFillReferenceMarksIntoDescription(activeSession.patent);
          if (!result.ok) throw new Error(result.message);
          patents.applyReferenceMarkPlan(
            activeSession.patentId,
            referenceHistoryBookKind,
            result.plan,
          );
        }}
      >
        填入说明书
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) return;
          const result = planAssignReferenceNumber(activeSession.patent, "夹具专利", {
            now: () => new Date(),
            createId: () => testUuid(9999),
          });
          if (result.ok)
            patents.applyReferenceMarkPlan(
              activeSession.patentId,
              "description-drawings",
              result.plan,
            );
        }}
      >
        附图页编号
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) return;
          const claims = activeSession.patent.books.find((book) => book.kind === "claims");
          if (!claims) return;
          patents.updateBookDocument(
            activeSession.patentId,
            "claims",
            withParagraph(claims.document, "夹具专利"),
            {},
          );
        }}
      >
        写入编号关键词
      </button>
      <button
        type="button"
        onClick={() =>
          activeSession &&
          referenceHistoryBookKind &&
          patents.undoReferenceMarkOperation(activeSession.patentId, referenceHistoryBookKind)
        }
      >
        撤销标号
      </button>
      <button
        type="button"
        onClick={() =>
          activeSession &&
          referenceHistoryBookKind &&
          patents.redoReferenceMarkOperation(activeSession.patentId, referenceHistoryBookKind)
        }
      >
        重做标号
      </button>
      <button
        type="button"
        onClick={() => patents.newPatent({ patentType: "invention", name: "夹具专利" })}
      >
        新建专利
      </button>
      <button type="button" onClick={() => patents.openPatent(testUuid(101))}>
        打开专利
      </button>
      <button
        type="button"
        onClick={() =>
          patents.commitDocxImport({
            sessionId: testUuid(750),
            patentType: "invention",
            name: "DOCX 导入夹具",
            customer: null,
            assignments: [
              {
                unitId: testUuid(751),
                title: "权利要求书",
                target: { kind: "official-book", bookKind: "claims" },
              },
            ],
            acknowledgedWarningIds: [],
          } satisfies DocxImportCommitRequest)
        }
      >
        提交 DOCX 导入
      </button>
      <button
        type="button"
        onClick={() => activeSession && patents.activateBook(activeSession.patentId, "claims")}
      >
        切到权利要求
      </button>
      <button
        type="button"
        onClick={() => activeSession && patents.activateBook(activeSession.patentId, "description")}
      >
        切到说明书
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession || !activeBook) return;
          patents.updateBookDocument(
            activeSession.patentId,
            activeBookKind as PatentBookKind,
            withParagraph(activeBook.document, `修改 ${activeSession.localRevision + 1}`),
            { selection: activeBookKind },
          );
        }}
      >
        修改当前书
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) return;
          const description = activeSession.patent.books.find(
            (book) => book.kind === "description",
          );
          if (!description) return;
          patents.updateBookDocument(
            activeSession.patentId,
            "description",
            withInventionTitle(description.document, "填写的专利名称"),
            {},
          );
        }}
      >
        填写说明书名称
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) return;
          const description = activeSession.patent.books.find(
            (book) => book.kind === "description",
          );
          if (!description) return;
          const preview = asset(77);
          patents.updateBookDocument(
            activeSession.patentId,
            "description",
            {
              ...description.document,
              content: [
                ...description.document.content,
                {
                  id: testUuid(977),
                  type: "chemical-structure",
                  ketSource: "(ket) (atom C)",
                  previewAssetId: preview.assetId,
                  widthMm: 80,
                  alignment: "center",
                },
                {
                  id: testUuid(978),
                  type: "paragraph",
                  attrs: {
                    alignment: "left",
                    paragraphIndentMm: 0,
                    lineSpacing: 1.5,
                    defaultFontFamily: "SimSun",
                    defaultFontSizePt: 12,
                  },
                  content: [{ type: "text", text: "其中，______。", marks: [] }],
                },
              ],
            },
            {},
            [preview],
          );
        }}
      >
        插入化学结构
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) return;
          const descriptor = asset(1);
          const drawing = figure(1, descriptor);
          patents.updatePatentFigures(
            activeSession.patentId,
            [drawing],
            drawing.figureId,
            [descriptor],
            { ownerBookKind: "description-drawings", label: "导入附图" },
          );
        }}
      >
        修改附图
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) return;
          const descriptor = asset(1);
          const drawing = { ...figure(1, descriptor), widthMm: 25.4 };
          patents.updatePatentFigures(
            activeSession.patentId,
            [drawing],
            null,
            [descriptor, descriptor],
            undefined,
            undefined,
            undefined,
            false,
            [drawing.figureId],
          );
        }}
      >
        插入重复资源附图
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) return;
          const firstAsset = asset(1);
          const firstFigure = { ...figure(1, firstAsset), widthMm: 60 };
          patents.updatePatentFigures(activeSession.patentId, [firstFigure], null, [firstAsset]);
          // A manual resize after insertion must survive a subsequent append.
          patents.updatePatentFigures(activeSession.patentId, [firstFigure], null, [firstAsset]);
          const secondAsset = asset(2);
          patents.appendImportedPatentFigures(
            activeSession.patentId,
            [figure(2, secondAsset)],
            [secondAsset],
            "粘贴附图",
          );
        }}
      >
        并发追加附图
      </button>
      <button
        type="button"
        onClick={() => activeSession && patents.undoDescriptionDrawing(activeSession.patentId)}
      >
        撤销附图
      </button>
      <button
        type="button"
        onClick={() => activeSession && patents.redoDescriptionDrawing(activeSession.patentId)}
      >
        重做附图
      </button>
      <button
        type="button"
        onClick={() =>
          activeSession &&
          patents.updatePatentSettings(activeSession.patentId, {
            name: settingsName,
            patentType: "utility-model",
          })
        }
      >
        修改专利设置
      </button>
      <button
        type="button"
        onClick={() =>
          activeSession &&
          patents.updatePatentSettings(activeSession.patentId, {
            name: "术语替换夹具",
            patentType: "utility-model",
            terminologyReplacementRequested: true,
          })
        }
      >
        修改设置并替换术语
      </button>
      <button
        type="button"
        onClick={() =>
          activeSession && patents.setDrawingBooksEnabled(activeSession.patentId, false)
        }
      >
        删除附图书
      </button>
      <button
        type="button"
        onClick={() =>
          activeSession && patents.setDrawingBooksEnabled(activeSession.patentId, true)
        }
      >
        添加附图书
      </button>
      <button
        type="button"
        onClick={() => activeSession && patents.requestClose(activeSession.patentId)}
      >
        关闭专利
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeSession) return;
          void patents.closePatent(activeSession.patentId).then((result) => {
            setCloseResults((current) => [...current, result]);
          });
        }}
      >
        跟踪关闭专利
      </button>
      <button
        type="button"
        onClick={() =>
          activeSession &&
          patents.closePatent(activeSession.patentId, { allowDiscardOnSaveFailure: false })
        }
      >
        安全关闭专利
      </button>
      <button
        type="button"
        onClick={() =>
          activeSession &&
          patents.applyPageMargins({
            marginTopMm: 30,
            marginRightMm: 20,
            marginBottomMm: 30,
            marginLeftMm: 20,
          })
        }
      >
        应用边距
      </button>
      <button type="button" onClick={() => patents.saveActivePatent()}>
        保存专利
      </button>

      <button
        type="button"
        onClick={async () => {
          const prepared = await patents.prepareActivePatentExport();
          setExportPreparation(
            prepared
              ? `${prepared.patentId}|${prepared.sessionId}|${prepared.expectedRevision}|${prepared.suggestedName}`
              : "未准备",
          );
        }}
      >
        准备导出
      </button>
      <button
        type="button"
        onClick={() =>
          void patents.exportActivePatdoc().then((saved) => setSavedPath(saved?.path ?? "未导出"))
        }
      >
        导出 PATDOC
      </button>
      <button
        type="button"
        onClick={async () => {
          const prepared = await patents.prepareActiveAiCorrection();
          setAiPreparation(
            prepared
              ? `${prepared.patentId}|${prepared.sessionId}|${prepared.expectedRevision}`
              : "未准备",
          );
        }}
      >
        准备 AI 修订
      </button>
    </div>
  );
}

test("returns the saved PATDOC descriptor after exporting the active patent", async () => {
  const user = userEvent.setup();
  const saved: SavedDocument = {
    sessionId: testUuid(201),
    path: "D:\\导出\\专利.patdoc",
    displayName: "专利.patdoc",
    savedAt: "2026-09-02T00:00:00.000Z",
  };
  const exportPatdoc = vi.fn(async () => ({ ok: true as const, value: saved }));
  window.patentApi = patentApi({ patents: { exportPatdoc } });

  render(
    <PatentProvider>
      <Harness />
    </PatentProvider>,
  );
  await user.click(screen.getByRole("button", { name: "新建专利" }));
  await user.click(screen.getByRole("button", { name: "导出 PATDOC" }));

  await waitFor(() =>
    expect(screen.getByTestId("saved-path").textContent).toBe("D:\\导出\\专利.patdoc"),
  );
});

function openedDocxImport(
  assignments: NonNullable<CanonicalPatent["docxImportReport"]>["assignments"],
): OpenedPatent {
  const opened = openedPatent(90, "DOCX 导入夹具");
  opened.patent.docxImportReport = {
    importedAt: "2026-09-03T00:00:00.000Z",
    sourceFileNames: ["导入测试.docx"],
    assignments,
    warnings: [],
  };
  return opened;
}

describe("DOCX import initial document", () => {
  test("refuses deletion without a recovery snapshot and snapshots before a successful deletion", async () => {
    const opened = openedPatent(1);
    const source = opened.patent.books[0];
    if (!source) throw new Error("fixture");
    opened.patent.auxiliaryDocuments = [
      {
        auxiliaryDocumentId: testUuid(794),
        title: "待删除",
        document: { ...source.document, documentId: testUuid(795), title: "待删除" },
        localRevision: 0,
        persistedRevision: 0,
        editorState: {},
        sourceFileName: null,
      },
    ];
    const order: string[] = [];
    const createSnapshot = vi.fn(
      async (): Promise<
        AppResult<import("../../../shared/snapshot/model").SnapshotCreationResult>
      > => {
        order.push("snapshot");
        return { ok: false, error: { code: "INTERNAL", message: "快照保存失败" } };
      },
    );
    const deleteDocument = vi.fn(async () => {
      order.push("delete");
      return {
        ok: true as const,
        value: { patentId: opened.patentId, revision: 1, savedAt: opened.patent.modifiedAt },
      };
    });
    window.patentApi = patentApi({
      patents: {
        create: vi.fn(async () => ({ ok: true as const, value: opened })),
        deleteAuxiliaryDocument: deleteDocument,
      },
      snapshot: { create: createSnapshot },
    });
    let controller: ReturnType<typeof usePatents> | undefined;
    function Probe() {
      controller = usePatents();
      return null;
    }
    render(
      <PatentProvider>
        <Probe />
      </PatentProvider>,
    );
    await act(async () => {
      await controller?.newPatent({ patentType: "invention", name: "已有" });
    });
    await act(async () => {
      expect(await controller?.deleteAuxiliaryDocument(opened.patentId, testUuid(794))).toBe(false);
    });
    expect(deleteDocument).not.toHaveBeenCalled();
    expect(controller?.activeSession?.patent.auxiliaryDocuments).toHaveLength(1);
    createSnapshot.mockImplementation(async () => {
      order.push("snapshot");
      return {
        ok: true,
        value: {
          outcome: "created",
          revision: 0,
          createdAt: opened.patent.modifiedAt,
          source: "manual-create",
        },
      };
    });
    await act(async () => {
      expect(await controller?.deleteAuxiliaryDocument(opened.patentId, testUuid(794))).toBe(true);
    });
    expect(order).toEqual(["snapshot", "snapshot", "delete"]);
    expect(controller?.activeSession?.patent.auxiliaryDocuments).toHaveLength(0);
  });
  test("flushes existing edits before append and updates the same session", async () => {
    const opened = openedPatent(1);
    const newDocumentId = testUuid(780);
    const source = opened.patent.books[0];
    if (!source) throw new Error("book fixture missing");
    let saved = structuredClone(opened.patent);
    const applyBookEdit = vi.fn(async (request: PatentApplyBookEditRequest) => {
      saved = {
        ...saved,
        revision: request.expectedRevision + 1,
        books: saved.books.map((book) =>
          book.kind === request.bookKind
            ? {
                ...book,
                document: request.document,
                localRevision: request.expectedRevision + 1,
                persistedRevision: request.expectedRevision + 1,
              }
            : book,
        ),
      };
      return {
        ok: true as const,
        value: { patentId: opened.patentId, revision: saved.revision, savedAt: saved.modifiedAt },
      };
    });
    const commit = vi.fn(async (request: DocxImportCommitRequest) => {
      expect(applyBookEdit).toHaveBeenCalledOnce();
      expect(request.appendTo).toEqual({
        patentId: opened.patentId,
        sessionId: opened.sessionId,
        expectedRevision: 1,
      });
      const revision = 2;
      const patent = {
        ...saved,
        revision,
        auxiliaryDocuments: [
          {
            auxiliaryDocumentId: newDocumentId,
            title: "补充文件",
            document: { ...source.document, documentId: testUuid(781) },
            editorState: {},
            localRevision: revision,
            persistedRevision: revision,
            sourceFileName: "补充文件.docx",
          },
        ],
      };
      return { ok: true as const, value: { ...opened, revision, patent } };
    });
    window.patentApi = patentApi({
      patents: {
        create: vi.fn(async () => ({ ok: true as const, value: opened })),
        applyBookEdit,
        commitDocxImport: commit,
      },
    });
    let controller: ReturnType<typeof usePatents> | undefined;
    function Probe() {
      controller = usePatents();
      return <Harness />;
    }
    render(
      <PatentProvider>
        <Probe />
      </PatentProvider>,
    );
    await act(async () => {
      await controller?.newPatent({ patentType: "invention", name: "已有专利" });
    });
    await act(async () => {
      controller?.updateBookDocument(
        opened.patentId,
        source.kind,
        withParagraph(source.document, "新编辑内容"),
        {},
      );
      await controller?.commitDocxImport({
        sessionId: testUuid(782),
        appendTo: { patentId: opened.patentId, sessionId: opened.sessionId, expectedRevision: 0 },
        patentType: "invention",
        name: null,
        customer: null,
        assignments: [{ unitId: testUuid(783), title: "补充文件", target: { kind: "auxiliary" } }],
        acknowledgedWarningIds: [],
      });
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(screen.getByTestId("session-count").textContent).toBe("1");
    expect(screen.getByTestId("active-auxiliary").textContent).toBe(newDocumentId);
    expect(screen.getByTestId("persisted-revision").textContent).toBe("2");
    expect(JSON.stringify(controller?.activeSession?.patent.books)).toContain("新编辑内容");
  });

  test("opens the only imported official book", async () => {
    const user = userEvent.setup();
    const opened = openedDocxImport([
      {
        unitId: testUuid(760),
        sourceFileName: "权利要求书.docx",
        title: "权利要求书",
        target: { kind: "official-book", bookKind: "claims" },
        confidence: "high",
        evidence: ["检测到文档标题"],
      },
    ]);
    window.patentApi = patentApi({
      patents: { commitDocxImport: vi.fn(async () => ({ ok: true as const, value: opened })) },
    });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "提交 DOCX 导入" }));

    await waitFor(() => expect(screen.getByTestId("active-book").textContent).toBe("claims"));
  });

  test("opens the leftmost actually imported official book", async () => {
    const user = userEvent.setup();
    const opened = openedDocxImport([
      {
        unitId: testUuid(761),
        sourceFileName: "说明书摘要.docx",
        title: "说明书摘要",
        target: { kind: "official-book", bookKind: "abstract" },
        confidence: "high",
        evidence: ["检测到文档标题"],
      },
      {
        unitId: testUuid(762),
        sourceFileName: "权利要求书.docx",
        title: "权利要求书",
        target: { kind: "official-book", bookKind: "claims" },
        confidence: "high",
        evidence: ["检测到文档标题"],
      },
    ]);
    window.patentApi = patentApi({
      patents: { commitDocxImport: vi.fn(async () => ({ ok: true as const, value: opened })) },
    });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "提交 DOCX 导入" }));

    await waitFor(() => expect(screen.getByTestId("active-book").textContent).toBe("claims"));
  });

  test("opens the first imported auxiliary document when no official book was imported", async () => {
    const user = userEvent.setup();
    const auxiliaryDocumentId = testUuid(763);
    const opened = openedDocxImport([
      {
        unitId: testUuid(764),
        sourceFileName: "试验记录.docx",
        title: "试验记录",
        target: { kind: "auxiliary", auxiliaryDocumentId },
        confidence: "low",
        evidence: ["无法识别为五书"],
      },
    ]);
    const source = opened.patent.books[0];
    if (!source) throw new Error("patent fixture missing");
    opened.patent.auxiliaryDocuments = [
      {
        auxiliaryDocumentId,
        title: "试验记录",
        document: {
          ...structuredClone(source.document),
          documentId: testUuid(765),
          title: "试验记录",
          content: [],
        },
        editorState: {},
        localRevision: 0,
        persistedRevision: 0,
        sourceFileName: "试验记录.docx",
      },
    ];
    window.patentApi = patentApi({
      patents: { commitDocxImport: vi.fn(async () => ({ ok: true as const, value: opened })) },
    });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "提交 DOCX 导入" }));

    await waitFor(() =>
      expect(screen.getByTestId("active-auxiliary").textContent).toBe(auxiliaryDocumentId),
    );
  });
});

function patentApi(
  overrides: {
    patents?: Partial<PatentApi["patents"]>;
    backup?: Partial<PatentApi["backup"]>;
    snapshot?: Partial<PatentApi["snapshot"]>;
    settings?: Partial<PatentApi["settings"]>;
    application?: Partial<PatentApi["application"]> & {
      onPrepareClose?(listener: (token: string) => void): () => void;
      closeResult?(request: { token: string; proceed: boolean }): Promise<AppResult<void>>;
    };
  } = {},
) {
  const created = openedPatent(1, "夹具专利");
  return {
    patents: {
      list: vi.fn(async () => ({ ok: true, value: [] })),
      create: vi.fn(async () => ({ ok: true, value: created })),
      open: vi.fn(async () => ({ ok: true, value: created })),
      openPath: vi.fn(),
      updateSettings: vi.fn(async () => ({
        ok: true,
        value: {
          patentId: created.patentId,
          revision: 1,
          savedAt: "2026-08-02T08:00:00.000Z",
        },
      })),
      applyBookEdit: vi.fn(
        async (request: PatentApplyBookEditRequest): Promise<AppResult<PatentEditAck>> => ({
          ok: true,
          value: {
            patentId: request.patentId,
            revision: request.expectedRevision + 1,
            savedAt: "2026-08-02T08:00:00.000Z",
          },
        }),
      ),
      applyFigureEdit: vi.fn(
        async (request: PatentApplyFigureEditRequest): Promise<AppResult<PatentEditAck>> => ({
          ok: true,
          value: {
            patentId: request.patentId,
            revision: request.expectedRevision + 1,
            savedAt: "2026-08-02T08:00:00.000Z",
          },
        }),
      ),
      flush: vi.fn(
        async (request: PatentFlushRequest): Promise<AppResult<PatentFlushResult>> => ({
          ok: true,
          value: {
            patentId: request.patentId,
            revision: request.expectedRevision,
            flushedAt: "2026-08-02T08:00:01.000Z",
          },
        }),
      ),
      moveToTrash: vi.fn(async () => ({ ok: true, value: undefined })),
      restore: vi.fn(async () => ({ ok: true, value: undefined })),
      permanentlyDelete: vi.fn(async () => ({ ok: true, value: undefined })),
      purgeExpired: vi.fn(async () => ({ ok: true, value: { purgedPatentIds: [] } })),
      release: vi.fn(async () => ({ ok: true, value: undefined })),
      ...overrides.patents,
    },
    application: {
      createDesktopShortcut: vi.fn(),
      onOpenPath: vi.fn(() => vi.fn()),
      onPrepareClose: vi.fn(() => vi.fn()),
      closeResult: vi.fn(async () => ({ ok: true as const, value: undefined })),
      forceClose: vi.fn(async () => ({ ok: true as const, value: undefined })),
      ...overrides.application,
    },
    backup: {
      ensureCurrent: vi.fn(async () => ({ ok: true as const, value: undefined })),
      finalize: vi.fn(async () => ({
        ok: true as const,
        value: {
          trigger: "application-close" as const,
          attemptedCount: 0,
          successCount: 0,
          skippedCount: 0,
          failures: [],
          cancelled: false,
          completedAt: "2026-08-23T08:00:00.000Z",
        },
      })),
      cancelFinalization: vi.fn(async () => ({ ok: true as const, value: undefined })),
      ...overrides.backup,
    },
    snapshot: {
      create: vi.fn(async () => ({
        ok: true as const,
        value: {
          outcome: "created" as const,
          revision: 0,
          createdAt: "2026-08-16T08:00:00.000Z",
          source: "manual-save" as const,
        },
      })),
      ...overrides.snapshot,
    },
    documents: {} as PatentApi["documents"],
    assets: {} as PatentApi["assets"],
    drafts: {} as PatentApi["drafts"],
    library: {} as PatentApi["library"],
    settings: {
      read: vi.fn(async () => ({
        ok: true,
        value: { ...DEFAULT_APP_SETTINGS },
      })),
      update: vi.fn(),
      ...overrides.settings,
    } as PatentApi["settings"],
    exports: {} as PatentApi["exports"],
    menu: { onCommand: vi.fn(() => vi.fn()) },
  } as unknown as PatentApi;
}

describe("patent persistence context", () => {
  beforeEach(() => {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: (update: () => void) => {
        update();
        return { finished: Promise.resolve() } as ViewTransition;
      },
    });
  });

  test("persists a new chemical preview asset with its ordinary description edit", async () => {
    const api = patentApi();
    window.patentApi = api as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "插入化学结构" }));
    await userEvent.click(screen.getByRole("button", { name: "保存专利" }));
    await waitFor(() => expect(api.patents.applyBookEdit).toHaveBeenCalledOnce());
    expect(api.patents.applyBookEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        assets: expect.arrayContaining([expect.objectContaining({ assetId: asset(77).assetId })]),
      }),
    );
  });

  test("applies a reference plan through one settings request", async () => {
    const api = patentApi();
    window.patentApi = api as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "写入编号关键词" }));
    await userEvent.click(screen.getByRole("button", { name: "编号关键词" }));
    await waitFor(() => expect(screen.getByTestId("reference-count").textContent).toBe("1"));
    expect(api.patents.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ referenceMarks: expect.any(Array), bookEdits: expect.any(Array) }),
    );
  });

  test("isolates reference history by its initiating book and supports redo", async () => {
    const user = userEvent.setup();
    window.patentApi = patentApi();
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "写入编号关键词" }));
    await user.click(screen.getByRole("button", { name: "编号关键词" }));
    expect(screen.getByTestId("reference-count").textContent).toBe("1");
    expect(screen.getByTestId("can-undo-reference").textContent).toBe("是");

    await user.click(screen.getByRole("button", { name: "撤销标号" }));
    expect(screen.getByTestId("reference-count").textContent).toBe("0");
    expect(screen.getByTestId("can-redo-reference").textContent).toBe("是");

    await user.click(screen.getByRole("button", { name: "重做标号" }));
    expect(screen.getByTestId("reference-count").textContent).toBe("1");
    expect(screen.getByTestId("can-undo-reference").textContent).toBe("是");

    await user.click(screen.getByRole("button", { name: "切到说明书" }));
    expect(screen.getByTestId("can-undo-reference").textContent).toBe("否");
    expect(screen.getByTestId("active-book").textContent).toBe("description");
  });

  test("undoes and redoes claims supplementation as one transaction without removing registrations", async () => {
    const user = userEvent.setup();
    window.patentApi = patentApi();
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "写入编号关键词" }));
    await user.click(screen.getByRole("button", { name: "编号关键词" }));
    await user.click(screen.getByRole("button", { name: "写入编号关键词" }));
    const before = screen.getByTestId("claims-document").textContent;
    await user.click(screen.getByRole("button", { name: "增补权利要求书编号" }));
    const after = screen.getByTestId("claims-document").textContent;
    expect(after).not.toBe(before);
    expect(after).toContain("夹具专利(1)");
    await user.click(screen.getByRole("button", { name: "撤销标号" }));
    expect(screen.getByTestId("claims-document").textContent).toBe(before);
    expect(screen.getByTestId("reference-count").textContent).toBe("1");
    await user.click(screen.getByRole("button", { name: "重做标号" }));
    expect(screen.getByTestId("claims-document").textContent).toBe(after);
  });

  test("undoes and redoes a fill in description without consuming claims numbering history", async () => {
    const user = userEvent.setup();
    window.patentApi = patentApi();
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "写入编号关键词" }));
    await user.click(screen.getByRole("button", { name: "编号关键词" }));
    const claims = screen.getByTestId("claims-document").textContent;
    const before = screen.getByTestId("description-document").textContent;
    await user.click(screen.getByRole("button", { name: "填入说明书" }));
    const filled = screen.getByTestId("description-document").textContent;
    expect(filled).not.toBe(before);
    await user.click(screen.getByRole("button", { name: "切到说明书" }));
    expect(screen.getByTestId("can-undo-reference").textContent).toBe("是");
    await user.click(screen.getByRole("button", { name: "撤销标号" }));
    expect(screen.getByTestId("description-document").textContent).toBe(before);
    expect(screen.getByTestId("claims-document").textContent).toBe(claims);
    expect(screen.getByTestId("reference-count").textContent).toBe("1");
    await user.click(screen.getByRole("button", { name: "重做标号" }));
    expect(screen.getByTestId("description-document").textContent).toBe(filled);
    await user.click(screen.getByRole("button", { name: "撤销标号" }));
    await user.click(screen.getByRole("button", { name: "切到权利要求" }));
    expect(screen.getByTestId("can-undo-reference").textContent).toBe("是");
    await user.click(screen.getByRole("button", { name: "撤销标号" }));
    expect(screen.getByTestId("reference-count").textContent).toBe("0");
    expect(screen.getByTestId("description-document").textContent).toBe(before);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("starts empty and creates a full five-book patent only when requested", async () => {
    const user = userEvent.setup();
    const create = vi.fn(async () => ({ ok: true as const, value: openedPatent(1, "夹具专利") }));
    window.patentApi = patentApi({ patents: { create } });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    expect(screen.getByTestId("active-name").textContent).toBe("无活动专利");
    expect(create).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "新建专利" }));

    expect(screen.getByTestId("active-name").textContent).toBe("夹具专利");
    expect(screen.getByTestId("active-book").textContent).toBe("claims");
    expect(screen.getByTestId("session-count").textContent).toBe("1");
    expect(create).toHaveBeenCalledWith({ patentType: "invention", name: "夹具专利" });
  });

  test("switches books without snapshotting two editor pages", async () => {
    const user = userEvent.setup();
    const startViewTransition = vi.fn((update: () => void) => {
      update();
      return { finished: Promise.resolve() } as ViewTransition;
    });
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    });
    window.patentApi = patentApi();

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "切到说明书" }));

    expect(screen.getByTestId("active-book").textContent).toBe("description");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.classList).not.toContain("patent-book-view-transition");
  });

  test("opens a patdoc from Windows directly on its description book", async () => {
    const onExternalPatentOpened = vi.fn();
    let openPathListener: ((path: string) => void) | undefined;
    const opened = openedPatent(1, "双击打开的专利");
    opened.patent.activeBookKind = "claims";
    const openPath = vi.fn(async () => ({ ok: true as const, value: opened }));
    window.patentApi = patentApi({
      patents: { openPath },
      application: {
        onOpenPath: vi.fn((listener: (path: string) => void) => {
          openPathListener = listener;
          return vi.fn();
        }),
      },
    });

    render(
      <PatentProvider onExternalPatentOpened={onExternalPatentOpened}>
        <Harness />
      </PatentProvider>,
    );

    act(() => openPathListener?.("C:\\patents\\双击打开.patdoc"));

    await waitFor(() => {
      expect(screen.getByTestId("active-name").textContent).toBe("双击打开的专利");
      expect(screen.getByTestId("active-book").textContent).toBe("description");
    });
    expect(openPath).toHaveBeenCalledWith("C:\\patents\\双击打开.patdoc");
    expect(onExternalPatentOpened).toHaveBeenCalledOnce();
  });

  test("flushes pending edits and atomically adopts the canonical patent returned by drawing-book deletion", async () => {
    const user = userEvent.setup();
    const opened = openedPatent(1, "切换前名称");
    const persisted = structuredClone(opened.patent);
    persisted.name = "服务端切换结果";
    persisted.drawingBooksEnabled = false;
    persisted.activeBookKind = "description";
    persisted.revision = 2;
    const applyBookEdit = vi.fn(
      async (request: PatentApplyBookEditRequest): Promise<AppResult<PatentEditAck>> => ({
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-08-08T08:00:00.000Z",
        },
      }),
    );
    const setDrawingBooksEnabled = vi.fn(async () => ({
      ok: true as const,
      value: {
        patent: persisted,
        savedAt: "2026-08-08T08:00:01.000Z",
        assetIdsForPostCommitGarbageCollection: [],
        notice: null,
      },
    }));
    window.patentApi = patentApi({
      patents: {
        create: vi.fn(async () => ({ ok: true as const, value: opened })),
        applyBookEdit,
        setDrawingBooksEnabled,
      },
    });
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "修改当前书" }));
    await user.click(screen.getByRole("button", { name: "删除附图书" }));

    await waitFor(() => expect(setDrawingBooksEnabled).toHaveBeenCalledOnce());
    expect(setDrawingBooksEnabled).toHaveBeenCalledWith({
      patentId: opened.patentId,
      sessionId: opened.sessionId,
      expectedRevision: 1,
      enabled: false,
    });
    expect(applyBookEdit).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0 }));
    expect(screen.getByTestId("active-name").textContent).toBe("服务端切换结果");
    expect(screen.getByTestId("drawing-books-enabled").textContent).toBe("已停用");
    // An available document remains selected; adopting the server aggregate
    // must not pull the user away from the document they are editing.
    expect(screen.getByTestId("active-book").textContent).toBe("claims");
    expect(screen.getByTestId("persisted-revision").textContent).toBe("2");
  });

  test("keeps the current patent untouched when drawing-book deletion fails", async () => {
    const user = userEvent.setup();
    const opened = openedPatent(1, "失败前名称");
    const setDrawingBooksEnabled = vi.fn(async () => ({
      ok: false as const,
      error: { code: "REVISION_CONFLICT" as const, message: "专利已被其他操作修改。" },
    }));
    window.patentApi = patentApi({
      patents: {
        create: vi.fn(async () => ({ ok: true as const, value: opened })),
        setDrawingBooksEnabled,
      },
    });
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "删除附图书" }));

    await waitFor(() => expect(setDrawingBooksEnabled).toHaveBeenCalledOnce());
    expect(screen.getByTestId("active-name").textContent).toBe("失败前名称");
    expect(screen.getByTestId("drawing-books-enabled").textContent).toBe("已启用");
    expect(screen.getByTestId("active-book").textContent).toBe("claims");
    expect(screen.getByTestId("persisted-revision").textContent).toBe("0");
  });

  test.each(["改名后的夹具", null])(
    "atomically adopts restored drawing books and name %s when becoming a utility model",
    async (settingsName) => {
      const user = userEvent.setup();
      const opened = openedPatent(1, "无附图发明");
      opened.patent.drawingBooksEnabled = false;
      const persisted = structuredClone(opened.patent);
      persisted.name = "恢复附图后的实用新型";
      persisted.patentType = "utility-model";
      persisted.drawingBooksEnabled = true;
      persisted.revision = 1;
      const updateSettings = vi.fn();
      const setDrawingBooksEnabled = vi.fn(async () => ({
        ok: true as const,
        value: {
          patent: persisted,
          savedAt: "2026-08-08T08:00:01.000Z",
          assetIdsForPostCommitGarbageCollection: [],
          notice: "已为实用新型恢复说明书附图和摘要附图。",
        },
      }));
      window.patentApi = patentApi({
        patents: {
          create: vi.fn(async () => ({ ok: true as const, value: opened })),
          updateSettings,
          setDrawingBooksEnabled,
        },
      });
      render(
        <PatentProvider>
          <Harness settingsName={settingsName} />
        </PatentProvider>,
      );

      await user.click(screen.getByRole("button", { name: "新建专利" }));
      await user.click(screen.getByRole("button", { name: "修改专利设置" }));

      await waitFor(() => expect(setDrawingBooksEnabled).toHaveBeenCalledOnce());
      expect(updateSettings).not.toHaveBeenCalled();
      expect(setDrawingBooksEnabled).toHaveBeenCalledWith({
        patentId: opened.patentId,
        sessionId: opened.sessionId,
        expectedRevision: 0,
        enabled: true,
        settings: {
          name: settingsName,
          customer: null,
          patentType: "utility-model",
          terminologyReplacementRequested: false,
        },
      });
      expect(screen.getByTestId("active-name").textContent).toBe("恢复附图后的实用新型");
      expect(screen.getByTestId("patent-type").textContent).toBe("utility-model");
      expect(screen.getByTestId("drawing-books-enabled").textContent).toBe("已启用");
      expect(screen.getByTestId("persisted-revision").textContent).toBe("1");
    },
  );

  test("serializes settings with surrounding edits and keeps the active session in sync", async () => {
    const user = userEvent.setup();
    const applyBookEdit = vi.fn(
      async (request: PatentApplyBookEditRequest): Promise<AppResult<PatentEditAck>> => ({
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-08-02T08:00:00.000Z",
        },
      }),
    );
    const updateSettings = vi.fn(async (request) => ({
      ok: true as const,
      value: {
        patentId: request.patentId,
        revision: request.expectedRevision + 1,
        savedAt: "2026-08-02T08:00:01.000Z",
      },
    }));
    window.patentApi = patentApi({ patents: { applyBookEdit, updateSettings } });
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "新建专利" }));

    await user.click(screen.getByRole("button", { name: "修改当前书" }));
    await user.click(screen.getByRole("button", { name: "修改专利设置" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "切到权利要求" }));
    await user.click(screen.getByRole("button", { name: "修改当前书" }));

    await waitFor(() => expect(applyBookEdit).toHaveBeenCalledTimes(2));
    expect(applyBookEdit.mock.calls.map(([request]) => request.expectedRevision)).toEqual([0, 2]);
    expect(updateSettings).toHaveBeenCalledWith({
      patentId: testUuid(101),
      expectedRevision: 1,
      name: "改名后的夹具",
      patentType: "utility-model",
    });
    expect(screen.getByTestId("active-name").textContent).toBe("改名后的夹具");
    expect(screen.getByTestId("patent-type").textContent).toBe("utility-model");
    await waitFor(() => expect(screen.getByTestId("persisted-revision").textContent).toBe("3"));
  });

  test("uses a newly filled description title when the patent was created without a name", async () => {
    const user = userEvent.setup();
    const unnamed = openedPatent(1, null);
    const onAutoTitlePersisted = vi.fn();
    const updateSettings = vi.fn(async (request) => ({
      ok: true as const,
      value: {
        patentId: request.patentId,
        revision: request.expectedRevision + 1,
        savedAt: "2026-08-02T08:00:01.000Z",
      },
    }));
    window.patentApi = patentApi({
      patents: {
        create: vi.fn(async () => ({ ok: true as const, value: unnamed })),
        updateSettings,
      },
    });
    render(
      <PatentProvider onAutoTitlePersisted={onAutoTitlePersisted}>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "填写说明书名称" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledOnce());
    expect(updateSettings).toHaveBeenCalledWith({
      patentId: unnamed.patentId,
      expectedRevision: 1,
      name: "填写的专利名称",
      patentType: "invention",
    });
    expect(screen.getByTestId("active-name").textContent).toBe("填写的专利名称");
    expect(onAutoTitlePersisted).toHaveBeenCalledWith(unnamed.patentId);
  });

  test("keeps the initial patent name when the description title is edited", async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn(async (request) => ({
      ok: true as const,
      value: {
        patentId: request.patentId,
        revision: request.expectedRevision + 1,
        savedAt: "2026-08-02T08:00:01.000Z",
      },
    }));
    window.patentApi = patentApi({ patents: { updateSettings } });
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "填写说明书名称" }));

    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    expect(updateSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId("active-name").textContent).toBe("夹具专利");
  });

  test("sends safe cross-book terminology replacements only when explicitly requested", async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn(async (request) => ({
      ok: true as const,
      value: {
        patentId: request.patentId,
        revision: request.expectedRevision + 1,
        savedAt: "2026-08-02T08:00:01.000Z",
      },
    }));
    window.patentApi = patentApi({ patents: { updateSettings } });
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "修改设置并替换术语" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledOnce());
    const request = updateSettings.mock.calls[0]?.[0];
    expect(request).toMatchObject({ patentType: "utility-model", expectedRevision: 0 });
    const descriptionEdit = request?.bookEdits?.find(
      (edit: { bookKind: string }) => edit.bookKind === "description",
    );
    expect(JSON.stringify(descriptionEdit?.document)).toContain("实用新型内容");
    expect(JSON.stringify(descriptionEdit?.document)).not.toContain("发明内容");
  });

  test("opens an already-open patent by activating it and releasing the duplicate session", async () => {
    const user = userEvent.setup();
    const first = openedPatent(1, "夹具专利");
    const duplicate = { ...first, sessionId: testUuid(299) };
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    window.patentApi = patentApi({
      patents: {
        create: vi.fn(async () => ({ ok: true as const, value: first })),
        open: vi.fn(async () => ({ ok: true as const, value: duplicate })),
        openPath: vi.fn(),
        release,
      },
    });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "打开专利" }));

    expect(screen.getByTestId("session-count").textContent).toBe("1");
    expect(release).toHaveBeenCalledWith(duplicate.sessionId);
  });

  test("queues edits for the selected book and marks the whole patent saved after persistence", async () => {
    const user = userEvent.setup();
    const applyBookEdit = vi.fn(
      async (request: PatentApplyBookEditRequest): Promise<AppResult<PatentEditAck>> => ({
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-08-02T08:00:00.000Z",
        },
      }),
    );
    window.patentApi = patentApi({ patents: { applyBookEdit } });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "切到权利要求" }));
    await user.click(screen.getByRole("button", { name: "修改当前书" }));

    await waitFor(() => expect(applyBookEdit).toHaveBeenCalledOnce());
    expect(applyBookEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        bookKind: "claims",
        expectedRevision: 0,
        editorState: { selection: "claims" },
      }),
    );
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    expect(screen.getByTestId("local-revision").textContent).toBe("1");
    expect(screen.getByTestId("persisted-revision").textContent).toBe("1");
  });

  test("late save confirmations do not replace newer queued text in the active patent", async () => {
    const user = userEvent.setup();
    let resolveFirst: ((result: AppResult<PatentEditAck>) => void) | undefined;
    const applyBookEdit = vi
      .fn()
      .mockImplementationOnce(
        (request: PatentApplyBookEditRequest) =>
          new Promise<AppResult<PatentEditAck>>((resolve) => {
            resolveFirst = () =>
              resolve({
                ok: true,
                value: {
                  patentId: request.patentId,
                  revision: request.expectedRevision + 1,
                  savedAt: "2026-08-02T08:00:00.000Z",
                },
              });
          }),
      )
      .mockImplementation(async (request: PatentApplyBookEditRequest) => ({
        ok: true as const,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-08-02T08:00:01.000Z",
        },
      }));
    window.patentApi = patentApi({ patents: { applyBookEdit } });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "修改当前书" }));
    await waitFor(() => expect(screen.getByTestId("active-book-text").textContent).toBe("修改 1"));
    await user.click(screen.getByRole("button", { name: "修改当前书" }));
    await waitFor(() => expect(screen.getByTestId("active-book-text").textContent).toBe("修改 2"));

    await act(async () => resolveFirst?.({ ok: true, value: {} as PatentEditAck }));

    await waitFor(() => expect(applyBookEdit).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("active-book-text").textContent).toBe("修改 2");
  });

  test("queues patent figure state and marks the whole patent saved after persistence", async () => {
    const user = userEvent.setup();
    const applyFigureEdit = vi.fn(
      async (request: PatentApplyFigureEditRequest): Promise<AppResult<PatentEditAck>> => ({
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-08-02T08:00:00.000Z",
        },
      }),
    );
    window.patentApi = patentApi({ patents: { applyFigureEdit } });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "修改附图" }));

    expect(screen.getByTestId("figure-count").textContent).toBe("1");
    expect(screen.getByTestId("abstract-figure").textContent).toBe(figure(1).figureId);
    await waitFor(() => expect(applyFigureEdit).toHaveBeenCalledOnce());
    expect(applyFigureEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 0,
        figures: [{ ...figure(1), widthMm: 146.6 }],
        abstractDrawingFigureId: figure(1).figureId,
        assets: [asset(1)],
      }),
    );
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    expect(screen.getByTestId("local-revision").textContent).toBe("1");
    expect(screen.getByTestId("persisted-revision").textContent).toBe("1");
  });

  test("appends imported figures to the latest queued drawing state", async () => {
    const user = userEvent.setup();
    window.patentApi = patentApi();
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "并发追加附图" }));

    expect(screen.getByTestId("figure-count").textContent).toBe("2");
    expect(screen.getByTestId("first-figure-width").textContent).toBe("60");
  });

  test("deduplicates reused generated assets before saving and retains their physical width", async () => {
    window.patentApi = patentApi();
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "插入重复资源附图" }));
    await waitFor(() => expect(window.patentApi.patents.applyFigureEdit).toHaveBeenCalled());
    expect(window.patentApi.patents.applyFigureEdit).toHaveBeenCalledWith(
      expect.objectContaining({ assets: [asset(1)], figures: [{ ...figure(1), widthMm: 25.4 }] }),
    );
  });

  test("orders drawing changes and reference panel changes on one shared undo timeline", async () => {
    const user = userEvent.setup();
    window.patentApi = patentApi();
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "写入编号关键词" }));
    await user.click(screen.getByRole("button", { name: "修改附图" }));
    await user.click(screen.getByRole("button", { name: "附图页编号" }));
    expect(screen.getByTestId("reference-count").textContent).toBe("1");
    await user.click(screen.getByRole("button", { name: "撤销附图" }));
    expect(screen.getByTestId("reference-count").textContent).toBe("0");
    expect(screen.getByTestId("figure-count").textContent).toBe("1");
    await user.click(screen.getByRole("button", { name: "撤销附图" }));
    expect(screen.getByTestId("figure-count").textContent).toBe("0");
    await user.click(screen.getByRole("button", { name: "重做附图" }));
    expect(screen.getByTestId("figure-count").textContent).toBe("1");
    expect(screen.getByTestId("reference-count").textContent).toBe("0");
    await user.click(screen.getByRole("button", { name: "重做附图" }));
    expect(screen.getByTestId("reference-count").textContent).toBe("1");
  });

  test("undoes and redoes a recorded figure-only edit", async () => {
    const user = userEvent.setup();
    window.patentApi = patentApi();
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "修改附图" }));
    expect(screen.getByTestId("figure-count").textContent).toBe("1");
    expect(screen.getByTestId("can-undo-drawing").textContent).toBe("是");

    await user.click(screen.getByRole("button", { name: "撤销附图" }));
    expect(screen.getByTestId("figure-count").textContent).toBe("0");
    expect(screen.getByTestId("abstract-figure").textContent).toBe("无");
    expect(screen.getByTestId("can-redo-drawing").textContent).toBe("是");

    await user.click(screen.getByRole("button", { name: "重做附图" }));
    expect(screen.getByTestId("figure-count").textContent).toBe("1");
    expect(screen.getByTestId("abstract-figure").textContent).toBe(figure(1).figureId);
  });

  test("refuses to close a whole patent while any book queue still fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(appDialogs, "confirmAppAction").mockResolvedValue(false);
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    window.patentApi = patentApi({
      patents: {
        release,
        applyBookEdit: vi.fn(async () => ({
          ok: false as const,
          error: { code: "DISK_FULL" as const, message: "磁盘空间不足" },
        })),
      },
    });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "修改当前书" }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("failed"));
    await user.click(screen.getByRole("button", { name: "关闭专利" }));

    expect(screen.getByTestId("session-count").textContent).toBe("1");
    expect(release).not.toHaveBeenCalled();
  });

  test("discards failed pending edits and closes the patent after confirmation", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(appDialogs, "confirmAppAction").mockResolvedValue(true);
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    window.patentApi = patentApi({
      patents: {
        release,
        applyBookEdit: vi.fn(async () => ({
          ok: false as const,
          error: { code: "INVALID_INPUT" as const, message: "输入内容无效" },
        })),
      },
    });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "修改当前书" }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("failed"));
    await user.click(screen.getByRole("button", { name: "关闭专利" }));

    await waitFor(() => expect(screen.getByTestId("session-count").textContent).toBe("0"));
    expect(confirm).toHaveBeenCalledWith(
      "保存仍然失败。是否放弃本次未保存的修改并关闭专利？已成功保存的内容不会丢失。",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  test("never offers to discard failed edits during a strict dual-view close", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(appDialogs, "confirmAppAction").mockResolvedValue(true);
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    window.patentApi = patentApi({
      patents: {
        release,
        applyBookEdit: vi.fn(async () => ({
          ok: false as const,
          error: { code: "DISK_FULL" as const, message: "磁盘空间不足" },
        })),
      },
    });
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "修改当前书" }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("failed"));
    await user.click(screen.getByRole("button", { name: "安全关闭专利" }));

    expect(screen.getByTestId("session-count").textContent).toBe("1");
    expect(confirm).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  test("drains edits arriving during the close snapshot before releasing the session", async () => {
    let finishSnapshot!: () => void;
    let finishEdit!: () => void;
    const applyBookEdit = vi.fn(
      (request: PatentApplyBookEditRequest) =>
        new Promise<AppResult<PatentEditAck>>((resolve) => {
          finishEdit = () =>
            resolve({
              ok: true,
              value: {
                patentId: request.patentId,
                revision: request.expectedRevision + 1,
                savedAt: "2026-10-10T00:00:00.000Z",
              },
            });
        }),
    );
    const createSnapshot = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSnapshot = () =>
              resolve({
                ok: true,
                value: {
                  outcome: "created",
                  revision: 0,
                  createdAt: "2026-10-10T00:00:00.000Z",
                  source: "patent-close",
                },
              });
          }),
      )
      .mockResolvedValue({
        ok: true,
        value: {
          outcome: "created",
          revision: 2,
          createdAt: "2026-10-10T00:00:00.000Z",
          source: "patent-close",
        },
      });
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    window.patentApi = patentApi({
      patents: { applyBookEdit, release },
      snapshot: { create: createSnapshot },
    }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "跟踪关闭专利" }));
    await waitFor(() => expect(createSnapshot).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "修改当前书" }));
    await userEvent.click(screen.getByRole("button", { name: "修改当前书" }));
    await act(async () => finishSnapshot());
    expect(release).not.toHaveBeenCalled();
    await act(async () => finishEdit());
    await waitFor(() => expect(applyBookEdit).toHaveBeenCalledTimes(2));
    await act(async () => finishEdit());
    await waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(createSnapshot).toHaveBeenCalledTimes(2);
  });

  test("creates one patent-close snapshot after persistence and before releasing the session", async () => {
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const createSnapshot = vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: "created" as const,
        revision: 0,
        createdAt: "2026-08-16T08:00:00.000Z",
        source: "patent-close" as const,
      },
    }));
    const api = patentApi({ patents: { release }, snapshot: { create: createSnapshot } });
    window.patentApi = api as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭专利" }));

    await waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(createSnapshot).toHaveBeenCalledWith({
      documentType: "patent",
      documentId: testUuid(101),
      source: "patent-close",
    });
    expect(vi.mocked(api.patents.flush).mock.invocationCallOrder[0]).toBeLessThan(
      createSnapshot.mock.invocationCallOrder[0] ?? 0,
    );
    expect(createSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0] ?? 0,
    );
    await waitFor(() =>
      expect(api.backup.ensureCurrent).toHaveBeenCalledWith({
        documentType: "patent",
        documentId: testUuid(101),
      }),
    );
  });

  test("retries a failed patent edit before creating the patent-close snapshot", async () => {
    const applyBookEdit = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "DISK_FULL", message: "磁盘空间不足" },
      })
      .mockImplementation(async (request: PatentApplyBookEditRequest) => ({
        ok: true as const,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-08-02T08:00:00.000Z",
        },
      }));
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const createSnapshot = vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: "created" as const,
        revision: 1,
        createdAt: "2026-08-16T08:00:00.000Z",
        source: "patent-close" as const,
      },
    }));
    window.patentApi = patentApi({
      patents: { applyBookEdit, release },
      snapshot: { create: createSnapshot },
    }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "修改当前书" }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("failed"));
    await userEvent.click(screen.getByRole("button", { name: "关闭专利" }));

    await waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(applyBookEdit).toHaveBeenCalledTimes(2);
    expect(createSnapshot).toHaveBeenCalledOnce();
  });

  test("does not release a patent until a failed close snapshot is retried successfully", async () => {
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const createSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "DISK_FULL", message: "关闭快照写入失败" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          outcome: "created",
          revision: 0,
          createdAt: "2026-08-16T08:00:00.000Z",
          source: "patent-close",
        },
      });
    window.patentApi = patentApi({
      patents: { release },
      snapshot: { create: createSnapshot },
    }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭专利" }));

    expect(await screen.findByRole("alertdialog", { name: "关闭恢复点创建失败" })).toBeDefined();
    expect(release).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "重试创建快照" }));

    await waitFor(() => expect(screen.getByTestId("session-count").textContent).toBe("0"));
    expect(createSnapshot).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  test("can retry close snapshot creation more than once before succeeding", async () => {
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const failed = {
      ok: false as const,
      error: { code: "DISK_FULL" as const, message: "关闭快照写入失败" },
    };
    const createSnapshot = vi
      .fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce({
        ok: true,
        value: {
          outcome: "created",
          revision: 0,
          createdAt: "2026-08-16T08:00:00.000Z",
          source: "patent-close",
        },
      });
    window.patentApi = patentApi({
      patents: { release },
      snapshot: { create: createSnapshot },
    }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭专利" }));
    await userEvent.click(await screen.findByRole("button", { name: "重试创建快照" }));
    await waitFor(() => expect(createSnapshot).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("button", { name: "重试创建快照" }));

    await waitFor(() => expect(screen.getByTestId("session-count").textContent).toBe("0"));
    expect(createSnapshot).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledOnce();
  });

  test("shares the first close decision with a concurrent close request", async () => {
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const createSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "DISK_FULL", message: "关闭快照写入失败" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          outcome: "created",
          revision: 0,
          createdAt: "2026-08-16T08:00:00.000Z",
          source: "patent-close",
        },
      });
    window.patentApi = patentApi({
      patents: { release },
      snapshot: { create: createSnapshot },
    }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "跟踪关闭专利" }));
    expect(await screen.findByRole("alertdialog", { name: "关闭恢复点创建失败" })).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "跟踪关闭专利" }));
    expect(screen.getByTestId("close-results").textContent).toBe("");
    expect(release).not.toHaveBeenCalled();
    expect(createSnapshot).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "重试创建快照" }));

    await waitFor(() => expect(screen.getByTestId("close-results").textContent).toBe("true,true"));
    expect(release).toHaveBeenCalledOnce();
    expect(createSnapshot).toHaveBeenCalledTimes(2);
  });

  test("deduplicates concurrent successful closes to one snapshot and one release", async () => {
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const createSnapshot = vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: "created" as const,
        revision: 0,
        createdAt: "2026-08-16T08:00:00.000Z",
        source: "patent-close" as const,
      },
    }));
    window.patentApi = patentApi({
      patents: { release },
      snapshot: { create: createSnapshot },
    }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    const closeButton = screen.getByRole("button", { name: "跟踪关闭专利" });
    act(() => {
      fireEvent.click(closeButton);
      fireEvent.click(closeButton);
    });

    await waitFor(() => expect(screen.getByTestId("close-results").textContent).toBe("true,true"));
    expect(createSnapshot).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  test("blocks application close while an individual close decision is pending", async () => {
    let prepareClose: ((token: string) => void) | undefined;
    const closeResult = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const createSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "DISK_FULL", message: "关闭快照写入失败" },
      })
      .mockResolvedValue({
        ok: true,
        value: {
          outcome: "created",
          revision: 0,
          createdAt: "2026-08-16T08:00:00.000Z",
          source: "application-close",
        },
      });
    window.patentApi = patentApi({
      patents: { release },
      snapshot: { create: createSnapshot },
      application: {
        onPrepareClose: vi.fn((listener) => {
          prepareClose = listener;
          return vi.fn();
        }),
        closeResult,
      },
    }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "跟踪关闭专利" }));
    expect(await screen.findByRole("alertdialog", { name: "关闭恢复点创建失败" })).toBeDefined();

    await act(async () => prepareClose?.(testUuid(781)));

    expect(closeResult).toHaveBeenCalledWith({ token: testUuid(781), proceed: false });
    expect(createSnapshot).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "取消关闭" }));
    await waitFor(() => expect(screen.getByTestId("close-results").textContent).toBe("false"));
  });

  test("cancels patent close without releasing after a snapshot creation failure", async () => {
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const createSnapshot = vi.fn(async () => ({
      ok: false as const,
      error: { code: "DISK_FULL" as const, message: "关闭快照写入失败" },
    }));
    window.patentApi = patentApi({
      patents: { release },
      snapshot: { create: createSnapshot },
    }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭专利" }));
    await userEvent.click(await screen.findByRole("button", { name: "取消关闭" }));

    expect(screen.getByTestId("session-count").textContent).toBe("1");
    expect(release).not.toHaveBeenCalled();
  });

  test("still closes on request and exposes that the close recovery point was not created", async () => {
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const createSnapshot = vi.fn(async () => ({
      ok: false as const,
      error: { code: "DISK_FULL" as const, message: "关闭快照写入失败" },
    }));
    window.patentApi = patentApi({
      patents: { release },
      snapshot: { create: createSnapshot },
    }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭专利" }));
    await userEvent.click(await screen.findByRole("button", { name: "仍然关闭" }));

    await waitFor(() => expect(screen.getByTestId("session-count").textContent).toBe("0"));
    expect(release).toHaveBeenCalledOnce();
    expect(
      within(screen.getByRole("alert")).getByText(
        "正文及编辑内容已经安全保存，但本次关闭恢复点未能创建。",
      ),
    ).toBeDefined();
  });

  test("application close waits for all patent queues and reports false if any patent cannot flush", async () => {
    const user = userEvent.setup();
    let prepareClose: ((token: string) => void) | undefined;
    const closeResult = vi.fn(async () => ({ ok: true as const, value: undefined }));
    window.patentApi = patentApi({
      patents: {
        applyBookEdit: vi.fn(async () => ({
          ok: false as const,
          error: { code: "DISK_FULL" as const, message: "磁盘空间不足" },
        })),
      },
      application: {
        onPrepareClose: vi.fn((listener) => {
          prepareClose = listener;
          return vi.fn();
        }),
        closeResult,
      },
    });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "修改当前书" }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("failed"));

    await act(async () => prepareClose?.(testUuid(777)));

    expect(closeResult).toHaveBeenCalledWith({ token: testUuid(777), proceed: false });
  });

  test("application close creates an application-close snapshot after every patent queue drains", async () => {
    let prepareClose: ((token: string) => void) | undefined;
    const closeResult = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const createSnapshot = vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: "created" as const,
        revision: 0,
        createdAt: "2026-08-16T08:00:00.000Z",
        source: "application-close" as const,
      },
    }));
    const api = patentApi({
      snapshot: { create: createSnapshot },
      application: {
        onPrepareClose: vi.fn((listener) => {
          prepareClose = listener;
          return vi.fn();
        }),
        closeResult,
      },
    });
    window.patentApi = api as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await act(async () => prepareClose?.(testUuid(778)));

    await waitFor(() =>
      expect(closeResult).toHaveBeenCalledWith({ token: testUuid(778), proceed: true }),
    );
    expect(createSnapshot).toHaveBeenCalledWith({
      documentType: "patent",
      documentId: testUuid(101),
      source: "application-close",
    });
    expect(vi.mocked(api.patents.flush).mock.invocationCallOrder[0]).toBeLessThan(
      createSnapshot.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test("retries failed patent persistence before creating an application-close snapshot", async () => {
    let prepareClose: ((token: string) => void) | undefined;
    const closeResult = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const applyBookEdit = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "DISK_FULL", message: "磁盘空间不足" },
      })
      .mockImplementation(async (request: PatentApplyBookEditRequest) => ({
        ok: true as const,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-08-02T08:00:00.000Z",
        },
      }));
    const createSnapshot = vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: "created" as const,
        revision: 1,
        createdAt: "2026-08-16T08:00:00.000Z",
        source: "application-close" as const,
      },
    }));
    window.patentApi = patentApi({
      patents: { applyBookEdit },
      snapshot: { create: createSnapshot },
      application: {
        onPrepareClose: vi.fn((listener) => {
          prepareClose = listener;
          return vi.fn();
        }),
        closeResult,
      },
    }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "修改当前书" }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("failed"));
    await act(async () => prepareClose?.(testUuid(780)));

    await waitFor(() =>
      expect(closeResult).toHaveBeenCalledWith({ token: testUuid(780), proceed: true }),
    );
    expect(applyBookEdit).toHaveBeenCalledTimes(2);
    expect(createSnapshot).toHaveBeenCalledOnce();
  });

  test("cancels application close when an application-close snapshot cannot be created", async () => {
    let prepareClose: ((token: string) => void) | undefined;
    const closeResult = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const createSnapshot = vi.fn(async () => ({
      ok: false as const,
      error: { code: "DISK_FULL" as const, message: "应用关闭快照写入失败" },
    }));
    window.patentApi = patentApi({
      snapshot: { create: createSnapshot },
      application: {
        onPrepareClose: vi.fn((listener) => {
          prepareClose = listener;
          return vi.fn();
        }),
        closeResult,
      },
    }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    act(() => prepareClose?.(testUuid(779)));
    await userEvent.click(await screen.findByRole("button", { name: "取消关闭" }));

    await waitFor(() =>
      expect(closeResult).toHaveBeenCalledWith({ token: testUuid(779), proceed: false }),
    );
  });

  test("save retries a failed edit and then flushes the aggregate revision", async () => {
    const user = userEvent.setup();
    const applyBookEdit = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "DISK_FULL", message: "磁盘空间不足" },
      })
      .mockImplementation(async (request: PatentApplyBookEditRequest) => ({
        ok: true as const,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-08-02T08:00:00.000Z",
        },
      }));
    const flush = vi.fn(
      async (request: PatentFlushRequest): Promise<AppResult<PatentFlushResult>> => ({
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision,
          flushedAt: "2026-08-02T08:00:01.000Z",
        },
      }),
    );
    window.patentApi = patentApi({ patents: { applyBookEdit, flush } });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "修改当前书" }));
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("failed"));
    await user.click(screen.getByRole("button", { name: "保存专利" }));

    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));
    expect(applyBookEdit).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledWith({
      patentId: testUuid(101),
      expectedRevision: 1,
    });
  });

  test("manual save drains and verifies persistence before creating one manual-save snapshot", async () => {
    const user = userEvent.setup();
    const createSnapshot = vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: "created" as const,
        revision: 1,
        createdAt: "2026-08-16T08:00:00.000Z",
        source: "manual-save" as const,
      },
    }));
    const api = patentApi({ snapshot: { create: createSnapshot } });
    window.patentApi = api as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "修改当前书" }));
    await user.click(screen.getByRole("button", { name: "保存专利" }));

    await waitFor(() => expect(createSnapshot).toHaveBeenCalledOnce());
    expect(createSnapshot).toHaveBeenCalledWith({
      documentType: "patent",
      documentId: testUuid(101),
      source: "manual-save",
    });
    expect(vi.mocked(api.patents.applyBookEdit).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.patents.flush).mock.invocationCallOrder[0] ?? 0,
    );
    expect(vi.mocked(api.patents.flush).mock.invocationCallOrder[0]).toBeLessThan(
      createSnapshot.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test("treats an already-existing manual-save snapshot as a successful save", async () => {
    const createSnapshot = vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: "already-exists" as const,
        revision: 0,
        createdAt: "2026-08-16T07:00:00.000Z",
        source: "automatic" as const,
      },
    }));
    window.patentApi = patentApi({ snapshot: { create: createSnapshot } }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "保存专利" }));

    await waitFor(() => expect(createSnapshot).toHaveBeenCalledOnce());
    expect(screen.getByTestId("save-state").textContent).toBe("saved");
  });

  test("keeps the body saved and shows the specific manual snapshot error", async () => {
    const createSnapshot = vi.fn(async () => ({
      ok: false as const,
      error: { code: "DISK_FULL" as const, message: "快照磁盘空间不足" },
    }));
    window.patentApi = patentApi({ snapshot: { create: createSnapshot } }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "保存专利" }));

    expect(
      await screen.findByText("正文已经保存，但“手动保存”快照创建失败：快照磁盘空间不足。请重试。"),
    ).toBeDefined();
    expect(
      screen
        .getByRole("alertdialog", { name: "手动保存快照创建失败" })
        .classList.contains("standard-dialog--s"),
    ).toBe(true);
    expect(screen.getByTestId("save-state").textContent).toBe("saved");
  });

  test("prepares export with persistence only and does not create a snapshot", async () => {
    const createSnapshot = vi.fn();
    window.patentApi = patentApi({ snapshot: { create: createSnapshot } }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "准备导出" }));

    await waitFor(() =>
      expect(screen.getByTestId("export-preparation").textContent).not.toBe("未准备"),
    );
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  test("prepares AI correction with persistence only and does not create a snapshot", async () => {
    const createSnapshot = vi.fn();
    window.patentApi = patentApi({ snapshot: { create: createSnapshot } }) as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "准备 AI 修订" }));

    await waitFor(() =>
      expect(screen.getByTestId("ai-preparation").textContent).not.toBe("未准备"),
    );
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  test("prepares export only after the pending edit is persisted", async () => {
    const user = userEvent.setup();
    let resolveEdit: ((result: AppResult<PatentEditAck>) => void) | undefined;
    const applyBookEdit = vi.fn(
      (request: PatentApplyBookEditRequest) =>
        new Promise<AppResult<PatentEditAck>>((resolve) => {
          resolveEdit = () =>
            resolve({
              ok: true,
              value: {
                patentId: request.patentId,
                revision: request.expectedRevision + 1,
                savedAt: "2026-08-02T08:00:00.000Z",
              },
            });
        }),
    );
    const flush = vi.fn(
      async (request: PatentFlushRequest): Promise<AppResult<PatentFlushResult>> => ({
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision,
          flushedAt: "2026-08-02T08:00:01.000Z",
        },
      }),
    );
    window.patentApi = patentApi({ patents: { applyBookEdit, flush } });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新建专利" }));
    await user.click(screen.getByRole("button", { name: "修改当前书" }));
    await waitFor(() => expect(applyBookEdit).toHaveBeenCalledOnce());
    const preparation = user.click(screen.getByRole("button", { name: "准备导出" }));

    expect(screen.getByTestId("export-preparation").textContent).toBe("未准备");
    await act(async () => resolveEdit?.({ ok: true, value: {} as PatentEditAck }));
    await preparation;

    await waitFor(() =>
      expect(screen.getByTestId("export-preparation").textContent).toBe(
        `${testUuid(101)}|${testUuid(201)}|1|夹具专利`,
      ),
    );
    expect(flush).toHaveBeenCalledWith({ patentId: testUuid(101), expectedRevision: 1 });
  });

  test("applies page margins to every book of an opened patent immediately", async () => {
    const user = userEvent.setup();
    const applyBookEdit = vi.fn(
      async (request: PatentApplyBookEditRequest): Promise<AppResult<PatentEditAck>> => ({
        ok: true,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-08-02T08:00:00.000Z",
        },
      }),
    );
    window.patentApi = patentApi({ patents: { applyBookEdit } });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await user.click(screen.getByRole("button", { name: "新建专利" }));

    await user.click(screen.getByRole("button", { name: "应用边距" }));

    await waitFor(() =>
      expect(screen.getByTestId("active-book-margin-top").textContent).toBe("30"),
    );
    expect(screen.getByTestId("active-book-margin-left").textContent).toBe("20");
    // 所有五书（claims/description/abstract/abstract-drawing/figures）都应同步。
    expect(screen.getByTestId("all-books-margin-top").textContent?.split(",")).toEqual([
      "30",
      "30",
      "30",
      "30",
      "30",
    ]);
    await waitFor(() => expect(applyBookEdit).toHaveBeenCalled());
  });

  test("inherits the current global page margins when installing an opened patent", async () => {
    const user = userEvent.setup();
    const read = vi.fn(async () => ({
      ok: true as const,
      value: {
        ...DEFAULT_APP_SETTINGS,
        pageMargins: {
          marginTopMm: 30,
          marginRightMm: 20,
          marginBottomMm: 30,
          marginLeftMm: 20,
        },
      },
    }));
    window.patentApi = patentApi({ settings: { read } });

    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    // 等设置读取完成后新建专利，install 时按全局设置同步五书 page。
    await waitFor(() => expect(read).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "新建专利" }));

    await waitFor(() =>
      expect(screen.getByTestId("active-book-margin-top").textContent).toBe("30"),
    );
    expect(screen.getByTestId("active-book-margin-left").textContent).toBe("20");
  });
});

test("automation barrier freezes edits, ignores stale release and adopts a new undo boundary", async () => {
  let eventListener!: (
    event: import("../../../shared/automation/protocol").AutomationEvent,
  ) => void;
  const unsubscribe = vi.fn();
  const control = vi.fn(async () => ({ ok: true as const, value: null }));
  const api = patentApi();
  window.patentApi = {
    ...api,
    automation: {
      control,
      onEvent: (listener: typeof eventListener) => {
        eventListener = listener;
        return unsubscribe;
      },
    },
  } as unknown as PatentApi;
  let context!: ReturnType<typeof usePatents>;
  function Probe() {
    context = usePatents();
    return <Harness />;
  }
  const view = render(
    <PatentProvider>
      <Probe />
    </PatentProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "打开专利" }));
  const patentId = testUuid(101),
    token = testUuid(900);
  await act(async () => context.activateBook(patentId, "claims"));
  await act(async () => eventListener({ type: "barrier", patentId, token, phase: "probe" }));
  expect(control).toHaveBeenCalledWith(
    expect.objectContaining({ phase: "probe", ok: true, dirty: false }),
  );
  await act(async () => eventListener({ type: "barrier", patentId, token, phase: "drain" }));
  expect(context.isAutomationReadOnly(patentId)).toBe(true);
  expect(control).toHaveBeenCalledWith(
    expect.objectContaining({ phase: "drain", ok: true, dirty: false }),
  );
  await act(async () =>
    eventListener({ type: "barrier", patentId, token: testUuid(901), phase: "release" }),
  );
  expect(context.isAutomationReadOnly(patentId)).toBe(true);
  const active = context.activeSession;
  if (!active) throw new Error("Expected open session");
  const document = active.patent.books.find((book) => book.kind === "description")?.document;
  if (!document) throw new Error("Expected description");
  await act(async () =>
    context.updateBookDocument(patentId, "description", { ...document, title: "不能写入" }),
  );
  expect(api.patents.applyBookEdit).not.toHaveBeenCalled();
  const patent = {
    ...active.patent,
    revision: active.persistedRevision + 1,
    name: "agent 已保存版本",
    activeBookKind: "description" as const,
  };
  await act(async () =>
    eventListener({ type: "barrier", patentId, token, phase: "adopt", patent }),
  );
  expect(context.activeSession?.patent.name).toBe("agent 已保存版本");
  expect(context.activeSession?.activeBookKind).toBe("claims");
  expect(context.automationEditorEpoch(patentId)).toBe(1);
  await act(async () => eventListener({ type: "barrier", patentId, token, phase: "release" }));
  expect(context.isAutomationReadOnly(patentId)).toBe(false);
  view.unmount();
  expect(unsubscribe).toHaveBeenCalled();
});

test("automation probe refuses active IME composition without changing local state", async () => {
  let eventListener!: (
    event: import("../../../shared/automation/protocol").AutomationEvent,
  ) => void;
  const control = vi.fn(async () => ({ ok: true as const, value: null }));
  const api = patentApi();
  window.patentApi = {
    ...api,
    automation: {
      control,
      onEvent: (listener: typeof eventListener) => {
        eventListener = listener;
        return () => {};
      },
    },
  } as unknown as PatentApi;
  render(
    <PatentProvider>
      <Harness />
    </PatentProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "打开专利" }));
  fireEvent.compositionStart(document.body);
  await act(async () =>
    eventListener({
      type: "barrier",
      patentId: testUuid(101),
      token: testUuid(900),
      phase: "probe",
    }),
  );
  expect(control).toHaveBeenCalledWith(expect.objectContaining({ phase: "probe", ok: false }));
  expect(api.patents.flush).not.toHaveBeenCalled();
  fireEvent.compositionEnd(document.body);
});

test("failed automation adoption keeps the document read-only through release until explicit resync", async () => {
  let listener!: (event: import("../../../shared/automation/protocol").AutomationEvent) => void;
  const api = patentApi();
  let persisted!: CanonicalPatent;
  const control = vi.fn(
    async (request: import("../../../shared/automation/protocol").AutomationUiRequest) => ({
      ok: true as const,
      value: request.action === "resync" ? persisted : null,
    }),
  );
  window.patentApi = {
    ...api,
    automation: {
      control,
      onEvent: (callback: typeof listener) => {
        listener = callback;
        return () => {};
      },
    },
  } as unknown as PatentApi;
  let context!: ReturnType<typeof usePatents>;
  function Probe() {
    context = usePatents();
    return <Harness />;
  }
  render(
    <PatentProvider>
      <Probe />
    </PatentProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "打开专利" }));
  const patentId = testUuid(101),
    token = testUuid(902);
  const active = context.activeSession;
  if (!active) throw new Error("Expected open session");
  persisted = { ...active.patent, revision: active.persistedRevision + 1, name: "已保存新版本" };
  await act(async () => listener({ type: "barrier", patentId, token, phase: "drain" }));
  await act(async () =>
    listener({ type: "barrier", patentId, token, phase: "adopt", patent: active.patent }),
  );
  expect(control).toHaveBeenCalledWith(expect.objectContaining({ phase: "adopt", ok: false }));
  await act(async () => listener({ type: "barrier", patentId, token, phase: "release" }));
  expect(context.isAutomationReadOnly(patentId)).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "重新同步已保存版本" }));
  await waitFor(() => expect(context.isAutomationReadOnly(patentId)).toBe(false));
  expect(context.activeSession?.patent.name).toBe("已保存新版本");
  expect(context.automationEditorEpoch(patentId)).toBe(1);
});

test("committed release without adoption keeps the old document read-only until resync", async () => {
  let listener!: (event: import("../../../shared/automation/protocol").AutomationEvent) => void;
  const api = patentApi();
  let persisted!: CanonicalPatent;
  const control = vi.fn(
    async (request: import("../../../shared/automation/protocol").AutomationUiRequest) => ({
      ok: true as const,
      value: request.action === "resync" ? persisted : null,
    }),
  );
  window.patentApi = {
    ...api,
    automation: {
      control,
      onEvent: (callback: typeof listener) => {
        listener = callback;
        return () => {};
      },
    },
  } as unknown as PatentApi;
  let context!: ReturnType<typeof usePatents>;
  function Probe() {
    context = usePatents();
    return <Harness />;
  }
  render(
    <PatentProvider>
      <Probe />
    </PatentProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "打开专利" }));
  const patentId = testUuid(101),
    token = testUuid(902);
  const active = context.activeSession;
  if (!active) throw new Error("Expected open session");
  persisted = { ...active.patent, revision: active.persistedRevision + 1, name: "已保存新版本" };
  await act(async () => listener({ type: "barrier", patentId, token, phase: "drain" }));
  await act(async () =>
    listener({ type: "barrier", patentId, token, phase: "release", committed: true }),
  );
  expect(context.isAutomationReadOnly(patentId)).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "重新同步已保存版本" }));
  await waitFor(() => expect(context.isAutomationReadOnly(patentId)).toBe(false));
  expect(context.activeSession?.patent.name).toBe("已保存新版本");
  expect(context.automationEditorEpoch(patentId)).toBe(1);
});

test.each(["saved", "failed", "snapshot-failed", "composing"] as const)(
  "automation close uses safe persistence for %s editor state",
  async (mode) => {
    let listener!: (event: import("../../../shared/automation/protocol").AutomationEvent) => void;
    const control = vi.fn(async () => ({ ok: true as const, value: null }));
    const confirm = vi.spyOn(appDialogs, "confirmAppAction").mockResolvedValue(true);
    const api = patentApi(
      mode === "failed"
        ? {
            patents: {
              applyBookEdit: vi.fn(async () => ({
                ok: false as const,
                error: { code: "DISK_FULL" as const, message: "fixture" },
              })),
            },
          }
        : {},
    );
    if (mode === "snapshot-failed")
      vi.mocked(api.snapshot.create).mockResolvedValue({
        ok: false,
        error: { code: "DISK_FULL", message: "fixture" },
      });
    window.patentApi = {
      ...api,
      automation: {
        control,
        onEvent: (callback: typeof listener) => {
          listener = callback;
          return () => {};
        },
      },
    } as unknown as PatentApi;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "打开专利" }));
    if (mode === "failed") {
      await userEvent.click(screen.getByRole("button", { name: "修改当前书" }));
      await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("failed"));
    }
    if (mode === "composing") fireEvent.compositionStart(document.body);
    await act(async () =>
      listener({
        type: "close",
        patentId: testUuid(101),
        sessionId: testUuid(201),
        token: testUuid(950),
      }),
    );
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith({
        action: "closeAck",
        token: testUuid(950),
        sessionId: testUuid(201),
        ok: mode === "saved",
      }),
    );
    expect(screen.getByTestId("session-count").textContent).toBe(mode === "saved" ? "0" : "1");
    expect(confirm).not.toHaveBeenCalled();
    if (mode !== "saved") expect(api.patents.release).not.toHaveBeenCalled();
    fireEvent.compositionEnd(document.body);
  },
);

test("concurrent patent opens release duplicate backend sessions before closing the visible tab", async () => {
  const first = openedPatent(1);
  const second = { ...first, sessionId: testUuid(998) };
  const api = patentApi({
    patents: {
      open: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: first })
        .mockResolvedValueOnce({ ok: true, value: second }),
    },
  });
  window.patentApi = api as PatentApi;
  let context!: ReturnType<typeof usePatents>;
  function Probe() {
    context = usePatents();
    return <Harness />;
  }
  render(
    <PatentProvider>
      <Probe />
    </PatentProvider>,
  );
  await act(async () => {
    await Promise.all([context.openPatent(first.patentId), context.openPatent(first.patentId)]);
  });
  expect(context.state.sessions).toHaveLength(1);
  expect(api.patents.release).toHaveBeenCalledWith(second.sessionId);
  await act(async () => {
    await context.closePatent(first.patentId);
  });
  expect(context.state.sessions).toHaveLength(0);
  expect(api.patents.release).toHaveBeenCalledWith(first.sessionId);
});

test.each(["saved", "snapshot-failed", "cancelled"] as const)(
  "reopening a patent waits for its pending close (%s)",
  async (outcome) => {
    const first = openedPatent(1);
    const reopened = { ...first, sessionId: testUuid(998) };
    let finishSnapshot!: (value: Awaited<ReturnType<PatentApi["snapshot"]["create"]>>) => void;
    const createSnapshot = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<PatentApi["snapshot"]["create"]>>>((resolve) => {
          finishSnapshot = resolve;
        }),
    );
    const api = patentApi({
      patents: {
        open: vi
          .fn()
          .mockResolvedValueOnce({ ok: true, value: first })
          .mockResolvedValue({ ok: true, value: reopened }),
      },
      snapshot: { create: createSnapshot },
    });
    window.patentApi = api as PatentApi;
    let context!: ReturnType<typeof usePatents>;
    function Probe() {
      context = usePatents();
      return <Harness />;
    }
    render(
      <PatentProvider>
        <Probe />
      </PatentProvider>,
    );
    await act(async () => {
      await context.openPatent(first.patentId);
    });
    let closing!: Promise<boolean>;
    let opening!: ReturnType<typeof context.openPatent>;
    act(() => {
      closing = context.closePatent(first.patentId, {
        allowDiscardOnSaveFailure: outcome === "cancelled",
      });
    });
    await waitFor(() => expect(createSnapshot).toHaveBeenCalledOnce());
    await act(async () => {
      opening = context.openPatent(first.patentId);
    });
    const callsBeforeClose = vi.mocked(api.patents.open).mock.calls.length;
    await act(async () => {
      finishSnapshot(
        outcome === "saved"
          ? {
              ok: true,
              value: {
                outcome: "created",
                revision: 0,
                createdAt: "2026-10-12T00:00:00.000Z",
                source: "patent-close",
              },
            }
          : { ok: false, error: { code: "DISK_FULL", message: "snapshot unavailable" } },
      );
    });
    if (outcome === "cancelled") {
      expect(api.patents.release).not.toHaveBeenCalled();
      await userEvent.click(await screen.findByRole("button", { name: "取消关闭" }));
    }
    await act(async () => {
      await closing;
      await opening;
    });
    expect(callsBeforeClose).toBe(1);
    expect(await closing).toBe(outcome === "saved");
    expect(context.state.sessions).toHaveLength(1);
    expect(context.state.sessions[0]?.sessionId).toBe(
      outcome === "saved" ? reopened.sessionId : first.sessionId,
    );
    expect(api.patents.release).toHaveBeenCalledTimes(1);
    expect(api.patents.release).toHaveBeenCalledWith(
      outcome === "saved" ? first.sessionId : reopened.sessionId,
    );
    expect(context.state.sessions[0]?.patent).toEqual(first.patent);
  },
);

test("CLI creation notifications immediately display the new patent while preserving existing drafts", async () => {
  let listener!: (event: import("../../../shared/automation/protocol").AutomationEvent) => void;
  const api = patentApi();
  const added = openedPatent(2, "Agent新建专利");
  const open = vi.fn(async () => ({ ok: true, value: added }));
  window.patentApi = {
    ...api,
    patents: { ...api.patents, open },
    automation: {
      onEvent: (fn: typeof listener) => {
        listener = fn;
        return () => {};
      },
      control: vi.fn(async () => ({ ok: true, value: null })),
    },
  } as unknown as PatentApi;
  let context!: ReturnType<typeof usePatents>;
  function Probe() {
    context = usePatents();
    return <Harness />;
  }
  render(
    <PatentProvider>
      <Probe />
    </PatentProvider>,
  );
  await act(async () => {
    await context.newPatent({ patentType: "invention", name: "夹具专利" });
  });
  act(() =>
    listener({
      type: "libraryChanged",
      patentIds: [added.patentId],
      createdPatentIds: [added.patentId],
    }),
  );
  await waitFor(() => expect(context.state.activePatentId).toBe(added.patentId));
  expect(context.state.sessions).toHaveLength(2);
  expect(context.state.sessions[0]!.patent.name).toBe("夹具专利");
});

test.each([false, true])(
  "closing preserves CAD and detail resources while pruning only unused vectors (orphan=%s)",
  async (orphan) => {
    const opened = openedPatent(1);
    const vectors = Array.from(
      { length: 7 },
      (_, i): AssetDescriptor => ({
        ...asset(i + 20),
        kind: "vector-image",
        mediaType: "image/svg+xml",
        extension: "svg",
      }),
    );
    const project = drawingProjectFixture(vectors[0]!.assetId);
    project.cad = {
      version: 1,
      engine: "cadcraft",
      engineVersion: "a".repeat(40),
      assetId: vectors[1]!.assetId,
      overlayAssetId: vectors[2]!.assetId,
      mapping: { originX: 0, originY: 0, scale: 1 },
    };
    project.detailViews![0]!.cadSource = {
      ...project.cad,
      assetId: vectors[3]!.assetId,
      baseAssetId: vectors[4]!.assetId,
      overlayAssetId: vectors[5]!.assetId,
    };
    opened.patent.drawingProjects = [project];
    opened.patent.assets = vectors.slice(0, orphan ? 7 : 6);
    CanonicalPatentSchema.parse(opened.patent);
    const applyFigureEdit = vi.fn(async (request: PatentApplyFigureEditRequest) => {
      CanonicalPatentSchema.parse({ ...opened.patent, assets: request.assets });
      return {
        ok: true as const,
        value: {
          patentId: request.patentId,
          revision: request.expectedRevision + 1,
          savedAt: "2026-10-15T00:00:00.000Z",
        },
      };
    });
    const api = patentApi({
      patents: {
        create: vi.fn(async () => ({ ok: true as const, value: opened })),
        applyFigureEdit,
      },
    });
    window.patentApi = api;
    render(
      <PatentProvider>
        <Harness />
      </PatentProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "新建专利" }));
    await userEvent.click(screen.getByRole("button", { name: "安全关闭专利" }));
    await waitFor(() => expect(screen.getByTestId("session-count").textContent).toBe("0"));
    expect(api.patents.release).toHaveBeenCalledWith(opened.sessionId);
    if (orphan)
      expect(applyFigureEdit).toHaveBeenCalledWith(
        expect.objectContaining({ assets: vectors.slice(0, 6) }),
      );
    else expect(applyFigureEdit).not.toHaveBeenCalled();
  },
);
