import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  AutomationDocumentAssetImportSchema,
  AutomationDocumentCreateSchema,
  AutomationDocumentExportSchema,
  AutomationDocumentImportSchema,
  AutomationDocumentLifecycleSchema,
  AutomationDocumentPrintSchema,
  AutomationDocumentReadSchema,
  AutomationDocumentUpdateSchema,
} from "../../shared/automation/documents.js";
import { AutomationError, MAX_AUTOMATION_FRAME } from "../../shared/automation/protocol.js";
import { createBlankDocument } from "../../shared/document/defaults.js";
import { AssetStore as SessionAssetStore } from "../assets/asset-store.js";
import { importImage, MAX_IMAGE_BYTES } from "../assets/image-importer.js";
import type { PatdocPayload } from "../documents/patdoc-format.js";
import { readPatdoc } from "../documents/patdoc-reader.js";
import { writePatdoc } from "../documents/patdoc-writer.js";
import { createDocxPackage } from "../exports/docx-exporter.js";
import { renderPrintHtml } from "../exports/print-template.js";
import type { LibraryRuntime } from "../library/library-runtime.js";
import type { AutomationExportContext } from "./export.js";
import { remapAssets } from "./imports.js";
import { type AutomationLedger, type OperationRecord, payloadHash } from "./ledger.js";
import { readAllowedFile } from "./paths.js";
import type { AutomationPrinting } from "./printing.js";
import { publishAutomationBytes } from "./publish.js";
import { validateAutomationChemicalChanges } from "./scientific-content.js";

export async function readAutomationDocuments(
  runtime: LibraryRuntime,
  payload: unknown,
  assertAuthorized: () => void,
) {
  const input = AutomationDocumentReadSchema.parse(payload);
  assertAuthorized();
  if (input.action === "list") {
    const entries = await runtime.library.list(input.scope, true);
    assertAuthorized();
    return {
      entries: entries.slice(input.offset, input.offset + input.limit),
      total: entries.length,
    };
  }
  const current = runtime.library.captureAutomation(
    input.documentId,
    input.action === "asset" || input.persisted,
  );
  if (input.action === "get") return current;
  if (
    !runtime.assetStore
      .references({ kind: "library-document" }, [input.assetId])
      .includes(input.documentId)
  )
    throw new AutomationError("SCOPE_DENIED", "资源不属于此独立文档。");
  const asset = await runtime.assetStore.readAsset(input.assetId);
  const bytes = asset[input.variant];
  if (bytes.byteLength > MAX_AUTOMATION_FRAME * 0.7)
    throw new AutomationError("RESULT_TOO_LARGE", "素材过大，请读取预览。");
  assertAuthorized();
  return {
    descriptor: asset.descriptor,
    encoding: "base64",
    data: Buffer.from(bytes).toString("base64"),
  };
}

