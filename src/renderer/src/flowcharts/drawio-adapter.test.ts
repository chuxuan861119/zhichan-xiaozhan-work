import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("switches one runtime at an acknowledged session barrier and rejects old-owner commands", () => {
  const parent = { postMessage: vi.fn() }, embedded = { postMessage: vi.fn() };
  let receive = (_event: unknown) => {};
  runInNewContext(readFileSync("resources/drawio/app/adapter.js", "utf8"), {
    window: { parent, addEventListener: (_type: string, listener: typeof receive) => { receive = listener; } },
    document: { getElementById: () => ({ contentWindow: embedded }) },
    TextEncoder, DOMParser,
  });
  const host = (sessionId: string, payload: object) => receive({
    source: parent, origin: "patent-app://app",
    data: { sessionId, projectId: sessionId, projectRevision: 1, requestId: `${sessionId}-request`, ...payload },
  });
  const native = (payload: object) => receive({ source: embedded, origin: "patent-diagram://editor", data: JSON.stringify(payload) });
  native({event: "init"});
  host("a", {type:"activate-session", source:"<mxfile/>"});
  native({event:"session-activated",sessionId:"a",restored:false});
  native({event:"load"});
  host("a", {type:"request-save", preserveEditing:true});
  expect(embedded.postMessage.mock.calls.map(([s])=>JSON.parse(s).action)).toContain("patent-preserve-editing");
  host("b", {type:"activate-session",source:"<mxfile/>"});
  expect(parent.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({sessionId:"b",type:"error"}), "patent-app://app");
  native({event:"export",xml:"<mxfile/>"});
  host("b", {type:"activate-session",source:"<mxfile/>"});
  parent.postMessage.mockClear();
  native({event:"autosave",xml:"<mxfile previous='a'/>"});
  native({event:"history-state",canUndo:false,canRedo:false});
  expect(parent.postMessage).not.toHaveBeenCalled();
  native({event:"session-activated",sessionId:"b",restored:true,pages:[{id:"b-page",name:"B"}],activePageId:"b-page",canUndo:true,canRedo:true,selectedCellIds:["b-cell"]});
  expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({sessionId:"b",type:"history-state",canUndo:true,canRedo:true}), "patent-app://app");
  expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({sessionId:"b",type:"selection-changed",selectedCellIds:["b-cell"]}), "patent-app://app");
  embedded.postMessage.mockClear();
  host("a", {type:"undo"});
  expect(embedded.postMessage).not.toHaveBeenCalled();
  host("retry-1", {type:"activate-session",source:"<mxfile/>"});
  host("retry-2", {type:"activate-session",source:"<mxfile/>"});
  parent.postMessage.mockClear();
  native({event:"session-error",sessionId:"retry-1"});
  native({event:"session-activated",sessionId:"retry-1",restored:false});
  expect(parent.postMessage).not.toHaveBeenCalled();
  native({event:"session-activated",sessionId:"retry-2",restored:false});
  native({event:"load"});
  expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({sessionId:"retry-2",type:"ready"}), "patent-app://app");
});

test.each([true, false])(
  "loads after initialization before parent configuration: %s",
  (initFirst) => {
    const parent = { postMessage: vi.fn() };
    const embedded = { postMessage: vi.fn() };
    let receive: (event: unknown) => void = () => undefined;
    runInNewContext(readFileSync("resources/drawio/app/adapter.js", "utf8"), {
      window: {
        parent,
        addEventListener: (_type: string, listener: typeof receive) => {
          receive = listener;
        },
      },
      document: { getElementById: () => ({ contentWindow: embedded }) },
      TextEncoder,
      DOMParser,
    });
    const raw = (event: string) =>
      receive({
        source: embedded,
        origin: "patent-diagram://editor",
        data: JSON.stringify({ event }),
      });
    const envelope = {
      sessionId: "session",
      projectId: "project",
      projectRevision: 1,
      requestId: "request",
    };
    if (initFirst) raw("init");
    receive({
      source: parent,
      origin: "patent-app://app",
      data: {
        ...envelope,
        type: "load",
        source: '<mxfile><diagram id="page-1" name="第1页"/></mxfile>',
      },
    });
    if (!initFirst) raw("init");
    expect(embedded.postMessage).toHaveBeenCalledWith(
      expect.stringContaining('"action":"load"'),
      "patent-diagram://editor",
    );
    // Ready means the document has loaded, not just that the child script started.
    expect(parent.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "ready" }),
      expect.anything(),
    );
    raw("load");
    expect(parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ready" }),
      "patent-app://app",
    );
    embedded.postMessage.mockClear();
    receive({
      source: parent,
      origin: "patent-app://app",
      data: { ...envelope, requestId: "save-live-label", type: "request-save" },
    });
    expect(embedded.postMessage.mock.calls.map(([data]) => JSON.parse(data))).toEqual([
      { action: "patent-finish-editing" },
      { action: "export", format: "xml" },
    ]);
    receive({
      source: embedded,
      origin: "patent-diagram://editor",
      data: JSON.stringify({ event: "export", xml: "<mxfile/>" }),
    });
    embedded.postMessage.mockClear();
    receive({
      source: parent,
      origin: "patent-app://app",
      data: {
        ...envelope,
        requestId: "automatic-save",
        type: "request-save",
        finishEditing: false,
      },
    });
    expect(embedded.postMessage.mock.calls.map(([data]) => JSON.parse(data))).toEqual([
      { action: "export", format: "xml" },
    ]);
  },
);

