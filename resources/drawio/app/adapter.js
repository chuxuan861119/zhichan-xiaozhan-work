(() => {
  const installedParentOrigin = "patent-app://app";
  const isAllowedParentOrigin = (origin) => {
    if (origin === installedParentOrigin) return true;
    try {
      const candidate = new URL(origin);
      return candidate.origin === origin && candidate.protocol === "http:" && ["localhost", "127.0.0.1"].includes(candidate.hostname);
    } catch { return false; }
  };
  let parentOrigin = null;
  const editorOrigin = "patent-diagram://editor";
  const editor = document.getElementById("editor");
  const maxMessageBytes = 40 * 1024 * 1024;
  const maxSourceBytes = 20 * 1024 * 1024;
  let context = null;
  let ready = false;
  let documentLoaded = false;
  let activating = null;
  let deferredMode = null;
  let activeExport = null;
  let pages = [];
  let activePageId = null;
  const pendingRaw = [];
  const exportQueue = [];
  const bytes = (value) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
  const id = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
  const validEnvelope = (value) => value && typeof value === "object" && id(value.sessionId) && id(value.projectId) && Number.isInteger(value.projectRevision) && value.projectRevision >= 0 && id(value.requestId);
  const exact = (value, keys) => Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
  const exportFormats = ["drawio", "svg", "png", "jpeg", "pdf"];
  const toolbarActions = ["toggle-project-menu", "save", "export-external", "export-to-description-drawing", "replace-description-drawing", "project-create", "project-import", "project-rename", "project-duplicate", "project-delete", "cycle-tab-next", "cycle-tab-previous"];
  const validPagesMessage = (message) => Array.isArray(message.pages) && message.pages.length <= 100 && message.pages.every((page) => page && exact(page, ["id", "name"]) && id(page.id) && typeof page.name === "string" && page.name.length >= 1 && page.name.length <= 512) && (message.activePageId === null || id(message.activePageId));
  let reducedMotion = false;
  const applyMotionPreference = () => {
    const apply = (doc) => {
      if (!doc?.documentElement) return;
      doc.documentElement.dataset.reducedMotion = String(reducedMotion);
      let style = doc.getElementById("patent-motion-policy");
      if (!style) { style = doc.createElement("style"); style.id = "patent-motion-policy"; doc.head.append(style); }
      style.textContent = reducedMotion ? "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}" : "";
      if (reducedMotion) {
        for (const animation of doc.getAnimations?.() ?? []) {
          if (["finished", "idle"].includes(animation.playState)) continue;
          try { animation.finish(); } catch { animation.cancel(); }
        }
      }
    };
    apply(document);
    try { apply(editor.contentDocument); } catch { /* The embedded editor must share the local diagram origin. */ }
  };
  editor.addEventListener?.("load", applyMotionPreference);
  const validCommand = (message) => {
    if (!validEnvelope(message) || typeof message.type !== "string") return false;
    if (message.type === "motion-preference") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "reducedMotion"]) && typeof message.reducedMotion === "boolean";
    if (message.type === "configure") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "locale", "policy"]) && ["zh_CN", "en"].includes(message.locale) && message.policy && exact(message.policy, ["cloud", "templates", "help", "updates", "plugins", "grid", "shadow"]) && Object.values(message.policy).every((value) => value === false);
    if (message.type === "load") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "source"]) && typeof message.source === "string" && bytes(message.source) <= maxSourceBytes;
    if (message.type === "activate-session") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "source"]) && typeof message.source === "string" && bytes(message.source) <= maxSourceBytes;
    if (message.type === "request-save") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", ...(message.finishEditing === undefined ? [] : ["finishEditing"]), ...(message.preserveEditing === undefined ? [] : ["preserveEditing"])]) && (message.finishEditing === undefined || typeof message.finishEditing === "boolean") && (message.preserveEditing === undefined || typeof message.preserveEditing === "boolean");
    if (message.type === "dispose" || ["undo", "redo"].includes(message.type)) return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type"]);
    if (message.type === "toolbar-action-ack") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "actionId"]) && id(message.actionId);
    if (message.type === "request-export") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "format", "selectionOnly", ...(message.allPages === undefined ? [] : ["allPages"]), ...(message.pageId === undefined ? [] : ["pageId"]), ...(message.selectedCellIds === undefined ? [] : ["selectedCellIds"])]) && (message.pageId === undefined || id(message.pageId)) && (message.selectedCellIds === undefined || (message.format === "svg" && message.selectionOnly && !message.allPages && Array.isArray(message.selectedCellIds) && message.selectedCellIds.length > 0 && message.selectedCellIds.length <= 50000 && message.selectedCellIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 500))) && exportFormats.includes(message.format) && typeof message.selectionOnly === "boolean" && (message.allPages === undefined || typeof message.allPages === "boolean");
    if (message.type === "set-editor-mode") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "mode"]) && ["flowchart", "circuit"].includes(message.mode);
    if (message.type === "toolbar-state") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "projectName", "activePageName", "saveStatus", "dirty", "saveBusy", "exportBusy", "canUndo", "canRedo", ...(message.canReplaceDrawing === undefined ? [] : ["canReplaceDrawing"])]) && (message.canReplaceDrawing === undefined || typeof message.canReplaceDrawing === "boolean") && typeof message.projectName === "string" && message.projectName.length > 0 && message.projectName.length <= 512 && (message.activePageName === null || (typeof message.activePageName === "string" && message.activePageName.length > 0 && message.activePageName.length <= 512)) && ["loading", "saved", "dirty", "saving", "error"].includes(message.saveStatus) && [message.dirty, message.saveBusy, message.exportBusy, message.canUndo, message.canRedo].every((value) => typeof value === "boolean");
    return message.type === "set-page" && exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "pageId"]) && id(message.pageId);
  };
  const sameContext = (message) => !context || (message.sessionId === context.sessionId && message.projectId === context.projectId && message.projectRevision === context.projectRevision);
  const send = (type, payload = {}) => {
    if (!context || !parentOrigin) return;
    const message = { ...context, requestId: context.requestId, type, ...payload };
    if (bytes(message) <= maxMessageBytes) window.parent.postMessage(message, parentOrigin);
  };
  const raw = (message) => {
    if (!ready) { pendingRaw.push(message); return; }
    editor.contentWindow?.postMessage(JSON.stringify(message), editorOrigin);
  };
  const pumpExport = () => {
    if (!ready || activeExport || exportQueue.length === 0) return;
    activeExport = exportQueue.shift();
    if (activeExport.preserveEditing) raw({action:"patent-preserve-editing"});
    if (activeExport.finishEditing !== false) raw({ action: "patent-finish-editing" });
    if (activeExport.kind === "save") raw({ action: "export", format: "xml" });
    else if (activeExport.format !== "drawio") raw({ action: "patent-export-svg", selectionOnly: activeExport.selectionOnly, ...(activeExport.allPages ? {allPages: true} : {}), ...(activeExport.pageId === undefined ? {} : {pageId: activeExport.pageId}), ...(activeExport.selectedCellIds === undefined ? {} : {selectedCellIds: activeExport.selectedCellIds}) });
    else if (activeExport.selectionOnly) raw({ action: "patent-export-selection", format: "xml" });
    else raw({ action: "export", format: "xml" });
  };
  const enqueueExport = (request) => { exportQueue.push(request); pumpExport(); };
  const parsePages = (xml) => {
    try {
      const documents = new DOMParser().parseFromString(xml, "text/xml").querySelectorAll("mxfile > diagram");
      return Array.from(documents).slice(0, 100).map((page, index) => ({ id: "page-" + index, name: page.getAttribute("name") || "第" + (index + 1) + "页" }));
    } catch { return []; }
  };
  window.addEventListener("message", (event) => {
    if (event.source === window.parent && isAllowedParentOrigin(event.origin) && (!parentOrigin || event.origin === parentOrigin)) {
      const message = event.data;
      if (message && message.type === "release-session" && exact(message, ["type", "sessionId"]) && id(message.sessionId)) {
        raw({action:"patent-release-session",sessionId:message.sessionId});
        return;
      }
      if (!validCommand(message) || bytes(message) > maxMessageBytes) return;
      parentOrigin ||= event.origin;
      if (!sameContext(message) && (message.type !== "activate-session" || activeExport || exportQueue.length)) { window.parent.postMessage({ sessionId: message.sessionId, projectId: message.projectId, projectRevision: message.projectRevision, requestId: message.requestId, type: "error", code: "CONTEXT_MISMATCH", message: "流程图会话已失效。" }, parentOrigin); return; }
      context = { sessionId: message.sessionId, projectId: message.projectId, projectRevision: message.projectRevision, requestId: message.requestId };
      if (message.type === "activate-session") {
        documentLoaded = false;
        activating = message;
        deferredMode = null;
        raw({action:"patent-activate-session",sessionId:message.sessionId});
      } else if (message.type === "motion-preference") {
        reducedMotion = message.reducedMotion; applyMotionPreference();
      } else if (message.type === "configure") {
        raw({ action: "configure", config: { grid: false, plugins: [], templates: [], help: false, updates: false, cloud: false } });
      } else if (message.type === "load" && typeof message.source === "string" && bytes(message.source) <= maxSourceBytes) {
        documentLoaded = false;
        activePageId = null;
        pages = parsePages(message.source);
        raw({ action: "load", xml: message.source, autosave: 1, saveAndExit: 0, modified: 0 });
      } else if (message.type === "request-save") {
        enqueueExport({ kind: "save", requestId: message.requestId, format: "xml", selectionOnly: false, finishEditing: message.finishEditing !== false, preserveEditing: message.preserveEditing === true });
      } else if (message.type === "request-export") {
        enqueueExport({ kind: message.format === "drawio" ? "source-export" : "export", requestId: message.requestId, format: message.format, selectionOnly: message.selectionOnly, allPages: message.allPages === true, pageId: message.pageId, selectedCellIds: message.selectedCellIds });
      } else if (message.type === "set-page") {
        raw({ action: "patent-set-page", pageId: message.pageId });
      } else if (message.type === "set-editor-mode") {
        if (!documentLoaded) deferredMode = message.mode;
        else raw({ action: "patent-set-editor-mode", mode: message.mode });
      } else if (["undo", "redo"].includes(message.type)) {
        raw({ action: "patent-command", command: message.type });
      } else if (message.type === "toolbar-action-ack") {
        raw({ action: "patent-toolbar-action-ack", actionId: message.actionId });
      } else if (message.type === "toolbar-state") {
        raw({ action: "patent-toolbar-state", state: { projectName: message.projectName, activePageName: message.activePageName, saveStatus: message.saveStatus, dirty: message.dirty, saveBusy: message.saveBusy, exportBusy: message.exportBusy, canUndo: message.canUndo, canRedo: message.canRedo, canReplaceDrawing: message.canReplaceDrawing ?? false } });
      } else if (message.type === "dispose") {
        context = null; activeExport = null; exportQueue.splice(0); documentLoaded = false;
      }
      return;
    }
    if (event.source !== editor.contentWindow || event.origin !== editorOrigin || typeof event.data !== "string") return;
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message.event !== "string") return;
    // The nested editor can initialize before the outer iframe's load/configure.
    // Keep this readiness even when a parent session has not been assigned yet.
    if (message.event === "init") { ready = true; for (const queued of pendingRaw.splice(0)) raw(queued); pumpExport(); return; }
    if (!context) return;
    if (message.event === "session-error" && activating && message.sessionId === activating.sessionId) {
      activating = null;
      send("error", {code:"SESSION_RESTORE_FAILED",message:"流程图编辑状态恢复失败，请返回原专利重试。"});
      return;
    }
    if (message.event === "session-activated" && activating && message.sessionId === activating.sessionId) {
      if (message.restored && validPagesMessage(message)) {
        activating = null; documentLoaded = true;
        pages = message.pages; activePageId = message.activePageId;
        send("ready", {pages, activePageId: activePageId || undefined});
        send("history-state", {canUndo: message.canUndo, canRedo: message.canRedo});
        send("selection-changed", {selectionCount:message.selectedCellIds.length,selectedCellIds:message.selectedCellIds});
        if (deferredMode) raw({action:"patent-set-editor-mode",mode:deferredMode});
      } else if (message.restored === false) {
        const source = activating.source;
        activating = null;
        pages = parsePages(source); activePageId = null;
        raw({action:"load",xml:source,autosave:1,saveAndExit:0,modified:0});
      }
      return;
    }
    // Old autosave/page/selection messages cannot be attributed to the new owner
    // until the single native runtime acknowledges the session barrier.
    if (activating) return;
    if (message.event === "toolbar-action" && exact(message, ["event", "action", "actionId"]) && toolbarActions.includes(message.action) && id(message.actionId)) { send("toolbar-action", { action: message.action, actionId: message.actionId }); return; }
    if (message.event === "history-state" && exact(message, ["event", "canUndo", "canRedo"]) && typeof message.canUndo === "boolean" && typeof message.canRedo === "boolean") { send("history-state", { canUndo: message.canUndo, canRedo: message.canRedo }); return; }
    if (message.event === "editor-mode" && exact(message, ["event", "mode"]) && ["flowchart", "circuit"].includes(message.mode)) { send("editor-mode-changed", { mode: message.mode }); return; }
    if (message.event === "editor-mode-error" && exact(message, ["event", "code"]) && message.code === "LIBRARY_MODE_FAILED") { send("error", { code: "LIBRARY_MODE_FAILED", message: "图库模式切换失败，已保留原模式。" }); return; }
    if (message.event === "load") { documentLoaded = true; send("ready", { pages, activePageId: activePageId || pages[0]?.id }); if(deferredMode) raw({action:"patent-set-editor-mode",mode:deferredMode}); return; }
    if (message.event === "autosave" && documentLoaded && typeof message.xml === "string") { send("changed"); return; }
    if (message.event === "selection" && Array.isArray(message.selectedCellIds) && message.selectedCellIds.length <= 50000 && message.selectedCellIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 500) && message.selectionCount === message.selectedCellIds.length) { send("selection-changed", { selectionCount: message.selectionCount, selectedCellIds: message.selectedCellIds }); return; }
    if (message.event === "pages" && validPagesMessage(message)) {
      pages = message.pages;
      activePageId = message.activePageId;
      if (documentLoaded) send("ready", { pages, activePageId: message.activePageId || undefined });
      if (message.activePageId) send("page-changed", { pageId: message.activePageId });
      return;
    }
    if (message.event === "export" && activeExport) {
      const request = activeExport; activeExport = null; context.requestId = request.requestId;
      if (request.kind === "save") {
        if (typeof message.xml !== "string") { send("error", { code: "SAVE_SOURCE_MISSING", message: "流程图源文件保存失败。" }); pumpExport(); return; }
        if (bytes(message.xml) > maxSourceBytes) { send("error", { code: "SOURCE_TOO_LARGE", message: "流程图源文件过大。" }); pumpExport(); return; }
        pages = parsePages(message.xml); send("autosave", { source: message.xml }); pumpExport(); return;
      }
      if (request.kind === "source-export") {
        if (typeof message.xml !== "string") { send("error", { code: "EXPORT_SOURCE_MISSING", message: "流程图源文件导出失败。" }); pumpExport(); return; }
        if (bytes(message.xml) > maxSourceBytes) { send("error", { code: "SOURCE_TOO_LARGE", message: "流程图源文件过大。" }); pumpExport(); return; }
        send("export-result", { format: request.format, data: message.xml }); pumpExport(); return;
      }
      const data = typeof message.data === "string" ? message.data : null;
      if (data === null) send("error", { code: "EXPORT_RESULT_MISSING", message: "流程图导出失败。" });
      else send("export-result", { format: request.format, data });
      pumpExport(); return;
    }
    if (message.event === "status" && message.message === "modified" && documentLoaded) send("changed");
  });
})();