export async function writeAutomationDocuments(
  runtime: LibraryRuntime,
  home: string,
  command: string,
  payload: unknown,
  context: AutomationExportContext,
  pdf?: (html: string, sessionId: string) => Promise<Uint8Array>,
  printing?: AutomationPrinting,
) {
  context.assertAuthorized();
  if (command === "global.documents.create") {
    const input = AutomationDocumentCreateSchema.parse(payload);
    return importAutomationDocument(
      runtime,
      { document: createBlankDocument(input.title), assets: [], settings: {}, editorState: {} },
      context,
    );
  }
  if (command === "global.documents.import") {
    const input = AutomationDocumentImportSchema.parse(payload);
    const bytes = await readAllowedFile(
      input.path,
      [context.grant.workspace.importDirectory],
      256 * 1024 * 1024,
    );
    const directory = await mkdtemp(join(home, "document-import-"));
    try {
      const path = join(directory, "input.patdoc");
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      const document = await readPatdoc(path);
      if (!("document" in document))
        throw new AutomationError("INVALID_INPUT", "请选择独立文档 patdoc。");
      return await importAutomationDocument(runtime, document, context);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (command === "global.documents.print") {
    const input = AutomationDocumentPrintSchema.parse(payload);
    if (!printing) throw new AutomationError("UNAVAILABLE", "打印服务不可用。");
    const current = runtime.library.captureAutomation(input.documentId, input.persisted);
    if (current.revision !== input.expectedRevision)
      throw new AutomationError("REVISION_CONFLICT", "文档版本已变化。");
    const printers = await printing.printers();
    if (!printers.some((p) => p.deviceName === input.output.printerDeviceName))
      throw new AutomationError("PRINTER_UNAVAILABLE", "指定打印机不可用。");
    const release = await runtime.assetStore.leaseSnapshotAssets(
      current.document.assets.map((a) => a.assetId),
    );
    try {
      const assets = await Promise.all(
        current.document.assets.map((a) => runtime.assetStore.readAsset(a.assetId)),
      );
      const warnings: Array<{ code: string; severity: string; message: string }> = [];
      const html = await renderPrintHtml(current.document, assets, input.layout, {
        onIssue: (issue) => warnings.push(issue),
      });
      if (warnings.some((issue) => issue.severity === "error"))
        throw new AutomationError("PRINT_BLOCKED", "内容存在阻断问题。", { issues: warnings });
      const declined = warnings.filter((issue) => !input.acceptWarnings.includes(issue.code));
      if (declined.length)
        throw new AutomationError("PRINT_WARNINGS", "请列出接受的打印警告代码。", {
          issues: declined,
        });
      context.assertAuthorized();
      await printing.submit(
        context.record.operationId,
        html,
        input.layout,
        input.output,
        printers.map((p) => p.deviceName),
        () => {
          context.assertAuthorized();
          context.ledger.update(context.record, "running", null, {
            kind: "print-submission",
            documentId: input.documentId,
            revision: input.expectedRevision,
            printer: input.output.printerDeviceName,
          });
        },
      );
      const result = {
        documentId: input.documentId,
        revision: input.expectedRevision,
        submitted: true,
        printer: input.output.printerDeviceName,
        warnings,
      };
      context.ledger.update(context.record, "committed", result);
      return result;
    } finally {
      release();
    }
  }
  if (command === "global.documents.export") {
    const input = AutomationDocumentExportSchema.parse(payload);
    const current = runtime.library.captureAutomation(input.documentId, input.persisted);
    if (current.revision !== input.expectedRevision)
      throw new AutomationError("REVISION_CONFLICT", "文档版本已变化。");
    const release = await runtime.assetStore.leaseSnapshotAssets(
      current.document.assets.map((asset) => asset.assetId),
    );
    let directory: string | undefined;
    const sessionAssets = new SessionAssetStore();
    const sessionId = context.record.operationId;
    sessionAssets.createSession(sessionId);
    try {
      directory = await mkdtemp(join(home, "document-export-"));
      const assets = await Promise.all(
        current.document.assets.map((asset) => runtime.assetStore.readAsset(asset.assetId)),
      );
      const warnings: Array<{ code: string; severity: string; message: string }> = [];
      let bytes: Uint8Array;
      if (input.format === "patdoc") {
        const path = join(directory, "document.patdoc");
        await writePatdoc(path, {
          document: current.document,
          assets,
          editorState: current.editorState,
          settings: {},
        });
        bytes = await readFile(path);
      } else if (input.format === "docx") {
        for (const asset of assets) sessionAssets.put(sessionId, asset);
        const result = await createDocxPackage(
          { sessionId, document: current.document },
          sessionAssets,
        );
        warnings.push(...result.issues);
        bytes = result.buffer;
      } else {
        if (!pdf) throw new AutomationError("UNAVAILABLE", "PDF 服务不可用。");
        const html = await renderPrintHtml(current.document, assets, {
          onIssue: (issue) => warnings.push(issue),
        });
        context.assertAuthorized();
        bytes = await pdf(html, sessionId);
      }
      if (warnings.some((issue) => issue.severity === "error"))
        throw new AutomationError("EXPORT_BLOCKED", "导出存在阻断问题。", { issues: warnings });
      const declined = warnings.filter((issue) => !input.acceptWarnings.includes(issue.code));
      if (declined.length)
        throw new AutomationError("EXPORT_WARNINGS", "请阅读并确认导出提示。", {
          issues: declined,
        });
      return await publishAutomationBytes(
        bytes,
        input.output,
        input.format,
        current.revision,
        context,
        warnings,
      );
    } finally {
      release();
      sessionAssets.destroySession(sessionId);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  const hooks = {
    assertAuthorized: context.assertAuthorized,
    inTransaction: (
      database: Parameters<AutomationLedger["inTransaction"]>[0],
      result: unknown,
    ) => {
      context.assertAuthorized();
      context.ledger.inTransaction(database, context.record, "committed", result);
    },
  };
  if (command === "global.documents.update") {
    const input = AutomationDocumentUpdateSchema.parse(payload);
    const current = runtime.library.captureAutomation(input.documentId);
    for (const descriptor of input.document.assets) {
      if (
        !runtime.assetStore
          .references({ kind: "library-document" }, [descriptor.assetId])
          .includes(input.documentId)
      )
        throw new AutomationError("SCOPE_DENIED", "资源不属于此独立文档。");
      const stored = await runtime.assetStore.readAsset(descriptor.assetId);
      if (payloadHash(stored.descriptor) !== payloadHash(descriptor))
        throw new AutomationError("INVALID_INPUT", "资源描述已变化。");
    }
    await validateAutomationChemicalChanges(
      current.document.content,
      input.document.content,
      (id) => runtime.assetStore.readAsset(id),
    );
    context.assertAuthorized();
    return runtime.library.mutateAutomation({ ...input, action: "update" }, hooks);
  }
  if (command === "global.documents.asset-import") {
    const input = AutomationDocumentAssetImportSchema.parse(payload);
    const bytes = await readAllowedFile(
      input.path,
      [context.grant.workspace.importDirectory],
      MAX_IMAGE_BYTES,
    );
    const imported = await importImage({ originalName: basename(input.path), bytes });
    context.assertAuthorized();
    const staged = await runtime.assetStore.stageMany(
      context.record.operationId,
      [imported],
      context.record.operationId,
    );
    try {
      const descriptor = staged[0]?.descriptor;
      if (!descriptor) throw new AutomationError("INTERNAL", "资源暂存失败。");
      return await runtime.library.mutateAutomation(
        {
          action: "asset",
          documentId: input.documentId,
          expectedRevision: input.expectedRevision,
          assetId: descriptor.assetId,
        },
        {
          ...hooks,
          inTransaction: (database) =>
            hooks.inTransaction(database, {
              documentId: input.documentId,
              revision: input.expectedRevision,
              descriptor,
            }),
        },
      );
    } finally {
      await runtime.assetStore.discardStaged(
        context.record.operationId,
        staged.map((asset) => asset.descriptor.assetId),
        context.record.operationId,
      );
    }
  }
  const action = command.slice("global.documents.".length);
  if (action !== "trash" && action !== "restore" && action !== "delete")
    throw new AutomationError("UNSUPPORTED_COMMAND", "独立文档命令不存在。");
  const input = AutomationDocumentLifecycleSchema.parse(payload);
  return runtime.library.mutateAutomation({ ...input, action }, hooks);
}

export async function importAutomationDocument(
  runtime: LibraryRuntime,
  payload: PatdocPayload,
  context: {
    record: OperationRecord;
    ledger: AutomationLedger;
    assertAuthorized(): void;
    onImportTransaction?: (database: DatabaseSync, documentId: string) => void;
  },
) {
  const stageId = context.record.operationId;
  const stagedIds = new Set<string>();
  try {
    context.assertAuthorized();
    const descriptors = new Map<string, PatdocPayload["document"]["assets"][number]>();
    for (const asset of payload.assets) {
      context.assertAuthorized();
      const [stored] = await runtime.assetStore.stageMany(
        stageId,
        [{ ...asset, descriptor: { ...asset.descriptor, assetId: randomUUID() } }],
        stageId,
      );
      if (!stored) throw new Error("资源暂存失败");
      stagedIds.add(stored.descriptor.assetId);
      descriptors.set(asset.descriptor.assetId, stored.descriptor);
    }
    const replacements = new Map(
      [...descriptors].map(([id, descriptor]) => [id, descriptor.assetId]),
    );
    const document = remapAssets(payload.document, replacements);
    document.documentId = randomUUID();
    document.assets = [
      ...new Map(
        [...descriptors.values()].map((descriptor) => [descriptor.assetId, descriptor]),
      ).values(),
    ];
    let result:
      | { documentType: "library_document"; documentId: string; revision: number }
      | undefined;
    const opened = await runtime.library.importDocument(
      document,
      {
        beforeCommit: context.assertAuthorized,
        inTransaction: (database, saved) => {
          context.assertAuthorized();
          const insert = database.prepare(
            "INSERT INTO document_assets(library_document_id, asset_id) VALUES (?, ?)",
          );
          for (const asset of document.assets) insert.run(saved.libraryDocumentId, asset.assetId);
          context.onImportTransaction?.(database, saved.libraryDocumentId);
          result = {
            documentType: "library_document",
            documentId: saved.libraryDocumentId,
            revision: 0,
          };
          context.ledger.inTransaction(database, context.record, "committed", result);
        },
      },
      remapAssets(payload.editorState, replacements),
    );
    await runtime.library.release(opened.sessionId, { preserveBlank: true });
    return result;
  } finally {
    await runtime.assetStore.discardStaged(stageId, [...stagedIds], stageId);
  }
}
