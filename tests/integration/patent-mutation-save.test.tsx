import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { createLibraryRuntime } from "../../src/main/library/library-runtime";
import { ApplicationCloseProvider } from "../../src/renderer/src/app/application-close-coordinator";
import {
  ContentFingerprint,
  documentEcho,
  rememberDocumentEcho,
} from "../../src/renderer/src/editor/content-fingerprint";
import { PatentProvider, usePatents } from "../../src/renderer/src/patents/patent-context";
import type { FlowchartOpenedProject, PatentApi } from "../../src/shared/ipc/contract";
import type { AppError, AppResult } from "../../src/shared/ipc/result";
import type { CanonicalPatent } from "../../src/shared/patent/model";
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_PATENT_TEMPLATE_SETTINGS,
} from "../../src/shared/settings/model";

const source = new TextEncoder().encode(
  '<mxfile><diagram id="page-1"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>',
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function claimsBook(patent: CanonicalPatent) {
  const book = patent.books.find((candidate) => candidate.kind === "claims");
  if (!book) throw new Error("Missing claims book fixture");
  return book;
}

test.each([
  "create",
  "rename",
  "rename-source",
  "duplicate",
  "delete",
  "import",
  "preview",
  "preview-figure",
  "drawing-books",
] as const)(
  "%s preserves and saves book typing while a committed mutation reply is delayed",
  async (operation) => {
    const root = await mkdtemp(join(tmpdir(), "zxw-mutation-save-"));
    const runtime = await createLibraryRuntime({
      libraryRoot: root,
      readOnly: false,
      runRecovery: false,
      startBackgroundSchedulers: false,
    });
    const opened = await runtime.patents.create({
      patentType: "invention",
      name: "并发保存测试",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
    const committed = deferred();
    const reply = deferred();
    let holdReply = false;
    let bookWrites = 0;
    let context!: ReturnType<typeof usePatents>;
    function session() {
      const current = context.activeSession;
      if (!current) throw new Error("Missing active session fixture");
      return current;
    }
    async function transport<T>(work: () => Promise<T>, mutation = false): Promise<AppResult<T>> {
      try {
        const value = await work();
        if (mutation && holdReply) {
          committed.resolve();
          await reply.promise;
        }
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: (error as AppError).code ?? "INTERNAL",
            message: (error as Error).message,
          },
        };
      }
    }
    function projectTransport(
      work: () => Promise<Omit<FlowchartOpenedProject, "source"> & { source: Uint8Array }>,
      mutation = true,
    ) {
      return transport(async () => {
        const value = await work();
        return { ...value, source: Uint8Array.from(value.source) };
      }, mutation);
    }
    const api = {
      application: {},
      settings: { read: async () => ({ ok: true, value: DEFAULT_APP_SETTINGS }) },
      patents: {
        create: async () => ({ ok: true, value: opened }),
        applyBookEdit: (request) => {
          bookWrites += 1;
          return transport(() => runtime.patents.applyBookEdit(request));
        },
        applyFigureEdit: (request) => transport(() => runtime.patents.applyFigureEdit(request)),
        flush: (request) =>
          transport(() => runtime.patents.flush(request.patentId, request.expectedRevision)),
        release: (sessionId) => transport(() => runtime.patents.release(sessionId)),
        setDrawingBooksEnabled: (request) =>
          transport(() => runtime.patents.setDrawingBooksEnabled(request), true),
      },
      flowcharts: {
        create: (request) => projectTransport(() => runtime.flowcharts.create(request)),
        rename: (request) => projectTransport(() => runtime.flowcharts.rename(request)),
        duplicate: (request) => projectTransport(() => runtime.flowcharts.duplicate(request)),
        delete: (request) => transport(() => runtime.flowcharts.delete(request), true),
        save: (request) => projectTransport(() => runtime.flowcharts.save(request), false),
        importFile: (request) =>
          projectTransport(
            () =>
              runtime.flowcharts.create({
                ...request,
                name: "导入流程图",
                source,
                pageCount: 1,
                lastPageId: "page-1",
              }),
            true,
          ),
        commitPreview: (request) =>
          transport(() => runtime.flowcharts.commitPreview(request), true),
      },
    } satisfies {
      application: object;
      settings: Pick<PatentApi["settings"], "read">;
      patents: Pick<
        PatentApi["patents"],
        | "create"
        | "applyBookEdit"
        | "applyFigureEdit"
        | "flush"
        | "release"
        | "setDrawingBooksEnabled"
      >;
      flowcharts: Pick<
        PatentApi["flowcharts"],
        "create" | "rename" | "duplicate" | "delete" | "save" | "importFile" | "commitPreview"
      >;
    };
    window.patentApi = api as unknown as PatentApi;
    function Harness() {
      context = usePatents();
      return null;
    }
    try {
      render(
        createElement(
          ApplicationCloseProvider,
          null,
          createElement(PatentProvider, null, createElement(Harness)),
        ),
      );
      await act(async () => {
        await context.newPatent({ patentType: "invention", name: "并发保存测试" });
      });
      const createRequest = {
        patentId: opened.patentId,
        expectedPatentRevision: 0,
        name: "流程图",
        source,
        pageCount: 1,
        lastPageId: "page-1",
      };
      const initial = await act(async () => context.flowcharts.create(createRequest));
      if (!initial.ok) throw new Error(initial.error.message);
      const project = initial.value.project;
      await act(async () => context.activateBook(opened.patentId, "claims"));
      if (operation === "preview-figure") {
        const originalPreview = await runtime.flowcharts.renderPreview({
          patentId: opened.patentId,
          projectId: project.projectId,
          expectedProjectRevision: project.revision,
          expectedSourceSha256: project.sourceSha256,
          pageId: "page-1",
          exportScope: "page",
          selectedCellIds: [],
          borderMm: 0,
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50"/></svg>',
          target: { kind: "new", insertIndex: 0 },
        });
        const original = await act(async () =>
          context.flowcharts.commitPreview({
            patentId: opened.patentId,
            sessionId: opened.sessionId,
            projectId: project.projectId,
            expectedPatentRevision: 1,
            previewToken: originalPreview.previewToken,
          }),
        );
        if (!original.ok) throw new Error(original.error.message);
      }
      const preview =
        operation === "preview" || operation === "preview-figure"
          ? await runtime.flowcharts.renderPreview({
              patentId: opened.patentId,
              projectId: project.projectId,
              expectedProjectRevision: project.revision,
              expectedSourceSha256: project.sourceSha256,
              pageId: "page-1",
              exportScope: "page",
              selectedCellIds: [],
              borderMm: 0,
              svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50"/></svg>',
              target: { kind: "new", insertIndex: 0 },
            })
          : null;
      holdReply = true;
      const request = {
        patentId: opened.patentId,
        projectId: project.projectId,
        expectedPatentRevision: 1,
        expectedProjectRevision: project.revision,
        name: "新流程图",
      };
      let mutation!: Promise<unknown>;
      await act(async () => {
        if (operation === "create")
          mutation = context.flowcharts.create({ ...createRequest, name: "新流程图" });
        else if (operation === "rename" || operation === "rename-source")
          mutation = context.flowcharts.rename(request);
        else if (operation === "duplicate") mutation = context.flowcharts.duplicate(request);
        else if (operation === "delete") mutation = context.flowcharts.delete(request);
        else if (operation === "import")
          mutation = context.flowcharts.importFile({
            patentId: opened.patentId,
            expectedPatentRevision: 1,
          });
        else if (operation === "preview" || operation === "preview-figure") {
          if (!preview) throw new Error("Missing flowchart preview fixture");
          mutation = context.flowcharts.commitPreview({
            patentId: opened.patentId,
            sessionId: opened.sessionId,
            projectId: project.projectId,
            expectedPatentRevision: 1,
            previewToken: preview.previewToken,
          });
        } else mutation = context.setDrawingBooksEnabled(opened.patentId, false);
        await committed.promise;
      });
      const book = claimsBook(session().patent);
      const document = structuredClone(book.document);
      document.content = [
        {
          id: crypto.randomUUID(),
          type: "paragraph",
          attrs: {
            alignment: "left",
            paragraphIndentMm: 0,
            lineSpacing: 1.5,
            defaultFontFamily: "SimSun",
            defaultFontSizePt: 12,
          },
          content: [{ type: "text", text: "等待期间输入的正文", marks: [] }],
        },
      ];
      document.modifiedAt = new Date().toISOString();
      const fingerprint = new ContentFingerprint({ text: "等待期间输入的正文" });
      rememberDocumentEcho(document, fingerprint);
      await act(async () => context.updateBookDocument(opened.patentId, "claims", document));
      if (operation === "preview-figure") {
        const patent = session().patent;
        await act(async () =>
          context.updatePatentFigures(
            opened.patentId,
            patent.figures.map((figure) => ({ ...figure, widthMm: 105 })),
            patent.abstractDrawingFigureId,
            patent.assets,
          ),
        );
      }
      expect(bookWrites).toBe(0);
      expect(session().saveError).toBeNull();
      const updatedSource = new TextEncoder().encode(
        '<mxfile><diagram id="page-1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>',
      );
      let sourceSave: Promise<unknown> | undefined;
      if (operation === "rename-source") {
        await act(async () => {
          sourceSave = context.flowcharts.save({
            ...request,
            source: updatedSource,
            pageCount: 1,
            lastPageId: "page-1",
          });
        });
      }
      let result: unknown;
      await act(async () => {
        reply.resolve();
        result = await mutation;
      });
      expect(operation === "drawing-books" ? result : (result as AppResult<unknown>).ok).toBe(true);
      if (sourceSave)
        await act(async () => {
          expect(((await sourceSave) as AppResult<unknown>).ok).toBe(true);
        });
      await act(async () => {
        expect(await context.persistActivePatent()).toBe(true);
      });
      await waitFor(() => expect(session().aggregateSaveState).toBe("saved"));
      const saved = await runtime.patents.loadSavedPatent(opened.patentId);
      expect(JSON.stringify(claimsBook(saved).document)).toContain("等待期间输入的正文");
      expect(session().persistedRevision).toBe(saved.revision);
      expect(session().activeBookKind).toBe("claims");
      expect(documentEcho(claimsBook(session().patent).document)).toBe(fingerprint);
      if (operation === "preview" || operation === "preview-figure") {
        expect(saved.figures).toHaveLength(operation === "preview-figure" ? 2 : 1);
        if (operation === "preview-figure") expect(saved.figures[1]?.widthMm).toBe(105);
        expect(
          saved.figures.every((figure) =>
            saved.assets.some((asset) => asset.assetId === figure.assetId),
          ),
        ).toBe(true);
        expect(session().patent.figures).toEqual(saved.figures);
      }
    } finally {
      reply.resolve();
      cleanup();
      await runtime.close();
    }
  },
  20000,
);
