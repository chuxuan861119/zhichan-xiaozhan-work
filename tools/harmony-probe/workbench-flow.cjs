// Executed inside the real sandboxed renderer through its published IPC bridge.
module.exports = async function exerciseWorkbench() {
  const api = window.patentApi;
  const unwrap = (result) => {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  };
  const name = "鸿蒙联调虚构专利";
  const marker = "鸿蒙正文持久化验证甲乙丙123";
  const existing = unwrap(await api.patents.list("active")).find((item) => item.name === name);
  let opened;
  let stage;
  if (existing) {
    opened = unwrap(await api.patents.open(existing.patentId));
    if (!JSON.stringify(opened.patent).includes(marker))
      throw new Error("Reopened patent lost saved text");
    stage = "reopened-after-process-restart";
  } else {
    opened = unwrap(await api.patents.create({ name, patentType: "invention" }));
    const book = opened.patent.books.find((item) => item.kind === "description");
    const paragraph = book.document.content.find((item) => item.type === "paragraph");
    if (!paragraph) throw new Error("Template paragraph missing");
    const document = {
      ...book.document,
      content: [
        ...book.document.content,
        {
          ...paragraph,
          id: "00000000-0000-4000-8000-000000000987",
          content: [{ type: "text", text: marker, marks: [] }],
        },
      ],
    };
    const edit = unwrap(
      await api.patents.applyBookEdit({
        patentId: opened.patentId,
        sessionId: opened.sessionId,
        bookKind: "description",
        expectedRevision: opened.revision,
        document,
        editorState: book.editorState,
        assets: opened.patent.assets,
      }),
    );
    unwrap(await api.patents.flush({ patentId: opened.patentId, expectedRevision: edit.revision }));
    stage = "created-edited-flushed";
  }
  unwrap(await api.patents.release(opened.sessionId));
  unwrap(await api.contentSearch.request({ action: "start" }));
  let status;
  for (let attempt = 0; attempt < 60; attempt++) {
    status = unwrap(await api.contentSearch.request({ action: "status" }));
    if (status.error) throw new Error("Search worker failed");
    if (!status.running) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (status.running) throw new Error("Search did not finish");
  const search = unwrap(
    await api.contentSearch.request({ action: "search", query: "持久化验证甲乙丙" }),
  );
  if (!search.hits?.length) throw new Error("Saved text missing from search results");
  const exporting = unwrap(await api.patents.open(opened.patentId));
  const request = {
    sessionId: exporting.sessionId,
    patentId: opened.patentId,
    expectedRevision: exporting.revision,
    mode: "combined",
    suggestedName: name,
  };
  const exports = {};
  try {
    exports.patdoc = unwrap(
      await api.patents.exportPatdoc({
        patentId: opened.patentId,
        expectedRevision: exporting.revision,
      }),
    );
    exports.docx = unwrap(await api.exports.patentDocx(request));
    exports.pdf = unwrap(await api.exports.patentPdf(request));
    if (!exports.patdoc || !exports.docx || !exports.pdf)
      throw new Error("Unexpected export cancellation");
  } finally {
    unwrap(await api.patents.release(exporting.sessionId));
  }
  return { stage, patentId: opened.patentId, searchHits: search.hits.length, exports };
};
