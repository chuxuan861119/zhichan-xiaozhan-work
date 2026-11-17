// Runs through the published renderer bridge against synthetic, isolated data only.
module.exports = async function acceptanceFlow(input) {
  const api = window.patentApi;
  const ok = (r) => {
    if (!r.ok) throw Error(JSON.stringify(r.error));
    return r.value;
  };
  const bytes = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const name = "鸿蒙全流程虚构专利20261021";
  const marker = "全流程保存重开验证甲乙丙123";
  if (input.stage === "backup") {
    const destination = ok(await api.dataTransfer.selectExportDestination());
    if (!destination) throw Error("Backup unexpectedly cancelled");
    return ok(
      await api.dataTransfer.exportPackage({
        operationId: crypto.randomUUID(),
        destinationSelectionId: destination.selectionId,
        password: "synthetic-backup-password-20261021",
        passwordHint: "synthetic only",
        passwordRecorded: true,
      }),
    );
  }
  if (input.stage === "restore") {
    const inspection = ok(await api.dataTransfer.inspectLibrary());
    if (!inspection.empty)
      throw Error("Restore target must be empty: " + JSON.stringify(inspection));
    const prepare = async (password) => {
      const selected = ok(await api.dataTransfer.selectImportPackage());
      return api.dataTransfer.prepareImport({
        operationId: crypto.randomUUID(),
        sourceSelectionId: selected.selectionId,
        password,
      });
    };
    const wrong = await prepare("incorrect-synthetic-password");
    if (wrong.ok) throw Error("Wrong backup password accepted");
    const cancelled = ok(await prepare("synthetic-backup-password-20261021"));
    ok(await api.dataTransfer.cancel(cancelled.operationId));
    if (!ok(await api.dataTransfer.inspectLibrary()).empty)
      throw Error("Cancelled restore changed target");
    const preview = ok(await prepare("synthetic-backup-password-20261021"));
    return { wrongPassword: wrong.error.code, cancelledWithoutChanges: true, preview };
  }
  if (input.stage === "restoreCommit")
    return ok(
      await api.dataTransfer.commitImport({
        operationId: input.operationId,
        acknowledgedEmptyLibraryAndRestart: true,
      }),
    );
  if (input.stage === "restoreVerify") {
    const list = ok(await api.patents.list("active"));
    const matches = list.filter((p) => p.name === name);
    if (!matches.length) throw Error("Restored patent missing");
    let flowcharts = 0;
    for (const p of matches) {
      const o = ok(await api.patents.open(p.patentId));
      try {
        if (!JSON.stringify(o.patent).includes(marker) || !o.patent.drawingProjects.length)
          throw Error("Restored text or CAD missing");
        for (const project of o.patent.drawingProjects) {
          const preview = ok(await api.assets.getPreview(o.sessionId, project.baseAssetId));
          if (!preview.length) throw Error("Restored CAD preview missing");
        }
        for (const project of ok(await api.flowcharts.list(p.patentId))) {
          const source = ok(
            await api.flowcharts.load({ patentId: p.patentId, projectId: project.projectId }),
          );
          if (!new TextDecoder().decode(source.source).includes("合成流程验证"))
            throw Error("Restored flowchart source missing");
          flowcharts++;
        }
      } finally {
        ok(await api.patents.release(o.sessionId));
      }
    }
    if (!flowcharts) throw Error("Expected backed-up flowcharts");
    return {
      restoredPatents: list.length,
      verifiedCadPatents: matches.length,
      verifiedFlowcharts: flowcharts,
      nextProcessVerified: true,
    };
  }
  const list = ok(await api.patents.list("active"));
  const selectedId = localStorage.getItem("acceptance-primary-patent");
  const old = list.find((p) => p.patentId === selectedId) ?? list.find((p) => p.name === name);
  let opened = old
    ? ok(await api.patents.open(old.patentId))
    : ok(await api.patents.create({ name, patentType: "invention" }));
  localStorage.setItem("acceptance-primary-patent", opened.patentId);
  const report = { stage: input.stage, existed: !!old, patentId: opened.patentId };
  try {
    if (input.stage === "save") {
      if (old) {
        if (!JSON.stringify(opened.patent).includes(marker))
          throw Error("Saved text missing after restart");
        report.previousProcessText = true;
        for (const project of opened.patent.drawingProjects) {
          const preview = ok(await api.assets.getPreview(opened.sessionId, project.baseAssetId));
          if (!preview.length) throw Error("Previous process CAD preview lost");
        }
        report.previousProcessCad = opened.patent.drawingProjects.length;
      }
      const book = opened.patent.books.find((b) => b.kind === "description");
      const para = book.document.content.find((p) => p.type === "paragraph");
      const document = {
        ...book.document,
        content: [
          ...book.document.content.filter((p) => p.id !== "00000000-0000-4000-8000-000000000987"),
          {
            ...para,
            id: "00000000-0000-4000-8000-000000000987",
            content: [
              { type: "text", text: marker, marks: [{ type: "bold" }] },
              {
                type: "inline-formula",
                source: "x^2+\\frac{1}{2}",
                formulaKind: "math",
                fontSizePt: 14,
                color: "#000000",
              },
            ],
          },
        ],
      };
      document.content = document.content.filter(
        (p) => p.id !== "00000000-0000-4000-8000-000000000988",
      );
      const cell = (text) => ({
        id: crypto.randomUUID(),
        colSpan: 1,
        rowSpan: 1,
        horizontalAlignment: "left",
        verticalAlignment: "middle",
        borderStyle: "single",
        content: [
          { ...para, id: crypto.randomUUID(), content: [{ type: "text", text, marks: [] }] },
        ],
      });
      document.content.push({
        id: "00000000-0000-4000-8000-000000000988",
        type: "table",
        columnWidthsMm: [50, 70],
        headerRowCount: 1,
        layoutMode: "fixed",
        tableAlignment: "center",
        tableNameEnabled: true,
        tableName: "合成参数表",
        tableNoteEnabled: true,
        tableNote: "仅用于兼容性验证",
        rows: [
          { id: crypto.randomUUID(), cells: [cell("参数甲"), cell("中文与希腊字母αβ")] },
          { id: crypto.randomUUID(), cells: [cell("数值"), cell("123.45")] },
        ],
      });
      const request = {
        patentId: opened.patentId,
        sessionId: opened.sessionId,
        bookKind: "description",
        expectedRevision: opened.revision,
        document,
        editorState: book.editorState,
        assets: opened.patent.assets,
      };
      const edit = ok(await api.patents.applyBookEdit(request));
      const stale = await api.patents.applyBookEdit({
        ...request,
        document: { ...document, content: [] },
      });
      if (stale.ok || stale.error.code !== "REVISION_CONFLICT")
        throw Error("Stale revision was not rejected");
      ok(await api.patents.flush({ patentId: opened.patentId, expectedRevision: edit.revision }));
      ok(await api.patents.release(opened.sessionId));
      opened = ok(await api.patents.open(opened.patentId));
      if (!JSON.stringify(opened.patent).includes(marker))
        throw Error("Close and reopen lost text");
      report.saveAndReopen = true;
      report.revisionConflict = true;
      // A second document must not inherit the first document's text.
      const secondName = name + "乙";
      const secondOld = list.find((p) => p.name === secondName);
      const second = secondOld
        ? ok(await api.patents.open(secondOld.patentId))
        : ok(await api.patents.create({ name: secondName, patentType: "utility-model" }));
      try {
        if (JSON.stringify(second.patent).includes(marker)) throw Error("Document state leaked");
        report.documentIsolation = true;
      } finally {
        ok(await api.patents.release(second.sessionId));
      }
    }
    if (input.stage === "native") {
      report.path = ok(
        await api.assets.exportCad({
          sessionId: opened.sessionId,
          bytes: bytes(input.dxf),
          format: "dwg",
          name: "鸿蒙原生选择器验证",
        }),
      );
      if (!report.path) throw Error("Native save cancelled");
      const request = {
        sessionId: opened.sessionId,
        patentId: opened.patentId,
        expectedRevision: opened.revision,
        mode: "combined",
        suggestedName: "鸿蒙原生导出验证",
      };
      report.patdoc = ok(
        await api.patents.exportPatdoc({
          patentId: opened.patentId,
          expectedRevision: opened.revision,
        }),
      );
      report.docx = ok(await api.exports.patentDocx(request));
      report.pdf = ok(await api.exports.patentPdf(request));
      if (!report.patdoc || !report.docx || !report.pdf) throw Error("Native export cancelled");
    }
    if (input.stage === "cad") {
      const dxf = bytes(input.dxf);
      const converted = ok(
        await api.assets.convertCad({ sessionId: opened.sessionId, bytes: dxf, format: "dwg" }),
      );
      if (String.fromCharCode(...converted.slice(0, 4)) !== "AC10")
        throw Error("DWG signature invalid");
      const prepared = ok(
        await api.assets.prepareCad({
          sessionId: opened.sessionId,
          operationId: crypto.randomUUID(),
          originalName: "synthetic.dwg",
          format: "dwg",
          bytes: converted,
        }),
      );
      const base = prepared.assets.find((a) => a.descriptor.extension === "svg");
      const source = prepared.assets.find((a) => a.descriptor.extension === "dwg");
      const project = {
        projectId: "00000000-0000-4000-8000-000000000801",
        name: "合成CAD工作稿",
        sourceAssetId: source.descriptor.assetId,
        baseAssetId: base.descriptor.assetId,
        cad: prepared.cad,
        sourceKind: "dwg",
        pageNumber: 1,
        width: prepared.width,
        height: prepared.height,
        annotations: [],
        regions: [],
        warnings: [],
        revision: 0,
      };
      const edit = ok(
        await api.patents.applyFigureEdit({
          patentId: opened.patentId,
          sessionId: opened.sessionId,
          expectedRevision: opened.revision,
          figures: [
            ...opened.patent.figures.filter(
              (f) => f.figureId !== "00000000-0000-4000-8000-000000000802",
            ),
            {
              figureId: "00000000-0000-4000-8000-000000000802",
              assetId: base.descriptor.assetId,
              widthMm: 80,
            },
          ],
          abstractDrawingFigureId: opened.patent.abstractDrawingFigureId,
          assets: [...opened.patent.assets, ...prepared.assets.map((a) => a.descriptor)],
          drawingProjects: [project],
        }),
      );
      ok(await api.patents.flush({ patentId: opened.patentId, expectedRevision: edit.revision }));
      ok(await api.patents.release(opened.sessionId));
      opened = ok(await api.patents.open(opened.patentId));
      const restored = opened.patent.drawingProjects.find((p) => p.projectId === project.projectId);
      if (!restored || restored.cad.assetId !== prepared.cad.assetId)
        throw Error("CAD checkpoint lost");
      for (const a of prepared.assets) {
        const preview = ok(await api.assets.getPreview(opened.sessionId, a.descriptor.assetId));
        if (!preview.length) throw Error("CAD preview missing");
      }
      report.savedAssets = prepared.assets.map((a) => ({
        kind: a.descriptor.kind,
        extension: a.descriptor.extension,
        size: a.descriptor.byteLength,
      }));
      for (const format of ["dxf", "dwg"])
        report[format] = ok(
          await api.assets.exportCad({
            sessionId: opened.sessionId,
            bytes: dxf,
            format,
            name: "synthetic-cad",
          }),
        );
      const invalid = await api.assets.prepareCad({
        sessionId: opened.sessionId,
        operationId: crypto.randomUUID(),
        originalName: "bad.dwg",
        format: "dwg",
        bytes: new Uint8Array([1, 2, 3]),
      });
      if (invalid.ok) throw Error("Corrupt CAD accepted");
      report.corruptRejected = invalid.error.code;
      report.savedAndReopened = true;
    }
    if (input.stage === "image") {
      const imported = ok(
        await api.assets.importBytes({
          sessionId: opened.sessionId,
          originalName: "synthetic.png",
          declaredMediaType: "image/png",
          bytes: bytes(input.png),
        }),
      );
      const image = {
        assetId: imported.descriptor.assetId,
        rotationDeg: 90,
        label: "synthetic-image",
      };
      report.png = ok(
        await api.assets.saveImage({ sessionId: opened.sessionId, image, format: "png" }),
      );
      report.jpg = ok(
        await api.assets.saveImage({ sessionId: opened.sessionId, image, format: "jpg" }),
      );
      report.tif = ok(
        await api.assets.saveImages({
          sessionId: opened.sessionId,
          images: [image],
          format: "tif",
        }),
      );
    }
    if (input.stage === "flowchart") {
      const source = new TextEncoder().encode(
        '<mxfile><diagram id="p1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="合成流程验证" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>',
      );
      const created = ok(
        await api.flowcharts.create({
          patentId: opened.patentId,
          expectedPatentRevision: opened.revision,
          name: "合成流程验证",
          source,
          pageCount: 1,
          lastPageId: "p1",
        }),
      );
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect x="1" y="1" width="118" height="58" fill="white" stroke="black"/><text x="10" y="34" font-family="Source Han Serif CN" font-size="14">合成流程验证</text></svg>';
      const preview = ok(
        await api.flowcharts.renderPreview({
          patentId: opened.patentId,
          projectId: created.project.projectId,
          expectedProjectRevision: created.project.revision,
          expectedSourceSha256: created.project.sourceSha256,
          pageId: "p1",
          exportScope: "page",
          selectedCellIds: [],
          borderMm: 2,
          svg,
          target: { kind: "new", insertIndex: opened.patent.figures.length },
        }),
      );
      const committed = ok(
        await api.flowcharts.commitPreview({
          patentId: opened.patentId,
          sessionId: opened.sessionId,
          expectedPatentRevision: created.patentRevision,
          projectId: created.project.projectId,
          previewToken: preview.previewToken,
        }),
      );
      ok(
        await api.patents.flush({
          patentId: opened.patentId,
          expectedRevision: committed.patent.revision,
        }),
      );
      ok(await api.patents.release(opened.sessionId));
      opened = ok(await api.patents.open(opened.patentId));
      const loaded = ok(
        await api.flowcharts.load({
          patentId: opened.patentId,
          projectId: created.project.projectId,
        }),
      );
      if (!new TextDecoder().decode(loaded.source).includes("合成流程验证"))
        throw Error("Flowchart source lost");
      report.sourceReopened = true;
      report.previewBytes = preview.preview.length;
      report.figures = opened.patent.figures.length;
      const backup = ok(
        await api.flowcharts.exportBackup({
          patentId: opened.patentId,
          projectId: created.project.projectId,
        }),
      );
      report.backupBytes = backup.length;
    }
    if (input.stage === "exports") {
      const request = {
        sessionId: opened.sessionId,
        patentId: opened.patentId,
        expectedRevision: opened.revision,
        mode: "combined",
        suggestedName: name,
      };
      report.patdoc = ok(
        await api.patents.exportPatdoc({
          patentId: opened.patentId,
          expectedRevision: opened.revision,
        }),
      );
      report.docx = ok(await api.exports.patentDocx(request));
      report.pdf = ok(await api.exports.patentPdf(request));
      const candidates = ok(await api.patents.list("active"));
      const selected = [
        candidates.find((p) => p.patentId === opened.patentId),
        candidates.find((p) => p.name === `${name}乙`),
      ].filter(Boolean);
      const patents = [];
      for (const p of selected) {
        const o = ok(await api.patents.open(p.patentId));
        patents.push({ patentId: p.patentId, expectedRevision: o.revision });
        ok(await api.patents.release(o.sessionId));
      }
      report.bundle = ok(await api.patents.exportBundle({ format: "patdoc", patents }));
    }
    if (input.stage === "imports") {
      const imported = ok(await api.patents.importPatdoc());
      if (!imported || !JSON.stringify(imported.patent).includes(marker))
        throw Error("PATDOC reimport lost text");
      if (!imported.patent.drawingProjects.length) throw Error("PATDOC reimport lost CAD");
      for (const p of imported.patent.drawingProjects) {
        const preview = ok(await api.assets.getPreview(imported.sessionId, p.baseAssetId));
        if (!preview.length) throw Error("Imported CAD preview unavailable");
      }
      ok(await api.patents.release(imported.sessionId));
      report.patdocReimport = true;
      report.bundle = ok(await api.patents.importBundle());
    }
    if (input.stage === "cancel") {
      report.cad = ok(
        await api.assets.exportCad({
          sessionId: opened.sessionId,
          bytes: bytes(input.dxf),
          format: "dwg",
          name: "cancelled",
        }),
      );
      report.patdoc = ok(
        await api.patents.exportPatdoc({
          patentId: opened.patentId,
          expectedRevision: opened.revision,
        }),
      );
      if (report.cad !== null || report.patdoc !== null)
        throw Error("Cancelled export produced output");
    }
    if (input.stage === "search") {
      ok(await api.contentSearch.request({ action: "start" }));
      for (let n = 0; n < 100; n++) {
        const s = ok(await api.contentSearch.request({ action: "status" }));
        if (s.error) throw Error("Search index failed");
        if (!s.running) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const result = ok(await api.contentSearch.request({ action: "search", query: marker }));
      if (!result.hits.length) throw Error("Saved content absent from search");
      report.hits = result.hits.length;
    }
    return report;
  } finally {
    ok(await api.patents.release(opened.sessionId));
  }
};