test("accepts the exact local development parent origin from the iframe referrer", () => {
  const parent = { postMessage: vi.fn() };
  const embedded = { postMessage: vi.fn() };
  let receive: (event: unknown) => void = () => undefined;
  runInNewContext(readFileSync("resources/drawio/app/adapter.js", "utf8"), {
    window: {
      parent,
      addEventListener: (_type: string, listener: typeof receive) => {
        receive = listener;
      },
    },
    document: {
      referrer: "http://127.0.0.1:5173/",
      getElementById: () => ({ contentWindow: embedded }),
    },
    TextEncoder,
    DOMParser,
    URL,
  });
  const envelope = {
    sessionId: "session",
    projectId: "project",
    projectRevision: 1,
    requestId: "request",
  };
  receive({
    source: embedded,
    origin: "patent-diagram://editor",
    data: JSON.stringify({ event: "init" }),
  });
  receive({
    source: parent,
    origin: "http://127.0.0.1:5173",
    data: {
      ...envelope,
      type: "load",
      source: '<mxfile><diagram id="page-1" name="第1页"/></mxfile>',
    },
  });

  expect(embedded.postMessage).toHaveBeenCalledWith(
    expect.stringContaining('"action":"load"'),
    "patent-diagram://editor",
  );
  receive({
    source: embedded,
    origin: "patent-diagram://editor",
    data: JSON.stringify({ event: "load" }),
  });
  expect(parent.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "ready" }),
    "http://127.0.0.1:5173",
  );
});

test("authenticated motion preference stops effects in the nested local editor", () => {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const child = iframe.contentDocument;
  if (!child) throw new Error("Missing editor document");
  child.body.innerHTML = "<p>编辑器</p>";
  const parent = { postMessage: vi.fn() };
  let receive: (event: unknown) => void = () => undefined;
  const hostDocument = document.implementation.createHTMLDocument("adapter");
  const embedded = {
    contentDocument: child,
    contentWindow: { postMessage: vi.fn() },
    addEventListener: vi.fn(),
  };
  const findElement = hostDocument.getElementById.bind(hostDocument);
  vi.spyOn(hostDocument, "getElementById").mockImplementation((id) =>
    id === "editor" ? (embedded as unknown as HTMLElement) : findElement(id),
  );
  runInNewContext(readFileSync("resources/drawio/app/adapter.js", "utf8"), {
    window: {
      parent,
      addEventListener: (_type: string, listener: typeof receive) => {
        receive = listener;
      },
    },
    document: hostDocument,
    TextEncoder,
    DOMParser,
  });
  const message = {
    sessionId: "session",
    projectId: "project",
    projectRevision: 1,
    requestId: "motion",
    type: "motion-preference",
    reducedMotion: true,
  };
  try {
    receive({ source: parent, origin: "https://untrusted.example", data: message });
    expect(child.getElementById("patent-motion-policy")).toBeNull();
    receive({ source: parent, origin: "patent-app://app", data: message });
    expect(child.documentElement.dataset.reducedMotion).toBe("true");
    expect(child.getElementById("patent-motion-policy")?.textContent).toContain(
      "animation:none!important",
    );
    receive({
      source: parent,
      origin: "patent-app://app",
      data: { ...message, reducedMotion: false },
    });
    expect(child.getElementById("patent-motion-policy")?.textContent).toBe("");
  } finally {
    iframe.remove();
    vi.restoreAllMocks();
  }
});
